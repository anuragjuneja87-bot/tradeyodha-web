"""Point-in-time AMD context vectors over the archived peer-minute overlap.

Build offline with --build. Query with retrieve(); no future outcomes are indexed.
The one-year AMD-only matcher remains a separate fallback.
"""
from __future__ import annotations

import hashlib
import json
import math
import statistics
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PEERS = ROOT / "analysis/amd-expanded-90-session-v6/market-context"
HISTORY = ROOT / "analysis/amd-live-tape-v1/history-windows.js"
DEST = ROOT / "analysis/amd-live-tape-v1/context-memory-v1.json"
AUDIT = ROOT / "analysis/amd-live-tape-v1/context-source-audit-v1.json"
SWINGS = ROOT / "analysis/amd-daily-swing-levels-v1/all-confirmed-swings.jsonl"
SWING_SUMMARY = ROOT / "analysis/amd-daily-swing-levels-v1/summary.json"
MACRO = ROOT / "analysis/premarket-midpoint-amd-msft-30-v1/macro-split/event-calendar.json"
MACRO_MANIFEST = MACRO.parent / "manifest.json"
TAPE_ARCHIVE = Path("/Volumes/ArmorATD/tradeyodha-data/research/symbols/AMD/preservation-v1/opening-tape-v1")
SWING_ARCHIVE = Path("/Volumes/ArmorATD/tradeyodha-data/research/symbols/AMD/analysis/amd-daily-swing-levels-v1/all-confirmed-swings.jsonl")
SYMBOLS = ("AMD", "NVDA", "MU", "SMH", "QQQ")
SCALES = {"tapeDelta": .3, "tapeOfi": .16, "tapePriceBps": 55,
          "logClassifiedShares": 1.3, "amdMoveAtr": .45, "amdPace": .9,
          "nvdaMoveAtr": .45, "muMoveAtr": .45, "smhMoveAtr": .45,
          "qqqMoveAtr": .45, "pmMidDistanceAtr": .45,
          "orbLowDistanceAtr": .55, "orbHighDistanceAtr": .55,
          "priorCloseDistanceAtr": .6}
SCALES.update({"dailySwingDistanceAtr": .6, "dailySwingIsHigh": 1})
WEIGHTS = {"tapeDelta": 1, "tapeOfi": 1, "tapePriceBps": .7,
           "logClassifiedShares": .3, "amdMoveAtr": .7, "amdPace": .5,
           "nvdaMoveAtr": .45, "muMoveAtr": .45, "smhMoveAtr": .4,
           "qqqMoveAtr": .3, "pmMidDistanceAtr": .55,
           "orbLowDistanceAtr": .35, "orbHighDistanceAtr": .35,
           "priorCloseDistanceAtr": .45}
WEIGHTS.update({"dailySwingDistanceAtr": .25, "dailySwingIsHigh": .1})


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def _clock_minutes(value: str) -> int:
    return int(value[:2]) * 60 + int(value[3:5])


