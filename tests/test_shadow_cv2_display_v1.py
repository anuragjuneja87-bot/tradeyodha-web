import csv
import gzip
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "scripts/shadow_cv2_display_v1.py"
SPEC = importlib.util.spec_from_file_location("shadow_cv2_display_v1", SOURCE)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class ShadowCv2DisplayTests(unittest.TestCase):
    def test_archived_score_and_quality_reason_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "AMD.csv.gz"
            with gzip.open(path, "wt", newline="") as output:
                writer = csv.DictWriter(output, fieldnames=(
                    "symbol", "date", "time", "width", "C_v2", "reasons",
                    "priorDates", "coverageAll", "quoteAgeMs", "tradeDelta",
                    "classified", "quotePairs2s"))
                writer.writeheader()
                writer.writerow(dict(symbol="AMD", date="2026-10-15", time="08:30",
                    width="1", C_v2="42", reasons="", priorDates="18",
                    coverageAll="75.5", quoteAgeMs="120", tradeDelta="0.25",
                    classified="600", quotePairs2s="10"))
                writer.writerow(dict(symbol="AMD", date="2026-10-15", time="08:31",
                    width="1", C_v2="", reasons="insufficient eligible-lit coverage|quote too old",
                    priorDates="0", coverageAll="35.0", quoteAgeMs="3100",
                    tradeDelta="-0.4", classified="100", quotePairs2s="2"))
                writer.writerow(dict(symbol="AMD", date="2026-10-14", time="08:30",
                    width="1", C_v2="-10", reasons="", priorDates="17",
                    coverageAll="80", quoteAgeMs="90", tradeDelta="-0.2",
                    classified="700", quotePairs2s="12"))
            with patch.object(BRIDGE, "COMPARISONS", Path(directory)):
                data = BRIDGE.archived_cv2("AMD", "2026-10-15")
            self.assertEqual(data["source"], "historical_rest_raw")
            self.assertEqual(data["windows"]["1"]["08:30"]["score"], 42)
            self.assertEqual(data["windows"]["1"]["08:30"]["rawTradeDelta"], 0.25)
            self.assertEqual(data["windows"]["1"]["08:30"]["rawClassified"], 600)
            self.assertIsNone(data["windows"]["1"]["08:31"]["score"])
            self.assertIn("quote too old", data["windows"]["1"]["08:31"]["reason"])
            self.assertEqual(len(data["windows"]["1"]), 2)

    def test_rejects_invalid_symbol_or_date(self):
        for symbol, day in (("../AMD", "2026-10-15"), ("AMD", "bad")):
            with self.assertRaises(ValueError):
                BRIDGE.archived_cv2(symbol, day)

    def test_watchlist_extension_keeps_original_archive_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "SNDK.csv.gz"
            with gzip.open(path, "wt", newline="") as output:
                writer = csv.DictWriter(output, fieldnames=(
                    "symbol", "date", "time", "width", "C_v2", "reasons",
                    "priorDates", "coverageAll", "quoteAgeMs", "tradeDelta",
                    "classified", "quotePairs2s"))
                writer.writeheader()
                writer.writerow(dict(symbol="SNDK", date="2026-10-21", time="08:30",
                    width="1", C_v2="", reasons="insufficient prior dates",
                    priorDates="0", coverageAll="72.0", quoteAgeMs="200",
                    tradeDelta="0.2", classified="800", quotePairs2s="12"))
            with patch.object(BRIDGE, "WATCHLIST_EXTENSION_COMPARISONS", Path(directory)):
                data = BRIDGE.archived_cv2("SNDK", "2026-10-21")
            self.assertIsNone(data["windows"]["1"]["08:30"]["score"])
            self.assertEqual(data["windows"]["1"]["08:30"]["rawClassified"], 800)


if __name__ == "__main__":
    unittest.main()
