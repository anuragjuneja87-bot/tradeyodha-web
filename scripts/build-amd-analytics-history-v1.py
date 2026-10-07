#!/usr/bin/env python3
"""Build completed-window AMD tape analogs from the verified 30-session browser.

Only contemporaneous features are stored. No future return or outcome is used
for matching, and the live/replay UI excludes same-day historical windows.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "analysis/amd-30-session-tape-browser-v1"
DEST = ROOT / "analysis/amd-live-tape-v1/history-windows.js"


def contiguous(rows: list[dict], width: int) -> bool:
    if len(rows) != width:
        return False
    minutes = [int(row["t"][:2]) * 60 + int(row["t"][3:5]) for row in rows]
    return all(b - a == 1 for a, b in zip(minutes, minutes[1:]))


def windows_for_day(date: str, bars: list[dict]) -> list[list]:
    tape = [row for row in bars if "08:30" <= row["t"] <= "10:59" and row.get("source") == "verified_raw_tape"]
    result = []
    for width in (5, 15):
        for end in range(width - 1, len(tape)):
            rows = tape[end - width + 1 : end + 1]
            if not contiguous(rows, width):
                continue
            buy = sum(row.get("buy") or 0 for row in rows)
            sell = sum(row.get("sell") or 0 for row in rows)
            classified = buy + sell
            ofis = [row["ofi"] for row in rows if isinstance(row.get("ofi"), (int, float))]
            coverage = [row["coverage"] for row in rows if isinstance(row.get("coverage"), (int, float))]
            if classified < 1000 or len(ofis) < max(3, width // 2) or len(coverage) < width:
                continue
            opening = rows[0]["o"]
            if not opening:
                continue
            result.append([
                date, rows[-1]["t"], width,
                round((buy - sell) / classified, 4),
                round(sum(ofis) / len(ofis), 4),
                round(10000 * (rows[-1]["c"] / opening - 1), 2),
                classified,
                round(sum(coverage) / len(coverage), 1),
            ])
    return result


def main() -> None:
    manifest = json.loads((SOURCE / "manifest.json").read_text())
    windows = []
    digests = {}
    for item in manifest["sessions"]:
        path = SOURCE / item["file"]
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != item["sha256"]:
            raise ValueError(f"History checksum mismatch: {path}")
        payload = json.loads(raw.decode().split("=", 2)[2].removesuffix(";\n"))
        if payload["date"] != item["date"] or payload["rawSha256"] != item["rawSha256"]:
            raise ValueError(f"History metadata mismatch: {path}")
        windows.extend(windows_for_day(item["date"], payload["bars"]["1m"]))
        digests[item["date"]] = digest
    output = {
        "version": 1,
        "dates": manifest["dates"],
        "source": "30 checksum-verified AMD sessions; classified lit continuous trades and NBBO OFI",
        "fields": ["date", "endCt", "minutes", "deltaFraction", "meanOfi", "priceBps", "classifiedShares", "coveragePct"],
        "windows": windows,
    }
    DEST.write_text("window.AMD_ANALYTICS_HISTORY=" + json.dumps(output, separators=(",", ":")) + ";\n")
    print(f"{len(manifest['dates'])} dates, {len(windows)} completed windows -> {DEST}")


if __name__ == "__main__":
    main()