def _load_and_validate_sources():
    """Fail closed before any vectors are constructed or written."""
    import numpy as np
    import pandas as pd
    manifest_path = PEERS / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    requested = set(manifest["requestedSessionDates"])
    if len(requested) != 90 or not manifest["validation"]["unadjustedPrices"]:
        raise ValueError("Peer manifest date/price provenance invalid")
    frames, peer_audit = {}, {}
    for symbol in SYMBOLS:
        path = PEERS / f"{symbol}.parquet"
        frame = pd.read_parquet(path, columns=["date_ct", "minute_ct", "o", "h", "l", "c", "v"])
        numeric = frame[["o", "h", "l", "c", "v"]]
        valid = (np.isfinite(numeric).all(axis=1) & (frame["o"] > 0) & (frame["c"] > 0) &
                 (frame["h"] >= frame[["o", "c", "l"]].max(axis=1)) &
                 (frame["l"] <= frame[["o", "c", "h"]].min(axis=1)) & (frame["v"] >= 0))
        if (len(frame) != manifest["symbols"][symbol]["rows"] or not valid.all() or
                frame.duplicated(["date_ct", "minute_ct"]).any() or
                set(frame["date_ct"]) != requested or
                not frame["minute_ct"].astype(str).str.fullmatch(r"[0-2][0-9]:[0-5][0-9]").all()):
            raise ValueError(f"Peer archive failed row/OHLC/time/coverage validation: {symbol}")
        frames[symbol] = frame
        peer_audit[symbol] = {"rows": len(frame), "dates": len(requested), "sha256": _sha(path)}
    source = HISTORY.read_text()
    if not source.startswith("window.AMD_ANALYTICS_HISTORY="):
        raise ValueError("Unexpected AMD history format")
    history = json.loads(source.split("=", 1)[1].rstrip(";\n"))
    if history.get("version") != 2 or len(history["dates"]) != len(set(history["dates"])):
        raise ValueError("AMD history version/date validation failed")
    seen = set()
    for row in history["windows"]:
        if (len(row) != 10 or row[0] not in history["dates"] or row[2] not in (5, 15) or
                not isinstance(row[1], str) or len(row[1]) != 5 or
                not row[1][:2].isdigit() or not row[1][3:].isdigit() or row[1][2] != ":" or
                not 0 <= _clock_minutes(row[1]) < 24 * 60 or
                not all(_finite(v) for v in row[3:]) or row[6] < 0):
            raise ValueError("AMD history window validation failed")
        key = tuple(row[:3])
        if key in seen:
            raise ValueError("Duplicate AMD history window")
        seen.add(key)
    overlap = requested & set(history["dates"])
    if not TAPE_ARCHIVE.is_dir():
        raise ValueError("ArmorATD tape archive must be mounted to validate sources")
    archive_check = {"mounted": True, "verifiedDates": 0, "verifiedFiles": 0}
    for day in sorted(overlap):
        folder = TAPE_ARCHIVE / day
        meta = json.loads((folder / "metadata.json").read_text())
        if meta.get("date") != day or meta.get("symbol") != "AMD":
            raise ValueError(f"Tape metadata identity mismatch: {day}")
        for kind in ("trades", "quotes"):
            file = folder / f"stock-{kind}.ndjson.gz"
            if (file.stat().st_size != meta[kind]["bytes"] or
                _sha(file) != meta[kind]["sha256"] or
                meta[kind]["sha256"] != history["archiveHashes"][day][kind]):
                raise ValueError(f"Tape archive checksum mismatch: {day} {kind}")
            archive_check["verifiedFiles"] += 1
        archive_check["verifiedDates"] += 1
    swings = [json.loads(line) for line in SWINGS.read_text().splitlines() if line]
    summary = json.loads(SWING_SUMMARY.read_text())
    if len(swings) != summary["confirmedSwingCount"] or len({s["id"] for s in swings}) != len(swings):
        raise ValueError("Daily swing archive count/id validation failed")
    for swing in swings:
        if (swing["type"] not in ("swingHigh", "swingLow") or not _finite(swing["price"]) or
                swing["price"] <= 0 or not
                swing["pivotDate"] < swing["confirmedThroughDate"] < swing["firstAvailableDate"]):
            raise ValueError("Daily swing archive point-in-time validation failed")
    if not SWING_ARCHIVE.exists():
        raise ValueError("ArmorATD swing archive must be mounted to validate sources")
    if _sha(SWING_ARCHIVE) != _sha(SWINGS):
        raise ValueError("Local and ArmorATD daily swing archives differ")
    macro_bytes = MACRO.read_bytes()
    macro_entry = json.loads(MACRO_MANIFEST.read_text())["event-calendar.json"]
    if len(macro_bytes) != macro_entry["bytes"] or _sha(MACRO) != macro_entry["sha256"]:
        raise ValueError("Macro archive checksum validation failed")
    macro = json.loads(macro_bytes)
    if len(macro) != len({r["date"] for r in macro}):
        raise ValueError("Macro archive duplicate date")
    audit = {"version": 1, "status": "passed", "peerMinute": peer_audit,
             "amdHistory": {"windows": len(history["windows"]), "dates": len(history["dates"]), "sha256": _sha(HISTORY)},
             "dailySwings": {"count": len(swings), "sha256": _sha(SWINGS), "asOfRule": "firstAvailableDate <= session date"},
             "tapeArchive": archive_check,
             "macroCalendar": {"dates": len(macro), "sha256": _sha(MACRO), "ingested": False,
                               "reason": "Only 30 retrospective dates; incomplete point-in-time availability"},
             "optionsBars": {"ingested": False, "reason": "Bars do not contain historical chain open interest or signed dealer gamma"}}
    return frames, history, swings, audit


def _swing_features(swings: list, day: str, price: float, atr: float) -> dict:
    """Use only levels confirmed before the session, never the later pivot outcome."""
    if not atr or atr <= 0:
        return {}
    eligible = [s for s in swings if s["firstAvailableDate"] <= day and
                0 <= (date.fromisoformat(day) - date.fromisoformat(s["firstAvailableDate"])).days <= 180]
    if not eligible:
        return {}
    nearest = min(eligible, key=lambda s: (abs(price-s["price"]), -date.fromisoformat(s["firstAvailableDate"]).toordinal()))
    return {"dailySwingDistanceAtr": round((price-nearest["price"])/atr, 4),
            "dailySwingIsHigh": int(nearest["type"] == "swingHigh")}


