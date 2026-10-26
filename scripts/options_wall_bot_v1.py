"""Descriptive option-interest levels from a timestamped Massive chain snapshot.

These are option positioning *proxies*, not dealer inventory or directional GEX.
The caller owns as-of eligibility and archives the unmodified vendor response.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta


def summarize_chain(rows: list[dict], spot: float, session_date: str,
                    captured_at_utc: str, symbol: str = "AMD") -> dict:
    if spot <= 0:
        raise ValueError("A positive reference price is required")
    first_day = date.fromisoformat(session_date)
    last_day = first_day + timedelta(days=14)
    lower, upper = spot * 0.90, spot * 1.10
    buckets = defaultdict(lambda: {"openInterest": 0, "grossGammaDollarPer1Pct": 0.0,
                                   "gammaContracts": 0, "contracts": 0})
    included = gamma_count = 0
    for row in rows:
        detail = row.get("details") or {}
        try:
            expiry = date.fromisoformat(detail["expiration_date"])
            strike = float(detail["strike_price"])
            side = detail["contract_type"]
            oi = int(row.get("open_interest") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if not (first_day <= expiry <= last_day and lower <= strike <= upper and
                side in ("call", "put") and oi >= 0):
            continue
        shares = float(detail.get("shares_per_contract") or 100)
        if shares <= 0:
            continue
        included += 1
        bucket = buckets[(side, strike)]
        bucket["openInterest"] += oi
        bucket["contracts"] += 1
        gamma = (row.get("greeks") or {}).get("gamma")
        if isinstance(gamma, (float, int)) and gamma >= 0:
            # Change in delta-hedge *dollar notional* for a 1% spot move.
            bucket["grossGammaDollarPer1Pct"] += gamma * oi * shares * spot * spot * 0.01
            bucket["gammaContracts"] += 1
            gamma_count += 1

    def ranked(side: str, key: str, require_gamma: bool = False) -> list[dict]:
        candidates = []
        for (kind, strike), values in buckets.items():
            if kind != side or (require_gamma and not values["gammaContracts"]):
                continue
            candidates.append({"strike": strike, **values})
        return sorted(candidates, key=lambda item: (-item[key], abs(item["strike"] - spot),
                                                     item["strike"]))[:5]

    combined_gamma = defaultdict(float)
    for (_side, strike), values in buckets.items():
        combined_gamma[strike] += values["grossGammaDollarPer1Pct"]
    pin_strike = min(combined_gamma, key=lambda strike: (-combined_gamma[strike], abs(strike - spot), strike)) if combined_gamma and max(combined_gamma.values()) > 0 else None

    return {
        "available": bool(included), "symbol": symbol, "sessionDate": session_date,
        "capturedAtUtc": captured_at_utc, "referenceSpot": round(spot, 2),
        "scope": {"calendarDays": 14, "strikeBandPct": 10,
                  "firstExpiration": first_day.isoformat(),
                  "lastExpiration": last_day.isoformat()},
        "contractCount": included, "gammaContractCount": gamma_count,
        "callOiWalls": ranked("call", "openInterest"),
        "putOiWalls": ranked("put", "openInterest"),
        "oiByStrike": {
            side: sorted(({"strike": strike, "openInterest": values["openInterest"]}
                          for (kind, strike), values in buckets.items() if kind == side),
                         key=lambda item: item["strike"])
            for side in ("call", "put")
        },
        "callGrossGammaPeaks": ranked("call", "grossGammaDollarPer1Pct", True),
        "putGrossGammaPeaks": ranked("put", "grossGammaDollarPer1Pct", True),
        "grossGammaPinProxy": ({"strike": pin_strike,
                                "grossGammaDollarPer1Pct": combined_gamma[pin_strike]}
                               if pin_strike is not None else None),
        "interpretation": ("callOiWalls and putOiWalls are chain-wide OI rankings, not "
                           "necessarily overhead call or lower put levels. For nearby levels, "
                           "filter oiByStrike by the selected stock price and label the side. "
                           "OI does not prove support/resistance or trade direction. Dealer "
                           "net position and signed GEX are not observable here."),
        "sourceRecency": ("Daily reference from Massive Options Starter: chain 15-minute "
                          "delayed at capture; open interest updated daily"),
    }
