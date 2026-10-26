"""The local replay picker must not silently alter archived AMD/AMDL flow."""
import hashlib
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "analysis/amd-live-tape-v1"


class ReplayLibraryTest(unittest.TestCase):
    def test_manifest_and_selected_source_values(self):
        manifest = json.loads((PAGE / "replay-manifest.json").read_text())
        self.assertGreaterEqual(len(manifest["dates"]), 30)
        self.assertEqual(manifest["dates"], sorted(set(manifest["dates"])))
        self.assertEqual(manifest["dates"], [item["date"] for item in manifest["sessions"]])
        for item in manifest["sessions"]:
            path = PAGE / item["file"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item["sha256"])
            payload = json.loads(path.read_text())
            self.assertEqual(payload["date"], item["date"])
            self.assertEqual(len(payload["bars"]["AMD"]), item["bars"]["AMD"])
            self.assertTrue(all(a["stampMs"] < b["stampMs"] for a, b in
                                zip(payload["bars"]["AMD"], payload["bars"]["AMD"][1:])))

        sep = json.loads((PAGE / "replay/2026-09-22.json").read_text())
        row = next(row for row in sep["bars"]["AMD"] if row["t"] == "08:30")
        self.assertEqual(row["delta"], row["buy"] - row["sell"])
        self.assertIsInstance(row["netOutflowUsd"], (int, float))
        self.assertEqual(sep["available"]["netOutflowUsd"], True)
        oct6 = json.loads((PAGE / "replay/2026-10-06.json").read_text())
        original = json.loads((PAGE / "demo-2026-10-06.json").read_text())
        self.assertEqual(len(oct6["bars"]["AMD"]), len(original["bars"]["AMD"]))
        for replay, recorded in zip(oct6["bars"]["AMD"], original["bars"]["AMD"]):
            for field in ("t", "stampMs", "o", "h", "l", "litShares", "buy", "sell", "delta"):
                self.assertEqual(replay[field], recorded[field], f"Oct 6 {replay['t']} {field}")
            self.assertAlmostEqual(replay["c"], recorded["c"], places=4)
        self.assertTrue(oct6["available"]["netOutflowUsd"])


if __name__ == "__main__":
    unittest.main()
