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
        # Hold an idle-sleep assertion only while the collector is running.
        # A closed lid or powered-off Mac can still sleep; REST refill repairs
        # those missed candles when the service resumes.
        "ProgramArguments": ["/usr/bin/caffeinate", "-i", str(python), str(ROOT / "scripts/serve-amd-live-tape-v1.py"),
                             "--symbols", "AMD,TSLA,SPY,SMH,QQQ,META,NVDA,MU,MSFT,SOXL,SPCX,SNDK"],
        "WorkingDirectory": str(ROOT),
        # A login after 03:00 must start the collector even when the 03:00
        # calendar event occurred while the Mac was powered off.
        "RunAtLoad": True,
        # Retry a crashed collector, while its normal exit at exchange close
        # stays stopped until the next scheduled trading-day start.
        "KeepAlive": {"SuccessfulExit": False},
        "StartCalendarInterval": [
            {"Weekday": weekday, "Hour": 3, "Minute": 0} for weekday in range(1, 6)],
        "ThrottleInterval": 10,
        "StandardOutPath": str(LOG_DIR / "launchd.out.log"),
        "StandardErrorPath": str(LOG_DIR / "launchd.err.log"),
    }
    PLIST.write_bytes(plistlib.dumps(payload))
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domain, str(PLIST)], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(PLIST)], check=True)
    # RunAtLoad starts the service during bootstrap when the session is open;
    # main() itself exits cleanly outside the market window.
    print(f"Installed {LABEL}; 03:00 CT trading-day start, automatic exchange-close stop")


if __name__ == "__main__":
    main()
