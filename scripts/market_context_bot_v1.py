"""Deterministic, as-of market context for AMD and a small semiconductor peer set.

Inputs are each symbol's own ATR-normalized move and same-clock volume pace.
The tracked names are illustrative peers, not a complete SMH constituent map.
"""
from __future__ import annotations

from datetime import datetime, timezone

STOCKS = ("AMD", "NVDA", "MU", "SNDK")
ETFS = ("SMH", "QQQ")
MOVE_DEADBAND_ATR = 0.05
ACTIVE_VOLUME_PACE = 1.25
QUIET_VOLUME_PACE = 0.75


def _direction(move: float | None) -> str:
    if move is None:
        return "unavailable"
    if move >= MOVE_DEADBAND_ATR:
        return "rising"
    if move <= -MOVE_DEADBAND_ATR:
        return "falling"
    return "flat"


def _etf_peer_relationship(etf: str, direction: str, rising: int, falling: int) -> str:
    if direction == "rising" and falling >= 3:
        return f"{etf.lower()}_up_peers_down"
    if direction == "falling" and rising >= 3:
        return f"{etf.lower()}_down_peers_up"
    if direction == "flat" and rising >= 3:
        return f"{etf.lower()}_flat_peers_up"
    if direction == "flat" and falling >= 3:
        return f"{etf.lower()}_flat_peers_down"
    if direction == "rising" and rising >= 3 or direction == "falling" and falling >= 3:
        return "aligned"
    return "mixed_or_unavailable"


def market_context_snapshot(breadth: dict, day: str, asof_ms: int) -> dict:
    """Summarize a causal peer-breadth payload without comparing raw returns to an ETF."""
    names = breadth.get("names", {})
    states = {}
    for symbol in STOCKS + ETFS:
        row = names.get(symbol, {})
        available = bool(row.get("available")) and row.get("moveInAtr") is not None
        midpoint = row.get("premarketMidpoint") or {}
        pace = row.get("volumePace") if available else None
        states[symbol] = {"available": available,
                          "open": row.get("open") if available else None,
                          "asOfClose": row.get("asOfClose") if available else None,
                          "lastObservedCt": row.get("lastObservedCt") if available else None,
                          "observationAgeMinutes": row.get("observationAgeMinutes") if available else None,
                          "atr14": row.get("atr14") if available else None,
                          "moveInOwnAtr": row.get("moveInAtr") if available else None,
                          "direction": _direction(row.get("moveInAtr") if available else None),
                          "sameClockVolumePace": pace,
                          "cumulativeVolume": row.get("cumulativeVolume") if available else None,
                          "sameClockMedianVolume": row.get("sameClockMedianVolume") if available else None,
                          "baselineSessions": row.get("baselineSessions") if available else None,
                          "volumeState": ("active" if pace >= ACTIVE_VOLUME_PACE else
                                          "quiet" if pace <= QUIET_VOLUME_PACE else "ordinary")
                          if pace is not None else "unavailable",
                          "premarketDirection": midpoint.get("premarketDirection") if midpoint.get("available") else None,
                          "premarketMidpoint": midpoint.get("midpoint") if midpoint.get("available") else None,
                          "midpointState": midpoint.get("lastThreeClosesState") if midpoint.get("available") else None}
    ranked = sorted((symbol for symbol in STOCKS if states[symbol]["available"]),
                    key=lambda symbol: states[symbol]["moveInOwnAtr"], reverse=True)
    rising = [symbol for symbol in ranked if states[symbol]["direction"] == "rising"]
    falling = [symbol for symbol in ranked if states[symbol]["direction"] == "falling"]
    flat = [symbol for symbol in ranked if states[symbol]["direction"] == "flat"]
    if len(ranked) < 3:
        participation = "insufficient_peer_coverage"
    elif len(rising) >= 3:
        participation = "broad_rise"
    elif len(falling) >= 3:
        participation = "broad_decline"
    elif len(rising) > len(falling):
        participation = "mixed_upward_lean"
    elif len(falling) > len(rising):
        participation = "mixed_downward_lean"
    else:
        participation = "mixed"
    smh_relationship = _etf_peer_relationship("SMH", states["SMH"]["direction"],
                                               len(rising), len(falling))
    qqq_relationship = _etf_peer_relationship("QQQ", states["QQQ"]["direction"],
                                               len(rising), len(falling))
    pm_directions = {symbol: states[symbol]["premarketDirection"] for symbol in STOCKS}
    pm_bearish = [symbol for symbol, direction in pm_directions.items() if direction == "bearish"]
    amd_rank = ranked.index("AMD") + 1 if "AMD" in ranked else None
    active = [symbol for symbol in STOCKS if states[symbol]["volumeState"] == "active"]
    return {"version": 2, "date": day, "asOfCt": breadth.get("asOfCt"),
            "asOfStampMs": asof_ms, "capturedAtUtc": datetime.now(timezone.utc).isoformat(),
            "phase": breadth.get("phase"), "stockUniverse": list(STOCKS),
            "marketContext": list(ETFS), "states": states,
            "participation": {"state": participation, "rising": rising,
                              "falling": falling, "flat": flat, "available": len(ranked)},
            "leadership": {"rankedByOwnAtrMove": ranked, "amdRank": amd_rank,
                           "highest": ranked[0] if ranked else None,
                           "lowest": ranked[-1] if ranked else None,
                           "activeVolumeStocks": active},
            "premarket": {"bearishStocks": pm_bearish,
                          "bearishCount": len(pm_bearish), "available": sum(
                              direction is not None for direction in pm_directions.values())},
            "smhPeerDivergence": smh_relationship,
            "qqqPeerDivergence": qqq_relationship,
            "method": "Directions use own 14-session ATR-normalized open-to-last-observed movement "
                      "with a ±0.05 ATR deadband. Volume states use prior same-clock median: "
                      "active ≥1.25×, quiet ≤0.75×. A last observation up to two minutes "
                      "old is allowed and disclosed. Four tracked stocks are not a complete "
                      "or weighted SMH attribution. No order-owner or forecast inference.",
            "source": breadth.get("source", "Massive unadjusted one-minute and daily aggregates")}
