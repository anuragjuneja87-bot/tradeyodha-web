"""Cross-sectional market-context rules on as-of peer snapshots."""
import unittest

from scripts.market_context_bot_v1 import market_context_snapshot


def peer(move, pace, pm="bearish"):
    return {"available": True, "open": 100, "asOfClose": 100 + move,
            "atr14": 10, "moveInAtr": move, "volumePace": pace,
            "cumulativeVolume": 1_000, "sameClockMedianVolume": 800,
            "baselineSessions": 20,
            "premarketMidpoint": {"available": True, "midpoint": 101,
                                  "premarketDirection": pm,
                                  "lastThreeClosesState": "sustained_below"}}


class MarketContextBotTests(unittest.TestCase):
    def test_mixed_premarket_counts_only_own_atr_moves_and_retains_evidence(self):
        names = {"AMD": peer(-0.08, 1.97), "NVDA": peer(-0.28, 1.03),
                 "MU": peer(0.008, 1.22), "SNDK": peer(-0.041, 0.96),
                 "SMH": peer(-0.213, 2.05), "QQQ": peer(-0.156, 1.3)}
        result = market_context_snapshot({"names": names, "phase": "premarket",
                                          "asOfCt": "08:25", "source": "test"},
                                         "2026-10-07", 123)
        self.assertEqual(result["premarket"]["bearishCount"], 4)
        self.assertEqual(result["participation"]["state"], "mixed_downward_lean")
        self.assertEqual(result["leadership"]["amdRank"], 3)
        self.assertEqual(result["states"]["AMD"]["volumeState"], "active")
        self.assertEqual(result["states"]["AMD"]["sameClockMedianVolume"], 800)
        self.assertEqual(result["smhPeerDivergence"], "mixed_or_unavailable")
        names["SMH"]["lastObservedCt"] = "08:24"
        names["SMH"]["observationAgeMinutes"] = 1
        aged = market_context_snapshot({"names": names, "phase": "premarket",
                                        "asOfCt": "08:25"}, "2026-10-07", 123)
        self.assertEqual(aged["states"]["SMH"]["observationAgeMinutes"], 1)

    def test_smh_decline_with_broad_stock_rise_is_divergence_not_etf_attribution(self):
        names = {symbol: peer(0.2, 1.0) for symbol in ("AMD", "NVDA", "MU", "SNDK")}
        names.update({"SMH": peer(-0.1, 1.0), "QQQ": peer(-0.1, 1.0)})
        result = market_context_snapshot({"names": names, "phase": "regular",
                                          "asOfCt": "08:45"}, "2026-10-07", 456)
        self.assertEqual(result["participation"]["state"], "broad_rise")
        self.assertEqual(result["smhPeerDivergence"], "smh_down_peers_up")
        self.assertEqual(result["qqqPeerDivergence"], "qqq_down_peers_up")

    def test_flat_smh_and_falling_qqq_with_rising_peers_are_visible(self):
        names = {symbol: peer(0.2, 1.0) for symbol in ("AMD", "NVDA", "MU", "SNDK")}
        names.update({"SMH": peer(-0.013, 1.0), "QQQ": peer(-0.089, 1.0)})
        result = market_context_snapshot({"names": names, "phase": "regular",
                                          "asOfCt": "08:45"}, "2026-10-07", 456)
        self.assertEqual(result["smhPeerDivergence"], "smh_flat_peers_up")
        self.assertEqual(result["qqqPeerDivergence"], "qqq_down_peers_up")


if __name__ == "__main__":
    unittest.main()
