"""Point-in-time and provenance checks for the AMD historical OI replay reader."""

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("amd_live_tape_oi", ROOT / "scripts/serve-amd-live-tape-v1.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HistoricalOiReplayTests(unittest.TestCase):
    def test_verified_snapshot_is_hidden_until_received_and_rejects_tampering(self):
        day = "2026-10-16"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / f"{day}-statistics.jsonl.gz"
            normalized = root / f"{day}-contract-oi.csv.gz"
            raw.write_bytes(b"original OPRA records")
            normalized.write_bytes(b"normalized contract OI")
            published = 1792157400000  # 08:30 CT on the example date
            report = {"available": True, "symbol": "AMD", "sessionDate": day,
                      "sourceProvider": "Databento OPRA.PILLAR", "sourceFile": raw.name,
                      "sourceSha256": hashlib.sha256(raw.read_bytes()).hexdigest(),
                      "normalizedSha256": hashlib.sha256(normalized.read_bytes()).hexdigest(),
                      "capturedStampMs": published}
            (root / f"{day}-options-summary.json").write_text(json.dumps(report))
            before = MODULE.archived_databento_options_walls(day, published - 120_000,
                                                              archive_dir=root)
            self.assertFalse(before["available"])
            self.assertIn("not yet been published", before["reason"])
            after = MODULE.archived_databento_options_walls(day, published,
                                                             archive_dir=root)
            self.assertTrue(after["available"])
            self.assertIsNone(MODULE.archived_databento_options_walls(
                day, published, symbol="TSLA", archive_dir=root))
            normalized.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                MODULE.archived_databento_options_walls(day, published,
                                                        archive_dir=root)


if __name__ == "__main__":
    unittest.main()
