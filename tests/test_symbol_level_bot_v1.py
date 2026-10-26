"""Point-in-time checks for the independent higher-timeframe level component."""
import unittest
from datetime import datetime, timedelta, timezone

from scripts.symbol_level_bot_v1 import CT, completed_regular_candles, find_symbol_levels, premarket_levels


class SymbolLevelBotTests(unittest.TestCase):
    def test_premarket_levels_stop_at_0825_and_selected_minute(self):
        def bar(hour, minute, high, low):
            stamp = int(datetime(2026, 10, 8, hour, minute, tzinfo=CT).timestamp() * 1000)
            return {"t": stamp, "h": high, "l": low}
        rows = [bar(2, 59, 999, 1), bar(3, 0, 101, 99),
                bar(6, 0, 103, 98), bar(8, 25, 105, 97), bar(8, 26, 999, 1)]
        early = premarket_levels(rows, "2026-10-08", rows[2]["t"] + 60_000)
        self.assertEqual((early["high"], early["low"], early["midpoint"]), (103, 98, 100.5))
        self.assertFalse(early["complete"])
        before_cutoff = premarket_levels(rows, "2026-10-08", rows[3]["t"])
        self.assertEqual((before_cutoff["high"], before_cutoff["low"]), (103, 98))
        self.assertFalse(before_cutoff["complete"])
        fixed = premarket_levels(rows, "2026-10-08", rows[-1]["t"])
        self.assertEqual((fixed["high"], fixed["low"], fixed["midpoint"]), (105, 97, 101))
        self.assertTrue(fixed["complete"])

    def test_premarket_midpoint_rounds_half_cent_up(self):
        stamp = int(datetime(2026, 10, 15, 8, 25, tzinfo=CT).timestamp() * 1000)
        result = premarket_levels([{"t": stamp, "h": 768.25, "l": 764.10}],
                                  "2026-10-15", stamp + 60_000)
        self.assertEqual(result["midpoint"], 766.18)

    def test_today_daily_bar_and_future_intraday_candle_never_leak(self):
        dates = ("2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01",
                 "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07")
        daily = []
        for index, date in enumerate(dates):
            stamp = int(datetime.fromisoformat(date).replace(tzinfo=timezone.utc).timestamp() * 1000)
            daily.append({"t": stamp, "o": 100, "h": 110 if index < 7 else 999,
                          "l": 90 if index < 7 else 1, "c": 100, "v": 1000})
        opening = datetime(2026, 10, 7, 8, 30, tzinfo=CT)
        minutes = [{"t": int((opening + timedelta(minutes=i)).timestamp() * 1000),
                    "o": 100, "h": 110 if i < 60 else 999,
                    "l": 90 if i < 60 else 1, "c": 100, "v": 100}
                   for i in range(240)]
        asof = int(datetime(2026, 10, 7, 9, 45, tzinfo=CT).timestamp() * 1000)
        result = find_symbol_levels("TEST", asof, daily, minutes, reference_price=100)
        self.assertEqual(result["lastCompletedDailyDate"], "2026-10-06")
        self.assertEqual(result["completedCandles"]["hourly"], 1)
        self.assertEqual(result["completedCandles"]["fourHour"], 0)
        self.assertTrue(all(level["price"] != 999 for level in result["levels"]))

    def test_four_hour_waits_until_the_entire_candle_is_complete(self):
        opening = datetime(2026, 10, 7, 8, 30, tzinfo=CT)
        minutes = [{"t": int((opening + timedelta(minutes=i)).timestamp() * 1000),
                    "o": 101, "h": 102, "l": 100, "c": 101, "v": 10}
                   for i in range(240)]
        before = int(datetime(2026, 10, 7, 12, 29, tzinfo=CT).timestamp() * 1000)
        after = int(datetime(2026, 10, 7, 12, 30, tzinfo=CT).timestamp() * 1000)
        self.assertEqual(completed_regular_candles(minutes, before, 240), [])
        self.assertEqual(len(completed_regular_candles(minutes, after, 240)), 1)


if __name__ == "__main__":
    unittest.main()
