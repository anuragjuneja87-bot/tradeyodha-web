#!/usr/bin/env python3
"""Build local, replay-only sweep candidates from preserved watchlist tape.

Outputs stay under ignored tmp/. A candidate is same-participant-millisecond,
same estimated side, at least 1,000 shares across two or more lit venues.
It is not a confirmed parent order or a trading signal.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import heapq
import json
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "analysis/watchlist-flow-history-v1/raw-full"
REPLAY = ROOT / "analysis/watchlist-flow-history-v1/replay-full"
OUTPUT = ROOT / "tmp/amd-live-tape-v1/replay-sweeps-v1"
PAGE = ROOT / "analysis/amd-live-tape-v1"
CT = ZoneInfo("America/Chicago")
TRF = {int(x["id"]) for x in json.loads((PAGE / "reference/exchanges.json").read_text()) if x.get("type") == "TRF"}
CONDITIONS = {int(x["id"]): x for x in json.loads((PAGE / "reference/trade-conditions.json").read_text())}
NON_CONTINUOUS = {8, 9, 15, 17, 19, 25, 52, 53}
NON_DIRECTIONAL = {2, 7, 13, 15, 16, 20, 21, 29, 32, 33, 38, 52, 53}
SYMBOLS = ("AMD", "TSLA", "SPY", "QQQ", "META", "NVDA", "MU", "MSFT", "SOXL", "SPCX", "SNDK")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def source_rows(path: Path):
    prior = -1
    with gzip.open(path, "rt") as source:
        for line in source:
            row = json.loads(line)
            stamp = row.get("sip_timestamp")
            if not isinstance(stamp, int) or stamp < prior:
                raise ValueError(f"Nonmonotonic or missing SIP timestamp: {path}")
            prior = stamp
            yield row


def verified_sources(symbol: str, day: str, raw_root: Path = RAW, replay_root: Path = REPLAY):
    if symbol not in SYMBOLS or not datetime.strptime(day, "%Y-%m-%d").strftime("%Y-%m-%d") == day:
        raise ValueError("Invalid symbol or session date")
    folder = raw_root / symbol / day
    metadata = {}
    for kind in ("trades", "quotes"):
        sidecar = json.loads((folder / f"stock-{kind}.json").read_text())
        path = folder / f"stock-{kind}.ndjson.gz"
        if (sidecar.get("symbol"), sidecar.get("date"), sidecar.get("kind")) != (symbol, day, kind):
            raise ValueError("Raw sidecar identity mismatch")
        if path.stat().st_size != sidecar["bytes"] or sha256(path) != sidecar["sha256"]:
            raise ValueError("Raw archive checksum mismatch")
        metadata[kind] = sidecar
    replay = json.loads((replay_root / symbol / f"{day}.json").read_text())
    if (replay.get("symbol"), replay.get("date")) != (symbol, day):
        raise ValueError("Replay identity mismatch")
    if replay.get("sourceSha256") != {kind: metadata[kind]["sha256"] for kind in metadata}:
        raise ValueError("Replay source checksum mismatch")
    return folder, metadata, replay


def eligible_trade(row: dict) -> bool:
    ids = set(row.get("conditions") or [])
    return (row.get("price") or 0) > 0 and (row.get("size") or 0) > 0 and row.get("exchange") not in TRF \
        and not row.get("trf_id") and not ids.intersection(NON_CONTINUOUS | NON_DIRECTIONAL) \
        and not any(CONDITIONS.get(code, {}).get("update_rules", {}).get("consolidated", {}).get("updates_volume") is False for code in ids)


def valid_quote(row: dict) -> bool:
    return (row.get("bid_price") or 0) > 0 and (row.get("ask_price") or 0) > row["bid_price"] \
        and (row.get("bid_size") or 0) > 0 and (row.get("ask_size") or 0) > 0


def compute(symbol: str, day: str, raw_root: Path = RAW, replay_root: Path = REPLAY) -> tuple[dict, int]:
    folder, metadata, replay = verified_sources(symbol, day, raw_root, replay_root)
    trades = source_rows(folder / "stock-trades.ndjson.gz")
    quotes = source_rows(folder / "stock-quotes.ndjson.gz")
    # Quote wins an exact SIP-nanosecond tie, as in the existing replay builder.
    merged = heapq.merge(((row["sip_timestamp"], 1, index, row) for index, row in enumerate(trades)),
                         ((row["sip_timestamp"], 0, index, row) for index, row in enumerate(quotes)))
    quote = None
    counts = {"trades": 0, "quotes": 0}
    classified = defaultdict(lambda: [0, 0])
    groups = defaultdict(lambda: [0, None, False])
    day_start = int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=CT).timestamp() * 1000)
    day_end = int((datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=CT) + timedelta(days=1)).timestamp() * 1000)
    for sip_ns, kind, _index, row in merged:
        stamp = sip_ns // 1_000_000
        if not day_start <= stamp < day_end:
            raise ValueError("Raw event outside declared session date")
        counts["quotes" if kind == 0 else "trades"] += 1
        if kind == 0:
            if valid_quote(row):
                quote = row
            continue
        if not eligible_trade(row) or quote is None:
            continue
        participant = row.get("participant_timestamp")
        if not isinstance(participant, int):
            continue
        pt = participant // 1_000_000
        quote_ms = quote["sip_timestamp"] // 1_000_000
        if not (0 <= stamp - pt <= 1000 and 0 <= stamp - quote_ms <= 2000):
            continue
        mid = (quote["bid_price"] + quote["ask_price"]) / 2
        price = row["price"]
        side = 1 if price > mid + 1e-7 else 0 if price < mid - 1e-7 else None
        if side is None:
            continue
        bucket = stamp // 30_000 * 30_000
        size = row["size"]
        classified[bucket][side] += size
        group = groups[(bucket, pt, side)]
        group[0] += size
        exchange = row["exchange"]
        if group[1] is None:
            group[1] = exchange
        elif exchange != group[1]:
            group[2] = True
    if any(counts[kind] != metadata[kind]["rows"] for kind in counts):
        raise ValueError("Raw row count mismatch")
    # Every published bucket must match the independently built full-session
    # candle classification. Missing replay bars remain unavailable, not zero.
    replay_bars = {bar["stampMs"]: bar for bar in replay["bars"]["30s"]}
    matched = 0
    for stamp, bar in replay_bars.items():
        observed = classified.get(stamp, [0, 0])
        if observed != [bar["sell"], bar["buy"]]:
            raise ValueError(f"30-second classified-side parity failed: {symbol} {day} {bar['t']}")
        matched += 1
    # A trade-only interval can lack a price-forming candle in the published
    # replay. It is intentionally omitted; neighboring multi-minute candles
    # fail closed when a constituent 30-second candle is absent.
    if matched < 200:
        raise ValueError("Incomplete 30-second replay parity")
    candidates = defaultdict(lambda: [0, 0, 0, 0])
    for (stamp, _pt, side), (shares, _venue, multi_venue) in groups.items():
        if multi_venue and shares >= 1000:
            entry = candidates[stamp]
            slot = 2 if side else 0
            entry[slot] += 1
            entry[slot + 1] += round(shares)
    bars = [{"stampMs": stamp,
             "sellSweepCandidates": candidates[stamp][0], "sellSweepShares": candidates[stamp][1],
             "buySweepCandidates": candidates[stamp][2], "buySweepShares": candidates[stamp][3]}
            for stamp in sorted(replay_bars)]
    return {"symbol": symbol, "date": day, "sourceSha256": replay["sourceSha256"],
            "method": "same participant millisecond, quote-estimated side, >=1000 lit shares across >=2 venues; candidate only",
            "parityChecks": matched, "bars": bars}, matched


def publish(symbols: tuple[str, ...], days: tuple[str, ...], output_root: Path = OUTPUT):
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {"version": 1, "sessions": []}
    sessions = {(row["symbol"], row["date"]): row for row in manifest["sessions"]}
    for symbol in symbols:
        for day in days:
            payload, checks = compute(symbol, day)
            target = output_root / symbol / f"{day}.json"
            target.parent.mkdir(exist_ok=True)
            temporary = target.with_suffix(".partial")
            temporary.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
            temporary.replace(target)
            sessions[(symbol, day)] = {"symbol": symbol, "date": day,
                "file": f"{symbol}/{day}.json", "sha256": sha256(target),
                "sourceSha256": payload["sourceSha256"], "buckets": len(payload["bars"]),
                "parityChecks": checks}
            print(symbol, day, checks, "verified 30-second buckets", flush=True)
            updated = {"version": 1, "sessions": sorted(sessions.values(),
                       key=lambda item: (item["symbol"], item["date"]))}
            temp_manifest = manifest_path.with_suffix(".partial")
            temp_manifest.write_text(json.dumps(updated, indent=2) + "\n")
            temp_manifest.replace(manifest_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dates", nargs="+")
    parser.add_argument("--symbols", nargs="+", choices=SYMBOLS, default=SYMBOLS)
    args = parser.parse_args()
    publish(tuple(args.symbols), tuple(args.dates))
