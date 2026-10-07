#!/usr/bin/env python3
"""Local read-only AMD/AMDL minute tape monitor backed by Massive WebSocket.

The browser never receives the API key. Completed minutes are published only
after a two-second event-time reorder window. This is a descriptive monitor;
it does not place orders or generate entries.
"""
from __future__ import annotations

import argparse
import heapq
import json
import os
import re
import statistics
import threading
import time
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "analysis/amd-live-tape-v1"
CT = ZoneInfo("America/Chicago")
SYMBOLS = ("AMD", "AMDL")
REORDER_MS = 2_000
QUOTE_AGE_MS = 2_000
TRADE_LAG_MS = 1_000
TRF_IDS = {
    int(row["id"])
    for row in json.loads((PAGE / "reference/exchanges.json").read_text())
    if row.get("type") == "TRF"
}
CONDITIONS = {
    int(row["id"]): row
    for row in json.loads((PAGE / "reference/trade-conditions.json").read_text())
}
NON_CONTINUOUS = {8, 9, 15, 17, 19, 25, 52, 53}
NON_DIRECTIONAL = {2, 7, 13, 15, 16, 20, 21, 29, 32, 33, 38, 52, 53}


def load_local_env() -> None:
    """Load the local API key without placing it in browser files or logs."""
    for path in (ROOT / ".env", ROOT / ".env.local"):
        if not path.is_file():
            continue
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def ct_clock(stamp_ms: int) -> str:
    return datetime.fromtimestamp(stamp_ms / 1000, CT).strftime("%H:%M")


def ct_date(stamp_ms: int) -> str:
    return datetime.fromtimestamp(stamp_ms / 1000, CT).strftime("%Y-%m-%d")


def continuous(ids: list[int]) -> bool:
    return not NON_CONTINUOUS.intersection(ids)


def eligible(ids: list[int]) -> bool:
    for condition in ids:
        rules = CONDITIONS.get(condition, {}).get("update_rules", {}).get("consolidated", {})
        if rules.get("updates_volume") is False:
            return False
    return True


def price_eligible(ids: list[int]) -> bool:
    if not continuous(ids):
        return False
    for condition in ids:
        rules = CONDITIONS.get(condition, {}).get("update_rules", {}).get("consolidated", {})
        if rules.get("updates_high_low") is False or rules.get("updates_open_close") is False:
            return False
    return True


class Minute:
    def __init__(self, stamp_ms: int):
        self.start_ms = stamp_ms // 60_000 * 60_000
        self.o = self.h = self.l = self.c = None
        self.volume = self.buy = self.sell = 0
        self.buy_notional = self.sell_notional = 0.0
        self.ofi_signed = self.ofi_gross = 0.0
        self.quotes = 0
        self.first_mid = self.last_mid = None
        self.spreads = []
        self.last_quote = None
        self.missing_pt = 0

    def quote(self, event: dict, prior: dict | None):
        bid, ask = float(event.get("bp") or 0), float(event.get("ap") or 0)
        bs, az = float(event.get("bs") or 0), float(event.get("as") or 0)
        if bid <= 0 or ask <= bid or bs <= 0 or az <= 0:
            return False
        self.quotes += 1
        mid = (bid + ask) / 2
        if self.first_mid is None:
            self.first_mid = mid
        self.last_mid = mid
        self.spreads.append(100 * (ask - bid))
        self.last_quote = event
        if prior is not None:
            old_bid, old_ask = float(prior["bp"]), float(prior["ap"])
            old_bs, old_az = float(prior["bs"]), float(prior["as"])
            e = (bs if bid >= old_bid else 0) - (old_bs if bid <= old_bid else 0)
            e -= (az if ask <= old_ask else 0) - (old_az if ask >= old_ask else 0)
            self.ofi_signed += e
            self.ofi_gross += abs(e)
        return True

    def trade(self, event: dict, quote: dict | None):
        price, size = float(event.get("p") or 0), float(event.get("s") or 0)
        ids = [int(x) for x in event.get("c") or []]
        if price <= 0 or size <= 0 or not eligible(ids):
            return
        stamp = int(event["t"])
        participant = event.get("pt")
        if participant is None:
            self.missing_pt += 1
            return
        lag = stamp - int(participant)
        if not 0 <= lag <= TRADE_LAG_MS:
            return
        # Form-T is the normal extended-hours sale condition. Match the
        # historical browser's premarket price rule through 08:29:59 CT.
        local_time = ct_clock(stamp)
        extended = local_time < "08:30" or local_time >= "15:00"
        price_ids = [condition for condition in ids if condition != 12] if extended else ids
        if price_eligible(price_ids):
            if self.o is None:
                self.o = self.h = self.l = price
            self.h = max(self.h, price)
            self.l = min(self.l, price)
            self.c = price
        if not continuous(ids) or int(event.get("trfi") or 0) or int(event.get("x") or 0) in TRF_IDS:
            return
        self.volume += size
        if quote is None or not 0 <= stamp - int(quote["t"]) <= QUOTE_AGE_MS or NON_DIRECTIONAL.intersection(ids):
            return
        bid, ask = float(quote["bp"]), float(quote["ap"])
        midpoint = (bid + ask) / 2
        if price >= ask - 1e-7 or price > midpoint + 1e-7:
            self.buy += size
            self.buy_notional += size * price
        elif price <= bid + 1e-7 or price < midpoint - 1e-7:
            self.sell += size
            self.sell_notional += size * price

    def result(self):
        classified = self.buy + self.sell
        last = self.last_quote
        age = self.start_ms + 60_000 - int(last["t"]) if last else None
        queue = None
        if last and age is not None and age <= QUOTE_AGE_MS:
            bs, az = float(last["bs"]), float(last["as"])
            if bs + az:
                queue = (bs - az) / (bs + az)
        return {
            "t": ct_clock(self.start_ms), "stampMs": self.start_ms,
            "o": self.o, "h": self.h, "l": self.l, "c": self.c,
            "litShares": round(self.volume), "buy": round(self.buy), "sell": round(self.sell),
            "delta": round(self.buy - self.sell),
            "imbalancePct": round(100 * (self.buy - self.sell) / classified, 1) if classified else None,
            "coveragePct": round(100 * classified / self.volume, 1) if self.volume else None,
            "netOutflowUsd": round(self.sell_notional - self.buy_notional),
            "ofi": round(self.ofi_signed / self.ofi_gross, 4) if self.ofi_gross else None,
            "quoteUpdates": self.quotes, "queue": round(queue, 4) if queue is not None else None,
            "medianSpreadCents": round(statistics.median(self.spreads), 2) if self.spreads else None,
            "midMoveCents": round(100 * (self.last_mid - self.first_mid), 1)
            if self.first_mid is not None else None,
            "quoteAgeMs": age, "missingParticipantTimestamp": self.missing_pt,
        }


