# AMD minute-flow monitor

Open <http://127.0.0.1:8765/> to inspect 30 archived AMD/AMDL sessions from August 25 through October 6, 2026. Select a date, then use the replay slider to reveal only completed earlier minutes. The replay data are local and require no market-data request. The processed one-minute archive has genuine gaps where no eligible AMD price print occurred; the page reports the number of available minutes rather than filling them. Historical classified dollar pressure is unavailable and appears as a dash.

To use the live feed on this Mac, from the TradeYodha repository run:

```bash
.venv/bin/python scripts/serve-amd-live-tape-v1.py
```

Then open <http://127.0.0.1:8765/> and select **Live feed**. The process reads the locally configured `MASSIVE_API_KEY`, subscribes to `T.AMD,Q.AMD,T.AMDL,Q.AMDL`, and stores raw WebSocket messages under `tmp/amd-live-tape-v1/`. It binds only to `127.0.0.1`; the key is never sent to the page. Stop it with Ctrl+C. Start the process before the window you want to observe; the WebSocket does not backfill missed minutes.

The monitor publishes only finished one-minute candles after a two-second event-time reorder buffer. Trade-side classification uses a valid NBBO no more than two seconds old. It excludes TRF and noncontinuous prints from aggressor delta. Quote OFI uses displayed best-quote changes. When an eligible trade has no participant timestamp, it is excluded rather than treated as a timely print. A quote-only minute is omitted instead of plotted at zero.

The feed status and event age are visible. A reconnect, stale feed, or dropped out-of-order event means the affected minutes should not be relied on. The live ingestion and UI were tested with an authenticated AMD/AMDL subscription and synthetic event-time checks; exact market-hours agreement with the historical archive is still to be measured on a subsequent session. This is an informational tool, with no broker or order interface.

## Analytics AI layer

The layer recalculates after every completed AMD minute, independently of the candle size selected for the latest-candle boxes. Select a trailing 5- or 15-minute window. It totals classified buyer and seller shares, averages available one-minute best-quote OFI readings, and measures the price change in basis points. It compares that vector against windows ending within 15 clock minutes of the current time in the checksum-verified 30-session AMD archive. Replay excludes its own date, and live analysis uses only prior dates. The nearest three analogs use trade imbalance, OFI, price response, and classified volume; they do **not** use future price outcomes.

The pattern text is a descriptive, fixed-rule watch. Buyer/seller imbalance requires an extreme same-clock trade-delta percentile, quote confirmation, and aligned price movement. Divergence and lack of price follow-through are labeled separately. The layer pauses when minute continuity, classified trade coverage, fresh quotes, or live feed freshness is insufficient. Its historical reference covers 08:30–11:00 CT; no statement about an entry, exit, win rate, or forecast has been validated.

Rebuild the small browser-side history after refreshing the 30-session archive with `python3 scripts/build-amd-analytics-history-v1.py`. Rebuild the replay library from the already-processed, checksum-linked AMD and AMDL session assets with `.venv/bin/python scripts/build-amd-live-replay-library-v1.py`. Run `node tests/test_amd_live_analytics_v1.cjs` and `.venv/bin/python -m unittest tests/test_amd_live_tape_v1.py` to check the causal comparison and minute collector.

For unattended local startup on macOS, run `.venv/bin/python scripts/install-amd-live-tape-launch-agent-v1.py` once. It installs a per-user LaunchAgent that starts the collector at login, keeps it running, and serves the page on port 8765. The Mac must be awake and logged in during the tape window; the feed does not backfill time missed while asleep or disconnected. The local Python environment needs `websockets` from `analysis/amd-live-tape-v1/requirements.txt`. Logs remain under `tmp/amd-live-tape-v1/`; the key remains in the local environment or `.env` and is never included in the page.