def build() -> dict:
    frames, history, swings, audit = _load_and_validate_sources()
    paths = {symbol: PEERS / f"{symbol}.parquet" for symbol in SYMBOLS}
    by_symbol = {}
    dates = None
    for symbol, path in paths.items():
        frame = frames[symbol]
        grouped = {day: {str(row.minute_ct): row for row in part.itertuples(index=False)}
                   for day, part in frame.groupby("date_ct", sort=True)}
        by_symbol[symbol] = grouped
        dates = set(grouped) if dates is None else dates & set(grouped)
    days = sorted(dates or [])
    daily = {}
    for symbol in SYMBOLS:
        daily[symbol] = {}
        for day in days:
            regular = [row for clock, row in sorted(by_symbol[symbol][day].items())
                       if "08:30" <= clock < "15:00"]
            if len(regular) >= 300:
                daily[symbol][day] = {"h": max(row.h for row in regular),
                                      "l": min(row.l for row in regular),
                                      "c": regular[-1].c}
    atr = defaultdict(dict)
    for symbol in SYMBOLS:
        good = sorted(daily[symbol])
        for idx in range(15, len(good)):
            ranges = []
            for j in range(idx - 14, idx):
                cur, prev = daily[symbol][good[j]], daily[symbol][good[j-1]]
                ranges.append(max(cur["h"]-cur["l"], abs(cur["h"]-prev["c"]),
                                  abs(cur["l"]-prev["c"])))
            atr[symbol][good[idx]] = statistics.mean(ranges)
    candidates = [row for row in history["windows"] if row[0] in dates and
                  row[2] in (5, 15) and _clock_minutes(row[1]) % 5 == 0]
    vectors = []
    for row in candidates:
        day, clock, width = row[:3]
        phase_start = "06:00" if clock < "08:30" else "08:30"
        phase = "premarket" if clock < "08:30" else "regular"
        features = {"tapeDelta": row[3], "tapeOfi": row[4],
                    "tapePriceBps": row[5],
                    "logClassifiedShares": math.log1p(row[6]) if row[6] > 0 else None}
        usable = True
        for symbol in SYMBOLS:
            today = by_symbol[symbol][day]
            current = today.get(clock)
            opening = today.get(phase_start)
            own_atr = atr[symbol].get(day)
            if not current or not opening or not own_atr:
                usable = False
                break
            move = (current.c - opening.o) / own_atr
            features[(symbol.lower() + "MoveAtr")] = round(move, 4)
        if not usable:
            continue
        amd = by_symbol["AMD"][day]
        price = amd[clock].c
        amd_atr = atr["AMD"][day]
        features.update(_swing_features(swings, day, price, amd_atr))
        pm = [r for t, r in amd.items() if "03:00" <= t <= min(clock, "08:24")]
        if pm:
            features["pmMidDistanceAtr"] = round((price - (max(r.h for r in pm) + min(r.l for r in pm))/2) / amd_atr, 4)
        orb = [amd.get(f"08:{minute:02d}") for minute in range(30, 35)]
        if clock >= "08:35" and all(orb):
            features["orbLowDistanceAtr"] = round((price - min(r.l for r in orb)) / amd_atr, 4)
            features["orbHighDistanceAtr"] = round((price - max(r.h for r in orb)) / amd_atr, 4)
        earlier = [d for d in days if d < day and d in daily["AMD"]]
        if earlier:
            features["priorCloseDistanceAtr"] = round((price - daily["AMD"][earlier[-1]]["c"]) / amd_atr, 4)
        prior_days = [d for d in days if d < day and d in by_symbol["AMD"]][-20:]
        base_volumes = []
        for previous in prior_days:
            total = sum(r.v for t, r in by_symbol["AMD"][previous].items()
                        if phase_start <= t <= clock)
            if total > 0:
                base_volumes.append(total)
        current_volume = sum(r.v for t, r in amd.items() if phase_start <= t <= clock)
        if len(base_volumes) >= 10 and statistics.median(base_volumes) > 0:
            features["amdPace"] = round(current_volume / statistics.median(base_volumes), 3)
        vectors.append({"date": day, "endCt": clock, "width": width,
                        "phase": phase, "price": round(price, 3), "features": features,
                        "coverage": sorted(features)})
    artifact = {"version": 1, "source": "Existing checksum-linked AMD tape history plus Massive peer minute parquet",
                "coverage": {"first": days[0], "last": days[-1], "candidateDates": len(days),
                             "indexedDates": len({r['date'] for r in vectors}),
                             "vectors": len(vectors), "symbols": list(SYMBOLS),
                             "missingHistorical": ["SNDK peer tape", "complete macro calendar",
                                                   "full historical news availability", "options walls",
                                                   "hourly/four-hour level-bot snapshots"]},
                "provenance": {"amdHistorySha256": _sha(HISTORY),
                               "peerParquetSha256": {s: _sha(p) for s,p in paths.items()},
                               "dailySwingsSha256": _sha(SWINGS), "sourceAuditSha256": None},
                "dailySwings": swings,
                "scales": SCALES, "weights": WEIGHTS, "vectors": vectors}
    audit_text = json.dumps(audit, indent=2) + "\n"
    artifact["provenance"]["sourceAuditSha256"] = hashlib.sha256(audit_text.encode()).hexdigest()
    audit_tmp = AUDIT.with_suffix(".json.tmp")
    dest_tmp = DEST.with_suffix(".json.tmp")
    audit_tmp.write_text(audit_text)
    dest_tmp.write_text(json.dumps(artifact, separators=(",", ":")) + "\n")
    audit_tmp.replace(AUDIT)
    dest_tmp.replace(DEST)
    return artifact["coverage"]