class TapeState:
    def __init__(self):
        self.lock = threading.Lock()
        self.feed = "waiting"
        self.message = "Waiting for Massive trades and quotes"
        self.connected_at = None
        self.last_received_at = None
        self.latest_event_ms = None
        self.last_processed_ms = None
        self.date = datetime.now(CT).strftime("%Y-%m-%d")
        self.open_minutes = {symbol: {} for symbol in SYMBOLS}
        self.closed = {symbol: deque(maxlen=300) for symbol in SYMBOLS}
        self.latest_quote = {symbol: None for symbol in SYMBOLS}
        self.heap = []
        self.serial = 0
        self.gaps = 0
        self.awaiting_first_event = True
        self.drop_through_minute = None

    def set_feed(self, feed: str, message: str):
        with self.lock:
            self.feed, self.message = feed, message
            if feed == "connected":
                self.connected_at = time.time()

    def ingest(self, events: list[dict]):
        with self.lock:
            for event in events:
                if event.get("ev") not in ("T", "Q") or event.get("sym") not in SYMBOLS or not isinstance(event.get("t"), int):
                    continue
                stamp = int(event["t"])
                day = ct_date(stamp)
                if day != self.date:
                    self.date = day
                    self.open_minutes = {symbol: {} for symbol in SYMBOLS}
                    self.closed = {symbol: deque(maxlen=300) for symbol in SYMBOLS}
                    self.latest_quote = {symbol: None for symbol in SYMBOLS}
                    self.heap.clear()
                    self.last_processed_ms = None
                    self.awaiting_first_event = True
                if self.awaiting_first_event:
                    # Starting midway through a minute cannot yield a complete bar.
                    self.drop_through_minute = stamp // 60_000 * 60_000
                    self.awaiting_first_event = False
                if self.last_processed_ms is not None and stamp < self.last_processed_ms:
                    self.gaps += 1
                    continue
                self.serial += 1
                heapq.heappush(self.heap, (stamp, self.serial, event))
                self.latest_event_ms = max(stamp, self.latest_event_ms or stamp)
            self.last_received_at = time.time()
            self._flush()

    def _flush(self):
        cutoff = (self.latest_event_ms or 0) - REORDER_MS
        while self.heap and self.heap[0][0] <= cutoff:
            stamp, _, event = heapq.heappop(self.heap)
            self.last_processed_ms = stamp
            symbol = event["sym"]
            key = stamp // 60_000 * 60_000
            minute = self.open_minutes[symbol].setdefault(key, Minute(stamp))
            if event["ev"] == "Q":
                if minute.quote(event, self.latest_quote[symbol]):
                    self.latest_quote[symbol] = event
            else:
                minute.trade(event, self.latest_quote[symbol])
        for symbol in SYMBOLS:
            ready = [key for key in self.open_minutes[symbol] if key + 60_000 <= cutoff]
            for key in sorted(ready):
                minute = self.open_minutes[symbol].pop(key).result()
                # A quote-only interval has useful feed activity but no candle.
                # Keep it out of the price chart rather than drawing a zero.
                if minute["c"] is not None and key > (self.drop_through_minute or -1):
                    self.closed[symbol].append(minute)

    def mark_gap(self):
        with self.lock:
            self.gaps += 1
            self.heap.clear()
            self.open_minutes = {symbol: {} for symbol in SYMBOLS}
            self.latest_quote = {symbol: None for symbol in SYMBOLS}
            self.last_processed_ms = None
            self.awaiting_first_event = True

    def snapshot(self):
        with self.lock:
            age = round(time.time() - self.last_received_at, 1) if self.last_received_at else None
            event_lag = round(time.time() - self.latest_event_ms / 1000, 1) if self.latest_event_ms else None
            status = self.feed
            if status == "connected" and age is not None and age > 15:
                status = "stale"
            return {
                "mode": "live", "date": self.date, "status": status, "message": self.message,
                "receivedAgeSeconds": age, "eventLagSeconds": event_lag,
                "reorderWindowSeconds": REORDER_MS / 1000, "feedGapsOrOutOfOrderDrops": self.gaps,
                "lastCompleted": {symbol: self.closed[symbol][-1]["t"] if self.closed[symbol] else None for symbol in SYMBOLS},
                "bars": {symbol: list(self.closed[symbol]) for symbol in SYMBOLS},
                "updatedAt": datetime.now(CT).isoformat(),
            }


