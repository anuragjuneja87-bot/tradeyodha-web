#!/usr/bin/env python3
"""Adapt the verified AMD/AMDL 30-session browser into local minute replays."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "analysis/amd-30-session-tape-browser-v1"
TARGET = ROOT / "analysis/amd-live-tape-v1"
CT = ZoneInfo("America/Chicago")


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_verified_js(path: Path, expected_hash: str) -> dict:
    assert sha(path) == expected_hash, f"Processed asset checksum mismatch: {path}"
    return json.loads(path.read_text().split("=", 2)[2].removesuffix(";\n"))


def stamp(date: str, clock: str) -> int:
    return int(datetime.fromisoformat(f"{date}T{clock}").replace(tzinfo=CT).timestamp() * 1000)


def normalise(date: str, row: dict, *, amd: bool) -> dict:
    buy, sell = int(row.get("buy") or 0), int(row.get("sell") or 0)
    volume = int(row.get("v") or 0)
    return {
        "t": row["t"], "stampMs": stamp(date, row["t"]),
        "o": row.get("o"), "h": row.get("h"), "l": row.get("l"), "c": row.get("c"),
        "litShares": volume, "buy": buy, "sell": sell, "delta": buy - sell,
        "imbalancePct": round(100 * (buy - sell) / (buy + sell), 1) if buy + sell else None,
        "coveragePct": row.get("coverage"),
        # The historical browser has classified shares, not exact trade notional.
        "netOutflowUsd": None,
        "ofi": row.get("ofi"), "quoteUpdates": row.get("quoteUpdates"),
        "queue": row.get("queue") if amd else None,
        "medianSpreadCents": row.get("spread") if amd else None,
        "midMoveCents": row.get("midmove") if amd else None,
        "quoteAgeMs": row.get("quoteAgeMs") if amd else None,
    }


def main() -> None:
    amd_manifest = json.loads((SOURCE / "manifest.json").read_text())
    cross_manifest = json.loads((SOURCE / "crossflow-manifest.json").read_text())
    assert amd_manifest["dates"] == cross_manifest["dates"]
    cross_by_date = {row["date"]: row for row in cross_manifest["sessions"]}
    out_dir = TARGET / "replay"
    out_dir.mkdir(exist_ok=True)
    sessions = []
    for entry in amd_manifest["sessions"]:
        date = entry["date"]
        cross = cross_by_date[date]
        amd = load_verified_js(SOURCE / entry["file"], entry["sha256"])
        amdl = load_verified_js(SOURCE / cross["file"], cross["sha256"])
        assert amd["date"] == amdl["date"] == date
        assert amd["rawSha256"] == entry["rawSha256"]
        assert amdl["amdlRawSha256"] == cross["amdlRawSha256"]
        amd_rows = [normalise(date, row, amd=True) for row in amd["bars"]["1m"]
                    if "06:00" <= row["t"] < "11:00" and row.get("source") == "verified_raw_tape"]
        # Keep quote-only AMDL minutes: they can still have useful OFI, while
        # absent prints must remain absent rather than becoming zero-price bars.
        amdl_rows = [normalise(date, row, amd=False) for row in amdl["bars"]["1m"]["amdl"]
                     if "06:00" <= row["t"] < "11:00"]
        # Earlier quiet premarket sessions have minutes without an eligible
        # price print. Preserve those gaps; never synthesize a candle.
        assert len(amd_rows) >= 230 and len(amdl_rows) >= 290, (date, len(amd_rows), len(amdl_rows))
        assert all(a["stampMs"] < b["stampMs"] for rows in (amd_rows, amdl_rows)
                   for a, b in zip(rows, rows[1:])), date
        if date == "2026-10-06":
            # Preserve the richer, separately verified replay already used by
            # the live page, including exact classified dollar notional.
            payload = json.loads((TARGET / "demo-2026-10-06.json").read_text())
            assert payload["date"] == date
            assert payload["rawSha256"] == {"AMD": amd["rawSha256"], "AMDL": amdl["amdlRawSha256"]}
            amd_rows, amdl_rows = payload["bars"]["AMD"], payload["bars"]["AMDL"]
            payload["available"] = {"netOutflowUsd": True, "AMDLQuoteDepth": True}
        else:
            payload = {
                "mode": "replay", "date": date,
                "source": "Checksum-verified processed AMD and AMDL raw tape, 06:00–11:00 CT",
                "rawSha256": {"AMD": amd["rawSha256"], "AMDL": amdl["amdlRawSha256"]},
                "available": {"netOutflowUsd": False, "AMDLQuoteDepth": False},
                "bars": {"AMD": amd_rows, "AMDL": amdl_rows},
            }
        path = out_dir / f"{date}.json"
        path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
        sessions.append({"date": date, "file": f"replay/{date}.json", "sha256": sha(path),
                         "bars": {"AMD": len(amd_rows), "AMDL": len(amdl_rows)}})
        print(date, sessions[-1]["bars"], flush=True)
    (TARGET / "replay-manifest.json").write_text(json.dumps({
        "dates": amd_manifest["dates"], "sessions": sessions,
        "windowCt": ["06:00", "11:00"],
        "source": "Derived only from the existing verified AMD/AMDL 30-session browser",
        "limitation": "Exact classified dollar pressure and AMDL quote-depth features are not available in this processed source",
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
