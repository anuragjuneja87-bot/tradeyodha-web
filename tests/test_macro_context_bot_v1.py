"""As-of macro context never leaks scheduled contents or later vendor news."""
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from scripts.macro_context_bot_v1 import macro_context_snapshot


CT = ZoneInfo("America/Chicago")


def stamp(hour, minute):
    return int(datetime(2026, 10, 7, hour, minute, tzinfo=CT).timestamp() * 1000)


class MacroContextBotTests(unittest.TestCase):
    def test_schedule_news_and_proxy_are_causal(self):
        catalog = {"coverageStart": "2026-10-01", "coverageEnd": "2026-10-31",
                   "verifiedOn": "2026-10-07", "events": [{"date": "2026-10-07",
                   "timeEt": "14:00", "name": "FOMC minutes", "category": "central_bank",
                   "source": "https://www.federalreserve.gov/"}]}
        news = [
            {"id": "old", "title": "Fed rate outlook", "published_utc": "2026-10-07T11:00:00Z",
             "tickers": ["AMD"], "insights": [{"ticker": "AMD", "sentiment": "positive"}]},
            {"id": "new", "title": "Treasury yields rise", "published_utc": "2026-10-07T13:00:00Z"},
        ]
        proxies = {"TLT": [{"t": stamp(6, 0), "o": 100, "c": 100},
                            {"t": stamp(8, 25), "o": 101, "c": 102},
                            {"t": stamp(8, 26), "o": 101, "c": 999}]}
        report = macro_context_snapshot("2026-10-07", stamp(8, 25), catalog,
                                        news, news, proxies)
        event = report["scheduledEvents"]["events"][0]
        self.assertEqual(event["scheduledCt"], "13:00")
        self.assertEqual(event["status"], "scheduled")
        self.assertEqual([item["title"] for item in report["news"]["marketWide"]["latest"]],
                         ["Fed rate outlook"])
        self.assertEqual(report["news"]["amd"]["latest"][0]["amdSentiment"], "positive")
        self.assertEqual(report["proxies"]["TLT"]["since06Pct"], 2.0)
        self.assertFalse(report["directTreasuryYields"]["available"])
        later = macro_context_snapshot("2026-10-07", stamp(13, 1), catalog, [], [], {})
        self.assertEqual(later["scheduledEvents"]["events"][0]["status"], "release_time_passed")

    def test_uncataloged_date_is_unavailable_not_no_events(self):
        report = macro_context_snapshot("2026-11-02", stamp(8, 25),
                                        {"coverageStart": "2026-10-01",
                                         "coverageEnd": "2026-10-31", "events": []},
                                        [], [], {})
        self.assertEqual(report["scheduledEvents"]["coverage"], "unavailable")


if __name__ == "__main__":
    unittest.main()
