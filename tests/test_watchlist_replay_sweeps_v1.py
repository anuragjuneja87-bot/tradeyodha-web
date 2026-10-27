"""Synthetic source and parity gates for local watchlist sweep candidates."""
import gzip
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "watchlist_replay_sweeps", ROOT / "scripts/build-watchlist-replay-sweeps-v1.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class SweepSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.raw = root / "raw"
        self.replay = root / "replay"
        self.day = "2026-10-23"
        self.start = int(datetime(2026, 10, 23, 8, 30,
                                  tzinfo=ZoneInfo("America/Chicago")).timestamp() * 1000)
        folder = self.raw / "AMD" / self.day
        folder.mkdir(parents=True)
        (self.replay / "AMD").mkdir(parents=True)
        quotes, trades = [], []
        bars = []
        for index in range(200):
            stamp = self.start + index * 30_000
            quotes.append({"sip_timestamp": stamp * 1_000_000,
                           "bid_price": 100, "ask_price": 101,
                           "bid_size": 100, "ask_size": 100})
            side = 0 if index == 0 else 1 if index == 1 else None
            if side is not None:
                price = 100 if side == 0 else 101
                for offset, size, exchange in ((1, 600, 12), (2, 500, 13)):
                    trades.append({"sip_timestamp": (stamp + offset) * 1_000_000,
                                   "participant_timestamp": (stamp + 1) * 1_000_000,
                                   "price": price, "size": size,
                                   "exchange": exchange, "conditions": []})
            bars.append({"stampMs": stamp, "t": "synthetic",
                         "sell": 1100 if side == 0 else 0,
                         "buy": 1100 if side == 1 else 0})
        hashes = {}
        for kind, rows in (("trades", trades), ("quotes", quotes)):
            path = folder / f"stock-{kind}.ndjson.gz"
            with gzip.open(path, "wt") as target:
                for row in rows:
                    target.write(json.dumps(row) + "\n")
            hashes[kind] = MOD.sha256(path)
            (folder / f"stock-{kind}.json").write_text(json.dumps({
                "symbol": "AMD", "date": self.day, "kind": kind,
                "bytes": path.stat().st_size, "sha256": hashes[kind], "rows": len(rows)}))
        self.replay_path = self.replay / "AMD" / f"{self.day}.json"
        self.replay_path.write_text(json.dumps({"symbol": "AMD", "date": self.day,
            "sourceSha256": hashes, "bars": {"30s": bars}}))

    def test_sweep_counts_use_same_participant_time_and_multiple_lit_venues(self):
        payload, checks = MOD.compute("AMD", self.day, self.raw, self.replay)
        self.assertEqual(checks, 200)
        self.assertEqual(payload["bars"][0]["sellSweepCandidates"], 1)
        self.assertEqual(payload["bars"][0]["sellSweepShares"], 1100)
        self.assertEqual(payload["bars"][1]["buySweepCandidates"], 1)
        self.assertEqual(payload["bars"][1]["buySweepShares"], 1100)
        self.assertEqual(payload["bars"][2]["sellSweepCandidates"], 0)

    def test_replay_side_mismatch_fails_closed(self):
        replay = json.loads(self.replay_path.read_text())
        replay["bars"]["30s"][0]["sell"] += 1
        self.replay_path.write_text(json.dumps(replay))
        with self.assertRaisesRegex(ValueError, "classified-side parity"):
            MOD.compute("AMD", self.day, self.raw, self.replay)

    def test_corrupt_raw_archive_fails_before_computation(self):
        with (self.raw / "AMD" / self.day / "stock-trades.ndjson.gz").open("ab") as file:
            file.write(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            MOD.compute("AMD", self.day, self.raw, self.replay)


if __name__ == "__main__":
    unittest.main()
