"""Causal daily, hourly, and four-hour price-structure levels for one stock.

The bot proposes observed reference levels. A candle alone cannot establish the
identity of resting buyers or sellers, and no candidate is an entry signal.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo

CT = ZoneInfo("America/Chicago")


def _clock(stamp: int) -> datetime:
    return datetime.fromtimestamp(stamp / 1000, CT)


def _daily_date(row: dict) -> str:
    # Massive daily aggregates are stamped at midnight UTC, not midnight CT.
    return datetime.fromtimestamp(row["t"] / 1000, timezone.utc).date().isoformat()


def premarket_levels(minutes: list[dict], day: str, asof_ms: int) -> dict:
    """Observed 03:00–08:25 CT bars available by the selected minute."""
    rows = []
    for row in minutes:
        stamp = int(row["t"])
        local = _clock(stamp)
        if (local.date().isoformat() == day and "03:00" <= local.strftime("%H:%M") <= "08:25"
                and stamp + 60_000 <= asof_ms):
            rows.append(row)
    if not rows:
        return {"available": False, "reason": "No completed 03:00–08:25 CT bars as of this minute"}
    rows.sort(key=lambda row: row["t"])
    high, low = max(float(row["h"]) for row in rows), min(float(row["l"]) for row in rows)
    midpoint = (Decimal(str(high)) + Decimal(str(low))) / 2
    return {"available": True, "high": round(high, 2), "low": round(low, 2),
            "midpoint": float(midpoint.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "barCount": len(rows),
            "firstCt": _clock(rows[0]["t"]).strftime("%H:%M"),
            "lastCt": _clock(rows[-1]["t"]).strftime("%H:%M"),
            "complete": _clock(asof_ms).strftime("%H:%M") >= "08:26"}


def completed_regular_candles(minutes: list[dict], asof_ms: int, length: int) -> list[dict]:
    """Regular-session buckets anchored at 08:30 CT; omit incomplete buckets."""
    grouped = defaultdict(list)
    for row in minutes:
        stamp = int(row["t"])
        if stamp + 60_000 > asof_ms:
            continue
        dt = _clock(stamp)
        minute_of_day = dt.hour * 60 + dt.minute
        if not 510 <= minute_of_day < 900:
            continue
        offset = minute_of_day - 510
        bucket = offset // length
        start = dt.replace(hour=8, minute=30, second=0, microsecond=0) + timedelta(minutes=bucket * length)
        expected = min(length, 390 - bucket * length)
        # The final 150-minute RTH fragment is not a completed four-hour candle.
        if expected != length:
            continue
        grouped[(dt.date().isoformat(), bucket, int(start.timestamp() * 1000))].append(row)
    candles = []
    for (date, bucket, start_ms), rows in sorted(grouped.items()):
        if start_ms + length * 60_000 > asof_ms or len(rows) < int(length * 0.95):
            continue
        rows = sorted(rows, key=lambda row: row["t"])
        candles.append({"date": date, "startCt": _clock(start_ms).strftime("%H:%M"),
                        "endCt": _clock(start_ms + length * 60_000).strftime("%H:%M"),
                        "o": float(rows[0]["o"]), "h": max(float(row["h"]) for row in rows),
                        "l": min(float(row["l"]) for row in rows),
                        "c": float(rows[-1]["c"]), "v": sum(float(row["v"]) for row in rows),
                        "startMs": start_ms, "barCount": len(rows)})
    return candles


def _confirmed_pivots(rows: list[dict], label: str, left: int = 2, right: int = 2) -> list[dict]:
    points = []
    for index in range(left, len(rows) - right):
        row = rows[index]
        neighbors = rows[index - left:index] + rows[index + 1:index + right + 1]
        for field, side in (("h", "resistance"), ("l", "support")):
            price = float(row[field])
            other = [float(item[field]) for item in neighbors]
            if (price > max(other)) if side == "resistance" else (price < min(other)):
                points.append({"price": round(price, 2), "side": side, "timeframe": label,
                               "kind": "confirmed_pivot", "sourceDate": row["date"],
                               "sourceCt": row.get("startCt"),
                               "confirmedThrough": rows[index + right]["date"]})
    return points


def _daily_low_zones(daily: list[dict], reference: float) -> list[dict]:
    """Group repeated recent daily lows into observed bands, with no hindsight outcome."""
    lows = sorted((float(row["l"]), row["date"]) for row in daily[-35:]
                  if 0.85 * reference <= float(row["l"]) <= 1.1 * reference)
    groups: list[list[tuple[float, str]]] = []
    tolerance = reference * 0.022
    for item in lows:
        if groups and item[0] - groups[-1][0][0] <= tolerance:
            groups[-1].append(item)
        else:
            groups.append([item])
    zones = []
    for group in groups:
        dates = sorted({date for _, date in group})
        if len(dates) < 2:
            continue
        low, high = round(group[0][0], 2), round(group[-1][0], 2)
        zones.append({"low": low, "high": high, "side": "support", "timeframe": "daily",
                      "kind": "repeated_daily_lows", "sourceDates": dates,
                      "touches": len(dates), "widthPct": round(100 * (high - low) / reference, 2)})
    return zones


def find_symbol_levels(symbol: str, asof_ms: int, daily_rows: list[dict], minute_rows: list[dict],
                       reference_price: float | None = None) -> dict:
    """Return only candles fully known at asof_ms; never use today's daily OHLC."""
    asof_date = _clock(asof_ms).date().isoformat()
    daily = [{**row, "date": _daily_date(row)} for row in daily_rows if _daily_date(row) < asof_date]
    daily.sort(key=lambda row: row["date"])
    if len(daily) < 6:
        return {"available": False, "symbol": symbol, "reason": "Fewer than six completed daily bars"}
    price = float(reference_price) if reference_price is not None else float(daily[-1]["c"])
    hourly = completed_regular_candles(minute_rows, asof_ms, 60)
    four_hour = completed_regular_candles(minute_rows, asof_ms, 240)
    prior = daily[-1]
    points = [
        {"price": round(float(prior["h"]), 2), "side": "resistance", "timeframe": "daily",
         "kind": "prior_high", "sourceDate": prior["date"]},
        {"price": round(float(prior["l"]), 2), "side": "support", "timeframe": "daily",
         "kind": "prior_low", "sourceDate": prior["date"]},
        {"price": round(float(prior["c"]), 2), "side": "reference", "timeframe": "daily",
         "kind": "prior_close", "sourceDate": prior["date"]},
    ]
    points.extend(_confirmed_pivots(daily, "daily"))
    points.extend(_confirmed_pivots(hourly, "hourly"))
    points.extend(_confirmed_pivots(four_hour, "four_hour"))
    for row in daily[-8:-1]:
        points.append({"price": round(float(row["l"]), 2), "side": "support", "timeframe": "daily",
                       "kind": "recent_low", "sourceDate": row["date"]})
    points = [point for point in points if abs(point["price"] / price - 1) <= 0.12]
    merged = {}
    for point in points:
        key = (point["price"], point["side"])
        item = merged.setdefault(key, {"price": point["price"], "side": point["side"],
                                       "timeframes": set(), "kinds": set(), "sourceDates": set()})
        item["timeframes"].add(point["timeframe"])
        item["kinds"].add(point["kind"])
        item["sourceDates"].add(point["sourceDate"])
    levels = [{**item, "timeframes": sorted(item["timeframes"]),
               "kinds": sorted(item["kinds"]), "sourceDates": sorted(item["sourceDates"])}
              for item in merged.values()]
    levels.sort(key=lambda item: (abs(item["price"] - price),
                                  -len(item["timeframes"]), item["price"]))
    zones = _daily_low_zones(daily, price)
    zones.sort(key=lambda zone: (max(zone["low"] - price, price - zone["high"], 0),
                                 -zone["touches"]))
    return {"available": True, "symbol": symbol, "asOfCt": _clock(asof_ms).isoformat(),
            "referencePrice": round(price, 2), "lastCompletedDailyDate": prior["date"],
            "completedCandles": {"daily": len(daily), "fourHour": len(four_hour), "hourly": len(hourly)},
            "levels": levels[:12], "dailyLowZones": zones[:4],
            "method": "Confirmed 2-left/2-right pivots, prior high/low/close, recent daily lows, "
                      "and repeated daily-low bands. Intraday candles use 08:30 CT RTH anchor; "
                      "four-hour candles are complete 08:30–12:30 CT only. All daily bars end "
                      "before the as-of date. These are candidates, not proved buyer/seller orders.",
            "source": "Massive unadjusted daily and one-minute OHLCV aggregates"}