def query_features(context: dict, day: str | None = None, swings: list | None = None) -> dict:
    current = context.get("current") or {}
    latest = context.get("latest") or {}
    peer = (context.get("marketContextBot") or {}).get("states") or {}
    levels = context.get("levels") or {}
    pm = levels.get("premarket") or {}
    orb = levels.get("orb5") or {}
    prior = (context.get("priorDay") or {}).get("priorSession") or {}
    amd = peer.get("AMD") or {}
    atr = amd.get("atr14")
    price = latest.get("c")
    result = {"tapeDelta": current.get("delta"), "tapeOfi": current.get("ofi"),
              "tapePriceBps": current.get("priceBps"),
              "logClassifiedShares": math.log1p(current["classified"]) if current.get("classified", 0) > 0 else None,
              "amdPace": amd.get("sameClockVolumePace")}
    for symbol in SYMBOLS:
        result[symbol.lower() + "MoveAtr"] = (peer.get(symbol) or {}).get("moveInOwnAtr")
    if atr and price:
        if day and swings is not None:
            result.update(_swing_features(swings, day, price, atr))
        for key, level in (("pmMidDistanceAtr", pm.get("midpoint")),
                           ("orbLowDistanceAtr", orb.get("low")),
                           ("orbHighDistanceAtr", orb.get("high")),
                           ("priorCloseDistanceAtr", prior.get("close"))):
            if level is not None:
                result[key] = (price - level) / atr
    return {key: value for key, value in result.items() if _finite(value)}


def retrieve(context: dict, day: str, memory: dict, limit: int = 5) -> dict:
    """Strictly earlier dates, same phase/width, nearby clock; distinct-day matches."""
    current = context.get("current") or {}
    clock = context.get("asOf")
    width = current.get("width")
    if not clock or not width:
        return {"available": False, "reason": "Current AMD tape window unavailable"}
    phase = "premarket" if clock < "08:30" else "regular"
    features = query_features(context, day, memory.get("dailySwings"))
    if len(features) < 7:
        return {"available": False, "reason": "Current cross-tool feature coverage too thin",
                "currentFeatures": sorted(features)}
    ranked = []
    for row in memory.get("vectors", []):
        if row["date"] >= day or row["phase"] != phase or row["width"] != width or abs(_clock_minutes(row["endCt"])-_clock_minutes(clock)) > 15:
            continue
        common = [key for key in features if key in row["features"] and key in SCALES]
        if len(common) < 7 or not all(key in common for key in ("tapeDelta", "tapeOfi", "tapePriceBps", "amdMoveAtr")):
            continue
        weight = sum(WEIGHTS[key] for key in common)
        distance = math.sqrt(sum(WEIGHTS[key] * ((features[key]-row["features"][key])/SCALES[key])**2 for key in common) / weight)
        ranked.append((distance, row, common))
    ranked.sort(key=lambda item: item[0])
    matches, seen = [], set()
    for distance, row, common in ranked:
        if row["date"] in seen:
            continue
        seen.add(row["date"])
        matches.append({"date": row["date"], "endCt": row["endCt"],
                        "distance": round(distance, 3), "featuresCompared": common,
                        "historicalPrice": row["price"],
                        "historicalFeatures": {key: row["features"][key] for key in common}})
        if len(matches) >= limit:
            break
    return {"available": len(matches) >= 3, "method": "fixed-scale numeric vector distance; no learned model",
            "phase": phase, "width": width, "priorCandidates": len(ranked),
            "matches": matches, "currentFeatures": features,
            "coverage": memory.get("coverage"),
            "limitations": "Historical macro/news, SNDK, options walls, and hourly/four-hour levels are not in this index. Confirmed daily swing levels are retrospective candidate zones, not validated support/resistance. No outcomes are retrieved."}


if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
