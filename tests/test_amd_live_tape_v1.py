"""Synthetic event-time checks for the local AMD minute monitor."""
import importlib.util
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


SPEC = importlib.util.spec_from_file_location(
    "amd_live_tape", Path(__file__).resolve().parents[1] / "scripts/serve-amd-live-tape-v1.py"
)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class LiveTapeTests(unittest.TestCase):
    def test_completed_minute_classifies_lit_trades_and_ofi(self):
        state = MOD.TapeState()
        base = 1_780_760_400_000  # A minute-aligned timestamp; the date is immaterial.
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        state.ingest([
            {"ev": "Q", "sym": "AMD", "t": base + 10_000, "bp": 100, "ap": 100.1, "bs": 100, "as": 100},
            {"ev": "T", "sym": "AMD", "t": base + 10_500, "pt": base + 10_490,
             "p": 100.1, "s": 200, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 20_000, "bp": 100.05, "ap": 100.15,
             "bs": 150, "as": 80},
            {"ev": "T", "sym": "AMD", "t": base + 20_500, "pt": base + 20_490,
             "p": 100.05, "s": 100, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 64_000, "bp": 100.04, "ap": 100.14,
             "bs": 130, "as": 100},
        ])
        bars = state.snapshot()["bars"]["AMD"]
        self.assertEqual(len(bars), 1)
        self.assertEqual((bars[0]["buy"], bars[0]["sell"], bars[0]["delta"]), (200, 100, 100))
        self.assertAlmostEqual(bars[0]["coveragePct"], 100)
        self.assertGreater(bars[0]["ofi"], 0)
        self.assertAlmostEqual(bars[0]["midMoveCents"], 5)

    def test_quote_only_minute_is_not_a_price_bar(self):
        state = MOD.TapeState()
        base = 1_780_760_400_000
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        state.ingest([
            {"ev": "Q", "sym": "AMD", "t": base + 1_000, "bp": 100, "ap": 100.1,
             "bs": 100, "as": 100},
            {"ev": "Q", "sym": "AMD", "t": base + 65_000, "bp": 100.01, "ap": 100.11,
             "bs": 100, "as": 100},
        ])
        self.assertEqual(state.snapshot()["bars"]["AMD"], [])

    def test_first_partial_minute_is_hidden(self):
        state = MOD.TapeState()
        base = 1_780_760_400_000
        state.ingest([
            {"ev": "T", "sym": "AMD", "t": base + 45_000, "pt": base + 44_990,
             "p": 100, "s": 100, "x": 12, "c": []},
            {"ev": "T", "sym": "AMD", "t": base + 60_100, "pt": base + 60_090,
             "p": 101, "s": 100, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 124_000, "bp": 100, "ap": 100.1,
             "bs": 100, "as": 100},
        ])
        bars = state.snapshot()["bars"]["AMD"]
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]["c"], 101)

    def test_opening_cross_does_not_make_an_actionable_bar(self):
        minute = MOD.Minute(1_780_760_400_000)
        minute.trade({"t": minute.start_ms + 10, "pt": minute.start_ms + 9,
                      "p": 100, "s": 1_000_000, "x": 4, "c": [9]}, None)
        self.assertIsNone(minute.result()["c"])
        self.assertEqual(minute.result()["litShares"], 0)

    def test_extended_hours_form_t_sets_price(self):
        start = int(datetime(2026, 10, 7, 6, 0, tzinfo=ZoneInfo("America/Chicago")).timestamp() * 1000)
        minute = MOD.Minute(start)
        minute.trade({"t": start + 10, "pt": start + 9,
                      "p": 100, "s": 100, "x": 12, "c": [12]}, None)
        self.assertEqual(minute.result()["c"], 100)


if __name__ == "__main__":
    unittest.main()
