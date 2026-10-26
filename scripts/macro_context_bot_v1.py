"""As-of broader-market context: official release schedule, vendor news, liquid proxies.

This component is descriptive. It never infers a live Treasury yield from bond ETF
prices, nor treats a scheduled release as known before its publication time.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

CT = ZoneInfo("America/Chicago")
ET = ZoneInfo("America/New_York")
NEWS_LAG = timedelta(minutes=60)  # Massive news endpoint documents hourly updates.
MACRO_TERMS = ("fomc", "federal reserve", "fed minutes", "fed rate", "interest rate", "treasury",
               "bond yield", "cpi", "inflation", "jobs report", "employment",
               "pce", "gdp", "economic data", "stock market", "wall street",
               "market futures", "yield curve", "powell", "tariff")


def _event_rows(catalog: dict, day: str, asof_ms: int) -> dict:
    covered = catalog.get("coverageStart", "9999") <= day <= catalog.get("coverageEnd", "0000")
    events = []
    for item in catalog.get("events", []):
        if item.get("date") != day:
            continue
        event_et = datetime.fromisoformat(f"{day}T{item['timeEt']}").replace(tzinfo=ET)
        stamp = int(event_et.timestamp() * 1000)
        events.append({"name": item["name"], "category": item["category"],
                       "scheduledCt": event_et.astimezone(CT).strftime("%H:%M"),
                       "scheduledStampMs": stamp,
                       "status": "scheduled" if stamp > asof_ms else "release_time_passed",
                       "minutesUntil": round((stamp - asof_ms) / 60000) if stamp > asof_ms else None,
                       "source": item["source"]})
    return {"coverage": "cataloged" if covered else "unavailable",
            "verifiedOn": catalog.get("verifiedOn"), "events": events}


def _headline_rows(articles: list[dict], asof_ms: int, market_wide: bool) -> dict:
    cutoff = datetime.fromtimestamp(asof_ms / 1000, timezone.utc)
    seen = set()
    eligible = []
    for item in articles:
        try:
            published = datetime.fromisoformat(item["published_utc"].replace("Z", "+00:00"))
        except (KeyError, ValueError, TypeError):
            continue
        if published.tzinfo is None or published + NEWS_LAG > cutoff:
            continue
        title = item.get("title") or ""
        keywords = " ".join(str(value) for value in item.get("keywords") or [])
        tagged = any(term in (title + " " + keywords).lower() for term in MACRO_TERMS)
        if market_wide and not tagged:
            continue
        identity = item.get("id") or (title, item["published_utc"])
        if identity in seen:
            continue
        seen.add(identity)
        insights = item.get("insights") or []
        amd = next((row for row in insights if row.get("ticker") == "AMD"), None)
        eligible.append({"title": title, "publishedUtc": item["published_utc"],
                         "conservativeAvailableUtc": (published + NEWS_LAG).isoformat(),
                         "publisher": (item.get("publisher") or {}).get("name"),
                         "url": item.get("article_url"),
                         "tickers": (item.get("tickers") or [])[:12],
                         "amdSentiment": amd.get("sentiment") if amd else None})
    eligible.sort(key=lambda row: row["publishedUtc"], reverse=True)
    return {"countInFetchedWindow": len(eligible), "latest": eligible[:8],
            "availabilityRule": "published UTC plus 60 minutes; vendor hourly-update assumption"}


def _proxy_row(symbol: str, rows: list[dict], day: str, asof_ms: int) -> dict:
    today = [row for row in rows if row.get("t", 0) <= asof_ms and
             datetime.fromtimestamp(row["t"] / 1000, CT).strftime("%Y-%m-%d") == day]
    today.sort(key=lambda row: row["t"])
    six = next((row for row in today if "06:00" <=
                datetime.fromtimestamp(row["t"] / 1000, CT).strftime("%H:%M") < "08:30"), None)
    open_bar = next((row for row in today if datetime.fromtimestamp(row["t"] / 1000, CT).strftime("%H:%M") >= "08:30"), None)
    last = today[-1] if today else None
    if not last or not six:
        return {"available": False, "symbol": symbol}
    close = float(last["c"])
    def pct(base):
        return round(100 * (close / float(base) - 1), 3) if base and float(base) > 0 else None
    return {"available": True, "symbol": symbol,
            "asOfCt": datetime.fromtimestamp(last["t"] / 1000, CT).strftime("%H:%M"),
            "baselineCt": datetime.fromtimestamp(six["t"] / 1000, CT).strftime("%H:%M"),
            "close": round(close, 3), "since06Pct": pct(six["o"]),
            "sinceOpenPct": pct(open_bar["o"]) if open_bar and asof_ms >= open_bar["t"] else None,
            "interpretation": "ETF price; not a Treasury yield" if symbol in ("TLT", "IEF") else "ETF price"}


def macro_context_snapshot(day: str, asof_ms: int, catalog: dict, amd_news: list[dict],
                           broad_news: list[dict], proxies: dict[str, list[dict]],
                           source_status: dict | None = None) -> dict:
    """Build a frozen as-of snapshot; source failure remains visible, never a zero."""
    return {"version": 2, "date": day,
            "asOfCt": datetime.fromtimestamp(asof_ms / 1000, CT).strftime("%H:%M"),
            "asOfStampMs": asof_ms, "capturedAtUtc": datetime.now(timezone.utc).isoformat(),
            "scheduledEvents": _event_rows(catalog, day, asof_ms),
            "news": {"amd": _headline_rows(amd_news, asof_ms, False),
                     "marketWide": _headline_rows(broad_news, asof_ms, True),
                     "vendor": "Massive /v2/reference/news; vendor sentiment only applies to its tagged ticker"},
            "proxies": {symbol: _proxy_row(symbol, proxies.get(symbol, []), day, asof_ms)
                        for symbol in ("SPY", "QQQ", "TLT", "IEF", "UUP")},
            "directTreasuryYields": {"available": False,
                                     "reason": "No timestamped intraday Treasury-yield feed configured"},
            "sourceStatus": source_status or {},
            "method": "Scheduled events are not release contents. News is conservatively available "
                      "60 minutes after vendor publication timestamp. Broad headlines are keyword-filtered "
                      "from fetched market news, not a complete news census. Bond ETFs reflect bond prices "
                      "and duration/credit mix, not a direct yield quote or a causal explanation."}
