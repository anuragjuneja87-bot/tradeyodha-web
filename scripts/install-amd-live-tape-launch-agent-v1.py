#!/usr/bin/env python3
"""Install the local AMD collector as a per-user macOS launch agent."""
from __future__ import annotations

import os
import plistlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LABEL = "com.tradeyodha.amd-live-tape-v1"
PLIST = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
LOG_DIR = ROOT / "tmp/amd-live-tape-v1"


def main() -> None:
    if sys.platform != "darwin":
        raise SystemExit("This installer is for macOS launchd only")
    python = ROOT / ".venv/bin/python"
    if not python.is_file():
        raise SystemExit(f"Create the local virtual environment first: {python}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": LABEL,
        "ProgramArguments": [str(python), str(ROOT / "scripts/serve-amd-live-tape-v1.py")],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": str(LOG_DIR / "launchd.out.log"),
        "StandardErrorPath": str(LOG_DIR / "launchd.err.log"),
    }
    PLIST.write_bytes(plistlib.dumps(payload))
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domain, str(PLIST)], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(PLIST)], check=True)
    subprocess.run(["launchctl", "kickstart", "-k", f"{domain}/{LABEL}"], check=True)
    print(f"Installed {LABEL}; local page: http://127.0.0.1:8765/")


if __name__ == "__main__":
    main()
