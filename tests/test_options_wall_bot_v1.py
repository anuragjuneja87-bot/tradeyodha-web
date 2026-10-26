"""Check that option-interest rankings do not become signed dealer GEX."""
import importlib.util
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "options_wall_bot_v1", Path(__file__).resolve().parents[1] / "scripts/options_wall_bot_v1.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class OptionsWallBotTests(unittest.TestCase):
    def test_oi_wall_and_gamma_peak_can_be_different(self):
        def contract(side, strike, oi, gamma, expiry="2026-10-09"):
            return {"details": {"contract_type": side, "strike_price": strike,
                                "expiration_date": expiry, "shares_per_contract": 100},
                    "open_interest": oi, "greeks": {} if gamma is None else {"gamma": gamma}}
        rows = [contract("call", 650, 10_000, .005),
                contract("call", 640, 2_000, .05),
                contract("put", 630, 8_000, .02),
                contract("put", 620, 100, None),
                contract("call", 650, 999_999, .9, "2026-11-20"),
                contract("put", 900, 999_999, .9)]
        report = MOD.summarize_chain(rows, 640, "2026-10-07", "2026-10-07T20:00:00Z")
        self.assertEqual(report["contractCount"], 4)
        self.assertEqual(report["gammaContractCount"], 3)
        self.assertEqual(report["callOiWalls"][0]["strike"], 650)
        self.assertEqual(report["callGrossGammaPeaks"][0]["strike"], 640)
        self.assertEqual(report["putOiWalls"][0]["strike"], 630)
        self.assertEqual([item["strike"] for item in report["oiByStrike"]["call"]],
                         [640, 650])
        self.assertNotIn("netGex", report)
        self.assertEqual(report["callGrossGammaPeaks"][0]["grossGammaDollarPer1Pct"],
                         .05 * 2_000 * 100 * 640 * 640 * .01)
        self.assertEqual(report["grossGammaPinProxy"]["strike"], 630)
        self.assertNotIn("dealerPosition", report)
        peer = MOD.summarize_chain(rows, 640, "2026-10-07", "2026-10-07T20:00:00Z", "MU")
        self.assertEqual(peer["symbol"], "MU")


if __name__ == "__main__":
    unittest.main()
