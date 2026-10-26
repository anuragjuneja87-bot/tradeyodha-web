"""Read-only adapter for archived Shadow C_v2 comparisons.

This does not compute live scores. It exposes only scores already frozen by the
chronological research comparison; the dashboard feature flag remains off until
identical live and historical event streams have passed parity checks.
"""
from __future__ import annotations

import csv
import gzip
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPARISONS = ROOT / "analysis/amd-live-tape-v1/research/candle_scoring_shadow_v2/outputs/comparisons"
WATCHLIST_EXTENSION_COMPARISONS = (ROOT / "analysis/amd-live-tape-v1/research/"
    "candle_scoring_shadow_v2/watchlist_extension_2026_10_21/comparisons")
SYMBOLS = frozenset(("AMD", "TSLA", "SPY", "SMH", "QQQ", "META", "NVDA", "MU", "MSFT", "SOXL", "SPCX", "SNDK"))
WATCHLIST_EXTENSION_SYMBOLS = frozenset(("SPCX", "SNDK"))
WIDTHS = frozenset(("0.5", "1", "2", "5", "15"))


def archived_cv2(symbol: str, day: str) -> dict:
    if symbol not in SYMBOLS or not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", day):
        raise ValueError("Invalid symbol or date")
    directory = (WATCHLIST_EXTENSION_COMPARISONS if symbol in WATCHLIST_EXTENSION_SYMBOLS
                 else COMPARISONS)
    path = directory / f"{symbol}.csv.gz"
    if not path.is_file():
        raise FileNotFoundError(path)
    windows = {width: {} for width in WIDTHS}
    with gzip.open(path, "rt", newline="") as source:
        for row in csv.DictReader(source):
            if row["date"] != day:
                continue
            if row["symbol"] != symbol or row["width"] not in WIDTHS:
                raise ValueError("Shadow comparison provenance mismatch")
            score = int(row["C_v2"]) if row["C_v2"] else None
            reason = row["reasons"].replace("|", "; ") if row["reasons"] else None
            if score is None and reason is None:
                raise ValueError("Missing score without quality reason")
            if score is not None and (reason is not None or not -100 <= score <= 100):
                raise ValueError("Invalid shadow score or quality reason")
            windows[row["width"]][row["time"]] = {
                "score": score,
                "reason": reason,
                "priorDates": int(row["priorDates"]),
                "coverageAll": float(row["coverageAll"]) if row["coverageAll"] else None,
                "quoteAgeMs": int(row["quoteAgeMs"]) if row["quoteAgeMs"] else None,
                # Descriptive raw-tape evidence for replay-only delta-border
                # agreement. Existing score fields and gates are unchanged.
                "rawTradeDelta": float(row["tradeDelta"]) if row["tradeDelta"] else None,
                "rawClassified": int(row["classified"]) if row["classified"] else None,
                "validQuotePairs": int(row["quotePairs2s"]) if row["quotePairs2s"] else 0,
            }
    if not any(windows.values()):
        raise FileNotFoundError(f"No Shadow C_v2 comparison for {symbol} {day}")
    return {"symbol": symbol, "date": day, "source": "historical_rest_raw",
            "version": "Shadow C_v2", "windows": windows}
