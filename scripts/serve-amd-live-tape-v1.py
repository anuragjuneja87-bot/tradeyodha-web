#!/usr/bin/env python3
"""Local read-only AMD minute tape monitor backed by Massive WebSocket.

The browser never receives the API key. Completed minutes are published only
after a two-second event-time reorder window. This is a descriptive monitor;
it does not place orders or generate entries.
"""
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import os
import re
import secrets
import shutil
import statistics
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.error
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from symbol_level_bot_v1 import find_symbol_levels, premarket_levels
from market_context_bot_v1 import market_context_snapshot
from macro_context_bot_v1 import macro_context_snapshot
from amd_context_memory_v1 import retrieve as retrieve_context_memory
from options_wall_bot_v1 import summarize_chain
from shadow_cv2_display_v1 import archived_cv2
PAGE = ROOT / "analysis/amd-live-tape-v1"
CT = ZoneInfo("America/Chicago")
SYMBOLS = ("AMD", "TSLA", "SPY", "SMH", "QQQ", "META", "NVDA", "MU", "MSFT", "SOXL", "SPCX", "SNDK")
DEFAULT_WATCHLIST = tuple(symbol for symbol in SYMBOLS if symbol != "SMH")
SESSION_START_CT = "03:00"
REGULAR_OPEN_CT = "08:30"
REGULAR_CLOSE_CT = "15:00"
ARCHIVE_END_CT = "11:00"  # Coverage of the existing 30-session raw baseline.
BAR_HISTORY_LIMIT = 780  # Preserve 03:00 premarket alongside the regular session.
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
DAILY_CONTEXT = {}
DAILY_CONTEXT_LOCK = threading.Lock()


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
    def __init__(self, stamp_ms: int, duration_ms: int = 60_000):
        self.duration_ms = duration_ms
        self.start_ms = stamp_ms // duration_ms * duration_ms
        self.o = self.h = self.l = self.c = None
        self.last_price_event_ms = None
        self.volume = self.buy = self.sell = 0
        self.off_exchange_prints = self.off_exchange_shares = 0
        self.off_exchange_buy = self.off_exchange_sell = self.off_exchange_unknown = 0
        self.buy_notional = self.sell_notional = 0.0
        self.ofi_signed = self.ofi_gross = 0.0
        self.quotes = 0
        self.first_mid = self.last_mid = None
        self.spreads = []
        self.last_quote = None
        self.missing_pt = 0
        # Keep the price ladder only for 30-second candles. It is served on
        # demand rather than sent with every live-state refresh.
        self.price_levels = {} if duration_ms == 30_000 else None

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
        off_exchange = bool(int(event.get("trfi") or 0) or int(event.get("x") or 0) in TRF_IDS)
        if price > 0 and size > 0 and off_exchange:
            # Reported off-exchange traffic is separate from classified lit
            # pressure. Count by SIP minute, including non-price-forming prints.
            self.off_exchange_prints += 1
            self.off_exchange_shares += size
            # A TRF report has no initiating-side field. Estimate only when
            # the last valid NBBO predates execution and the report is timely.
            # Midpoint, stale, special-condition and delayed reports stay unknown.
            side = None
            participant = event.get("pt")
            if (eligible(ids) and continuous(ids) and not NON_DIRECTIONAL.intersection(ids)
                    and participant is not None and quote is not None):
                stamp, execution = int(event["t"]), int(participant)
                quote_stamp = int(quote["t"])
                if (0 <= stamp - execution <= TRADE_LAG_MS
                        and 0 <= execution - quote_stamp <= QUOTE_AGE_MS):
                    bid, ask = float(quote["bp"]), float(quote["ap"])
                    midpoint = (bid + ask) / 2
                    if bid > 0 and ask > bid:
                        if price > midpoint + 1e-7:
                            side = "buy"
                        elif price < midpoint - 1e-7:
                            side = "sell"
            if side == "buy":
                self.off_exchange_buy += size
            elif side == "sell":
                self.off_exchange_sell += size
            else:
                self.off_exchange_unknown += size
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
            self.last_price_event_ms = stamp
        if not continuous(ids) or int(event.get("trfi") or 0) or int(event.get("x") or 0) in TRF_IDS:
            return
        self.volume += size
        level = None
        if self.price_levels is not None:
            level = self.price_levels.setdefault(round(price * 100), [0, 0, 0])
            level[0] += size
        if quote is None or not 0 <= stamp - int(quote["t"]) <= QUOTE_AGE_MS or NON_DIRECTIONAL.intersection(ids):
            return
        bid, ask = float(quote["bp"]), float(quote["ap"])
        midpoint = (bid + ask) / 2
        if price >= ask - 1e-7 or price > midpoint + 1e-7:
            self.buy += size
            self.buy_notional += size * price
            if level is not None:
                level[1] += size
        elif price <= bid + 1e-7 or price < midpoint - 1e-7:
            self.sell += size
            self.sell_notional += size * price
            if level is not None:
                level[2] += size

    def result(self):
        classified = self.buy + self.sell
        last = self.last_quote
        age = self.start_ms + self.duration_ms - int(last["t"]) if last else None
        queue = None
        if last and age is not None and age <= QUOTE_AGE_MS:
            bs, az = float(last["bs"]), float(last["as"])
            if bs + az:
                queue = (bs - az) / (bs + az)
        result = {
            "t": datetime.fromtimestamp(self.start_ms / 1000, CT).strftime(
                "%H:%M:%S" if self.duration_ms == 30_000 else "%H:%M"),
            "stampMs": self.start_ms,
            "o": self.o, "h": self.h, "l": self.l, "c": self.c,
            "litShares": round(self.volume), "buy": round(self.buy), "sell": round(self.sell),
            "offExchangePrints": self.off_exchange_prints,
            "offExchangeShares": round(self.off_exchange_shares),
            "offExchangeEstimatedBuy": round(self.off_exchange_buy),
            "offExchangeEstimatedSell": round(self.off_exchange_sell),
            "offExchangeUnknown": round(self.off_exchange_unknown),
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
        if self.price_levels is not None:
            result["priceLevels"] = [[cents, round(total), round(buy), round(sell)]
                                     for cents, (total, buy, sell) in sorted(self.price_levels.items())]
        return result


class TapeState:
    def __init__(self, active_symbols: tuple[str, ...] | None = None,
                 session_close_ct: str = REGULAR_CLOSE_CT,
                 observational_research: bool = False, diagnostics=None):
        self.lock = threading.Lock()
        self.updated = threading.Condition(self.lock)
        self.version = {symbol: 0 for symbol in SYMBOLS}
        self.tick_version = {symbol: 0 for symbol in SYMBOLS}
        self.live_tick = {symbol: None for symbol in SYMBOLS}
        self.last_tick_notify_at = {symbol: 0.0 for symbol in SYMBOLS}
        self.run_id = secrets.token_hex(8)
        self.active_symbols = tuple(active_symbols if active_symbols is not None else SYMBOLS)
        self.feed = "waiting"
        self.message = "Waiting for Massive trades and quotes"
        self.connected_at = None
        self.last_received_at = None
        self.latest_event_ms = None
        self.last_processed_ms = None
        self.date = datetime.now(CT).strftime("%Y-%m-%d")
        self.session_close_ct = session_close_ct
        self.open_minutes = {symbol: {} for symbol in SYMBOLS}
        self.closed = {symbol: deque(maxlen=BAR_HISTORY_LIMIT) for symbol in SYMBOLS}
        self.open_halves = {symbol: {} for symbol in SYMBOLS}
        self.closed_halves = {symbol: deque(maxlen=BAR_HISTORY_LIMIT * 2) for symbol in SYMBOLS}
        self.off_exchange = {symbol: deque(maxlen=BAR_HISTORY_LIMIT) for symbol in SYMBOLS}
        self.latest_quote = {symbol: None for symbol in SYMBOLS}
        self.heap = []
        self.serial = 0
        self.gaps = 0
        self.feed_interruptions = 0
        self.awaiting_first_event = True
        self.drop_through_minute = None
        self.drop_through_symbol = {symbol: None for symbol in SYMBOLS}
        self.recovered_bars = 0
        self.recovery_warnings = 0
        self.refill_status = "not_needed"
        self.refill_through_ms = None
        self.refill_symbols = set()
        self.gap_start_ms = None
        self.refill_message = None
        self.observational_research = observational_research
        self.research_engines = None
        self.research_completed_sec = None
        self.diagnostics = diagnostics
        self.diagnostic_event_times = {} if diagnostics is not None else None
        self.diagnostic_published_sec = {symbol: None for symbol in SYMBOLS}
        # L5.3 candidate only. The default collector never enables the
        # checkpoint path or early HTTP listener.
        self.checkpoint_recovery = False
        self.checkpoint_manager = None
        self.startup_phase = "process_started"
        self.startup_recovery_method = None
        self.startup_error = None
        self.checkpoint_rejection = None
        self.startup_recovered_at = None
        self.startup_closed_stamps = {}
        if observational_research:
            research_path = PAGE / "research/live_observational_v1"
            sys.path.insert(0, str(research_path))
            from engine import ObservationalEngine
            self.research_engines = {symbol: ObservationalEngine(symbol) for symbol in SYMBOLS}

    def set_feed(self, feed: str, message: str):
        with self.updated:
            previous = self.feed
            self.feed, self.message = feed, message
            if self.diagnostics is not None and feed != previous:
                self.diagnostics.record("feed", from_status=previous, to_status=feed,
                                        wall_ns=time.time_ns(), mono_ns=time.monotonic_ns())
                if feed in ("reconnecting", "error", "stale"):
                    self.diagnostics.increment("feed_interruptions")
            if feed == "connected":
                self.connected_at = time.time()
            self.updated.notify_all()

    def health(self) -> dict:
        """Readiness is distinct from a bound port or an old candle."""
        with self.lock:
            phase = self.startup_phase
            feed = self.feed
            age = time.time() - self.last_received_at if self.last_received_at else None
            completed = [symbol for symbol in self.active_symbols
                         if self.closed[symbol] and self.closed[symbol][-1]["stampMs"] >
                         self.startup_closed_stamps.get(symbol, -1)]
            recovered_at = self.startup_recovered_at
            method = self.startup_recovery_method
            error = self.startup_error
            rejection = self.checkpoint_rejection
            manager = self.checkpoint_manager
            enabled = self.checkpoint_recovery
        if phase == "market_data_connection_pending" and feed == "connected":
            phase = ("connected_healthy" if age is not None and age <= 5 and completed
                     else "connected_warming")
        return {"phase": phase, "http_serving": phase not in ("process_started",),
                "journal_recovered": recovered_at is not None,
                "websocket_connected": feed == "connected",
                "feed_received_age_seconds": round(age, 3) if age is not None else None,
                "completed_symbols_since_recovery": completed,
                "recovery_method": method, "recovery_error": error,
                "checkpoint_rejection": rejection,
                "optional_research_enabled": self.observational_research,
                "optional_research_certified": False,
                "checkpoint_candidate_enabled": enabled,
                "checkpoint": manager.status() if manager is not None else None}

    def set_refill(self, status: str, message: str | None = None):
        with self.updated:
            self.refill_status, self.refill_message = status, message
            self.updated.notify_all()

    def merge_refill(self, bundle: dict):
        """Replace the verified historical prefix; keep newer WebSocket candles."""
        if bundle["date"] != self.date:
            raise ValueError("Refill date differs from live session")
        end_ms = bundle["endMs"]
        with self.updated:
            for symbol in bundle["symbols"]:
                if symbol not in self.active_symbols:
                    continue
                data = bundle["data"][symbol]
                live_minutes = {row["stampMs"]: row for row in self.closed[symbol]}
                live_halves = {row["stampMs"]: row for row in self.closed_halves[symbol]}
                live_off = {row["stampMs"]: row for row in self.off_exchange[symbol]}
                rest_minutes = {row["stampMs"]: row for row in data["bars"]["1m"]}
                rest_halves = {row["stampMs"]: row for row in data["bars"]["30s"]}
                rest_off = {row["stampMs"]: row for row in data["offExchange"]}

                def paired(minute, halves):
                    if minute is None:
                        return False
                    first = halves.get(minute["stampMs"])
                    second = halves.get(minute["stampMs"] + 30_000)
                    if first is None or second is None:
                        return False
                    for field in ("buy", "sell", "litShares", "quoteUpdates"):
                        if field in minute and field in first and field in second and \
                                first[field] + second[field] != minute[field]:
                            return False
                    return second.get("c") == minute.get("c")

                minutes, halves, off = {}, {}, {}
                for stamp in sorted(live_minutes.keys() | rest_minutes.keys()):
                    live = live_minutes.get(stamp)
                    rest = rest_minutes.get(stamp)
                    live_pair = paired(live, live_halves)
                    rest_pair = paired(rest, rest_halves)
                    # Keep an already-published WebSocket candle and its own
                    # half-minutes together. If its pair is incomplete or
                    # inconsistent, take the verified REST trio as a unit.
                    use_rest = rest is not None and (live is None or
                        (rest_pair and not live_pair))
                    source_minutes = rest_minutes if use_rest else live_minutes
                    source_halves = rest_halves if use_rest else live_halves
                    source_off = rest_off if use_rest else live_off
                    minute = source_minutes.get(stamp)
                    if minute is None:
                        continue
                    minutes[stamp] = minute
                    incompatible_live_pair = (not use_rest and live is not None and
                        stamp in live_halves and stamp + 30_000 in live_halves and
                        not live_pair)
                    for half_stamp in (stamp, stamp + 30_000):
                        half = None if incompatible_live_pair else source_halves.get(half_stamp)
                        if half is not None:
                            halves[half_stamp] = half
                    if stamp in source_off:
                        off[stamp] = source_off[stamp]
                for stamp in live_off.keys() | rest_off.keys():
                    if stamp not in minutes:
                        off[stamp] = live_off.get(stamp) or rest_off.get(stamp)
                self.closed[symbol] = deque(
                    (minutes[stamp] for stamp in sorted(minutes)), maxlen=BAR_HISTORY_LIMIT)
                self.closed_halves[symbol] = deque(
                    (halves[stamp] for stamp in sorted(halves)), maxlen=BAR_HISTORY_LIMIT * 2)
                self.off_exchange[symbol] = deque(
                    (off[stamp] for stamp in sorted(off)), maxlen=BAR_HISTORY_LIMIT)
                self.version[symbol] += 1
            self.run_id = secrets.token_hex(8)  # Force clients to reload the prepended bars.
            self.refill_through_ms = end_ms
            session_start = int(datetime.fromisoformat(f"{self.date}T{SESSION_START_CT}:00").replace(
                tzinfo=CT).timestamp()*1000)
            if bundle["startMs"] == session_start:
                self.refill_symbols.update(bundle["symbols"])
            if self.gap_start_ms is not None and bundle["startMs"] <= self.gap_start_ms < end_ms:
                self.gap_start_ms = None
            self.refill_status = "complete"
            self.refill_message = f"REST tape verified through {ct_clock(end_ms - 60_000)} CT"
            self.updated.notify_all()

    def watchlist(self) -> list[str]:
        with self.lock:
            return list(self.active_symbols)

    def set_watchlist(self, symbols: tuple[str, ...]):
        with self.updated:
            removed = set(self.active_symbols) - set(symbols)
            added = set(symbols) - set(self.active_symbols)
            self.active_symbols = symbols
            for symbol in removed | added:
                self.open_minutes[symbol].clear()
                self.closed[symbol].clear()
                self.open_halves[symbol].clear()
                self.closed_halves[symbol].clear()
                self.off_exchange[symbol].clear()
                self.latest_quote[symbol] = None
                self.live_tick[symbol] = None
                self.tick_version[symbol] += 1
                self.version[symbol] += 1
                self.drop_through_symbol[symbol] = (int(time.time() * 1000) // 60_000) * 60_000 if symbol in added else None
            if removed:
                self.heap = [item for item in self.heap if item[2]["sym"] not in removed]
                heapq.heapify(self.heap)
            self.updated.notify_all()

    def ingest(self, events: list[dict], timing: dict | None = None):
        with self.updated:
            for event in events:
                if event.get("ev") not in ("T", "Q") or event.get("sym") not in self.active_symbols or not isinstance(event.get("t"), int):
                    if self.diagnostics is not None and timing is not None:
                        self.diagnostics.increment("invalid_dropped")
                    continue
                stamp = int(event["t"])
                day = ct_date(stamp)
                if day != self.date:
                    self.date = day
                    for symbol in SYMBOLS:
                        self.version[symbol] += 1
                    self.updated.notify_all()
                    self.open_minutes = {symbol: {} for symbol in SYMBOLS}
                    self.closed = {symbol: deque(maxlen=BAR_HISTORY_LIMIT) for symbol in SYMBOLS}
                    self.open_halves = {symbol: {} for symbol in SYMBOLS}
                    self.closed_halves = {symbol: deque(maxlen=BAR_HISTORY_LIMIT * 2) for symbol in SYMBOLS}
                    self.off_exchange = {symbol: deque(maxlen=BAR_HISTORY_LIMIT) for symbol in SYMBOLS}
                    self.latest_quote = {symbol: None for symbol in SYMBOLS}
                    self.live_tick = {symbol: None for symbol in SYMBOLS}
                    self.tick_version = {symbol: self.tick_version[symbol] + 1 for symbol in SYMBOLS}
                    self.drop_through_symbol = {symbol: None for symbol in SYMBOLS}
                    self.heap.clear()
                    self.last_processed_ms = None
                    self.awaiting_first_event = True
                    if self.research_engines is not None:
                        from engine import ObservationalEngine
                        self.research_engines = {name: ObservationalEngine(name) for name in SYMBOLS}
                        self.research_completed_sec = None
                    if self.diagnostic_event_times is not None:
                        self.diagnostic_event_times.clear()
                        self.diagnostic_published_sec = {name: None for name in SYMBOLS}
                if self.awaiting_first_event:
                    # Starting midway through a minute cannot yield a complete bar.
                    self.drop_through_minute = stamp // 60_000 * 60_000
                    self.awaiting_first_event = False
                if self.last_processed_ms is not None and stamp < self.last_processed_ms:
                    self.gaps += 1
                    if self.diagnostics is not None and timing is not None:
                        self.diagnostics.increment("late_dropped")
                        self.diagnostics.record("late_drop", symbol=event["sym"], event_ms=stamp,
                                                batch_id=timing["batch_id"],
                                                receipt_mono_ns=timing["receipt_mono_ns"])
                    if self.research_engines is not None:
                        self.research_engines[event["sym"]].invalidate("collector_late_drop")
                    continue
                self.serial += 1
                heapq.heappush(self.heap, (stamp, self.serial, event))
                if self.diagnostic_event_times is not None and timing is not None:
                    self.diagnostic_event_times[self.serial] = timing
                    self.diagnostics.increment("enqueued")
                self.latest_event_ms = max(stamp, self.latest_event_ms or stamp)
            self.last_received_at = time.time()
            self._flush()
            if self.diagnostics is not None and timing is not None:
                self._publish_diagnostic_windows(timing["batch_id"])

    def _flush(self):
        cutoff = (self.latest_event_ms or 0) - REORDER_MS
        changed = set()
        changed_ticks = set()
        latest_tick_minutes = {}
        while self.heap and self.heap[0][0] <= cutoff:
            stamp, serial, event = heapq.heappop(self.heap)
            event_timing = (self.diagnostic_event_times.pop(serial, None)
                            if self.diagnostic_event_times is not None else None)
            released_mono_ns = time.monotonic_ns() if event_timing is not None else None
            self.last_processed_ms = stamp
            symbol = event["sym"]
            if self.research_engines is not None:
                try:
                    self.research_engines[symbol].process(event, receipt_ns=time.time_ns(),
                                                          receipt_mono_ns=time.monotonic_ns())
                except Exception as error:
                    # Research is isolated: never interrupt the journal or the
                    # existing candle path when the optional engine fails.
                    self.research_engines[symbol].invalidate("research_exception")
                    self.research_engines[symbol].diagnostics["exception_" + type(error).__name__] += 1
            key = stamp // 60_000 * 60_000
            minute = self.open_minutes[symbol].setdefault(key, Minute(stamp))
            half_key = stamp // 30_000 * 30_000
            half = self.open_halves[symbol].setdefault(half_key, Minute(stamp, 30_000))
            if event["ev"] == "Q":
                prior = self.latest_quote[symbol]
                if minute.quote(event, prior):
                    half.quote(event, prior)
                    self.latest_quote[symbol] = event
            else:
                previous_price_event_ms = minute.last_price_event_ms
                previous_price = minute.c
                minute.trade(event, self.latest_quote[symbol])
                half.trade(event, self.latest_quote[symbol])
                if (minute.last_price_event_ms != previous_price_event_ms or
                        minute.c != previous_price):
                    changed_ticks.add(symbol)
                    latest_tick_minutes[symbol] = minute
            if event_timing is not None:
                processed_mono_ns = time.monotonic_ns()
                self.diagnostics.increment("processed")
                if serial % 128 == 0 or serial == event_timing.get("first_serial"):
                    self.diagnostics.latency(event_timing["receipt_mono_ns"], processed_mono_ns)
                    self.diagnostics.stage_latency("recv_to_journal",
                        event_timing["receipt_mono_ns"], event_timing["journal_mono_ns"])
                    self.diagnostics.stage_latency("journal_to_release",
                        event_timing["journal_mono_ns"], released_mono_ns)
                    self.diagnostics.stage_latency("release_to_process",
                        released_mono_ns, processed_mono_ns)
                    self.diagnostics.record(
                        "event_timing", symbol=symbol, event_type=event["ev"], event_ms=stamp,
                        serial=serial, batch_id=event_timing["batch_id"],
                        receipt_wall_ns=event_timing["receipt_wall_ns"],
                        receipt_mono_ns=event_timing["receipt_mono_ns"],
                        journal_wall_ns=event_timing["journal_wall_ns"],
                        journal_mono_ns=event_timing["journal_mono_ns"],
                        reorder_release_mono_ns=released_mono_ns,
                        processed_mono_ns=processed_mono_ns)
        for symbol in self.active_symbols:
            ready_halves = [key for key in self.open_halves[symbol] if key + 30_000 <= cutoff]
            for key in sorted(ready_halves):
                half = self.open_halves[symbol].pop(key).result()
                drop = max(self.drop_through_minute or -1, self.drop_through_symbol[symbol] or -1)
                if half["c"] is not None and key > drop:
                    self.closed_halves[symbol].append(half)
                    changed.add(symbol)
            ready = [key for key in self.open_minutes[symbol] if key + 60_000 <= cutoff]
            for key in sorted(ready):
                minute = self.open_minutes[symbol].pop(key).result()
                drop = max(self.drop_through_minute or -1, self.drop_through_symbol[symbol] or -1)
                if key > drop:
                    self.off_exchange[symbol].append({
                        "t": minute["t"], "stampMs": key,
                        "prints": minute["offExchangePrints"],
                        "shares": minute["offExchangeShares"],
                        "estimatedBuy": minute["offExchangeEstimatedBuy"],
                        "estimatedSell": minute["offExchangeEstimatedSell"],
                        "unknown": minute["offExchangeUnknown"],
                    })
                # A quote-only interval has useful feed activity but no candle.
                # Keep it out of the price chart rather than drawing a zero.
                if minute["c"] is not None and key > drop:
                    self.closed[symbol].append(minute)
                    changed.add(symbol)
                    if self.research_engines is not None and minute["t"] == "08:34":
                        recent = [bar for bar in self.closed[symbol]
                                  if "08:30" <= bar["t"] <= "08:34"]
                        if len(recent) == 5 and [bar["t"] for bar in recent] == [
                                "08:30", "08:31", "08:32", "08:33", "08:34"]:
                            from engine import KnownLevel
                            available_ns = max((key + 60_000) * 1_000_000, time.time_ns())
                            for name, price, direction in (
                                    ("ORB high", max(bar["h"] for bar in recent), 1),
                                    ("ORB low", min(bar["l"] for bar in recent), -1)):
                                self.research_engines[symbol].levels.add(KnownLevel(
                                    name, price, direction, available_ns,
                                    "completed local WebSocket 1m OHLC",
                                    "replay_or_official_ORB_may_differ"))
                                if self.diagnostics is not None:
                                    self.diagnostics.record("level_ref", symbol=symbol, name=name,
                                        price=price, direction=direction, available_ns=available_ns,
                                        source="completed local WebSocket 1m OHLC",
                                        quality="replay_or_official_ORB_may_differ",
                                        processed=self.diagnostics.status()["counts"].get("processed", 0))
        for symbol in changed:
            self.version[symbol] += 1
        now = time.monotonic()
        for symbol in changed_ticks:
            minute = latest_tick_minutes[symbol]
            self.live_tick[symbol] = {
                "stampMs": minute.start_ms, "eventMs": minute.last_price_event_ms,
                "o": minute.o, "h": minute.h, "l": minute.l, "c": minute.c,
            }
            self.tick_version[symbol] += 1
            if now - self.last_tick_notify_at[symbol] >= 0.75:
                self.last_tick_notify_at[symbol] = now
                changed.add(symbol)
        if changed:
            self.updated.notify_all()
        if self.research_engines is not None:
            self.research_completed_sec = cutoff // 1000

    def _publish_diagnostic_windows(self, batch_id: int):
        """Sample finalized windows every ten seconds without rescanning source tape."""
        if self.research_engines is None or self.research_completed_sec is None:
            return
        for symbol in self.active_symbols:
            engine = self.research_engines[symbol]
            if engine.last_ns is None:
                continue
            end_sec = min(self.research_completed_sec, engine.last_ns // 1_000_000_000 + 1)
            sample_sec = end_sec - end_sec % 10
            last = self.diagnostic_published_sec[symbol]
            if sample_sec <= 0 or (last is not None and sample_sec <= last):
                continue
            try:
                ready_mono_ns = time.monotonic_ns()
                observation = engine.snapshot(sample_sec, feed_status=self.feed,
                                              now_ns=time.time_ns(), now_mono_ns=ready_mono_ns)
            except (ValueError, KeyError, IndexError) as error:
                self.diagnostics.increment("publication_errors")
                self.diagnostics.record("publication_error", symbol=symbol,
                                        batch_id=batch_id, reason=type(error).__name__)
                continue
            self.diagnostic_published_sec[symbol] = sample_sec
            self.diagnostics.increment("published_windows")
            if "STALE_FEED" in observation.get("quality", ()):
                self.diagnostics.increment("stale_observation_samples")
            self.diagnostics.stage_latency("process_to_publication",
                engine.last_receipt_mono_ns, ready_mono_ns)
            self.diagnostics.record("observation", batch_id=batch_id, symbol=symbol,
                                    end_sec=sample_sec, feature_ready_mono_ns=ready_mono_ns,
                                    feature_ingest_mono_ns=engine.last_receipt_mono_ns,
                                    observation=observation)

    def diagnostic_backlog(self):
        with self.lock:
            oldest = self.heap[0] if self.heap else None
            timing = (self.diagnostic_event_times.get(oldest[1])
                      if oldest and self.diagnostic_event_times is not None else None)
            oldest_ms = ((time.monotonic_ns() - timing["receipt_mono_ns"]) / 1e6
                         if timing else None)
            lag_ms = (self.latest_event_ms - self.last_processed_ms
                      if self.latest_event_ms is not None and self.last_processed_ms is not None
                      else None)
            return len(self.heap), oldest_ms, lag_ms

    def research_snapshot(self, symbol: str) -> dict:
        if self.research_engines is None:
            return {"available": False, "reason": "disabled_by_default"}
        with self.lock:
            engine = self.research_engines[symbol]
            if self.research_completed_sec is None or engine.last_ns is None:
                return {"available": False, "reason": "no_completed_research_second"}
            from engine import NS
            end_sec = min(self.research_completed_sec, engine.last_ns // NS + 1)
            ready_mono_ns = time.monotonic_ns()
            result = engine.snapshot(end_sec, feed_status=self.feed,
                                     now_ns=time.time_ns(), now_mono_ns=ready_mono_ns)
            result["available"] = True
            if self.diagnostics is not None:
                result["timing"] = {"sample_id": secrets.token_hex(8),
                                    "feature_ready_mono_ns": ready_mono_ns,
                                    "feature_ready_wall_ns": result["feature_ready_ns"],
                                    "server_response_mono_ns": time.monotonic_ns(),
                                    "server_response_wall_ns": time.time_ns()}
                self.diagnostics.browser_response(symbol, end_sec, result["timing"],
                                                  engine.last_receipt_mono_ns)
            return result

    def register_research_premarket(self, symbol: str, report: dict):
        """Reuse an already-requested complete REST reference; never poll here."""
        if self.research_engines is None or report.get("sessionDate") != self.date:
            return
        premarket = report.get("premarket") or {}
        if (not premarket.get("available") or not premarket.get("complete") or
                int(premarket.get("barCount") or 0) < 300):
            return
        with self.lock:
            from engine import KnownLevel
            tracker = self.research_engines[symbol].levels
            quality = ("aggregate_326_minutes" if premarket.get("barCount") == 326
                       else f"aggregate_partial_{premarket.get('barCount', 'unknown')}_minutes")
            for name, field, direction in (("PM high", "high", 1), ("PM low", "low", -1)):
                if name not in tracker.levels:
                    available_ns = time.time_ns()
                    tracker.add(KnownLevel(name, float(premarket[field]), direction,
                                           available_ns, "Massive completed 03:00–08:25 1m REST aggregates",
                                           quality))
                    if self.diagnostics is not None:
                        self.diagnostics.record("level_ref", symbol=symbol, name=name,
                            price=float(premarket[field]), direction=direction,
                            available_ns=available_ns,
                            source="Massive completed 03:00–08:25 1m REST aggregates",
                            quality=quality, bar_count=int(premarket["barCount"]),
                            processed=self.diagnostics.status()["counts"].get("processed", 0))

    def mark_gap(self):
        with self.updated:
            if self.diagnostics is not None:
                self.diagnostics.increment("feed_gaps")
                self.diagnostics.record("gap", wall_ns=time.time_ns(),
                                        mono_ns=time.monotonic_ns())
            if self.research_engines is not None:
                for engine in self.research_engines.values():
                    engine.invalidate("collector_feed_gap")
            if self.last_processed_ms is not None:
                overlap = self.last_processed_ms // 60_000 * 60_000
                self.gap_start_ms = min(self.gap_start_ms, overlap) if self.gap_start_ms else overlap
            self.gaps += 1
            self.feed_interruptions += 1
            self.heap.clear()
            self.open_minutes = {symbol: {} for symbol in SYMBOLS}
            self.open_halves = {symbol: {} for symbol in SYMBOLS}
            self.latest_quote = {symbol: None for symbol in SYMBOLS}
            self.live_tick = {symbol: None for symbol in SYMBOLS}
            for symbol in SYMBOLS:
                self.tick_version[symbol] += 1
            self.last_processed_ms = None
            self.awaiting_first_event = True
            self.updated.notify_all()

    def prepare_resume(self):
        """Keep completed bars, but never join a partial bar across a restart."""
        with self.updated:
            if self.last_processed_ms is not None:
                overlap = self.last_processed_ms // 60_000 * 60_000
                self.gap_start_ms = min(self.gap_start_ms, overlap) if self.gap_start_ms else overlap
            self.heap.clear()
            self.open_minutes = {symbol: {} for symbol in SYMBOLS}
            self.open_halves = {symbol: {} for symbol in SYMBOLS}
            self.latest_quote = {symbol: None for symbol in SYMBOLS}
            self.live_tick = {symbol: None for symbol in SYMBOLS}
            for symbol in SYMBOLS:
                self.tick_version[symbol] += 1
            self.last_processed_ms = None
            self.latest_event_ms = None
            self.last_received_at = None
            self.awaiting_first_event = True
            self.drop_through_minute = None
            self.recovered_bars = sum(len(bars) for bars in self.closed.values())
            self.updated.notify_all()

    def update_signal(self, symbol: str) -> dict:
        """Small feed notification; completed bars remain on the snapshot endpoints."""
        with self.lock:
            age = round(time.time() - self.last_received_at, 1) if self.last_received_at else None
            lag = round(time.time() - self.latest_event_ms / 1000, 1) if self.latest_event_ms else None
            return {"version": self.version[symbol], "tickVersion": self.tick_version[symbol],
                    "tick": self.live_tick[symbol], "runId": self.run_id, "date": self.date,
                    "versions": {name: self.version[name] for name in self.active_symbols},
                    "active": symbol in self.active_symbols,
                    "watchlist": list(self.active_symbols),
                    "status": "stale" if self.feed == "connected" and age is not None and age > 15 else self.feed,
                    "message": self.message, "receivedAgeSeconds": age, "eventLagSeconds": lag,
                    "refillStatus": self.refill_status, "refillThroughMs": self.refill_through_ms,
                    "feedGapsOrOutOfOrderDrops": self.gaps}

    def half_snapshot(self, symbol: str | None = None, *, after_ms: int | None = None,
                      client_run_id: str | None = None, client_date: str | None = None):
        with self.lock:
            selected = (symbol,) if symbol is not None else self.active_symbols
            incremental = (symbol is not None and after_ms is not None and
                           client_run_id == self.run_id and client_date == self.date)
            return {"date": self.date, "runId": self.run_id, "incremental": incremental,
                    "bars": {symbol: [{k: v for k, v in bar.items() if k != "priceLevels"}
                                      for bar in self.closed_halves[symbol]
                                      if not incremental or bar["stampMs"] > after_ms]
                                                for symbol in selected},
                    "lastCompleted": {symbol: self.closed_halves[symbol][-1]["t"]
                                      if self.closed_halves[symbol] else None for symbol in selected}}

    def footprint(self, stamp_ms: int, duration_ms: int) -> dict | None:
        if duration_ms not in (30_000, 60_000, 120_000, 300_000, 900_000):
            return None
        with self.lock:
            halves = [bar for bar in self.closed_halves[SYMBOLS[0]]
                      if stamp_ms <= bar["stampMs"] < stamp_ms + duration_ms]
            if len(halves) != duration_ms // 30_000 or any(
                    bar["stampMs"] != stamp_ms + i * 30_000 for i, bar in enumerate(halves)):
                return None
            levels = {}
            for bar in halves:
                for cents, total, buy, sell in bar.get("priceLevels", []):
                    values = levels.setdefault(cents, [0, 0, 0])
                    values[0] += total
                    values[1] += buy
                    values[2] += sell
            return {"date": self.date, "stampMs": stamp_ms, "durationMs": duration_ms,
                    "source": "completed local Massive WebSocket buckets",
                    "levels": [[cents, *values] for cents, values in sorted(levels.items())]}

    def zone_buckets(self, symbol: str, start_ms: int, end_ms: int) -> dict | None:
        """Bounded completed execution buckets; no raw-file scan or active candle."""
        if (symbol not in self.active_symbols or start_ms % 30_000 or end_ms % 30_000 or
                end_ms <= start_ms or end_ms - start_ms > 120 * 60_000):
            return None
        with self.lock:
            rows = [row for row in self.closed_halves[symbol]
                    if start_ms <= row["stampMs"] < end_ms]
            # Missing completed half-minutes remain gaps in the shared client
            # calculation. Return recorded buckets only; never synthesize zeros.
            if not rows or any("priceLevels" not in row for row in rows):
                return None
            return {"date": self.date, "symbol": symbol, "startMs": start_ms,
                    "endMs": end_ms, "runId": self.run_id,
                    "sourceVersion": self.version[symbol],
                    "source": "completed local Massive WebSocket buckets",
                    "bars": rows}

    def snapshot(self, symbol: str | None = None, *, after_ms: int | None = None,
                 client_run_id: str | None = None, client_date: str | None = None):
        with self.lock:
            selected = (symbol,) if symbol is not None else self.active_symbols
            incremental = (symbol is not None and after_ms is not None and
                           client_run_id == self.run_id and client_date == self.date)
            age = round(time.time() - self.last_received_at, 1) if self.last_received_at else None
            event_lag = round(time.time() - self.latest_event_ms / 1000, 1) if self.latest_event_ms else None
            status = self.feed
            if status == "connected" and age is not None and age > 15:
                status = "stale"
            return {
                "mode": "live", "date": self.date, "version": self.version[symbol] if symbol else None,
                "referenceEndCt": self.session_close_ct,
                "sessionWindow": {"startCt": SESSION_START_CT, "openCt": REGULAR_OPEN_CT,
                                  "endCt": self.session_close_ct,
                                  "archiveEndCt": ARCHIVE_END_CT},
                "runId": self.run_id,
                "incremental": incremental,
                "status": status, "message": self.message,
                "receivedAgeSeconds": age, "eventLagSeconds": event_lag,
                "refillStatus": self.refill_status, "refillThroughMs": self.refill_through_ms,
                "refillMessage": self.refill_message,
                "reorderWindowSeconds": REORDER_MS / 1000, "feedGapsOrOutOfOrderDrops": self.gaps,
                "recoveredBars": self.recovered_bars, "recoveryWarnings": self.recovery_warnings,
                "lastCompleted": {symbol: self.closed[symbol][-1]["t"] if self.closed[symbol] else None for symbol in selected},
                "bars": {symbol: [bar for bar in self.closed[symbol]
                                  if not incremental or bar["stampMs"] > after_ms] for symbol in selected},
                "offExchange": {symbol: [bar for bar in self.off_exchange[symbol]
                                         if not incremental or bar["stampMs"] > after_ms] for symbol in selected},
                "updatedAt": datetime.now(CT).isoformat(),
            }


def raw_path(log_dir: Path, day: str) -> Path:
    return log_dir / f"{day}.ndjson"


def validate_watchlist(symbols) -> tuple[str, ...]:
    if (not isinstance(symbols, list) or not symbols or len(symbols) > len(SYMBOLS) or
            any(not isinstance(symbol, str) or symbol not in SYMBOLS for symbol in symbols) or
            len(set(symbols)) != len(symbols)):
        raise ValueError("Watchlist must contain distinct supported symbols: " + ", ".join(SYMBOLS))
    return tuple(symbols)


def load_watchlist(log_dir: Path, default: tuple[str, ...]) -> tuple[str, ...]:
    path = log_dir / "watchlist.json"
    if not path.exists():
        return default
    return validate_watchlist(json.loads(path.read_text())["symbols"])


def persist_watchlist(log_dir: Path, symbols: tuple[str, ...]):
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / "watchlist.json"
    temporary = path.with_suffix(".partial")
    temporary.write_text(json.dumps({"symbols": symbols}, separators=(",", ":")))
    temporary.replace(path)


def append_raw(log_dir: Path, day: str, rows: list[dict], *, durable: bool = False):
    """Append full source events or a recovery boundary to the daily journal."""
    log_dir.mkdir(parents=True, exist_ok=True)
    path = raw_path(log_dir, day)
    # A killed writer may leave a truncated final JSON record. Keep the next
    # record on its own line so recovery can flag the bad one and continue.
    needs_newline = False
    if durable and path.exists() and path.stat().st_size:
        with path.open("rb") as previous:
            previous.seek(-1, os.SEEK_END)
            needs_newline = previous.read(1) != b"\n"
    with path.open("a") as handle:
        if needs_newline:
            handle.write("\n")
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
        if durable:
            handle.flush()
            os.fsync(handle.fileno())


def recover_today(state: TapeState, log_dir: Path) -> int:
    """Rebuild completed minutes from the durable raw journal before connecting."""
    day = datetime.now(CT).strftime("%Y-%m-%d")
    return recover_journal_range(state, log_dir, day, 0)


def recover_journal_range(state: TapeState, log_dir: Path, day: str,
                          start_offset: int = 0) -> int:
    """Use the same parser for a whole journal or a validated checkpoint tail."""
    path = raw_path(log_dir, day)
    if not path.is_file():
        if start_offset:
            raise ValueError("Checkpoint tail source is missing")
        return 0
    batch = []
    event_count = 0
    with path.open() as handle:
        if start_offset:
            handle.seek(start_offset)
        for line in handle:
            try:
                row = json.loads(line)
            except (ValueError, TypeError):
                if batch:
                    state.ingest(batch)
                    batch = []
                state.mark_gap()
                state.recovery_warnings += 1
                continue
            if not isinstance(row, dict):
                continue
            if row.get("ev") == "BACKFILL_START":
                if batch:
                    state.ingest(batch)
                    batch = []
                # A verified REST range beginning at the recorded session start contains
                # the full first minute. Ordinary mid-minute WebSocket starts
                # still discard their first incomplete minute.
                if row.get("date") == day and row.get("startCt") in {"06:00", SESSION_START_CT}:
                    state.awaiting_first_event = False
                    state.drop_through_minute = None
                continue
            if row.get("ev") == "GAP":
                if batch:
                    state.ingest(batch)
                    batch = []
                state.mark_gap()
                continue
            if (row.get("ev") not in ("T", "Q") or row.get("sym") not in SYMBOLS
                    or not isinstance(row.get("t"), int) or ct_date(row["t"]) != day):
                continue
            batch.append(row)
            event_count += 1
            if len(batch) >= 1_000:
                state.ingest(batch)
                batch = []
    if batch:
        state.ingest(batch)
    state.prepare_resume()
    return event_count


def verified_refill(path: Path, day: str, symbols: tuple[str, ...]) -> dict:
    """Accept only a complete same-day source bundle with matching raw checksums."""
    bundle = json.loads(path.read_text())
    gap_bundle = path.parent.parent.name.isdigit() and path.parent.name.isdigit()
    path_end = path.parent.parent.name if gap_bundle else path.parent.name
    path_start = int(path.parent.name) if gap_bundle else int(
        datetime.fromisoformat(f"{day}T{SESSION_START_CT}:00").replace(tzinfo=CT).timestamp()*1000)
    if (bundle.get("schema") != 1 or bundle.get("date") != day or
            tuple(bundle.get("symbols", [])) != symbols or
            bundle.get("endMs") != int(path_end) or bundle.get("startMs") != path_start or
            bundle.get("endMs", 0) % 60_000):
        raise ValueError("Refill bundle identity or cutoff mismatch")
    for symbol in symbols:
        data = bundle["data"][symbol]
        for kind in ("trades", "quotes"):
            source = bundle["source"][symbol][kind]
            raw = path.parent / source["file"]
            digest = hashlib.sha256()
            with raw.open("rb") as stream:
                for block in iter(lambda: stream.read(1 << 20), b""):
                    digest.update(block)
            if (raw.stat().st_size != source["bytes"] or
                    digest.hexdigest() != source["sha256"] or
                    data["sourceRows"][kind] != source["rows"]):
                raise ValueError(f"{symbol} {kind}: refill source verification failed")
        for rows, duration in ((data["bars"]["1m"], 60_000),
                               (data["bars"]["30s"], 30_000)):
            stamps = [row["stampMs"] for row in rows]
            if (not stamps or stamps != sorted(set(stamps)) or
                    any(stamp % duration or not bundle["startMs"] <= stamp < bundle["endMs"]
                        for stamp in stamps)):
                raise ValueError(f"{symbol}: invalid refill candle timeline")
        if data["parityChecks"] <= 0:
            raise ValueError(f"{symbol}: no 30-second/minute parity checks")
    return bundle


def recover_latest_refill(state: TapeState, raw_dir: Path) -> int | None:
    """Restore a verified earlier REST prefix before reconnecting to live tape."""
    directory = raw_dir / "refill" / state.date
    now_ms = int(time.time() * 1000) // 60_000 * 60_000
    candidates = sorted(directory.glob("*/bundle.json") if directory.is_dir() else [],
                        key=lambda path: int(path.parent.name) if path.parent.name.isdigit() else 0,
                        reverse=True)
    restored = None
    restored_symbols: set[str] = set()
    for path in candidates:
        if not path.parent.name.isdigit() or int(path.parent.name) > now_ms:
            continue
        try:
            # A saved prefix can cover the original watchlist even when new
            # symbols join later. Verify and restore that subset; otherwise a
            # restart would refetch every symbol during active trading.
            stored_symbols = tuple(json.loads(path.read_text()).get("symbols", []))
            if not stored_symbols or not set(stored_symbols).issubset(state.active_symbols):
                continue
            new_symbols = tuple(symbol for symbol in stored_symbols
                                if symbol not in restored_symbols)
            if not new_symbols:
                continue
            bundle = verified_refill(path, state.date, stored_symbols)
            if len(new_symbols) != len(stored_symbols):
                bundle = {**bundle, "symbols": new_symbols,
                          "data": {symbol: bundle["data"][symbol]
                                   for symbol in new_symbols}}
            state.merge_refill(bundle)
            restored_symbols.update(new_symbols)
            restored = max(restored or 0, bundle["endMs"])
            if restored_symbols == set(state.active_symbols):
                break
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            state.recovery_warnings += 1
    gap_directory = raw_dir / "refill-gaps" / state.date
    gaps = sorted(gap_directory.glob("*/*/bundle.json") if gap_directory.is_dir() else [],
                  key=lambda path: int(path.parent.parent.name)
                  if path.parent.parent.name.isdigit() else 0)
    prefix_end = restored
    for path in gaps:
        if (not path.parent.parent.name.isdigit() or not path.parent.name.isdigit() or
                int(path.parent.parent.name) > now_ms or
                prefix_end is not None and int(path.parent.parent.name) <= prefix_end):
            continue
        try:
            stored_symbols = tuple(json.loads(path.read_text()).get("symbols", []))
            if not stored_symbols or not set(stored_symbols).issubset(state.active_symbols):
                continue
            bundle = verified_refill(path, state.date, stored_symbols)
            state.merge_refill(bundle)
            restored = max(restored or 0, bundle["endMs"])
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            state.recovery_warnings += 1
    return restored


def refill_monitor(state: TapeState, raw_dir: Path, close_at: datetime):
    """Recover startup or sleep gaps without blocking the WebSocket or HTTP UI."""
    day = state.date
    start_ms = int(datetime.fromisoformat(f"{day}T{SESSION_START_CT}:00").replace(tzinfo=CT).timestamp() * 1000)
    covered_interruptions = state.feed_interruptions - (1 if state.gap_start_ms is not None else 0)
    covered_symbols = state.watchlist()
    retry_at = 0.0
    while datetime.now(CT) < close_at:
        with state.lock:
            connected = state.feed == "connected"
            symbols = state.active_symbols
            interruptions = state.feed_interruptions
            gap_start = state.gap_start_ms
            past_open = datetime.now(CT).strftime("%H:%M") >= REGULAR_OPEN_CT
            missing_prefix = [symbol for symbol in symbols
                              if symbol not in state.refill_symbols and
                              (((bars := state.closed[symbol]) and bars[0]["stampMs"] > start_ms + 60_000)
                               or (not bars and past_open))]
            needs_prefix = bool(missing_prefix)
            watchlist_changed = symbols != covered_symbols
            needs_refill = needs_prefix or interruptions > covered_interruptions
        if watchlist_changed:
            covered_symbols = symbols
            if not needs_refill:
                state.set_refill("deferred", "New symbols are live; earlier candles await a later REST refill")
        now = time.time()
        if connected and needs_refill and now >= retry_at:
            prefix_repair = needs_prefix
            symbols_to_refill = tuple(missing_prefix) if prefix_repair else symbols
            selected_start = start_ms if prefix_repair else gap_start
            if selected_start is None:
                with state.lock:
                    latest = [bars[-1]["stampMs"] for symbol in symbols
                              if (bars := state.closed[symbol])]
                selected_start = min(latest) if latest else start_ms
            end_ms = int(now * 1000) // 60_000 * 60_000
            if prefix_repair and all(state.closed[symbol] for symbol in symbols_to_refill):
                # A late-added or late-starting symbol needs only its missing
                # prefix. Keep this repair small during active trading.
                end_ms = min(end_ms, max(state.closed[symbol][0]["stampMs"]
                                         for symbol in symbols_to_refill) + 120_000)
            if end_ms > selected_start + 60_000:
                state.set_refill("running", "Recovering missed candles from Massive REST")
                path = (raw_dir / "refill" / day / str(end_ms) / "bundle.json" if
                        selected_start == start_ms else
                        raw_dir / "refill-gaps" / day / str(end_ms) / str(selected_start) / "bundle.json")
                try:
                    if not path.is_file():
                        command = [sys.executable, str(ROOT / "scripts/refill-live-tape-v1.py"),
                                   "--date", day, "--end-ms", str(end_ms),
                                   "--symbols", ",".join(symbols_to_refill), "--raw-dir", str(raw_dir)]
                        if selected_start != start_ms:
                            command += ["--start-ms", str(selected_start)]
                        log = raw_dir / f"refill-{day}.log"
                        with log.open("a") as output:
                            result = subprocess.run(command, stdout=output, stderr=output,
                                                    timeout=1800, check=False)
                        if result.returncode:
                            raise RuntimeError(f"Refill worker exited {result.returncode}; see {log}")
                    bundle = verified_refill(path, day, symbols_to_refill)
                    state.merge_refill(bundle)
                    if not prefix_repair:
                        covered_interruptions = interruptions
                    covered_symbols = symbols
                except Exception as error:
                    state.set_refill("error", f"Refill failed: {type(error).__name__}: {error}")
                    retry_at = time.time() + 120
        time.sleep(10)


def options_reference_monitor(state: TapeState, raw_dir: Path, close_at: datetime):
    """Capture one daily watchlist OI reference per symbol without a browser request."""
    retry_at = {symbol: 0.0 for symbol in SYMBOLS}
    while datetime.now(CT) < close_at:
        now = datetime.now(CT)
        if now.strftime("%H:%M") < "08:00":
            time.sleep(30)
            continue
        day = now.strftime("%Y-%m-%d")
        for symbol in state.watchlist():
            if time.time() < retry_at[symbol]:
                continue
            directory = (raw_dir / "options-wall-bot-v1" / day if symbol == "AMD" else
                         raw_dir / "options-wall-bot-v1" / symbol / day)
            if any(directory.glob("*-summary.json")):
                continue
            with state.lock:
                bar = state.closed[symbol][-1] if state.closed[symbol] else None
            if not bar or not bar.get("c") or time.time()*1000-bar["stampMs"] > 180_000:
                continue
            try:
                capture_options_walls(day, bar["stampMs"], float(bar["c"]), raw_dir, symbol)
            except Exception as error:
                retry_at[symbol] = time.time()+600
                print(f"{symbol} daily options reference: {type(error).__name__}: {error}", flush=True)
            # Stagger vendor requests and keep the stock feed's CPU/network first.
            time.sleep(10)
        time.sleep(30)


def node_binary() -> str:
    candidates = [os.environ.get("TRADEYODHA_NODE"), shutil.which("node"),
                  str(Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise RuntimeError("Node.js is unavailable for the historical AMD matcher")


def prior_day_context(day: str) -> dict:
    """Frozen prior-day OHLC and a trailing-year high, with no current-day leakage."""
    with DAILY_CONTEXT_LOCK:
        if day in DAILY_CONTEXT:
            return DAILY_CONTEXT[day]
    token = os.environ.get("MASSIVE_API_KEY")
    if not token:
        return {"available": False, "reason": "Massive key unavailable"}
    target = datetime.fromisoformat(day).date()
    params = urllib.parse.urlencode({"adjusted": "false", "sort": "asc", "limit": 50000})
    url = (f"https://api.massive.com/v2/aggs/ticker/AMD/range/1/day/"
           f"{target - timedelta(days=370)}/{target - timedelta(days=1)}?{params}")
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            rows = json.load(response).get("results") or []
        if not rows:
            raise ValueError("No prior AMD daily bars")
        prior = rows[-1]
        earlier = rows[-252:-1]
        earlier_high = max((float(row["h"]) for row in earlier), default=None)
        context = {"available": True, "priorSession": {
            "open": prior["o"], "high": prior["h"], "low": prior["l"],
            "close": prior["c"], "volume": prior["v"]},
            "precedingYearHigh": earlier_high,
            "priorMadeNew52WeekHigh": (float(prior["h"]) > earlier_high) if earlier_high is not None and len(earlier) >= 200 else None,
            "trailingSessions": len(earlier) + 1,
            "allTimeHighVerified": False,
            "source": "Massive unadjusted daily AMD aggregates through prior session"}
    except (OSError, ValueError, KeyError) as error:
        context = {"available": False, "reason": f"Prior-day data unavailable: {type(error).__name__}"}
    with DAILY_CONTEXT_LOCK:
        DAILY_CONTEXT[day] = context
    return context


def build_on_demand_context(bars: list[dict], day: str, width: int) -> dict:
    process = subprocess.run([node_binary(), str(ROOT / "scripts/amd-on-demand-context-v1.cjs")],
                             input=json.dumps({"bars": bars, "date": day, "width": width}),
                             text=True, capture_output=True, timeout=10, check=True)
    return json.loads(process.stdout)


PEER_BREADTH_SYMBOLS = ("AMD", "NVDA", "MU", "SNDK", "SMH", "QQQ")
PEER_BENCHMARKS = {"SMH", "QQQ", "SPY"}


def watchlist_peer_snapshot(day: str, asof_ms: int, pairs: list[tuple[str, str]], raw_dir: Path) -> dict:
    """Bounded, on-demand aggregate comparison; the AMD WebSocket is untouched."""
    if not pairs or len(pairs) > 16 or len({symbol for symbol, _ in pairs}) != len(pairs):
        raise ValueError("Watchlist must contain 1–16 distinct symbols")
    if any(not re.fullmatch(r"[A-Z]{1,6}", symbol) or benchmark not in PEER_BENCHMARKS
           or symbol in PEER_BENCHMARKS for symbol, benchmark in pairs):
        raise ValueError("Invalid stock symbol or benchmark")
    symbols = sorted({symbol for symbol, _ in pairs} | {benchmark for _, benchmark in pairs})
    reference_dir = raw_dir / "watchlist-peer-v1" / "references" / day
    reference_dir.mkdir(parents=True, exist_ok=True)

    def load_reference(symbol: str) -> dict:
        path = reference_dir / f"{symbol}.json"
        if path.is_file():
            return json.loads(path.read_text())
        target = datetime.fromisoformat(day).date()
        daily = massive_aggregates(symbol, "day", str(target - timedelta(days=35)),
                                   str(target - timedelta(days=1)))
        if len(daily) < 15:
            raise ValueError("Fewer than 15 prior daily bars")
        true_ranges = [max(float(row["h"]) - float(row["l"]),
                           abs(float(row["h"]) - float(previous["c"])),
                           abs(float(row["l"]) - float(previous["c"])))
                       for previous, row in zip(daily[-15:-1], daily[-14:])]
        result = {"atr14": statistics.mean(true_ranges), "priorSessions": 14}
        temporary = path.with_suffix(".partial")
        temporary.write_text(json.dumps(result))
        temporary.replace(path)
        return result

    def load_symbol(symbol: str) -> dict:
        try:
            reference = load_reference(symbol)
            rows = [row for row in massive_aggregates(symbol, "minute", day, day)
                    if row["t"] <= asof_ms and ct_date(row["t"]) == day]
            clock = ct_clock(asof_ms)
            phase_start = "06:00" if clock < "08:30" else "08:30"
            phase = [row for row in rows if phase_start <= ct_clock(row["t"]) < "11:00"]
            if not phase:
                raise ValueError("No as-of phase price")
            first, last = phase[0], phase[-1]
            age = (asof_ms - last["t"]) // 60_000
            if age > 2 or ct_clock(first["t"]) > ("06:05" if phase_start == "06:00" else "08:35"):
                raise ValueError("Opening or latest price is stale")
            move = (float(last["c"]) - float(first["o"])) / reference["atr14"]
            return {"available": True, "moveInOwnAtr": round(move, 4),
                    "asOfCt": ct_clock(last["t"]), "ageMinutes": age,
                    "phaseOpenCt": ct_clock(first["t"]), "atr14": round(reference["atr14"], 4)}
        except (OSError, ValueError, RuntimeError, KeyError, ZeroDivisionError) as error:
            return {"available": False, "reason": str(error)}

    with ThreadPoolExecutor(max_workers=4) as executor:
        states = dict(zip(symbols, executor.map(load_symbol, symbols)))
    rows = []
    for symbol, benchmark in pairs:
        stock, index = states[symbol], states[benchmark]
        difference = (stock["moveInOwnAtr"] - index["moveInOwnAtr"]
                      if stock["available"] and index["available"] else None)
        rows.append({"symbol": symbol, "benchmark": benchmark,
                     "stock": stock, "index": index,
                     "relativeAtr": round(difference, 4) if difference is not None else None,
                     "score": round(50 + 50 * math.tanh(difference / 0.5))
                     if difference is not None else None})
    return {"date": day, "asOfCt": ct_clock(asof_ms), "phase": "premarket" if ct_clock(asof_ms) < "08:30" else "regular",
            "rows": rows, "method": "Score = 50 + 50*tanh((stock move/own ATR14 - benchmark move/own ATR14)/0.5). "
            "Both moves start at their first observed minute within five minutes of 06:00 or 08:30 CT; "
            "latest price may be at most two minutes old. Descriptive, uncalibrated score."}


def massive_aggregates(symbol: str, unit: str, start: str, end: str) -> list[dict]:
    token = os.environ.get("MASSIVE_API_KEY")
    if not token:
        raise RuntimeError("MASSIVE_API_KEY is not configured")
    params = urllib.parse.urlencode({"adjusted": "false", "sort": "asc", "limit": 50000})
    url = f"https://api.massive.com/v2/aggs/ticker/{symbol}/range/1/{unit}/{start}/{end}?{params}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.load(response)
    if payload.get("next_url"):
        raise ValueError(f"{symbol} {unit} aggregates were truncated")
    return payload.get("results") or []


def peer_reference(symbol: str, day: str) -> dict:
    """Prior-only ATR and median cumulative same-clock volume; compact for disk caching."""
    target = datetime.fromisoformat(day).date()
    start = str(target - timedelta(days=45))
    finish = str(target - timedelta(days=1))
    daily = massive_aggregates(symbol, "day", start, finish)
    minutes = massive_aggregates(symbol, "minute", start, finish)
    if len(daily) < 15:
        raise ValueError(f"{symbol} lacks 15 prior daily bars")
    true_ranges = []
    for previous, row in zip(daily[-15:-1], daily[-14:]):
        prior_close = float(previous["c"])
        high, low = float(row["h"]), float(row["l"])
        true_ranges.append(max(high - low, abs(high - prior_close), abs(low - prior_close)))
    atr14 = statistics.mean(true_ranges)
    by_day: dict[str, dict[str, dict[str, int]]] = {}
    for row in minutes:
        clock = ct_clock(row["t"])
        phase = ("premarket" if SESSION_START_CT <= clock < REGULAR_OPEN_CT else
                 "regular" if REGULAR_OPEN_CT <= clock < ARCHIVE_END_CT else None)
        if phase:
            by_day.setdefault(ct_date(row["t"]), {}).setdefault(phase, {})[clock] = int(row["v"])
    baseline = {}
    for phase, opening, length, minimum in (("premarket", 360, 150, 60), ("regular", 510, 150, 100)):
        sessions = [values[phase] for _, values in sorted(by_day.items())
                    if len(values.get(phase, {})) >= minimum][-20:]
        cumulative = []
        for rows in sessions:
            total = 0
            series = []
            for minute in range(opening, opening + length):
                clock = f"{minute // 60:02d}:{minute % 60:02d}"
                total += rows.get(clock, 0)
                series.append(total)
            cumulative.append(series)
        baseline[phase] = {
            "sessions": len(sessions),
            "medianCumulativeVolume": [round(statistics.median(values)) for values in zip(*cumulative)]
            if len(sessions) >= 10 else None}
    return {"atr14": round(atr14, 4), "baseline": baseline,
            "source": "Massive prior daily and one-minute unadjusted aggregates"}


def premarket_midpoint_context(rows: list[dict], day: str, asof_ms: int) -> dict:
    """Describe a causal 03:00–08:25 CT midpoint and subsequent one-minute tests."""
    eligible = sorted((row for row in rows if row["t"] <= asof_ms and ct_date(row["t"]) == day),
                      key=lambda row: row["t"])
    premarket = [row for row in eligible if "03:00" <= ct_clock(row["t"]) < "08:25"]
    if not premarket:
        return {"available": False, "reason": "No 03:00–08:25 CT minute aggregates"}
    high = max(float(row["h"]) for row in premarket)
    low = min(float(row["l"]) for row in premarket)
    midpoint = (high + low) / 2
    pm_open = float(premarket[0]["o"])
    pm_close = float(premarket[-1]["c"])
    regular = [row for row in eligible if "08:30" <= ct_clock(row["t"]) < "16:00"]
    state = "premarket_in_progress" if ct_clock(asof_ms) < "08:25" else "awaiting_open"
    rejection_events = []
    reclaim_events = []
    if regular:
        for index, row in enumerate(regular):
            prior_close = float(regular[index - 1]["c"]) if index else float(row["o"])
            if prior_close < midpoint <= float(row["h"]) and float(row["c"]) < midpoint:
                rejection_events.append(ct_clock(row["t"]))
            if index >= 2 and all(
                float(item["c"]) > midpoint for item in regular[index - 2:index + 1]
            ) and (index == 2 or float(regular[index - 3]["c"]) <= midpoint):
                reclaim_events.append(ct_clock(regular[index - 2]["t"]))
        recent = regular[-min(3, len(regular)):]
        if len(recent) == 3 and all(float(row["c"]) > midpoint for row in recent):
            state = "sustained_above"
        elif len(recent) == 3 and all(float(row["c"]) < midpoint for row in recent):
            state = "sustained_below"
        else:
            state = "testing_or_mixed"
    return {"available": True, "high": round(high, 3), "low": round(low, 3),
            "midpoint": round(midpoint, 3), "premarketOpen": round(pm_open, 3),
            "premarketLastClose": round(pm_close, 3),
            "premarketDirection": "bearish" if pm_close < pm_open else "bullish" if pm_close > pm_open else "flat",
            "openingSide": ("above" if float(regular[0]["o"]) > midpoint else "below") if regular else None,
            "firstRejectionCt": rejection_events[0] if rejection_events else None,
            "lastRejectionCt": rejection_events[-1] if rejection_events else None,
            "firstSustainedReclaimCt": reclaim_events[0] if reclaim_events else None,
            "lastSustainedReclaimCt": reclaim_events[-1] if reclaim_events else None,
            "lastThreeClosesState": state,
            "method": "Midpoint of observed 03:00–08:24 CT one-minute high and low; "
                      "reclaim requires three consecutive completed one-minute closes above it. "
                      "A rejection is a touch from below that closes below. Descriptive, not a signal.",
            "source": "Massive unadjusted one-minute aggregates; may differ from TradingView PM Levels"}


def breadth_snapshot(day: str, asof_ms: int, references: dict, today_minutes: dict) -> dict:
    """Each name is measured in its own ATR and same-clock volume units."""
    clock = ct_clock(asof_ms)
    phase = "premarket" if clock < "08:30" else "regular"
    open_clock = "06:00" if phase == "premarket" else "08:30"
    phase_start = 360 if phase == "premarket" else 510
    minute_index = int(clock[:2]) * 60 + int(clock[3:]) - phase_start
    names = {}
    for symbol in PEER_BREADTH_SYMBOLS:
        reference = references.get(symbol)
        rows = {row["t"]: row for row in today_minutes.get(symbol, [])
                if row["t"] <= asof_ms and ct_date(row["t"]) == day}
        midpoint_context = premarket_midpoint_context(list(rows.values()), day, asof_ms)
        # Sparse premarket aggregates may omit an exact minute. Carry only a
        # recent observed close, and label its age so a peer is not mistaken
        # for a fresh print at the selected timestamp.
        observed = [row for stamp, row in rows.items() if stamp <= asof_ms]
        end = max(observed, key=lambda row: row["t"]) if observed else None
        age_minutes = (asof_ms - end["t"]) // 60_000 if end else None
        if age_minutes is not None and age_minutes > 2:
            end = None
        opening = next((row for row in rows.values() if ct_clock(row["t"]) == open_clock), None)
        if not reference or "atr14" not in reference or not end or not opening:
            names[symbol] = {"available": False, "reason": "Opening or selected minute/reference unavailable",
                             "premarketMidpoint": midpoint_context}
            continue
        atr = reference["atr14"]
        baseline = reference["baseline"][phase]
        median_volume = (baseline["medianCumulativeVolume"][minute_index]
                         if baseline["medianCumulativeVolume"] is not None else None)
        cumulative_volume = sum(int(row["v"]) for row in rows.values()
                                if open_clock <= ct_clock(row["t"]) <= clock)
        names[symbol] = {"available": True, "open": round(opening["o"], 3),
                         "asOfClose": round(end["c"], 3), "atr14": atr,
                         "lastObservedCt": ct_clock(end["t"]), "observationAgeMinutes": age_minutes,
                         "moveInAtr": round((end["c"] - opening["o"]) / atr, 3) if atr > 0 else None,
                         "cumulativeVolume": cumulative_volume,
                         "sameClockMedianVolume": median_volume,
                         "volumePace": round(cumulative_volume / median_volume, 2) if median_volume else None,
                         "baselineSessions": baseline["sessions"],
                         "premarketMidpoint": midpoint_context}
    tracked = ["AMD", "NVDA", "MU", "SNDK"]
    ranked = sorted((symbol for symbol in tracked if names[symbol].get("moveInAtr") is not None),
                    key=lambda symbol: names[symbol]["moveInAtr"], reverse=True)
    return {"asOfCt": clock, "phase": phase, "trackedStocks": tracked,
            "marketContext": ["SMH", "QQQ"], "names": names,
            "trackedStockBreadth": {"rising": sum(names[symbol].get("moveInAtr", 0) > 0 for symbol in ranked),
                                    "falling": sum(names[symbol].get("moveInAtr", 0) < 0 for symbol in ranked),
                                    "rankedByOwnAtrMove": ranked},
            "method": "Open-to-last-observed price displacement divided by prior 14-session ATR; "
                      "a missing exact minute may use an observed close at most two minutes old, "
                      "with observationAgeMinutes disclosed. "
                      "cumulative share volume divided by prior 20-session median at the same CT minute. "
                      "SMH/QQQ are context, not subtracted from stock returns. Tracked names are not "
                      "a complete or weight-adjusted ETF attribution.",
            "source": "Massive one-minute and daily unadjusted aggregates; only as-of or earlier bars"}


def fetch_peer_breadth(day: str, asof_ms: int, raw_dir: Path) -> dict:
    cache = raw_dir / "peer-breadth-v1" / f"{day}.json"
    if cache.is_file():
        references = json.loads(cache.read_text())
    else:
        references = {}
        with ThreadPoolExecutor(max_workers=3) as executor:
            tasks = {symbol: executor.submit(peer_reference, symbol, day)
                     for symbol in PEER_BREADTH_SYMBOLS}
            for symbol, task in tasks.items():
                try:
                    references[symbol] = task.result()
                except (OSError, ValueError, RuntimeError, KeyError) as error:
                    references[symbol] = {"unavailable": type(error).__name__}
        cache.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache.with_suffix(".partial")
        temporary.write_text(json.dumps(references, separators=(",", ":")))
        temporary.replace(cache)
    today = {}
    with ThreadPoolExecutor(max_workers=6) as executor:
        tasks = {symbol: executor.submit(massive_aggregates, symbol, "minute", day, day)
                 for symbol in PEER_BREADTH_SYMBOLS}
        for symbol, task in tasks.items():
            try:
                today[symbol] = task.result()
            except (OSError, ValueError, RuntimeError, KeyError):
                today[symbol] = []
    return breadth_snapshot(day, asof_ms, references, today)


def fetch_symbol_levels(symbol: str, day: str, asof_ms: int, raw_dir: Path) -> dict:
    """Cache prior completed candles; recompute the as-of intraday view on demand."""
    if not re.fullmatch(r"[A-Z]{1,6}", symbol):
        raise ValueError("Invalid level-bot symbol")
    target = datetime.fromisoformat(day).date()
    cache = raw_dir / "symbol-level-bot-v1" / day / f"{symbol}.json"
    if cache.is_file():
        prior = json.loads(cache.read_text())
    else:
        start = str(target - timedelta(days=40))
        finish = str(target - timedelta(days=1))
        prior = {"daily": massive_aggregates(symbol, "day", start, finish),
                 "minutes": massive_aggregates(symbol, "minute", start, finish)}
        cache.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache.with_suffix(".partial")
        temporary.write_text(json.dumps(prior, separators=(",", ":")))
        temporary.replace(cache)
    today = massive_aggregates(symbol, "minute", day, day)
    current = [row for row in today if row["t"] + 60_000 <= asof_ms]
    reference = float(current[-1]["c"]) if current else None
    result = find_symbol_levels(symbol, asof_ms, prior["daily"], prior["minutes"] + today,
                                reference_price=reference)
    result["premarket"] = premarket_levels(today, day, asof_ms)
    return result


@lru_cache(maxsize=64)
def completed_day_minutes(symbol: str, day: str) -> list[dict]:
    """Cache only a past day's or fixed 08:25 premarket reference bars."""
    return massive_aggregates(symbol, "minute", day, day)


@lru_cache(maxsize=512)
def previous_regular_close(symbol: str, day: str, raw_dir: Path) -> dict:
    """Use the last completed, unadjusted daily close before this session."""
    if symbol not in SYMBOLS:
        raise ValueError("Symbol is not on the fixed watchlist")
    target = datetime.fromisoformat(day).date()
    cache = raw_dir / "prior-regular-close-v1" / symbol / f"{day}.json"
    if cache.is_file():
        record = json.loads(cache.read_text())
        if (record.get("symbol") == symbol and record.get("sessionDate") == day
                and record.get("sourceDate", day) < day
                and isinstance(record.get("close"), (int, float))
                and math.isfinite(record["close"]) and record["close"] > 0):
            return record
    start = str(target - timedelta(days=10))
    finish = str(target - timedelta(days=1))
    daily = massive_aggregates(symbol, "day", start, finish)
    prior = sorted(((datetime.fromtimestamp(row["t"] / 1000, timezone.utc).date().isoformat(), row)
                    for row in daily if isinstance(row.get("c"), (int, float))
                    and math.isfinite(row["c"]) and row["c"] > 0), key=lambda item: item[0])
    prior = [(date, row) for date, row in prior if date < day]
    if not prior:
        raise ValueError(f"No completed daily close before {day} for {symbol}")
    source_date, row = prior[-1]
    record = {"symbol": symbol, "sessionDate": day, "sourceDate": source_date,
              "close": float(row["c"]), "source": "Massive unadjusted daily aggregate"}
    cache.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache.with_suffix(".partial")
    temporary.write_text(json.dumps(record, separators=(",", ":")))
    temporary.replace(cache)
    return record


def fetch_premarket_reference(symbol: str, day: str, asof_ms: int,
                              raw_dir: Path | None = None) -> dict:
    if symbol not in SYMBOLS:
        raise ValueError("Symbol is not on the fixed watchlist")
    raw_dir = raw_dir or ROOT / "tmp/amd-live-tape-v1"
    asof_ct = datetime.fromtimestamp(asof_ms / 1000, CT)
    fixed = day < datetime.now(CT).date().isoformat() or asof_ct.strftime("%H:%M") >= "08:26"
    minutes = (completed_day_minutes(symbol, day) if fixed else
               massive_aggregates(symbol, "minute", day, day))
    gap = {"available": False, "reason": "No completed premarket price"}
    premarket = sorted((row for row in minutes if row["t"] + 60_000 <= asof_ms
                        and ct_date(row["t"]) == day
                        and "03:00" <= ct_clock(row["t"]) < REGULAR_OPEN_CT
                        and isinstance(row.get("c"), (int, float))
                        and math.isfinite(row["c"]) and row["c"] > 0
                        and isinstance(row.get("o"), (int, float))
                        and math.isfinite(row["o"]) and row["o"] > 0),
                       key=lambda row: row["t"])
    if premarket:
        try:
            prior = previous_regular_close(symbol, day, raw_dir)
            first, last = premarket[0], premarket[-1]
            change = float(last["c"]) - prior["close"]
            opening_change = float(first["o"]) - prior["close"]
            premarket_move = float(last["c"]) - float(first["o"])
            gap = {"available": True, "direction": "up" if change >= .005 else
                   "down" if change <= -.005 else "flat",
                   "openingDirection": "up" if opening_change >= .005 else
                   "down" if opening_change <= -.005 else "flat",
                   "openingChange": round(opening_change, 2),
                   "openingChangePct": round(100 * opening_change / prior["close"], 2),
                   "premarketOpen": float(first["o"]), "premarketOpenCt": ct_clock(first["t"]),
                   "premarketMove": round(premarket_move, 2),
                   "premarketMovePct": round(100 * premarket_move / first["o"], 2),
                   "priorClose": prior["close"], "priorCloseDate": prior["sourceDate"],
                   "premarketPrice": float(last["c"]), "premarketPriceCt": ct_clock(last["t"]),
                   "priceStampMs": last["t"] + 60_000,
                   "change": round(change, 2),
                   "changePct": round(100 * change / prior["close"], 2),
                   "source": prior["source"]}
        except (OSError, ValueError, RuntimeError, KeyError) as error:
            gap = {"available": False, "reason": f"Prior daily close unavailable: {error}"}
    return {"symbol": symbol, "sessionDate": day, "asOfCt": asof_ct.isoformat(),
            "premarket": premarket_levels(minutes, day, asof_ms), "premarketGap": gap}


def capture_market_context(day: str, asof_ms: int, raw_dir: Path,
                           breadth: dict | None = None) -> dict:
    """Persist one as-of market snapshot, fetched only when explicitly requested."""
    path = raw_dir / "market-context-bot-v1" / day / f"{asof_ms}.json"
    if path.is_file():
        cached = json.loads(path.read_text())
        if cached.get("version") == 2:
            return cached
    if breadth is None:
        breadth = fetch_peer_breadth(day, asof_ms, raw_dir)
    result = market_context_snapshot(breadth, day, asof_ms)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".partial")
    temporary.write_text(json.dumps(result, separators=(",", ":")))
    temporary.replace(path)
    return result


def massive_news(asof_ms: int, symbol: str | None = None) -> tuple[list[dict], bool]:
    """Fetch at most one recent page; the incomplete-census flag is preserved."""
    token = os.environ.get("MASSIVE_API_KEY")
    if not token:
        raise RuntimeError("MASSIVE_API_KEY is not configured")
    cutoff = datetime.fromtimestamp(asof_ms / 1000, ZoneInfo("UTC")) - timedelta(hours=1)
    start = cutoff - timedelta(hours=24)
    params = {"published_utc.gte": start.isoformat(),
              "published_utc.lte": cutoff.isoformat(),
              "order": "desc", "sort": "published_utc", "limit": 1000}
    if symbol:
        params["ticker"] = symbol
    url = "https://api.massive.com/v2/reference/news?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=12) as response:
        payload = json.load(response)
    return payload.get("results") or [], bool(payload.get("next_url"))


def capture_macro_context(day: str, asof_ms: int, raw_dir: Path) -> dict:
    """One as-of macro snapshot with explicit source gaps; no extra live subscriptions."""
    path = raw_dir / "macro-context-bot-v1" / day / f"{asof_ms}.json"
    if path.is_file():
        cached = json.loads(path.read_text())
        if cached.get("version") == 2 and cached.get("complete"):
            return cached
    catalog = json.loads((PAGE / "reference/macro-events-2026-10.json").read_text())
    news = {"amd": [], "marketWide": []}
    proxies = {}
    status = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        jobs = {"amdNews": executor.submit(massive_news, asof_ms, "AMD"),
                "marketNews": executor.submit(massive_news, asof_ms)}
        for symbol in ("SPY", "QQQ", "TLT", "IEF", "UUP"):
            jobs[symbol] = executor.submit(massive_aggregates, symbol, "minute", day, day)
        for name, job in jobs.items():
            try:
                result = job.result()
                if name in ("amdNews", "marketNews"):
                    rows, truncated = result
                    news["amd" if name == "amdNews" else "marketWide"] = rows
                    status[name] = "truncated_first_page" if truncated else "available"
                else:
                    proxies[name] = result
                    status[name] = "available" if result else "no_bars"
            except (OSError, ValueError, RuntimeError, KeyError) as error:
                status[name] = f"unavailable:{type(error).__name__}"
    result = macro_context_snapshot(day, asof_ms, catalog, news["amd"],
                                    news["marketWide"], proxies, status)
    for symbol in ("SPY", "QQQ", "TLT", "IEF", "UUP"):
        if status.get(symbol) == "available" and not result["proxies"][symbol]["available"]:
            status[symbol] = "no_asof_premarket_bar"
    result["complete"] = all(value == "available" for value in status.values())
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".partial")
    temporary.write_text(json.dumps(result, separators=(",", ":")))
    temporary.replace(path)
    return result


def archived_databento_options_walls(day: str, asof_ms: int, symbol: str = "AMD",
                                     archive_dir: Path | None = None) -> dict | None:
    """Read verified start-of-day AMD OI only after its OPRA receive time."""
    if symbol != "AMD":
        return None
    directory = archive_dir or PAGE / "research/historical_oi_local_v1/data/databento/AMD"
    path = directory / f"{day}-options-summary.json"
    if not path.is_file():
        return None
    report = json.loads(path.read_text())
    source = directory / f"{day}-statistics.jsonl.gz"
    normalized = directory / f"{day}-contract-oi.csv.gz"
    if (report.get("symbol") != symbol or report.get("sessionDate") != day or
            report.get("sourceProvider") != "Databento OPRA.PILLAR" or
            report.get("sourceFile") != source.name or
            not source.is_file() or not normalized.is_file() or
            hashlib.sha256(source.read_bytes()).hexdigest() != report.get("sourceSha256") or
            hashlib.sha256(normalized.read_bytes()).hexdigest() != report.get("normalizedSha256")):
        raise ValueError("Historical OI identity or source checksum mismatch")
    if int(report["capturedStampMs"]) > asof_ms + 60_000:
        return {"available": False, "symbol": symbol, "sessionDate": day,
                "reason": "Start-of-day OI had not yet been published at this replay minute",
                "firstEligibleStampMs": int(report["capturedStampMs"])}
    return report


@lru_cache(maxsize=32)
def capture_options_walls(day: str, asof_ms: int, spot: float, raw_dir: Path,
                          symbol: str = "AMD") -> dict:
    """Use the first archived chain only after its actual capture time.

    The 15-minute vendor delay does not make a later local capture available
    to an earlier replay minute. A just-fetched chain is archived immediately,
    but becomes eligible starting with the next completed minute.
    """
    if not re.fullmatch(r"[A-Z]{1,6}", symbol):
        raise ValueError("Invalid options symbol")
    if day != datetime.now(CT).strftime("%Y-%m-%d"):
        archived = archived_databento_options_walls(day, asof_ms, symbol)
        if archived is not None:
            return archived
    # Preserve the existing AMD archive; other symbols get isolated snapshots.
    directory = (raw_dir / "options-wall-bot-v1" / day if symbol == "AMD" else
                 raw_dir / "options-wall-bot-v1" / symbol / day)
    eligible = []
    if directory.is_dir():
        for path in directory.glob("*-summary.json"):
            try:
                stamp = int(path.name.split("-", 1)[0])
            except ValueError:
                continue
            if stamp <= asof_ms + 60_000:
                eligible.append((stamp, path))
    if eligible:
        _stamp, path = min(eligible)
        report = json.loads(path.read_text())
        source = path.with_name(path.name.replace("-summary.json", "-raw.json"))
        if (report.get("symbol") != symbol or report.get("sessionDate") != day or
                report.get("capturedStampMs") != _stamp or not source.is_file() or
                hashlib.sha256(source.read_bytes()).hexdigest() != report.get("sourceSha256")):
            raise ValueError("Options snapshot identity or source checksum mismatch")
        if "grossGammaPinProxy" not in report:
            raw = json.loads(source.read_text())
            refreshed = summarize_chain(raw["results"], report["referenceSpot"],
                                        day, report["capturedAtUtc"], symbol)
            report["grossGammaPinProxy"] = refreshed["grossGammaPinProxy"]
        return report

    now_ms = int(time.time() * 1000)
    now_ct = datetime.now(CT)
    selected_end = asof_ms + 60_000
    if (day != now_ct.strftime("%Y-%m-%d") or not 6 <= now_ct.hour < 15 or
            not 0 <= now_ms - selected_end <= 120_000):
        return {"available": False, "reason": "No options snapshot existed at the selected minute",
                "symbol": symbol, "sessionDate": day}
    token = os.environ.get("MASSIVE_API_KEY")
    if not token:
        return {"available": False, "reason": "MASSIVE_API_KEY is not configured"}
    start = datetime.fromisoformat(day).date()
    params = {"limit": 250, "strike_price.gte": round(spot * .90, 2),
              "strike_price.lte": round(spot * 1.10, 2),
              "expiration_date.gte": day,
              "expiration_date.lte": (start + timedelta(days=14)).isoformat(),
              "apiKey": token}
    url = f"https://api.massive.com/v3/snapshot/options/{symbol}?" + urllib.parse.urlencode(params)
    rows = []
    pages = 0
    while url:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https" or parts.netloc != "api.massive.com":
            raise RuntimeError("Unexpected options pagination host")
        with urllib.request.urlopen(url, timeout=20) as response:
            payload = json.load(response)
        if payload.get("status") != "OK":
            raise RuntimeError("Massive options snapshot did not return OK")
        rows.extend(payload.get("results") or [])
        pages += 1
        if pages >= 20 and payload.get("next_url"):
            raise RuntimeError("Options chain exceeded the bounded page limit")
        url = payload.get("next_url")
        if url and "apiKey=" not in urllib.parse.urlsplit(url).query:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode({"apiKey": token})
    captured_ms = int(time.time() * 1000)
    captured_utc = datetime.fromtimestamp(captured_ms / 1000, timezone.utc).isoformat()
    report = summarize_chain(rows, spot, day, captured_utc, symbol)
    report["capturedStampMs"] = captured_ms
    report["sourcePages"] = pages
    directory.mkdir(parents=True, exist_ok=True)
    prefix = directory / str(captured_ms)
    raw_path = Path(str(prefix) + "-raw.json")
    summary_path = Path(str(prefix) + "-summary.json")
    raw_bytes = json.dumps({"capturedAtUtc": captured_utc, "results": rows},
                           separators=(",", ":")).encode()
    report["sourceSha256"] = hashlib.sha256(raw_bytes).hexdigest()
    raw_path.write_bytes(raw_bytes)
    summary_path.write_text(json.dumps(report, separators=(",", ":")))
    if captured_ms > selected_end:
        return {"available": False, "reason": "Options snapshot captured after the selected minute",
                "symbol": symbol, "sessionDate": day,
                "firstEligibleStampMs": captured_ms}
    return report


def context_memory() -> dict:
    path = PAGE / "context-memory-v1.json"
    memory = json.loads(path.read_text())
    audit_path = PAGE / "context-source-audit-v1.json"
    audit_bytes = audit_path.read_bytes()
    expected = (memory.get("provenance") or {}).get("sourceAuditSha256")
    if hashlib.sha256(audit_bytes).hexdigest() != expected or json.loads(audit_bytes).get("status") != "passed":
        raise ValueError("Historical context source audit is missing or does not match the index")
    return memory


def ask_openai(context: dict, day: str, note: str) -> dict:
    from openai import OpenAI
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not configured")
    instructions = (
        "You are TradeYodha's on-demand AMD tape analyst for a fast intraday trader. "
        "Synthesize the closest historical numeric feature-vector match, current AMD flow, "
        "and marketContextBot/peerBreadth. Compare AMD with NVDA, MU, and SNDK using each name's own "
        "ATR-normalized displacement and same-clock volume pace. Use SMH and QQQ as market "
        "context, never subtract ETF returns from stock returns or call that relative strength. "
        "Use each name's premarketMidpoint to interpret location and divergence: a bearish "
        "premarket does not mean the midpoint remains resistance after a sustained reclaim. "
        "Treat touches, failed tests, and subsequent flips as separate events. These midpoint "
        "levels are from Massive minute aggregates and may differ from TradingView labels. "
        "Distinguish broad participation from an ETF rise with mixed or concentrated tracked-name "
        "participation. If a peer's observationAgeMinutes is positive, treat its state as "
        "a recent observation, not a fresh print at the selected minute. "
        "These four stocks are not a complete or weight-adjusted ETF attribution; "
        "do not claim which constituent caused the ETF move. "
        "Use macroContextBot separately for scheduled releases, timestamp-eligible AMD and "
        "market-wide headlines, and broad ETF/bond-price context. A scheduled event is not "
        "its result; TLT/IEF moves are not live Treasury yields. Never attribute AMD's move "
        "to a headline or rate change without direct evidence. If a macro source is unavailable, "
        "do not replace it with conjecture. "
        "crossToolHistory is a strictly prior-date numeric nearest-neighbor memory for "
        "AMD tape, premarket/ORB location, and archived chip-peer behavior. Use it only "
        "when available, name the closest prior date and one shared condition, and state "
        "one material difference. It is not a learned transformer, forecast, or complete "
        "historical macro/news/options memory. Do not assert that missing historical fields matched. "
        "The historical match is hand-built normalized distance, not learned embeddings or "
        "a forecast probability. Before the open, historical tape matching may be unavailable; "
        "never imply that a regular-session analog matched premarket tape. "
        "If tapeWindowQuality is incomplete, use only completed one-minute observations, "
        "aggregate price/volume context, and peers; do not claim a complete five-minute "
        "tape window or historical tape analog. At 08:30–08:33 CT the ORB is forming, "
        "so do not call its running high/low the five-minute ORB. "
        "AMD levels.premarket covers only 06:00 onward. peerBreadth.names.AMD.premarketMidpoint "
        "covers 03:00–08:24 and is the canonical premarket high/low/midpoint for this method. "
        "Do not mix or compare those windows without naming each one. Use the canonical "
        "premarket low/midpoint/high, prior close/high/low, and the completed five-minute "
        "ORB high/low when relevant. Include AMD's "
        "same-clock volume pace versus prior sessions when available. "
        "Use higherTimeframeLevels for daily, hourly, and four-hour candidate levels "
        "when they are available before the selected minute. Distinguish an observed "
        "break and hold from a candidate level; never infer identifiable buyers from a "
        "candle alone. Do not claim a TradingView four-hour level exactly matches these "
        "regular-session-anchored candles. Prefer the nearest two levels relevant to AMD. "
        "Use optionsWalls only when available. Its callOiWalls and putOiWalls "
        "are chain-wide rankings, not necessarily overhead or lower price levels. "
        "For nearby levels use oiByStrike: strongest call OI strictly above AMD's "
        "as-of price and strongest put OI strictly below it, each within 3%; "
        "otherwise state nearby OI is unavailable. Name them candidate strikes "
        "with snapshot time and Starter's 15-minute chain delay. "
        "Gross gamma is unsigned; dealer net positioning and signed GEX remain unknown. "
        "Never imply an option wall held or caused price movement without tape evidence. "
        "Give a compact interpretation rather than duplicating the dashboard. "
        "Treat trader_note as unverified. Do not assume later prices or news, identify actual "
        "order owners, or recommend an entry, exit, position size, or trade direction. "
        "If a tracked name lacks data, state that briefly rather than guessing. "
        "Reply in plain English in at most 110 words across six short labeled lines: "
        "Read, Volume, Levels, Market, Watch. Include specific price levels and volume pace "
        "only from the payload, rounded to cents and two decimals respectively. "
        "Volume should cover AMD only; Market should summarize both broader macro context "
        "and peer divergence without listing every metric. Add an Options line with "
        "the nearby sourced call and put OI concentrations when available; otherwise say "
        "'Options: nearby OI unavailable'. "
        "Read should interpret AMD's overall structure and, after the open, current tape "
        "versus the nearest valid analog when one exists. Market should explain whether "
        "peer participation confirms or diverges from SMH/QQQ. Watch should name one "
        "observable condition that would change the read. Do not cite analog future returns "
        "or suggest a guaranteed outcome."
    )
    payload = {"date": day, "asOfCt": context["asOf"], "amd": context, "trader_note": note or None,
               "trader_note_verified": False}
    response = OpenAI(timeout=25, max_retries=0).responses.create(
        model=os.environ.get("TRADEYODHA_TAPE_MODEL", "gpt-6-astra"),
        reasoning={"effort": "low"}, instructions=instructions,
        input=json.dumps(payload, separators=(",", ":")),
        max_output_tokens=550, store=False)
    return {"text": response.output_text, "model": response.model,
            "usage": {"inputTokens": response.usage.input_tokens,
                      "outputTokens": response.usage.output_tokens} if response.usage else None}


def current_rss_mb() -> float:
    """Resident memory of this collector, as reported by macOS ps."""
    result = subprocess.run(["ps", "-p", str(os.getpid()), "-o", "rss="],
                            capture_output=True, text=True, timeout=3, check=True)
    return int(result.stdout.strip()) / 1024


def memory_guard(state: TapeState, stop: threading.Event, limit_mb: int):
    """Stop ingestion before this process can exhaust the trading workstation."""
    while not stop.wait(1):
        try:
            used_mb = current_rss_mb()
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
        if state.diagnostics is not None:
            depth, oldest_ms, backlog_ms = state.diagnostic_backlog()
            state.diagnostics.resource(used_mb, time.process_time_ns(), time.monotonic_ns(),
                                       depth, oldest_ms, backlog_ms)
        if used_mb < limit_mb:
            continue
        stop.set()
        message = (f"Collector stopped at {used_mb:.0f} MB resident memory "
                   f"(limit {limit_mb} MB); raw tape already journaled is retained")
        state.set_feed("error", message)
        print(f"AMD live tape: {message}", flush=True)
        return


def collect(state: TapeState, log_dir: Path, close_at: datetime | None = None,
            memory_stop: threading.Event | None = None):
    key = os.environ.get("MASSIVE_API_KEY")
    if not key:
        state.set_feed("error", "MASSIVE_API_KEY is not configured")
        return
    backoff = 1
    previously_connected = False
    diagnostic_batch_id = 0
    while True:
        if memory_stop is not None and memory_stop.is_set():
            return
        if close_at is not None and datetime.now(CT) >= close_at:
            return
        try:
            state.set_feed("connecting", "Connecting to Massive")
            with connect("wss://socket.massive.com/stocks", open_timeout=15,
                         ping_interval=20, ping_timeout=20) as socket:
                socket.send(json.dumps({"action": "auth", "params": key}))
                authenticated = False
                requested = set()
                subscribed = set()
                backoff = 1
                while True:
                    if memory_stop is not None and memory_stop.is_set():
                        return
                    if close_at is not None and datetime.now(CT) >= close_at:
                        return
                    active = set(state.watchlist())
                    if authenticated:
                        add = active - requested
                        remove = requested - active
                        if remove:
                            channels = ",".join(f"{channel}.{symbol}" for symbol in sorted(remove)
                                                for channel in ("T", "Q"))
                            socket.send(json.dumps({"action": "unsubscribe", "params": channels}))
                            requested -= remove
                            subscribed -= {f"{kind}.{symbol}" for symbol in remove for kind in ("T", "Q")}
                            if not add:
                                state.set_feed("connected", f"{', '.join(sorted(active))} trades and quotes subscribed")
                        if add:
                            channels = ",".join(f"{channel}.{symbol}" for symbol in sorted(add)
                                                for channel in ("T", "Q"))
                            socket.send(json.dumps({"action": "subscribe", "params": channels}))
                            requested |= add
                            state.set_feed("subscribing", f"Waiting for {', '.join(sorted(add))} trade/quote channels")
                    try:
                        message = socket.recv(timeout=1)
                        receipt_mono_ns = time.monotonic_ns() if state.diagnostics is not None else None
                        receipt_wall_ns = time.time_ns() if state.diagnostics is not None else None
                        rows = json.loads(message)
                    except TimeoutError:
                        continue
                    if state.diagnostics is None:
                        if memory_stop is not None and memory_stop.is_set():
                            return
                        if close_at is not None and datetime.now(CT) >= close_at:
                            return
                    if not isinstance(rows, list):
                        rows = [rows]
                    if state.diagnostics is not None:
                        state.diagnostics.increment("recv_messages")
                        state.diagnostics.increment("recv_rows", len(rows))
                    market = []
                    for row in rows:
                        if row.get("ev") == "status":
                            status = row.get("status")
                            if status == "auth_success" and not authenticated:
                                authenticated = True
                            elif status in ("auth_failed", "max_connections"):
                                raise RuntimeError(f"Massive WebSocket: {status}")
                            elif status == "success" and "subscribed to:" in row.get("message", ""):
                                channels = row["message"].split("subscribed to:", 1)[1].strip()
                                subscribed.update(item.strip() for item in channels.split(","))
                                desired_channels = {f"{kind}.{symbol}" for symbol in active
                                                    for kind in ("T", "Q")}
                                if desired_channels <= subscribed:
                                    state.set_feed("connected", f"{', '.join(sorted(active))} trades and quotes subscribed")
                                    previously_connected = True
                            continue
                        if row.get("ev") in ("T", "Q") and row.get("sym") in active:
                            market.append(row)
                    if market:
                        active_now = set(state.watchlist())
                        market = [row for row in market if row["sym"] in active_now]
                    if ((memory_stop is not None and memory_stop.is_set()) or
                            (close_at is not None and datetime.now(CT) >= close_at)):
                        if state.diagnostics is not None and market:
                            diagnostic_batch_id += 1
                            state.diagnostics.begin_journal(
                                diagnostic_batch_id, len(market), receipt_mono_ns)
                            state.diagnostics.journal_discarded(diagnostic_batch_id)
                        return
                    if market:
                        day = datetime.now(CT).strftime("%Y-%m-%d")
                        timing = None
                        if state.diagnostics is not None:
                            diagnostic_batch_id += 1
                            state.diagnostics.begin_journal(
                                diagnostic_batch_id, len(market), receipt_mono_ns)
                            source = raw_path(log_dir, day)
                        try:
                            if state.diagnostics is not None:
                                start_offset = source.stat().st_size if source.exists() else 0
                            append_raw(log_dir, day, market)
                            if state.diagnostics is not None:
                                end_offset = raw_path(log_dir, day).stat().st_size
                        except Exception:
                            if state.diagnostics is not None:
                                state.diagnostics.journal_failed(diagnostic_batch_id)
                            raise
                        if state.diagnostics is not None:
                            journal_mono_ns = time.monotonic_ns()
                            journal_wall_ns = time.time_ns()
                            state.diagnostics.journal_appended(diagnostic_batch_id)
                            timing = {"batch_id": diagnostic_batch_id,
                                      "receipt_mono_ns": receipt_mono_ns,
                                      "receipt_wall_ns": receipt_wall_ns,
                                      "journal_mono_ns": journal_mono_ns,
                                      "journal_wall_ns": journal_wall_ns,
                                      "first_serial": state.serial + 1}
                            state.diagnostics.record("batch", batch_id=diagnostic_batch_id,
                                date=day, raw_path=source.name, raw_start_offset=start_offset,
                                raw_end_offset=end_offset, count=len(market),
                                receipt_mono_ns=receipt_mono_ns,
                                receipt_wall_ns=receipt_wall_ns,
                                journal_mono_ns=journal_mono_ns,
                                journal_wall_ns=journal_wall_ns)
                        state.ingest(market, timing=timing)
                        manager = state.checkpoint_manager
                        if manager is not None and manager.due():
                            try:
                                source_path = raw_path(log_dir, day)
                                manager.maybe_capture(state, source_path,
                                                      source_path.stat().st_size)
                            except Exception as error:
                                # A cache failure cannot interrupt raw journaling.
                                manager.last_error = f"{type(error).__name__}:{error}"
                        previously_connected = True
        except Exception as error:
            if memory_stop is not None and memory_stop.is_set():
                return
            if previously_connected:
                state.mark_gap()
                previously_connected = False
                try:
                    append_raw(log_dir, datetime.now(CT).strftime("%Y-%m-%d"),
                               [{"ev": "GAP", "reason": "feed_interruption"}], durable=True)
                except OSError:
                    state.set_feed("error", "Raw tape journal unavailable; collector stopped")
                    return
            state.set_feed("reconnecting", f"Feed interrupted: {type(error).__name__}; retrying")
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)


def completed_session_minute(day: str, stamp_ms: int, end_ct: str,
                             now_ms: int | None = None) -> bool:
    """One clock/date rule for live reference and analyst requests."""
    return (ct_date(stamp_ms) == day and
            SESSION_START_CT <= ct_clock(stamp_ms) < end_ct and
            (now_ms is None or stamp_ms + 60_000 <= now_ms))


def handler(state: TapeState, raw_dir: Path, live_upstream: str | None = None):
    ask_lock = threading.Lock()
    session_end_ct = getattr(state, "session_close_ct", REGULAR_CLOSE_CT)

    def archived_amd_bars(day: str) -> list[dict]:
        """Use the published full-session tape, with legacy AMD replay as fallback."""
        history_path = PAGE / "watchlist-history/AMD.json"
        if history_path.is_file():
            history = json.loads(history_path.read_text())
            entry = next((item for item in history.get("sessions", []) if item.get("date") == day), None)
            if entry:
                path = ROOT / "analysis/watchlist-flow-history-v1" / entry["file"]
                if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
                    raise ValueError(f"AMD {day}: published replay checksum mismatch")
                replay = json.loads(path.read_text())
                if (replay.get("symbol") != "AMD" or replay.get("date") != day or
                        replay.get("sourceSha256") != entry.get("sourceSha256")):
                    raise ValueError(f"AMD {day}: published replay provenance mismatch")
                return replay["bars"]["1m"]
        manifest = json.loads((PAGE / "replay-manifest.json").read_text())
        if day not in manifest.get("dates", []):
            raise ValueError("Session is not in the verified replay library")
        replay = json.loads((PAGE / "replay" / f"{day}.json").read_text())
        if replay.get("date") != day:
            raise ValueError("Replay session date mismatch")
        return replay["bars"]["AMD"]

    class Handler(BaseHTTPRequestHandler):
        def proxy_live_get(self) -> bool:
            """Share the existing collector with LAN dashboard viewers; never start a feed."""
            if not live_upstream or not self.path.startswith("/api/"):
                return False
            try:
                with urllib.request.urlopen(
                        f"http://{live_upstream}{self.path}", timeout=10) as response:
                    self.send_response(response.status)
                    self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                    self.send_header("Cache-Control", "no-store")
                    if response.headers.get("Content-Length"):
                        self.send_header("Content-Length", response.headers["Content-Length"])
                    self.end_headers()
                    if self.path.startswith("/api/updates"):
                        while chunk := response.readline():
                            self.wfile.write(chunk)
                            self.wfile.flush()
                    else:
                        self.wfile.write(response.read())
                return True
            except urllib.error.HTTPError as error:
                payload = error.read()
                self.send_response(error.code)
                self.send_header("Content-Type", error.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return True
            except (BrokenPipeError, ConnectionResetError):
                return True
            except (OSError, urllib.error.URLError):
                return False

        def send_json(self, status: int, value: dict):
            payload = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            if self.path == "/api/observational-browser-metric":
                if state.diagnostics is None or self.client_address[0] not in ("127.0.0.1", "::1"):
                    self.send_error(404)
                    return
                origin = self.headers.get("Origin")
                if origin and origin != f"http://{self.headers.get('Host')}":
                    self.send_json(403, {"error": "Local dashboard only"})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json" or not 0 < length <= 1024:
                        raise ValueError("Invalid metric payload")
                    item = json.loads(self.rfile.read(length))
                    sample_id = item.get("sample_id")
                    symbol = item.get("symbol")
                    response_ms = float(item.get("browser_response_epoch_ms"))
                    paint_ms = float(item.get("browser_paint_epoch_ms"))
                    duration_ms = float(item.get("response_to_paint_ms"))
                    if (not isinstance(sample_id, str) or not re.fullmatch(r"[0-9a-f]{16}", sample_id)
                            or symbol not in SYMBOLS or not all(math.isfinite(x) for x in
                                (response_ms, paint_ms, duration_ms))
                            or not 0 <= duration_ms <= 10_000 or paint_ms < response_ms):
                        raise ValueError("Invalid metric values")
                    if not state.diagnostics.browser_paint(sample_id, symbol, response_ms,
                                                           paint_ms, duration_ms):
                        raise ValueError("Unknown or expired sample")
                    self.send_json(200, {"recorded": True})
                except (ValueError, TypeError, KeyError):
                    self.send_json(400, {"error": "Invalid browser metric"})
                return
            if self.path == "/api/watchlist":
                self.send_json(405, {"error": "The supported-symbol watchlist is fixed"})
                return
            if self.path != "/api/ask":
                self.send_error(404)
                return
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{self.headers.get('Host')}":
                self.send_json(403, {"error": "Use the local AMD dashboard to request a thesis"})
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
                self.send_json(415, {"error": "Expected JSON"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 2048:
                    raise ValueError("Request exceeds the size limit")
                request = json.loads(self.rfile.read(length))
                day = request.get("date") or state.snapshot()["date"]
                if not isinstance(day, str) or not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", day):
                    raise ValueError("Invalid session date")
                width = request.get("width", 5)
                if width not in (1, 2, 5, 15):
                    raise ValueError("Choose a 1-, 2-, 5-, or 15-minute tape window")
                note = request.get("traderNote", "")
                if not isinstance(note, str) or len(note) > 500:
                    raise ValueError("Trader note must be 500 characters or fewer")
                asof = request.get("asofStampMs")
                if asof is not None and (not isinstance(asof, int) or isinstance(asof, bool)):
                    raise ValueError("Invalid completed-minute timestamp")
                today = state.snapshot()
                if day == today["date"]:
                    source = today["bars"]["AMD"]
                    feed = {"status": today["status"], "receivedAgeSeconds": today["receivedAgeSeconds"],
                            "eventLagSeconds": today["eventLagSeconds"]}
                    if asof is not None and not any(row.get("stampMs") == asof for row in source):
                        source = archived_amd_bars(day)
                        feed = {"status": "recorded"}
                else:
                    source = archived_amd_bars(day)
                    feed = {"status": "recorded"}
                selected = source[-1] if asof is None and source else next(
                    (row for row in source if row.get("stampMs") == asof), None)
                if not selected or not completed_session_minute(day, selected["stampMs"],
                                                                  session_end_ct):
                    raise ValueError(f"Select a completed AMD minute between {SESSION_START_CT} and "
                                     f"{session_end_ct} CT")
                prefix = [row for row in source if row["stampMs"] <= selected["stampMs"]]
                if len(prefix) < width:
                    raise ValueError("Not enough completed tape for this window")
            except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)})
                return
            identity = {"contextVersion": 17, "date": day, "stampMs": selected["stampMs"], "width": width,
                        "traderNote": note.strip()}
            digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:16]
            report_path = raw_dir / "analyst-reports" / day / f"{selected['stampMs']}-{digest}.json"
            if report_path.is_file():
                report = json.loads(report_path.read_text())
                report["cached"] = True
                self.send_json(200, report)
                return
            if not ask_lock.acquire(blocking=False):
                self.send_json(429, {"error": "An AMD thesis is already being prepared"})
                return
            try:
                context = build_on_demand_context(prefix, day, width)
                context["priorDay"] = prior_day_context(day)
                latest_live = (day == today["date"] and selected["stampMs"] == source[-1]["stampMs"]
                               and time.time() * 1000 - (selected["stampMs"] + 60_000) <= 90_000)
                context["feed"] = feed if latest_live else {"status": "recorded selected minute"}
                context["peerBreadth"] = fetch_peer_breadth(day, selected["stampMs"], raw_dir)
                context["marketContextBot"] = capture_market_context(day, selected["stampMs"], raw_dir,
                                                                      context["peerBreadth"])
                levels = {}
                with ThreadPoolExecutor(max_workers=4) as executor:
                    macro_task = executor.submit(capture_macro_context, day,
                                                 selected["stampMs"], raw_dir)
                    tasks = {symbol: executor.submit(fetch_symbol_levels, symbol, day,
                                                     selected["stampMs"] + 60_000, raw_dir)
                             for symbol in ("AMD", "MU", "SNDK")}
                    for symbol, task in tasks.items():
                        try:
                            levels[symbol] = task.result()
                        except (OSError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
                            levels[symbol] = {"available": False, "reason": type(error).__name__}
                    try:
                        context["macroContextBot"] = macro_task.result()
                    except (OSError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
                        context["macroContextBot"] = {"available": False,
                                                      "reason": type(error).__name__}
                context["higherTimeframeLevels"] = levels
                try:
                    context["crossToolHistory"] = retrieve_context_memory(
                        context, day, context_memory())
                except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
                    context["crossToolHistory"] = {"available": False,
                                                   "reason": type(error).__name__}
                context["tapeWindowQuality"] = ("incomplete" if context.get("reason") else "complete")
                try:
                    context["optionsWalls"] = capture_options_walls(
                        day, selected["stampMs"], float(selected.get("c") or 0), raw_dir)
                except (OSError, ValueError, RuntimeError, KeyError, json.JSONDecodeError) as error:
                    context["optionsWalls"] = {"available": False,
                                               "reason": f"Options snapshot unavailable ({type(error).__name__})"}
                opening_partial = ("08:30" <= selected["t"] <= "08:33" and
                                   context.get("reason") == "Waiting for 5 complete regular-session minutes")
                if context.get("reason") and selected["t"] >= "08:30" and not opening_partial:
                    raise ValueError(context["reason"])
                answer = ask_openai(context, day, note.strip())
                if not answer["text"].strip():
                    raise RuntimeError("OpenAI returned no thesis text")
                report = {"date": day, "asOfCt": context["asOf"], "asOfStampMs": selected["stampMs"],
                          "width": width, "text": answer["text"], "model": answer["model"],
                          "usage": answer["usage"], "traderNote": note.strip(), "context": context,
                          "createdAtCt": datetime.now(CT).isoformat(), "cached": False}
                report_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = report_path.with_suffix(".partial")
                temporary.write_text(json.dumps(report, separators=(",", ":")))
                temporary.replace(report_path)
                self.send_json(200, report)
            except ValueError as error:
                self.send_json(422, {"error": str(error)})
            except Exception as error:
                self.send_json(503, {"error": f"AMD analyst unavailable ({type(error).__name__})"})
            finally:
                ask_lock.release()

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if self.proxy_live_get():
                return
            if live_upstream and parsed.path in ("/api/state", "/api/updates", "/api/health"):
                self.send_json(503, {"error": "Live collector is offline"})
                return
            if parsed.path == "/api/health":
                if hasattr(state, "health"):
                    self.send_json(200, state.health())
                else:
                    self.send_json(501, {"phase": "health_unavailable_for_recorded_state"})
                return
            if getattr(state, "checkpoint_recovery", False) and state.startup_phase in (
                    "process_started", "recovery_in_progress", "recovery_failure"):
                self.send_json(503, {"ready": False, "phase": state.startup_phase,
                                     "reason": state.startup_error or "journal_recovery_pending"})
                return
            if parsed.path == "/api/observational-diagnostics":
                if state.diagnostics is None or self.client_address[0] not in ("127.0.0.1", "::1"):
                    self.send_error(404)
                else:
                    self.send_json(200, state.diagnostics.status())
                return
            if parsed.path == "/api/observational-research":
                symbol = urllib.parse.parse_qs(parsed.query).get("symbol", [""])[0]
                if symbol not in state.watchlist():
                    self.send_json(400, {"error": "Symbol is not on the watchlist"})
                else:
                    self.send_json(200, state.research_snapshot(symbol))
                return
            if parsed.path == "/api/shadow-cv2":
                query = urllib.parse.parse_qs(parsed.query)
                try:
                    symbol = query.get("symbol", [""])[0]
                    day = query.get("date", [""])[0]
                    if symbol not in state.watchlist():
                        raise ValueError("Symbol is not on the watchlist")
                    self.send_json(200, archived_cv2(symbol, day))
                except ValueError as error:
                    self.send_json(400, {"error": str(error)})
                except FileNotFoundError:
                    self.send_json(404, {"error": "Archived Shadow C_v2 unavailable"})
                return
            if parsed.path == "/api/watchlist":
                self.send_json(200, {"symbols": state.watchlist(), "supported": list(SYMBOLS)})
                return
            if parsed.path == "/api/updates":
                symbol = urllib.parse.parse_qs(parsed.query).get("symbol", [None])[0]
                if symbol not in state.watchlist():
                    self.send_json(400, {"error": "Symbol is not on the live tape"})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                try:
                    last_sent = None
                    last_send_at = 0.0
                    while True:
                        signal = state.update_signal(symbol)
                        marker = (signal["version"], signal["tickVersion"],
                                  tuple(signal["versions"].items()), signal["runId"],
                                  signal["date"], signal["active"], signal["status"],
                                  signal["message"], tuple(signal["watchlist"]),
                                  signal["refillStatus"], signal["feedGapsOrOutOfOrderDrops"])
                        if marker != last_sent or time.monotonic() - last_send_at >= 5:
                            payload = json.dumps(signal, separators=(",", ":"))
                            self.wfile.write(f"data: {payload}\n\n".encode())
                            self.wfile.flush()
                            last_sent, last_send_at = marker, time.monotonic()
                        if not signal["active"]:
                            break
                        with state.updated:
                            if (state.version[symbol] == signal["version"] and
                                    state.tick_version[symbol] == signal["tickVersion"] and
                                    all(state.version[name] == version
                                        for name, version in signal["versions"].items())):
                                state.updated.wait(timeout=1)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                return
            if parsed.path == "/api/footprint":
                try:
                    query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
                    day = query["date"][0]
                    stamp = int(query["stampMs"][0])
                    duration = int(query["durationMs"][0])
                    if (day != state.date or ct_date(stamp) != day or
                            duration not in (30_000, 60_000, 120_000, 300_000, 900_000) or
                            stamp % duration or not completed_session_minute(day, stamp,
                                                                              session_end_ct) or
                            ct_clock(stamp + duration - 1) >= session_end_ct):
                        raise ValueError("Invalid completed AMD interval")
                    result = state.footprint(stamp, duration)
                    if result is None:
                        self.send_json(404, {"error": "Complete live footprint unavailable for this interval"})
                    else:
                        self.send_json(200, result)
                except (KeyError, ValueError, IndexError) as error:
                    self.send_json(400, {"error": str(error)})
                return
            if parsed.path == "/api/zone-buckets":
                try:
                    query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
                    symbol = query["symbol"][0]
                    day = query["date"][0]
                    start = int(query["startMs"][0])
                    end = int(query["endMs"][0])
                    if (symbol not in state.watchlist() or day != state.date or
                            ct_date(start) != day or ct_date(end - 1) != day):
                        raise ValueError("Invalid current-session zone request")
                    result = state.zone_buckets(symbol, start, end)
                    if result is None:
                        self.send_json(404, {"error": "Complete zone buckets unavailable"})
                    else:
                        self.send_json(200, result)
                except (KeyError, ValueError, IndexError) as error:
                    self.send_json(400, {"error": str(error)})
                return
            if parsed.path == "/api/half":
                try:
                    query = urllib.parse.parse_qs(parsed.query)
                    day = query.get("date", [state.date])[0]
                    selected_symbol = query.get("symbol", [None])[0]
                    if selected_symbol is not None and selected_symbol not in SYMBOLS:
                        raise ValueError("Symbol is not on the live tape")
                    if not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", day):
                        raise ValueError("Invalid session date")
                    if day == state.date:
                        if selected_symbol is not None and selected_symbol not in state.watchlist():
                            raise ValueError("Symbol is not in the live watchlist")
                        after = int(query["afterMs"][0]) if "afterMs" in query else None
                        self.send_json(200, state.half_snapshot(
                            selected_symbol, after_ms=after,
                            client_run_id=query.get("runId", [None])[0],
                            client_date=query.get("clientDate", [None])[0]))
                    else:
                        if selected_symbol not in (None, "AMD"):
                            raise ValueError("Historical 30-second tape is available only for AMD")
                        manifest = json.loads((PAGE / "replay-manifest.json").read_text())
                        if day not in manifest.get("dates", []):
                            raise ValueError("Session is not in the verified replay library")
                        path = PAGE / "replay" / f"{day}-30s.json"
                        if not path.is_file():
                            self.send_json(404, {"error": "Verified 30-second replay is unavailable for this session"})
                        else:
                            self.send_json(200, json.loads(path.read_text()))
                except (ValueError, KeyError, json.JSONDecodeError) as error:
                    self.send_json(400, {"error": str(error)})
                return
            if parsed.path == "/api/watchlist-peers":
                try:
                    query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
                    day = query["date"][0]
                    stamp = int(query["asofStampMs"][0])
                    raw_pairs = query["watch"][0].split(",")
                    pairs = [tuple(item.split(":")) for item in raw_pairs]
                    if not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", day):
                        raise ValueError("Invalid session date")
                    now = datetime.now(CT)
                    if not completed_session_minute(day, stamp, session_end_ct,
                                                    int(now.timestamp() * 1000) if day == now.strftime("%Y-%m-%d") else None):
                        raise ValueError(f"Choose a completed minute from {SESSION_START_CT}–{session_end_ct} CT")
                    if day != now.strftime("%Y-%m-%d"):
                        manifest = json.loads((PAGE / "replay-manifest.json").read_text())
                        if day not in manifest.get("dates", []):
                            raise ValueError("Session is not in the verified replay library")
                    self.send_json(200, watchlist_peer_snapshot(day, stamp, pairs, raw_dir))
                except (ValueError, KeyError, IndexError, TypeError) as error:
                    self.send_json(400, {"error": str(error)})
                except Exception as error:
                    self.send_json(503, {"error": f"Watchlist peers unavailable ({type(error).__name__})"})
                return
            if parsed.path in ("/api/levels", "/api/premarket-levels", "/api/market-context", "/api/macro-context",
                               "/api/options-walls"):
                try:
                    query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
                    symbol = query.get("symbol", ["AMD"])[0].upper()
                    day = query.get("date", [state.snapshot()["date"]])[0]
                    stamp = int(query.get("asofStampMs", ["0"])[0])
                    if not re.fullmatch(r"[A-Z]{1,6}", symbol) or not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", day):
                        raise ValueError("Invalid symbol or session date")
                    live = state.snapshot()
                    source = []
                    if day == live["date"]:
                        source = live["bars"].get(symbol, [])
                        if symbol == "AMD" and not any(row.get("stampMs") == stamp for row in source):
                            source = archived_amd_bars(day)
                    elif symbol == "AMD":
                        source = archived_amd_bars(day)
                    selected = next((row for row in source if row.get("stampMs") == stamp
                                     and completed_session_minute(day, stamp, session_end_ct)), None)
                    if parsed.path == "/api/macro-context":
                        now = datetime.now(CT)
                        if not completed_session_minute(day, stamp, session_end_ct,
                                                        int(now.timestamp() * 1000) if day == now.strftime("%Y-%m-%d") else None):
                            raise ValueError(f"Choose a completed market-context minute from {SESSION_START_CT}–{session_end_ct} CT")
                    elif symbol == "AMD" and not selected:
                        raise ValueError(f"Choose a recorded AMD minute from {SESSION_START_CT}–{session_end_ct} CT")
                    elif symbol != "AMD":
                        if not completed_session_minute(day, stamp, session_end_ct,
                                                        int(time.time() * 1000) if day == datetime.now(CT).strftime("%Y-%m-%d") else None):
                            raise ValueError(f"Choose a completed minute from {SESSION_START_CT}–{session_end_ct} CT")
                    if parsed.path == "/api/premarket-levels":
                        report = fetch_premarket_reference(symbol, day, stamp + 60_000, raw_dir)
                        register = getattr(state, "register_research_premarket", None)
                        if register is not None:
                            register(symbol, report)
                        self.send_json(200, report)
                    elif parsed.path == "/api/levels":
                        self.send_json(200, fetch_symbol_levels(symbol, day, stamp + 60_000, raw_dir))
                    elif parsed.path == "/api/market-context":
                        self.send_json(200, capture_market_context(day, stamp, raw_dir))
                    elif parsed.path == "/api/options-walls":
                        if selected:
                            spot = float(selected.get("c") or 0)
                        else:
                            prices = [row for row in massive_aggregates(symbol, "minute", day, day)
                                      if row["t"] <= stamp and ct_date(row["t"]) == day]
                            if not prices or stamp - prices[-1]["t"] > 5 * 60_000:
                                raise ValueError(f"No recent {symbol} reference price")
                            spot = float(prices[-1]["c"])
                        self.send_json(200, capture_options_walls(
                            day, stamp, spot, raw_dir, symbol))
                    else:
                        self.send_json(200, capture_macro_context(day, stamp, raw_dir))
                except (ValueError, KeyError, json.JSONDecodeError) as error:
                    self.send_json(400, {"error": str(error)})
                except Exception as error:
                    self.send_json(503, {"error": f"Context bot unavailable ({type(error).__name__})"})
                return
            if parsed.path == "/api/state":
                query = urllib.parse.parse_qs(parsed.query)
                selected_symbol = query.get("symbol", [None])[0]
                if selected_symbol is not None and selected_symbol not in state.watchlist():
                    self.send_json(400, {"error": "Symbol is not on the live tape"})
                    return
                try:
                    after = int(query["afterMs"][0]) if "afterMs" in query else None
                except ValueError:
                    self.send_json(400, {"error": "Invalid afterMs"})
                    return
                payload = json.dumps(state.snapshot(
                    selected_symbol, after_ms=after,
                    client_run_id=query.get("runId", [None])[0],
                    client_date=query.get("clientDate", [None])[0]), separators=(",", ":")).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            name = self.path.split("?", 1)[0].lstrip("/") or "index.html"
            sweep_root = ROOT / "tmp/amd-live-tape-v1/replay-sweeps-v1"
            sweep_match = re.fullmatch(
                r"replay-sweeps/(AMD|TSLA|SPY|QQQ|META|NVDA|MU|MSFT|SOXL|SPCX|SNDK)/(20\d{2}-\d{2}-\d{2})\.json", name)
            if name == "replay-sweeps-manifest.json" or sweep_match:
                manifest_path = sweep_root / "manifest.json"
                if not manifest_path.is_file():
                    self.send_error(404)
                    return
                if sweep_match:
                    symbol, day = sweep_match.groups()
                    manifest = json.loads(manifest_path.read_text())
                    entry = next((item for item in manifest.get("sessions", [])
                                  if item.get("symbol") == symbol and item.get("date") == day), None)
                    if entry is None or entry.get("file") != f"{symbol}/{day}.json":
                        self.send_error(404)
                        return
                    history_path = PAGE / "watchlist-history" / f"{symbol}.json"
                    history = json.loads(history_path.read_text()) if history_path.is_file() else {}
                    source_entry = next((item for item in history.get("sessions", [])
                                         if item.get("date") == day), None)
                    if source_entry is None or entry.get("sourceSha256") != source_entry.get("sourceSha256"):
                        self.send_error(503, "Sweep source provenance mismatch")
                        return
                    path = sweep_root / entry["file"]
                    if not path.is_file():
                        self.send_error(404)
                        return
                    payload = path.read_bytes()
                    if hashlib.sha256(payload).hexdigest() != entry.get("sha256"):
                        self.send_error(503, "Sweep cache checksum mismatch")
                        return
                else:
                    payload = manifest_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            watchlist_replay = re.fullmatch(r"watchlist-replay/(AMD|TSLA|SPY|SMH|QQQ|META|NVDA|MU|MSFT|SOXL|SPCX|SNDK)/(20\d{2}-\d{2}-\d{2})\.json", name)
            early_replay = re.fullmatch(r"watchlist-early/(AMD|TSLA|SPY|SMH|QQQ|META|NVDA|MU|MSFT|SOXL|SPCX|SNDK)/(20\d{2}-\d{2}-\d{2})\.json", name)
            if name not in {"index.html", "app.js", "analytics.js", "tape-intelligence.js", "zone-tape.js", "shadow-cv2-adapter.js", "replay-chart.js", "history-windows.js",
                            "short-history-windows.js", "half-history-windows.js",
                            "replay-manifest.json", "microstructure-manifest.json", "watchlist-early-manifest.json"} and not re.fullmatch(
                                r"(?:replay|replay30|microstructure)/20\d{2}-\d{2}-\d{2}\.json|watchlist-history/(?:AMD|TSLA|SPY|SMH|QQQ|META|NVDA|MU|MSFT|SOXL|SPCX|SNDK)\.json", name) and not watchlist_replay and not early_replay:
                self.send_error(404)
                return
            if early_replay:
                symbol, day = early_replay.groups()
                manifest_path = ROOT / "analysis/watchlist-early-price-v1/manifest.json"
                if not manifest_path.is_file():
                    self.send_error(404)
                    return
                manifest = json.loads(manifest_path.read_text())
                entry = next((row for row in manifest.get("entries", []) if row.get("symbol") == symbol and row.get("date") == day), None)
                if entry is None or entry.get("file") != f"{symbol}/{day}.json":
                    self.send_error(404)
                    return
                path = ROOT / "analysis/watchlist-early-price-v1" / entry["file"]
            elif name == "watchlist-early-manifest.json":
                path = ROOT / "analysis/watchlist-early-price-v1/manifest.json"
            elif watchlist_replay:
                symbol, day = watchlist_replay.groups()
                history_path = PAGE / "watchlist-history" / f"{symbol}.json"
                if not history_path.is_file():
                    self.send_error(404)
                    return
                history = json.loads(history_path.read_text())
                entry = next((row for row in history.get("sessions", []) if row.get("date") == day), None)
                if entry is None or entry.get("file") not in (
                        f"replay/{symbol}/{day}.json", f"replay-full/{symbol}/{day}.json"):
                    self.send_error(404)
                    return
                path = ROOT / "analysis/watchlist-flow-history-v1" / entry["file"]
            else:
                path = PAGE / name
            if not path.is_file():
                self.send_error(404)
                return
            payload = path.read_bytes()
            micro_match = re.fullmatch(r"microstructure/(20\d{2}-\d{2}-\d{2})\.json", name)
            if micro_match:
                manifest_path = PAGE / "microstructure-manifest.json"
                manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
                micro_entry = next((item for item in manifest.get("sessions", [])
                                    if item.get("date") == micro_match.group(1) and
                                    item.get("file") == name), None)
                if micro_entry is None or hashlib.sha256(payload).hexdigest() != micro_entry.get("sha256"):
                    self.send_error(503, "Published microstructure checksum mismatch")
                    return
            if (watchlist_replay or early_replay) and hashlib.sha256(payload).hexdigest() != entry.get("sha256"):
                self.send_error(503, "Published replay checksum mismatch")
                return
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


def market_session_bounds(now: datetime) -> tuple[datetime, datetime] | None:
    """Chicago-time collector window, including holidays and early closes."""
    import exchange_calendars as calendars
    local_now = now.astimezone(CT)
    day = local_now.strftime("%Y-%m-%d")
    calendar = calendars.get_calendar("XNYS")
    if not calendar.is_session(day):
        return None
    hour, minute = map(int, SESSION_START_CT.split(":"))
    start = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    close = calendar.session_close(day).to_pydatetime().astimezone(CT)
    return start, close


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--raw-dir", type=Path, default=ROOT / "tmp/amd-live-tape-v1")
    parser.add_argument("--symbols", default=",".join(SYMBOLS), help="Legacy launch argument; watchlist is fixed")
    parser.add_argument("--max-rss-mb", type=int, default=512,
                        help="Stop live ingestion at this resident-memory ceiling (default: 512 MB)")
    parser.add_argument("--no-feed", action="store_true", help="Serve replay and UI without opening Massive")
    parser.add_argument("--persistent-no-feed", action="store_true",
                        help="Keep a separate no-feed replay server available during market hours")
    parser.add_argument("--live-upstream", default=None,
                        help="Optional loopback live API source for a no-feed dashboard")
    parser.add_argument("--observational-research", action="store_true",
                        help="Enable isolated research preview; disabled by default")
    parser.add_argument("--observational-instrumentation", action="store_true",
                        help="Record bounded local shadow diagnostics; disabled by default")
    parser.add_argument("--checkpoint-recovery", action="store_true",
                        help="L5.3 candidate: validated checkpoint plus journal tail; disabled by default")
    args = parser.parse_args()
    if args.max_rss_mb < 128:
        parser.error("--max-rss-mb must be at least 128")
    if args.persistent_no_feed and (not args.no_feed or args.port == 8765):
        parser.error("--persistent-no-feed requires --no-feed and a port other than 8765")
    if args.live_upstream and (not args.no_feed or args.live_upstream != "127.0.0.1:8765"):
        parser.error("--live-upstream is limited to the existing loopback collector")
    if args.observational_instrumentation and not args.observational_research:
        parser.error("--observational-instrumentation requires --observational-research")
    active_symbols = DEFAULT_WATCHLIST
    if not args.no_feed:
        now = datetime.now(CT)
        bounds = market_session_bounds(now)
        if bounds is None:
            print(f"AMD live tape: {now:%Y-%m-%d} is not a U.S. equity session; collector stopped", flush=True)
            return
        start_at, close_at = bounds
        if now < start_at or now >= close_at:
            print(f"AMD live tape: outside {SESSION_START_CT}–{close_at:%H:%M} CT; collector stopped", flush=True)
            return
    load_local_env()
    diagnostics = None
    state = TapeState(active_symbols, session_close_ct=close_at.strftime("%H:%M") if not args.no_feed else REGULAR_CLOSE_CT,
                      observational_research=args.observational_research)
    state.checkpoint_recovery = args.checkpoint_recovery and not args.no_feed
    if args.no_feed:
        state.startup_phase = "replay_only_http_serving"
    recovery = None
    checkpoint_path = None
    if args.checkpoint_recovery and not args.no_feed:
        research_path = PAGE / "research/live_observational_v1"
        sys.path.insert(0, str(research_path))
        import startup_recovery_l5_3 as recovery
        engine_file = research_path / "engine.py"
        state.checkpoint_manager = recovery.CheckpointManager(
            args.raw_dir / "startup-checkpoints" / f"{state.date}.json",
            server_hash=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            engine_hash=hashlib.sha256(engine_file.read_bytes()).hexdigest())
        checkpoint_path = state.checkpoint_manager.target
    # Reserve the dashboard port before touching the journal or opening the
    # account's single stock WebSocket. Duplicate starts fail without side effects.
    server = ThreadingHTTPServer((args.bind, args.port), handler(state, args.raw_dir, args.live_upstream))
    server.daemon_threads = True
    early_http_thread = None
    if args.checkpoint_recovery and not args.no_feed:
        state.startup_phase = "recovery_in_progress"
        early_http_thread = threading.Thread(target=server.serve_forever,
                                             daemon=True, name="l5_3_health_http")
        early_http_thread.start()
    if args.observational_instrumentation:
        research_path = PAGE / "research/live_observational_v1"
        sys.path.insert(0, str(research_path))
        from instrumentation import DiagnosticSink
        diagnostics = DiagnosticSink(args.raw_dir / "l4_1_diagnostics" /
                                     datetime.now(CT).strftime("%Y-%m-%d") /
                                     f"diagnostics-{state.run_id}.ndjson")
        state.diagnostics = diagnostics
        state.diagnostic_event_times = {}
    if not args.no_feed:
        try:
            recovered_events = 0
            if recovery is not None:
                journal = raw_path(args.raw_dir, state.date)
                record = None
                if journal.is_file():
                    try:
                        record = recovery.load(
                            checkpoint_path, journal, day=state.date,
                            symbols=active_symbols, close_ct=state.session_close_ct,
                            observational=args.observational_research,
                            server_hash=state.checkpoint_manager.server_hash,
                            engine_hash=state.checkpoint_manager.engine_hash)
                    except Exception as error:
                        state.checkpoint_rejection = f"{type(error).__name__}:{error}"
                if record is not None:
                    recovery.restore(state, record, sys.modules[__name__])
                    recovered_events = recover_journal_range(
                        state, args.raw_dir, state.date, record["journal"]["offset"])
                    state.startup_recovery_method = "checkpoint_and_verified_tail"
                else:
                    state.startup_recovery_method = "full_replay_degraded"
                    recovered_events = recover_today(state, args.raw_dir)
            else:
                recovered_events = recover_today(state, args.raw_dir)
            recover_latest_refill(state, args.raw_dir)
            if state.checkpoint_manager is not None:
                journal = raw_path(args.raw_dir, state.date)
                if journal.is_file():
                    journal_size = journal.stat().st_size
                    if journal_size:
                        with journal.open("rb") as source:
                            source.seek(-1, os.SEEK_END)
                            if source.read(1) != b"\n":
                                raise ValueError("truncated_final_journal_record")
                    try:
                        state.checkpoint_manager.maybe_capture(
                            state, journal, journal_size, force=True)
                    except Exception as error:
                        # A failed cache write is optional after verified
                        # recovery. A torn journal boundary above is not.
                        state.checkpoint_manager.last_error = f"{type(error).__name__}:{error}"
            state.startup_closed_stamps = {
                symbol: state.closed[symbol][-1]["stampMs"] if state.closed[symbol] else -1
                for symbol in active_symbols}
        except (OSError, ValueError, TypeError, RuntimeError) as error:
            state.startup_phase = "recovery_failure"
            state.startup_error = f"{type(error).__name__}:{error}"
            print(f"AMD live tape: startup recovery failed: {state.startup_error}", flush=True)
            if early_http_thread is not None:
                early_http_thread.join()
            return
        try:
            if recovered_events or (recovery is not None and record is not None and
                                    record["journal"]["offset"] > 0):
                state.mark_gap()
            append_raw(args.raw_dir, state.date,
                       [{"ev": "GAP", "reason": "server_restart"}], durable=True)
        except Exception as error:
            state.startup_phase = "recovery_failure"
            state.startup_error = f"restart_marker_failure:{type(error).__name__}:{error}"
            print(f"AMD live tape: startup recovery failed: {state.startup_error}", flush=True)
            if early_http_thread is not None:
                early_http_thread.join()
            return
        state.startup_recovered_at = time.monotonic()
        state.startup_phase = "market_data_connection_pending"
        memory_stop = threading.Event()
        threading.Thread(target=memory_guard,
                         args=(state, memory_stop, args.max_rss_mb), daemon=True).start()
        threading.Thread(target=collect,
                         args=(state, args.raw_dir, close_at, memory_stop), daemon=True).start()
        threading.Thread(target=refill_monitor, args=(state, args.raw_dir, close_at), daemon=True).start()
        threading.Thread(target=options_reference_monitor,
                         args=(state, args.raw_dir, close_at), daemon=True).start()
    if args.no_feed and not args.persistent_no_feed:
        # An after-hours replay server must release the port before launchd
        # starts the real collector at 03:00 CT on the next trading day.
        def release_before_open():
            while True:
                now = datetime.now(CT)
                bounds = market_session_bounds(now)
                if bounds and bounds[0] - timedelta(minutes=5) <= now < bounds[1]:
                    server.shutdown()
                    return
                time.sleep(30)
        threading.Thread(target=release_before_open, daemon=True).start()
    if not args.no_feed:
        def stop_at_close():
            remaining = (close_at - datetime.now(CT)).total_seconds()
            if remaining > 0:
                time.sleep(remaining)
            print(f"AMD live tape: exchange close at {close_at:%H:%M} CT; stopping", flush=True)
            server.shutdown()
            # Finalize the completed session outside the live collector. The
            # child waits ten minutes for REST historical data to settle and
            # publishes each symbol only after its raw/candle audit passes.
            log_path = args.raw_dir / f"session-sync-{state.date}.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a") as log:
                command = [sys.executable, str(ROOT / "scripts/sync-watchlist-session-v1.py"),
                           "--date", state.date, "--catch-up", "--wait-for-baselines", "--wait-until",
                           (close_at + timedelta(minutes=10)).astimezone(CT).strftime("%H:%M")]
                if sys.platform == "darwin":
                    command = ["/usr/bin/caffeinate", "-i", *command]
                subprocess.Popen(command,
                                 cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True, close_fds=True)
        threading.Thread(target=stop_at_close, daemon=True).start()
    print(f"AMD live tape: http://{args.bind}:{args.port}/", flush=True)
    try:
        if early_http_thread is not None:
            early_http_thread.join()
        else:
            server.serve_forever()
    finally:
        server.server_close()
        if diagnostics is not None:
            diagnostics.close()


if __name__ == "__main__":
    main()