def collect(state: TapeState, log_dir: Path):
    key = os.environ.get("MASSIVE_API_KEY")
    if not key:
        state.set_feed("error", "MASSIVE_API_KEY is not configured")
        return
    backoff = 1
    previously_connected = False
    while True:
        try:
            state.set_feed("connecting", "Connecting to Massive")
            with connect("wss://socket.massive.com/stocks", open_timeout=15,
                         ping_interval=20, ping_timeout=20) as socket:
                socket.send(json.dumps({"action": "auth", "params": key}))
                authenticated = False
                subscribed = set()
                backoff = 1
                while True:
                    try:
                        rows = json.loads(socket.recv(timeout=5))
                    except TimeoutError:
                        continue
                    if not isinstance(rows, list):
                        rows = [rows]
                    market = []
                    for row in rows:
                        if row.get("ev") == "status":
                            status = row.get("status")
                            if status == "auth_success" and not authenticated:
                                authenticated = True
                                socket.send(json.dumps({"action": "subscribe", "params":
                                                        "T.AMD,Q.AMD,T.AMDL,Q.AMDL"}))
                            elif status in ("auth_failed", "max_connections"):
                                raise RuntimeError(f"Massive WebSocket: {status}")
                            elif status == "success" and "subscribed to:" in row.get("message", ""):
                                subscribed.add(row["message"].split("subscribed to:", 1)[1].strip())
                                if len(subscribed) >= 4:
                                    state.set_feed("connected", "AMD and AMDL trades and quotes subscribed")
                                    previously_connected = True
                            continue
                        if row.get("ev") in ("T", "Q") and row.get("sym") in SYMBOLS:
                            market.append(row)
                    if market:
                        day = datetime.now(CT).strftime("%Y-%m-%d")
                        log_dir.mkdir(parents=True, exist_ok=True)
                        with (log_dir / f"{day}.ndjson").open("a") as handle:
                            for event in market:
                                handle.write(json.dumps(event, separators=(",", ":")) + "\n")
                        state.ingest(market)
        except Exception as error:
            if previously_connected:
                state.mark_gap()
                previously_connected = False
            state.set_feed("reconnecting", f"Feed interrupted: {type(error).__name__}; retrying")
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)


def handler(state: TapeState):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/api/state":
                payload = json.dumps(state.snapshot(), separators=(",", ":")).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            name = self.path.split("?", 1)[0].lstrip("/") or "index.html"
            if name not in {"index.html", "app.js", "analytics.js", "history-windows.js", "replay-manifest.json"} and not re.fullmatch(r"replay/20\d{2}-\d{2}-\d{2}\.json", name):
                self.send_error(404)
                return
            path = PAGE / name
            if not path.is_file():
                self.send_error(404)
                return
            payload = path.read_bytes()
            mime = "text/html" if name.endswith(".html") else "application/javascript" if name.endswith(".js") else "application/json"
            self.send_response(200)
            self.send_header("Content-Type", f"{mime}; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--raw-dir", type=Path, default=ROOT / "tmp/amd-live-tape-v1")
    parser.add_argument("--no-feed", action="store_true", help="Serve replay and UI without opening Massive")
    args = parser.parse_args()
    load_local_env()
    state = TapeState()
    if not args.no_feed:
        threading.Thread(target=collect, args=(state, args.raw_dir), daemon=True).start()
    server = ThreadingHTTPServer((args.bind, args.port), handler(state))
    print(f"AMD live tape: http://{args.bind}:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
