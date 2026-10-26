"""Synthetic event-time checks for the local AMD minute monitor."""
import importlib.util
import gzip
import json
import queue
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo


SPEC = importlib.util.spec_from_file_location(
    "amd_live_tape", Path(__file__).resolve().parents[1] / "scripts/serve-amd-live-tape-v1.py"
)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class LiveTapeTests(unittest.TestCase):
    def test_no_feed_dashboard_proxies_existing_live_api_and_reports_offline(self):
        class SyntheticCollector(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith("/api/updates"):
                    payload = b'data: {"active":true,"symbol":"AMD"}\n\n'
                    kind = "text/event-stream"
                else:
                    payload = json.dumps({"synthetic": True, "path": self.path}).encode()
                    kind = "application/json"
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), SyntheticCollector)
        upstream.daemon_threads = True
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory() as folder:
            state = MOD.TapeState(("AMD",))
            dashboard = ThreadingHTTPServer(
                ("127.0.0.1", 0), MOD.handler(state, Path(folder),
                                              f"127.0.0.1:{upstream.server_port}"))
            dashboard.daemon_threads = True
            threading.Thread(target=dashboard.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{dashboard.server_port}"
            try:
                with urllib.request.urlopen(base + "/api/state?symbol=AMD", timeout=3) as response:
                    self.assertEqual(json.load(response), {
                        "synthetic": True, "path": "/api/state?symbol=AMD"})
                with urllib.request.urlopen(base + "/api/updates?symbol=AMD", timeout=3) as response:
                    self.assertEqual(response.read(), b'data: {"active":true,"symbol":"AMD"}\n\n')
                upstream.shutdown()
                upstream.server_close()
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(base + "/api/state?symbol=AMD", timeout=3)
                self.assertEqual(error.exception.code, 503)
                with urllib.request.urlopen(base + "/replay-manifest.json", timeout=3) as response:
                    self.assertEqual(response.status, 200)
            finally:
                dashboard.shutdown()
                dashboard.server_close()

    def test_live_trade_tick_precedes_candle_close_and_clears_on_gap(self):
        base = int(datetime(2026, 10, 13, 8, 30, tzinfo=MOD.CT).timestamp() * 1000)
        state = MOD.TapeState(("AMD",))
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        state.ingest([
            {"ev": "Q", "sym": "AMD", "t": base + 100,
             "bp": 100, "ap": 100.1, "bs": 100, "as": 100},
            {"ev": "T", "sym": "AMD", "t": base + 200, "pt": base + 200,
             "p": 100.1, "s": 50, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 3_000,
             "bp": 100, "ap": 100.1, "bs": 100, "as": 100},
        ])
        signal = state.update_signal("AMD")
        self.assertEqual(signal["tick"], {
            "stampMs": base, "eventMs": base + 200,
            "o": 100.1, "h": 100.1, "l": 100.1, "c": 100.1,
        })
        self.assertEqual(signal["version"], 0)
        self.assertGreater(signal["tickVersion"], 0)
        self.assertEqual(state.snapshot("AMD")["bars"]["AMD"], [])
        state.mark_gap()
        self.assertIsNone(state.update_signal("AMD")["tick"])

    def test_sse_pushes_price_tick_without_full_snapshot(self):
        base = int(datetime(2026, 10, 13, 8, 30, tzinfo=MOD.CT).timestamp() * 1000)
        state = MOD.TapeState(("AMD",))
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        with tempfile.TemporaryDirectory() as folder:
            server = ThreadingHTTPServer(("127.0.0.1", 0), MOD.handler(state, Path(folder)))
            server.daemon_threads = True
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/api/updates?symbol=AMD"
                with urllib.request.urlopen(url, timeout=3) as response:
                    first = json.loads(response.readline().removeprefix(b"data: "))
                    self.assertIsNone(first["tick"])
                    state.ingest([
                        {"ev": "T", "sym": "AMD", "t": base + 1_000,
                         "pt": base + 1_000, "p": 100.25, "s": 100,
                         "x": 12, "c": []},
                        {"ev": "Q", "sym": "AMD", "t": base + 4_000,
                         "bp": 100.2, "ap": 100.3, "bs": 100, "as": 100},
                    ])
                    response.readline()  # SSE separator.
                    second = json.loads(response.readline().removeprefix(b"data: "))
                    self.assertEqual(second["tick"]["c"], 100.25)
                    self.assertEqual(second["version"], first["version"])
                    self.assertGreater(second["tickVersion"], first["tickVersion"])
            finally:
                server.shutdown()
                server.server_close()

    def test_selected_symbol_stream_reports_other_watchlist_candle(self):
        base = int(datetime(2026, 10, 13, 8, 30, tzinfo=MOD.CT).timestamp() * 1000)
        state = MOD.TapeState(("AMD", "TSLA"))
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        with tempfile.TemporaryDirectory() as folder:
            server = ThreadingHTTPServer(("127.0.0.1", 0), MOD.handler(state, Path(folder)))
            server.daemon_threads = True
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{server.server_port}/api/updates?symbol=AMD", timeout=3
                ) as stream:
                    first = json.loads(stream.readline().removeprefix(b"data: "))
                    stream.readline()
                    state.ingest([
                        {"ev": "T", "sym": "TSLA", "t": base + 1_000,
                         "pt": base + 1_000, "p": 200, "s": 100, "x": 12, "c": []},
                        {"ev": "Q", "sym": "TSLA", "t": base + 33_000,
                         "bp": 200, "ap": 200.1, "bs": 100, "as": 100},
                    ])
                    second = json.loads(stream.readline().removeprefix(b"data: "))
                    self.assertEqual(second["version"], first["version"])
                    self.assertEqual(second["tickVersion"], first["tickVersion"])
                    self.assertGreater(second["versions"]["TSLA"], first["versions"]["TSLA"])
                    self.assertEqual(second["versions"]["AMD"], first["versions"]["AMD"])
            finally:
                server.shutdown()
                server.server_close()

    def test_shared_live_session_window_and_completed_minute_rule(self):
        day = "2026-10-15"
        stamp = lambda hour, minute: int(datetime(2026, 10, 15, hour, minute,
                                                   tzinfo=MOD.CT).timestamp() * 1000)
        state = MOD.TapeState(("AMD", "TSLA"))
        snapshot = state.snapshot()
        self.assertEqual(snapshot["sessionWindow"], {
            "startCt": "03:00", "openCt": "08:30", "endCt": "15:00",
            "archiveEndCt": "11:00"})
        self.assertEqual(snapshot["referenceEndCt"], "15:00")
        self.assertFalse(MOD.completed_session_minute(day, stamp(2, 59), "15:00"))
        self.assertTrue(MOD.completed_session_minute(day, stamp(3, 0), "15:00"))
        self.assertTrue(MOD.completed_session_minute(day, stamp(6, 0), "15:00"))
        self.assertTrue(MOD.completed_session_minute(day, stamp(14, 59), "15:00"))
        self.assertFalse(MOD.completed_session_minute(day, stamp(15, 0), "15:00"))
        self.assertFalse(MOD.completed_session_minute(day, stamp(14, 59), "15:00",
                                                      now_ms=stamp(14, 59) + 30_000))
        self.assertTrue(MOD.completed_session_minute(day, stamp(14, 59), "15:00",
                                                     now_ms=stamp(15, 0)))

    def test_watchlist_premarket_reference_uses_only_asof_completed_bars(self):
        day = "2026-10-15"
        stamp = lambda hour, minute: int(datetime(2026, 10, 15, hour, minute,
                                                   tzinfo=MOD.CT).timestamp() * 1000)
        rows = [{"t": stamp(3, 15), "h": 101, "l": 99},
                {"t": stamp(8, 24), "h": 104, "l": 100},
                {"t": stamp(8, 26), "h": 120, "l": 90}]
        with mock.patch.object(MOD, "completed_day_minutes", return_value=rows):
            report = MOD.fetch_premarket_reference("TSLA", day, stamp(8, 31))
        self.assertEqual(report["premarket"]["high"], 104)
        self.assertEqual(report["premarket"]["low"], 99)
        self.assertEqual(report["premarket"]["midpoint"], 101.5)
        self.assertTrue(report["premarket"]["complete"])

    def test_premarket_gap_uses_prior_daily_close_and_completed_premarket_price(self):
        day = "2026-09-23"
        stamp = lambda hour, minute: int(datetime(2026, 9, 23, hour, minute,
                                                   tzinfo=MOD.CT).timestamp() * 1000)
        prior_stamp = int(datetime(2026, 9, 22, tzinfo=ZoneInfo("UTC")).timestamp() * 1000)
        rows = [{"t": stamp(3, 0), "o": 621.92, "h": 622.1, "l": 621.8, "c": 622.0},
                {"t": stamp(8, 24), "o": 619.0, "h": 619.3, "l": 618.9, "c": 619.1},
                {"t": stamp(8, 29), "o": 622.3, "h": 622.7, "l": 622.2, "c": 622.65},
                {"t": stamp(8, 30), "o": 621.5, "h": 622.0, "l": 621.2, "c": 621.6}]
        MOD.previous_regular_close.cache_clear()
        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.object(MOD, "completed_day_minutes", return_value=rows), \
             mock.patch.object(MOD, "massive_aggregates",
                               return_value=[{"t": prior_stamp, "c": 623.77}]) as daily:
            early = MOD.fetch_premarket_reference("AMD", day, stamp(8, 25), Path(folder))
            late = MOD.fetch_premarket_reference("AMD", day, stamp(8, 31), Path(folder))
        self.assertEqual(daily.call_count, 1)
        self.assertEqual(early["premarketGap"]["priorClose"], 623.77)
        self.assertEqual(early["premarketGap"]["premarketOpen"], 621.92)
        self.assertEqual(early["premarketGap"]["openingDirection"], "down")
        self.assertEqual(early["premarketGap"]["openingChange"], -1.85)
        self.assertEqual(early["premarketGap"]["premarketPriceCt"], "08:24")
        self.assertEqual(early["premarketGap"]["direction"], "down")
        self.assertEqual(early["premarketGap"]["change"], -4.67)
        self.assertEqual(late["premarketGap"]["premarketPriceCt"], "08:29")
        self.assertEqual(late["premarketGap"]["change"], -1.12)
        self.assertEqual(late["premarketGap"]["premarketMove"], 0.73)
        self.assertEqual(late["premarketGap"]["priceStampMs"], stamp(8, 30))
        self.assertEqual(late["premarket"]["lastCt"], "08:24")

    def test_recover_prior_watchlist_refill_after_symbols_are_added(self):
        state = MOD.TapeState(("AMD", "TSLA", "SPY", "SMH", "QQQ", "META"))
        end_ms = int(time.time() * 1000) // 60_000 * 60_000 - 60_000
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "refill" / state.date / str(end_ms) / "bundle.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"symbols": ["AMD", "TSLA", "SPY", "SMH"]}))
            bundle = {"endMs": end_ms}
            with mock.patch.object(MOD, "verified_refill", return_value=bundle) as verify, \
                 mock.patch.object(state, "merge_refill") as merge:
                self.assertEqual(MOD.recover_latest_refill(state, Path(folder)), end_ms)
            verify.assert_called_once_with(path, state.date, ("AMD", "TSLA", "SPY", "SMH"))
            merge.assert_called_once_with(bundle)

    def test_recover_disjoint_symbol_refill_bundles(self):
        state = MOD.TapeState(("AMD", "SPCX", "SNDK"))
        latest = int(time.time() * 1000) // 60_000 * 60_000 - 60_000
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "refill" / state.date
            for end_ms, symbols in ((latest, ["SNDK"]),
                                    (latest - 60_000, ["AMD", "SPCX"])):
                path = root / str(end_ms) / "bundle.json"
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps({"symbols": symbols}))

            def verified(path, _day, symbols):
                return {"endMs": int(path.parent.name), "symbols": symbols,
                        "data": {symbol: {} for symbol in symbols}}

            with mock.patch.object(MOD, "verified_refill", side_effect=verified), \
                 mock.patch.object(state, "merge_refill") as merge:
                self.assertEqual(MOD.recover_latest_refill(state, Path(folder)), latest)
            self.assertEqual(merge.call_count, 2)
            self.assertEqual({symbol for call in merge.call_args_list
                              for symbol in call.args[0]["symbols"]},
                             {"AMD", "SPCX", "SNDK"})

    def test_memory_guard_stops_ingestion_and_reports_limit(self):
        state = MOD.TapeState(("AMD", "TSLA"))
        stop = threading.Event()
        with mock.patch.object(MOD, "current_rss_mb", return_value=513):
            MOD.memory_guard(state, stop, 512)
        self.assertTrue(stop.is_set())
        self.assertEqual(state.feed, "error")
        self.assertIn("limit 512 MB", state.message)

    def test_refill_prepends_missing_bars_without_changing_live_candle(self):
        state = MOD.TapeState(("AMD",))
        day = state.date
        start = int(datetime.fromisoformat(f"{day}T03:00:00").replace(tzinfo=MOD.CT).timestamp() * 1000)
        live = {"stampMs": start + 60_000, "t": "03:01", "c": 102.0, "buy": 100}
        state.closed["AMD"].append(live)
        prior_run = state.run_id
        historical = {"stampMs": start, "t": "03:00", "c": 100.0, "buy": 20}
        overlap = {"stampMs": start + 60_000, "t": "03:01", "c": 101.0, "buy": 10}
        bundle = {"date": day, "startMs": start, "endMs": start + 120_000, "symbols": ["AMD"],
                  "data": {"AMD": {"bars": {"1m": [historical, overlap], "30s": []},
                                   "offExchange": []}}}
        state.merge_refill(bundle)
        self.assertEqual([row["c"] for row in state.closed["AMD"]], [100.0, 102.0])
        self.assertNotEqual(state.run_id, prior_run)
        self.assertEqual(state.refill_status, "complete")
        self.assertEqual(state.refill_symbols, {"AMD"})

    def test_refill_keeps_minute_and_half_minute_from_same_source(self):
        state = MOD.TapeState(("AMD",))
        day = state.date
        start = int(datetime.fromisoformat(f"{day}T06:00:00").replace(tzinfo=MOD.CT).timestamp() * 1000)
        stamp = start + 60_000
        live = {"stampMs": stamp, "t": "06:01", "c": 102.0,
                "buy": 100, "sell": 50, "litShares": 150, "quoteUpdates": 4}
        live_first = {"stampMs": stamp, "c": 101.0, "buy": 40,
                      "sell": 20, "litShares": 60, "quoteUpdates": 2}
        state.closed["AMD"].append(live)
        state.closed_halves["AMD"].append(live_first)
        rest = {"stampMs": stamp, "t": "06:01", "c": 101.5,
                "buy": 80, "sell": 40, "litShares": 120, "quoteUpdates": 6}
        rest_first = {"stampMs": stamp, "c": 101.0, "buy": 30,
                      "sell": 10, "litShares": 40, "quoteUpdates": 2}
        rest_second = {"stampMs": stamp + 30_000, "c": 101.5, "buy": 50,
                       "sell": 30, "litShares": 80, "quoteUpdates": 4}
        bundle = {"date": day, "startMs": start, "endMs": start + 120_000,
                  "symbols": ["AMD"], "data": {"AMD": {
                      "bars": {"1m": [rest], "30s": [rest_first, rest_second]},
                      "offExchange": []}}}
        state.merge_refill(bundle)
        self.assertEqual(state.closed["AMD"][0], rest)
        self.assertEqual(list(state.closed_halves["AMD"]), [rest_first, rest_second])

        state = MOD.TapeState(("AMD",))
        live_second = {"stampMs": stamp + 30_000, "c": 102.0, "buy": 60,
                       "sell": 30, "litShares": 90, "quoteUpdates": 2}
        state.closed["AMD"].append(live)
        state.closed_halves["AMD"].extend((live_first, live_second))
        state.merge_refill(bundle)
        self.assertEqual(state.closed["AMD"][0], live)
        self.assertEqual(list(state.closed_halves["AMD"]), [live_first, live_second])

    def test_gap_repair_does_not_claim_premarket_coverage(self):
        state = MOD.TapeState(("AMD",))
        day = state.date
        start = int(datetime.fromisoformat(f"{day}T06:00:00").replace(
            tzinfo=MOD.CT).timestamp() * 1000)
        state.last_processed_ms = start + 180_500
        state.mark_gap()
        self.assertEqual(state.gap_start_ms, start + 180_000)
        repaired = {"stampMs": start + 180_000, "t": "06:03", "c": 100.0}
        state.merge_refill({"date": day, "startMs": start + 180_000,
                            "endMs": start + 300_000, "symbols": ["AMD"],
                            "data": {"AMD": {"bars": {"1m": [repaired], "30s": []},
                                             "offExchange": []}}})
        self.assertIsNone(state.gap_start_ms)
        self.assertEqual(state.refill_symbols, set())

    def test_refill_builds_and_verifies_30_second_and_minute_bars(self):
        spec = importlib.util.spec_from_file_location(
            "live_refill_test", Path(__file__).resolve().parents[1] / "scripts/refill-live-tape-v1.py")
        refill = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(refill)
        day = datetime.now(MOD.CT).date().isoformat()
        start = int(datetime.fromisoformat(f"{day}T06:00:00").replace(tzinfo=MOD.CT).timestamp() * 1000)
        ns = start * 1_000_000
        quotes = [
            {"sip_timestamp": ns + 100_000_000, "bid_price": 100, "ask_price": 100.1,
             "bid_size": 100, "ask_size": 100},
            {"sip_timestamp": ns + 31_100_000_000, "bid_price": 100.1, "ask_price": 100.2,
             "bid_size": 100, "ask_size": 100},
        ]
        trades = [
            {"sip_timestamp": ns + 200_000_000, "participant_timestamp": ns + 200_000_000,
             "price": 100.1, "size": 100, "conditions": [12], "exchange": 8},
            {"sip_timestamp": ns + 31_200_000_000, "participant_timestamp": ns + 31_200_000_000,
             "price": 100.2, "size": 200, "conditions": [12], "exchange": 8},
        ]
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            for kind, rows in (("trades", trades), ("quotes", quotes)):
                with gzip.open(directory / f"AMD-{kind}.ndjson.gz", "wt") as target:
                    for row in rows:
                        target.write(json.dumps(row) + "\n")
            result = refill.build_bars("AMD", directory, MOD)
            self.assertEqual(result["sourceRows"], {"trades": 2, "quotes": 2})
            self.assertEqual(result["parityChecks"], 1)
            self.assertEqual(result["bars"]["1m"][0]["buy"], 300)
            self.assertEqual(len(result["bars"]["30s"]), 2)

    def test_duplicate_server_does_not_touch_journal_or_open_feed(self):
        with socket.socket() as occupied, tempfile.TemporaryDirectory() as folder:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            port = occupied.getsockname()[1]
            now = datetime.now(MOD.CT)
            with mock.patch.object(sys, "argv", ["serve-amd-live-tape-v1.py", "--port", str(port),
                                                "--raw-dir", folder]), \
                 mock.patch.object(MOD, "market_session_bounds",
                                   return_value=(now - timedelta(minutes=1), now + timedelta(minutes=1))), \
                 mock.patch.object(MOD, "recover_today") as recover, \
                 mock.patch.object(MOD, "append_raw") as journal, \
                 mock.patch.object(MOD, "collect") as feed:
                with self.assertRaises(OSError):
                    MOD.main()
                recover.assert_not_called()
                journal.assert_not_called()
                feed.assert_not_called()

    def test_collector_does_not_connect_after_exchange_close(self):
        state = MOD.TapeState()
        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.dict(MOD.os.environ, {"MASSIVE_API_KEY": "test"}), \
             mock.patch.object(MOD, "connect") as connect:
            MOD.collect(state, Path(folder), datetime.now(MOD.CT) - timedelta(seconds=1))
            connect.assert_not_called()
            self.assertFalse(list(Path(folder).iterdir()))

    def test_verified_full_window_backfill_keeps_first_minute(self):
        day = datetime.now(MOD.CT).date().isoformat()
        base = int(datetime.fromisoformat(f"{day}T06:00:00").replace(tzinfo=MOD.CT).timestamp() * 1000)
        events = [
            {"ev": "BACKFILL_START", "date": day, "startCt": "06:00"},
            {"ev": "Q", "sym": "AMD", "t": base + 100, "bp": 100, "ap": 100.10, "bs": 100, "as": 100},
            {"ev": "T", "sym": "AMD", "t": base + 200, "pt": base + 200,
             "p": 100.10, "s": 100, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 121_000,
             "bp": 100.10, "ap": 100.20, "bs": 100, "as": 100},
        ]
        with tempfile.TemporaryDirectory() as folder:
            log_dir = Path(folder)
            MOD.append_raw(log_dir, day, events)
            recovered = MOD.TapeState()
            self.assertEqual(MOD.recover_today(recovered, log_dir), 3)
            self.assertEqual(recovered.snapshot()["bars"]["AMD"][0]["t"], "06:00")
            self.assertEqual(recovered.recovery_warnings, 0)

    def test_half_minute_buckets_close_only_after_reorder_window(self):
        base = int(datetime(2026, 10, 13, 8, 30, tzinfo=MOD.CT).timestamp() * 1000)
        state = MOD.TapeState()
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        state.ingest([
            {"ev": "Q", "sym": "AMD", "t": base + 1_000,
             "bp": 100, "ap": 100.10, "bs": 100, "as": 100},
            {"ev": "T", "sym": "AMD", "t": base + 1_100, "pt": base + 1_100,
             "p": 100.10, "s": 100, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 32_000,
             "bp": 100.10, "ap": 100.20, "bs": 100, "as": 100},
            {"ev": "T", "sym": "AMD", "t": base + 32_100, "pt": base + 32_100,
             "p": 100.10, "s": 200, "x": 12, "c": []},
        ])
        self.assertEqual(state.half_snapshot()["bars"]["AMD"][0]["t"], "08:30:00")
        self.assertEqual(len(state.half_snapshot()["bars"]["AMD"]), 1)
        self.assertNotIn("priceLevels", state.half_snapshot()["bars"]["AMD"][0])
        first = state.footprint(base, 30_000)
        self.assertEqual(first["levels"], [[10010, 100, 100, 0]])
        self.assertIsNone(state.footprint(base, 60_000))
        state.ingest([{"ev": "Q", "sym": "AMD", "t": base + 63_000,
                       "bp": 100.10, "ap": 100.20, "bs": 100, "as": 100}])
        halves = state.half_snapshot()["bars"]["AMD"]
        self.assertEqual([bar["t"] for bar in halves], ["08:30:00", "08:30:30"])
        minute = state.snapshot()["bars"]["AMD"][0]
        self.assertEqual(minute["buy"], sum(bar["buy"] for bar in halves))
        self.assertEqual(minute["sell"], sum(bar["sell"] for bar in halves))
        self.assertEqual(minute["c"], halves[-1]["c"])
        whole = state.footprint(base, 60_000)
        self.assertEqual(whole["levels"], [[10010, 300, 100, 200]])
        with tempfile.TemporaryDirectory() as folder:
            server = ThreadingHTTPServer(("127.0.0.1", 0), MOD.handler(state, Path(folder)))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                url = (f"http://127.0.0.1:{server.server_port}/api/footprint"
                       f"?date={state.date}&stampMs={base}&durationMs=60000")
                self.assertEqual(json.load(urllib.request.urlopen(url))["levels"], whole["levels"])
                with self.assertRaises(urllib.error.HTTPError) as invalid:
                    urllib.request.urlopen(url.replace("durationMs=60000", "durationMs=45000"))
                self.assertEqual(invalid.exception.code, 400)
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_live_updates_stream_only_advances_for_completed_buckets(self):
        base = int(datetime(2026, 10, 13, 8, 30, tzinfo=MOD.CT).timestamp() * 1000)
        state = MOD.TapeState()
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        with tempfile.TemporaryDirectory() as folder:
            server = ThreadingHTTPServer(("127.0.0.1", 0), MOD.handler(state, Path(folder)))
            server.daemon_threads = True
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{server.server_port}/api/updates?symbol=AMD", timeout=3
                ) as stream:
                    self.assertEqual(stream.headers.get_content_type(), "text/event-stream")
                    initial = json.loads(stream.readline().decode().removeprefix("data: "))
                    stream.readline()
                    self.assertEqual(initial["version"], 0)
                    state.ingest([{"ev": "T", "sym": "AMD", "t": base + 1_000,
                                   "pt": base + 1_000, "p": 100, "s": 10, "x": 12, "c": []}])
                    self.assertEqual(state.update_signal("AMD")["version"], 0)
                    state.ingest([{"ev": "T", "sym": "AMD", "t": base + 33_000,
                                   "pt": base + 33_000, "p": 101, "s": 10, "x": 12, "c": []}])
                    update = json.loads(stream.readline().decode().removeprefix("data: "))
                    self.assertEqual(update["version"], 1)
                    self.assertEqual(update["runId"], state.snapshot("AMD")["runId"])
                    self.assertEqual(len(state.half_snapshot("AMD")["bars"]["AMD"]), 1)
                    url = (f"http://127.0.0.1:{server.server_port}/api/half?date={state.date}"
                           f"&symbol=AMD&afterMs={base}&runId={state.run_id}&clientDate={state.date}")
                    self.assertEqual(json.load(urllib.request.urlopen(url))["bars"]["AMD"], [])
                    delta = state.half_snapshot("AMD", after_ms=base, client_run_id=state.run_id,
                                                client_date=state.date)
                    self.assertTrue(delta["incremental"])
                    self.assertEqual(delta["bars"]["AMD"], [])
                    restart = state.half_snapshot("AMD", after_ms=base, client_run_id="old-run",
                                                  client_date=state.date)
                    self.assertFalse(restart["incremental"])
                    self.assertEqual(len(restart["bars"]["AMD"]), 1)
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_watchlist_peers_use_own_atr_and_surface_stale_prices(self):
        day = "2026-10-08"
        stamp = int(datetime(2026, 10, 8, 8, 10, tzinfo=MOD.CT).timestamp() * 1000)
        daily = [{"c": 100, "h": 105, "l": 95} for _ in range(15)]

        def aggregates(symbol, unit, _start, _end):
            if unit == "day":
                return daily
            close = {"AMD": 103, "SMH": 101, "MSFT": 99, "QQQ": 100}[symbol]
            end_minute = 8 if symbol == "MSFT" else 10
            return [{"t": int(datetime(2026, 10, 8, 6, 0, tzinfo=MOD.CT).timestamp() * 1000),
                     "o": 100, "c": 100},
                    {"t": int(datetime(2026, 10, 8, 8, end_minute, tzinfo=MOD.CT).timestamp() * 1000),
                     "o": close, "c": close}]

        with tempfile.TemporaryDirectory() as folder, mock.patch.object(
                MOD, "massive_aggregates", side_effect=aggregates):
            report = MOD.watchlist_peer_snapshot(day, stamp,
                                                   [("AMD", "SMH"), ("MSFT", "QQQ")], Path(folder))
        self.assertEqual(report["rows"][0]["relativeAtr"], 0.2)
        self.assertGreater(report["rows"][0]["score"], 50)
        self.assertEqual(report["rows"][1]["stock"]["ageMinutes"], 2)
        self.assertLess(report["rows"][1]["score"], 50)

    def test_options_chain_snapshot_is_archived_and_not_retrofilled(self):
        selected = int(datetime(2026, 10, 7, 8, 30, tzinfo=MOD.CT).timestamp() * 1000)
        clock = datetime(2026, 10, 7, 8, 31, 15, tzinfo=MOD.CT)

        class FixedDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return clock.astimezone(tz) if tz else clock.replace(tzinfo=None)

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def read(self, *_args):
                return json.dumps({"status": "OK", "results": [{
                    "details": {"contract_type": "call", "strike_price": 650,
                                "expiration_date": "2026-10-09", "shares_per_contract": 100},
                    "open_interest": 1234, "greeks": {"gamma": .01}}]}).encode()

        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.object(MOD, "datetime", FixedDatetime), \
             mock.patch.object(MOD.time, "time", return_value=clock.timestamp()), \
             mock.patch.dict(MOD.os.environ, {"MASSIVE_API_KEY": "fixture-key"}), \
             mock.patch.object(MOD.urllib.request, "urlopen", return_value=Response()) as fetch:
            report = MOD.capture_options_walls("2026-10-07", selected, 640, Path(folder))
            self.assertFalse(report["available"])
            self.assertIn("after the selected minute", report["reason"])
            self.assertEqual(fetch.call_count, 1)
            raw = next(Path(folder).glob("options-wall-bot-v1/2026-10-07/*-raw.json"))
            self.assertNotIn("fixture-key", raw.read_text())
            self.assertEqual(MOD.hashlib.sha256(raw.read_bytes()).hexdigest(),
                             json.loads(next(Path(folder).glob("options-wall-bot-v1/2026-10-07/*-summary.json")).read_text())["sourceSha256"])
            later = MOD.capture_options_walls("2026-10-07", selected + 2 * 60_000,
                                              642, Path(folder))
            self.assertTrue(later["available"])
            self.assertEqual(later["callOiWalls"][0]["strike"], 650)
            older = MOD.capture_options_walls("2026-10-07", selected - 10 * 60_000,
                                              640, Path(folder))
            self.assertFalse(older["available"])
            self.assertEqual(fetch.call_count, 1)
            other = MOD.capture_options_walls("2026-10-07", selected, 640,
                                              Path(folder), "MU")
            self.assertEqual(other["symbol"], "MU")
            self.assertTrue(list(Path(folder).glob(
                "options-wall-bot-v1/MU/2026-10-07/*-summary.json")))
            self.assertIn("/options/MU?", fetch.call_args.args[0])

    def test_market_context_capture_is_persisted_per_recorded_minute(self):
        stamp = int(datetime(2026, 10, 7, 8, 25, tzinfo=MOD.CT).timestamp() * 1000)
        breadth = {"names": {}, "phase": "premarket", "asOfCt": "08:25"}
        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.object(MOD, "fetch_peer_breadth", return_value=breadth) as fetch:
            first = MOD.capture_market_context("2026-10-07", stamp, Path(folder))
            second = MOD.capture_market_context("2026-10-07", stamp, Path(folder))
            self.assertEqual(first, second)
            self.assertEqual(fetch.call_count, 1)
            self.assertTrue((Path(folder) / "market-context-bot-v1" / "2026-10-07" /
                             f"{stamp}.json").is_file())

    def test_level_bot_endpoint_uses_a_recorded_amd_minute(self):
        stamp = int(datetime(2026, 10, 7, 8, 25, tzinfo=MOD.CT).timestamp() * 1000)

        class RecordedState:
            def snapshot(self):
                return {"date": "2026-10-07", "bars": {"AMD": [{"t": "08:25", "stampMs": stamp}]}}

        with tempfile.TemporaryDirectory() as folder:
            server = ThreadingHTTPServer(("127.0.0.1", 0), MOD.handler(RecordedState(), Path(folder)))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                url = (f"http://127.0.0.1:{server.server_port}/api/levels"
                       f"?symbol=MU&date=2026-10-07&asofStampMs={stamp}")
                with mock.patch.object(MOD, "fetch_symbol_levels", return_value={
                    "available": True, "symbol": "MU", "levels": []}) as find:
                    result = json.load(urllib.request.urlopen(url))
                self.assertEqual(result["symbol"], "MU")
                self.assertEqual(find.call_args.args[:3], ("MU", "2026-10-07", stamp + 60_000))
                with mock.patch.object(MOD, "fetch_premarket_reference", return_value={
                    "symbol": "MU", "premarket": {"available": True, "high": 123.45}}) as premarket:
                    reference = json.load(urllib.request.urlopen(
                        url.replace("/api/levels", "/api/premarket-levels")))
                self.assertEqual(reference["premarket"]["high"], 123.45)
                self.assertEqual(premarket.call_args.args[:3], ("MU", "2026-10-07", stamp + 60_000))
                with mock.patch.object(MOD, "capture_market_context", return_value={
                    "date": "2026-10-07", "asOfCt": "08:25"}) as context:
                    market = json.load(urllib.request.urlopen(
                        url.replace("/api/levels", "/api/market-context")))
                self.assertEqual(market["asOfCt"], "08:25")
                self.assertEqual(context.call_args.args[:2], ("2026-10-07", stamp))
                with mock.patch.object(MOD, "capture_macro_context", return_value={
                    "date": "2026-10-07", "asOfCt": "08:25"}) as macro:
                    broad = json.load(urllib.request.urlopen(
                        url.replace("/api/levels", "/api/macro-context")))
                self.assertEqual(broad["asOfCt"], "08:25")
                self.assertEqual(macro.call_args.args[:2], ("2026-10-07", stamp))
                with mock.patch.object(MOD, "massive_aggregates", return_value=[{
                    "t": stamp, "c": 640}]), mock.patch.object(MOD, "capture_options_walls", return_value={
                    "available": True, "callOiWalls": [{"strike": 650}]}) as walls:
                    options = json.load(urllib.request.urlopen(
                        url.replace("/api/levels", "/api/options-walls")))
                self.assertEqual(options["callOiWalls"][0]["strike"], 650)
                self.assertEqual(walls.call_args.args[:2], ("2026-10-07", stamp))
                self.assertEqual(walls.call_args.args[-1], "MU")
                with mock.patch.object(MOD, "fetch_symbol_levels", return_value={
                    "available": True, "symbol": "MU"}):
                    next_minute = json.load(urllib.request.urlopen(
                        url.replace(str(stamp), str(stamp + 60_000))))
                self.assertEqual(next_minute["symbol"], "MU")
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(url.replace("symbol=MU", "symbol=AMD").replace(
                        str(stamp), str(stamp + 12_345)))
                self.assertEqual(error.exception.code, 400)
                # A same-date archived replay remains usable after the live
                # buffer has stopped, but only for an exact recorded minute.
                with mock.patch.object(MOD, "fetch_symbol_levels", return_value={
                    "available": True, "symbol": "AMD"}) as archived:
                    replayed = json.load(urllib.request.urlopen(
                        url.replace("symbol=MU", "symbol=AMD").replace(
                            str(stamp), str(stamp + 60_000))))
                self.assertEqual(replayed["symbol"], "AMD")
                self.assertEqual(archived.call_args.args[:3],
                                 ("AMD", "2026-10-07", stamp + 120_000))
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_premarket_midpoint_distinguishes_rejection_reclaim_and_future(self):
        def bar(clock, opening, high, low, close):
            hour, minute = map(int, clock.split(":"))
            stamp = int(datetime(2026, 10, 7, hour, minute, tzinfo=MOD.CT).timestamp() * 1000)
            return {"t": stamp, "o": opening, "h": high, "l": low, "c": close, "v": 100}

        rows = [bar("03:00", 110, 110, 108, 109),
                bar("08:24", 101, 102, 100, 101),
                bar("08:30", 104, 106, 103, 104),  # 105 rejects from below.
                bar("08:31", 104, 106, 104, 106),
                bar("08:32", 106, 107, 105, 106),
                bar("08:33", 106, 108, 105, 107),
                bar("08:34", 107, 200, 107, 199)]
        early = MOD.premarket_midpoint_context(rows, "2026-10-07", rows[2]["t"])
        self.assertEqual(early["midpoint"], 105)
        self.assertEqual(early["premarketDirection"], "bearish")
        self.assertEqual(early["firstRejectionCt"], "08:30")
        self.assertIsNone(early["firstSustainedReclaimCt"])
        self.assertEqual(early["lastThreeClosesState"], "testing_or_mixed")
        reclaimed = MOD.premarket_midpoint_context(rows, "2026-10-07", rows[5]["t"])
        self.assertEqual(reclaimed["firstSustainedReclaimCt"], "08:31")
        self.assertEqual(reclaimed["lastThreeClosesState"], "sustained_above")
        self.assertEqual(reclaimed["high"], 110)  # Later regular-session high cannot leak into PM.

    def test_collector_window_uses_exchange_close_and_holidays(self):
        regular = MOD.market_session_bounds(datetime(2026, 10, 7, 6, 0, tzinfo=MOD.CT))
        self.assertEqual(regular[0].strftime("%H:%M"), "03:00")
        self.assertEqual(regular[1].strftime("%H:%M"), "15:00")
        self.assertIsNone(MOD.market_session_bounds(datetime(2026, 11, 26, 6, 0,
                                                       tzinfo=MOD.CT)))
        early = MOD.market_session_bounds(datetime(2026, 11, 27, 6, 0, tzinfo=MOD.CT))
        self.assertEqual(early[1].strftime("%H:%M"), "12:00")

    def test_on_demand_request_uses_selected_completed_prefix_and_caches(self):
        start = int(datetime(2026, 10, 7, 6, 0, tzinfo=MOD.CT).timestamp() * 1000)
        bars = [{"t": f"06:{minute:02d}", "stampMs": start + minute * 60_000}
                for minute in range(20)]

        class RecordedState:
            def snapshot(self):
                return {"date": "2026-10-07", "bars": {"AMD": bars},
                        "status": "connected", "receivedAgeSeconds": 1,
                        "eventLagSeconds": 1}

        with tempfile.TemporaryDirectory() as folder:
            server = ThreadingHTTPServer(("127.0.0.1", 0), MOD.handler(RecordedState(), Path(folder)))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            payload = json.dumps({"date": "2026-10-07", "width": 2,
                                  "asofStampMs": bars[12]["stampMs"],
                                  "traderNote": "AMD appears to consolidate"}).encode()
            request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/api/ask",
                                             data=payload, headers={"Content-Type": "application/json"},
                                             method="POST")
            try:
                with mock.patch.object(MOD, "build_on_demand_context", return_value={
                    "asOf": "06:12", "reason": "Minute gap in the current window"}) as build, \
                     mock.patch.object(MOD, "prior_day_context", return_value={"available": False}), \
                     mock.patch.object(MOD, "fetch_peer_breadth", return_value={"names": {}}), \
                     mock.patch.object(MOD, "capture_macro_context", return_value={"available": True}), \
                     mock.patch.object(MOD, "capture_options_walls", return_value={
                         "available": False, "reason": "fixture"}), \
                     mock.patch.object(MOD, "ask_openai", return_value={
                         "text": "Thesis: test", "model": "test", "usage": None}) as ask:
                    first = json.load(urllib.request.urlopen(request))
                    second = json.load(urllib.request.urlopen(request))
                self.assertEqual(len(build.call_args.args[0]), 13)
                self.assertEqual(build.call_args.args[0][-1]["t"], "06:12")
                self.assertEqual(build.call_count, 1)
                self.assertEqual(ask.call_count, 1)
                self.assertEqual(ask.call_args.args[0]["tapeWindowQuality"], "incomplete")
                self.assertTrue(ask.call_args.args[0]["macroContextBot"]["available"])
                self.assertIn("crossToolHistory", ask.call_args.args[0])
                self.assertFalse(ask.call_args.args[0]["optionsWalls"]["available"])
                self.assertFalse(first["cached"])
                self.assertTrue(second["cached"])
                self.assertEqual(second["asOfCt"], "06:12")
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_first_two_opening_minutes_allow_partial_read_without_orb(self):
        start = int(datetime(2026, 10, 7, 8, 25, tzinfo=MOD.CT).timestamp() * 1000)
        bars = [{"t": f"08:{minute:02d}", "stampMs": start + (minute - 25) * 60_000}
                for minute in range(25, 32)]

        class RecordedState:
            def snapshot(self):
                return {"date": "2026-10-07", "bars": {"AMD": bars},
                        "status": "recorded", "receivedAgeSeconds": None,
                        "eventLagSeconds": None}

        with tempfile.TemporaryDirectory() as folder:
            server = ThreadingHTTPServer(("127.0.0.1", 0), MOD.handler(RecordedState(), Path(folder)))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            payload = json.dumps({"date": "2026-10-07", "width": 5,
                                  "asofStampMs": bars[-1]["stampMs"]}).encode()
            request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/api/ask",
                                             data=payload, headers={"Content-Type": "application/json"},
                                             method="POST")
            try:
                with mock.patch.object(MOD, "build_on_demand_context", return_value={
                         "asOf": "08:31", "reason": "Waiting for 5 complete regular-session minutes",
                         "levels": {"orb5": None}}), \
                     mock.patch.object(MOD, "prior_day_context", return_value={"available": False}), \
                     mock.patch.object(MOD, "fetch_peer_breadth", return_value={"names": {}}), \
                     mock.patch.object(MOD, "capture_market_context", return_value={"available": False}), \
                     mock.patch.object(MOD, "fetch_symbol_levels", return_value={"available": False}), \
                     mock.patch.object(MOD, "capture_macro_context", return_value={"available": False}), \
                     mock.patch.object(MOD, "capture_options_walls", return_value={"available": False}), \
                     mock.patch.object(MOD, "ask_openai", return_value={
                         "text": "Read: partial open", "model": "test", "usage": None}) as ask:
                    result = json.load(urllib.request.urlopen(request))
                self.assertEqual(result["asOfCt"], "08:31")
                self.assertEqual(result["context"]["tapeWindowQuality"], "incomplete")
                self.assertIsNone(result["context"]["levels"]["orb5"])
                self.assertEqual(ask.call_count, 1)
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_peer_breadth_uses_own_atr_and_same_clock_volume_without_future(self):
        start = int(datetime(2026, 10, 7, 8, 30, tzinfo=MOD.CT).timestamp() * 1000)
        reference = {"atr14": 10, "baseline": {"regular": {
            "sessions": 20, "medianCumulativeVolume": [100, 200, 300, 400, 500] + [500] * 145}}}
        references = {symbol: reference for symbol in MOD.PEER_BREADTH_SYMBOLS}
        today = {symbol: [{"t": start + i * 60_000, "o": 100,
                           "c": 100 + i, "v": 50} for i in range(5)] +
                 [{"t": start + 5 * 60_000, "o": 100, "c": 999, "v": 999_999}]
                 for symbol in MOD.PEER_BREADTH_SYMBOLS}
        result = MOD.breadth_snapshot("2026-10-07", start + 4 * 60_000,
                                     references, today)
        self.assertEqual(result["names"]["AMD"]["moveInAtr"], 0.4)
        self.assertEqual(result["names"]["AMD"]["volumePace"], 0.5)
        self.assertEqual(result["names"]["AMD"]["cumulativeVolume"], 250)
        self.assertEqual(result["names"]["SMH"]["moveInAtr"], 0.4)
        today["MU"].pop(4)
        missing = MOD.breadth_snapshot("2026-10-07", start + 4 * 60_000,
                                     references, today)
        self.assertTrue(missing["names"]["MU"]["available"])
        self.assertEqual(missing["names"]["MU"]["lastObservedCt"], "08:33")
        self.assertEqual(missing["names"]["MU"]["observationAgeMinutes"], 1)
        today["MU"] = today["MU"][:2]
        stale = MOD.breadth_snapshot("2026-10-07", start + 4 * 60_000,
                                    references, today)
        self.assertFalse(stale["names"]["MU"]["available"])

    def test_raw_journal_recovers_complete_minutes_and_skips_gaps(self):
        base = int(datetime.now(MOD.CT).replace(
            hour=6, minute=0, second=0, microsecond=0).timestamp() * 1000)

        def trade(offset, price):
            stamp = base + offset
            return {"ev": "T", "sym": "AMD", "t": stamp, "pt": stamp - 1,
                    "p": price, "s": 100, "x": 12, "c": []}

        with tempfile.TemporaryDirectory() as folder:
            log_dir = Path(folder)
            MOD.append_raw(log_dir, MOD.ct_date(base), [
                trade(10_000, 100),               # Initial partial minute is hidden.
                trade(70_000, 101),
                trade(130_000, 102),              # Closes 06:01.
                {"ev": "GAP", "reason": "feed_interruption"},
                trade(200_000, 103),              # First minute after gap is hidden.
                trade(250_000, 104),
                trade(310_000, 105),              # Closes 06:04.
                trade(370_000, 106),              # In-progress minute is discarded.
            ])
            restored = MOD.TapeState()
            self.assertEqual(MOD.recover_today(restored, log_dir), 7)
            bars = restored.snapshot()["bars"]["AMD"]
            self.assertEqual([bar["c"] for bar in bars], [101, 104, 105])
            self.assertEqual(restored.snapshot()["recoveredBars"], 3)
            self.assertIsNone(restored.snapshot()["receivedAgeSeconds"])

            # The first live minute after process restart cannot reuse 06:06.
            restored.ingest([trade(400_000, 107), trade(430_000, 108),
                             trade(490_000, 109)])
            self.assertEqual([bar["c"] for bar in restored.snapshot()["bars"]["AMD"]],
                             [101, 104, 105, 108])

    def test_truncated_raw_tail_is_isolated_before_next_record(self):
        base = int(datetime.now(MOD.CT).replace(
            hour=6, minute=0, second=0, microsecond=0).timestamp() * 1000)
        with tempfile.TemporaryDirectory() as folder:
            log_dir = Path(folder)
            path = MOD.raw_path(log_dir, MOD.ct_date(base))
            path.write_text('{"ev":"T"')
            MOD.append_raw(log_dir, MOD.ct_date(base),
                           [{"ev": "GAP", "reason": "server_restart"}], durable=True)
            lines = path.read_text().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(json.loads(lines[1])["ev"], "GAP")
            restored = MOD.TapeState()
            MOD.recover_today(restored, log_dir)
            self.assertEqual(restored.snapshot()["recoveryWarnings"], 1)

    def test_two_symbols_have_isolated_buckets_on_one_socket(self):
        self.assertEqual(MOD.SYMBOLS, ("AMD", "TSLA", "SPY", "SMH", "QQQ", "META", "NVDA", "MU", "MSFT", "SOXL", "SPCX", "SNDK"))
        source = Path(MOD.__file__).read_text()
        self.assertIn('"action": "unsubscribe"', source)
        self.assertNotIn('T.AMDL', source)
        original = MOD.SYMBOLS
        try:
            MOD.SYMBOLS = ("AMD", "TSLA", "SPY", "SMH")
            state = MOD.TapeState()
            self.assertEqual(set(state.snapshot()["bars"]), {"AMD", "TSLA", "SPY", "SMH"})
            self.assertIsNot(state.closed["AMD"], state.closed["TSLA"])
            self.assertIsNot(state.closed["SPY"], state.closed["SMH"])
            state.closed["AMD"].append({"t": "08:30", "stampMs": 1, "c": 100})
            state.closed["TSLA"].append({"t": "08:30", "stampMs": 1, "c": 200})
            state.closed["SPY"].append({"t": "08:30", "stampMs": 1, "c": 300})
            state.closed["SMH"].append({"t": "08:30", "stampMs": 1, "c": 400})
            state.closed_halves["AMD"].append({"t": "08:30:00", "stampMs": 1, "c": 100})
            state.closed_halves["TSLA"].append({"t": "08:30:00", "stampMs": 1, "c": 200})
            self.assertEqual(list(state.snapshot("TSLA")["bars"]), ["TSLA"])
            self.assertEqual(state.snapshot("TSLA")["bars"]["TSLA"][0]["c"], 200)
            self.assertEqual(state.snapshot("SPY")["bars"]["SPY"][0]["c"], 300)
            self.assertEqual(state.snapshot("SMH")["bars"]["SMH"][0]["c"], 400)
            self.assertEqual(list(state.half_snapshot("AMD")["bars"]), ["AMD"])
            with tempfile.TemporaryDirectory() as folder:
                server = ThreadingHTTPServer(("127.0.0.1", 0), MOD.handler(state, Path(folder)))
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    base = f"http://127.0.0.1:{server.server_port}"
                    self.assertEqual(list(json.load(urllib.request.urlopen(base + "/api/state?symbol=TSLA"))["bars"]), ["TSLA"])
                    self.assertEqual(list(json.load(urllib.request.urlopen(
                        base + f"/api/half?date={state.date}&symbol=AMD"))["bars"]), ["AMD"])
                    with self.assertRaises(urllib.error.HTTPError) as invalid:
                        urllib.request.urlopen(base + "/api/state?symbol=INVALID")
                    self.assertEqual(invalid.exception.code, 400)
                finally:
                    server.shutdown()
                    server.server_close()
                    worker.join(timeout=2)
        finally:
            MOD.SYMBOLS = original

    def test_server_watchlist_is_read_only_and_preserves_live_buckets(self):
        state = MOD.TapeState(("AMD", "TSLA"))
        state.closed["TSLA"].append({"t": "08:30", "stampMs": 1, "c": 200})
        with tempfile.TemporaryDirectory() as folder:
            raw_dir = Path(folder)
            server = ThreadingHTTPServer(("127.0.0.1", 0), MOD.handler(state, raw_dir))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                self.assertEqual(json.load(urllib.request.urlopen(base + "/api/watchlist"))["symbols"],
                                 ["AMD", "TSLA"])
                request = urllib.request.Request(base + "/api/watchlist",
                                                 data=b'{"symbols":["AMD"]}',
                                                 headers={"Content-Type": "application/json"})
                with self.assertRaises(urllib.error.HTTPError) as rejected:
                    urllib.request.urlopen(request)
                self.assertEqual(rejected.exception.code, 405)
                self.assertEqual(state.watchlist(), ["AMD", "TSLA"])
                self.assertEqual(state.snapshot("TSLA")["bars"]["TSLA"],
                                 [{"t": "08:30", "stampMs": 1, "c": 200}])
                self.assertFalse((raw_dir / "watchlist.json").exists())
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_watchlist_isolates_actual_amd_and_tsla_candles(self):
        base = int(datetime(2026, 10, 13, 8, 30, tzinfo=MOD.CT).timestamp() * 1000)
        state = MOD.TapeState(("AMD", "TSLA"))
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        state.ingest([
            {"ev": "T", "sym": "AMD", "t": base + 1_000,
             "pt": base + 1_000, "p": 100, "s": 20, "x": 12, "c": []},
            {"ev": "T", "sym": "TSLA", "t": base + 1_100,
             "pt": base + 1_100, "p": 200, "s": 30, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 63_000,
             "bp": 100, "ap": 100.1, "bs": 100, "as": 100},
        ])
        self.assertEqual(state.snapshot("AMD")["bars"]["AMD"][0]["c"], 100)
        self.assertEqual(state.snapshot("TSLA")["bars"]["TSLA"][0]["c"], 200)
        state.set_watchlist(("AMD",))
        self.assertEqual(state.snapshot()["bars"].keys(), {"AMD"})
        state.ingest([{"ev": "T", "sym": "TSLA", "t": base + 65_000,
                       "pt": base + 65_000, "p": 201, "s": 40, "x": 12, "c": []}])
        self.assertEqual(state.snapshot("TSLA")["bars"]["TSLA"], [])

    def test_watchlist_changes_subscribe_and_unsubscribe_on_one_socket(self):
        class FakeSocket:
            def __init__(self):
                self.incoming = queue.Queue()
                self.sent = []
                self.lock = threading.Lock()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def send(self, value):
                with self.lock:
                    self.sent.append(json.loads(value))

            def recv(self, timeout):
                try:
                    return self.incoming.get(timeout=0.01)
                except queue.Empty:
                    raise TimeoutError

            def has(self, action, symbol):
                with self.lock:
                    return any(row.get("action") == action and f"T.{symbol}" in row.get("params", "")
                               and f"Q.{symbol}" in row.get("params", "") for row in self.sent)

        def wait_for(predicate):
            deadline = time.monotonic() + 0.5
            while time.monotonic() < deadline:
                if predicate():
                    return True
                time.sleep(0.01)
            return False

        socket = FakeSocket()
        socket.incoming.put(json.dumps([{"ev": "status", "status": "auth_success"}]))
        state = MOD.TapeState(("AMD",))
        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.dict(MOD.os.environ, {"MASSIVE_API_KEY": "test"}), \
             mock.patch.object(MOD, "connect", return_value=socket) as connect:
            worker = threading.Thread(target=MOD.collect,
                                      args=(state, Path(folder), datetime.now(MOD.CT) + timedelta(seconds=1)),
                                      daemon=True)
            worker.start()
            self.assertTrue(wait_for(lambda: socket.has("subscribe", "AMD")))
            state.set_watchlist(("AMD", "TSLA", "SPY", "SMH"))
            self.assertTrue(wait_for(lambda: socket.has("subscribe", "TSLA")))
            self.assertTrue(wait_for(lambda: socket.has("subscribe", "SPY")))
            self.assertTrue(wait_for(lambda: socket.has("subscribe", "SMH")))
            state.set_watchlist(("TSLA",))
            self.assertTrue(wait_for(lambda: socket.has("unsubscribe", "AMD")))
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
            connect.assert_called_once()

    def test_completed_minute_classifies_lit_trades_and_ofi(self):
        state = MOD.TapeState()
        base = 1_780_760_400_000  # A minute-aligned timestamp; the date is immaterial.
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        state.ingest([
            {"ev": "Q", "sym": "AMD", "t": base + 10_000, "bp": 100, "ap": 100.1, "bs": 100, "as": 100},
            {"ev": "T", "sym": "AMD", "t": base + 10_500, "pt": base + 10_490,
             "p": 100.1, "s": 200, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 20_000, "bp": 100.05, "ap": 100.15,
             "bs": 150, "as": 80},
            {"ev": "T", "sym": "AMD", "t": base + 20_500, "pt": base + 20_490,
             "p": 100.05, "s": 100, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 64_000, "bp": 100.04, "ap": 100.14,
             "bs": 130, "as": 100},
        ])
        bars = state.snapshot()["bars"]["AMD"]
        self.assertEqual(len(bars), 1)
        self.assertEqual((bars[0]["buy"], bars[0]["sell"], bars[0]["delta"]), (200, 100, 100))
        self.assertAlmostEqual(bars[0]["coveragePct"], 100)
        self.assertGreater(bars[0]["ofi"], 0)
        self.assertAlmostEqual(bars[0]["midMoveCents"], 5)

    def test_quote_only_minute_is_not_a_price_bar(self):
        state = MOD.TapeState()
        base = 1_780_760_400_000
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        state.ingest([
            {"ev": "Q", "sym": "AMD", "t": base + 1_000, "bp": 100, "ap": 100.1,
             "bs": 100, "as": 100},
            {"ev": "Q", "sym": "AMD", "t": base + 65_000, "bp": 100.01, "ap": 100.11,
             "bs": 100, "as": 100},
        ])
        self.assertEqual(state.snapshot()["bars"]["AMD"], [])

    def test_first_partial_minute_is_hidden(self):
        state = MOD.TapeState()
        base = 1_780_760_400_000
        state.ingest([
            {"ev": "T", "sym": "AMD", "t": base + 45_000, "pt": base + 44_990,
             "p": 100, "s": 100, "x": 12, "c": []},
            {"ev": "T", "sym": "AMD", "t": base + 60_100, "pt": base + 60_090,
             "p": 101, "s": 100, "x": 12, "c": []},
            {"ev": "Q", "sym": "AMD", "t": base + 124_000, "bp": 100, "ap": 100.1,
             "bs": 100, "as": 100},
        ])
        bars = state.snapshot()["bars"]["AMD"]
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]["c"], 101)

    def test_opening_cross_does_not_make_an_actionable_bar(self):
        minute = MOD.Minute(1_780_760_400_000)
        minute.trade({"t": minute.start_ms + 10, "pt": minute.start_ms + 9,
                      "p": 100, "s": 1_000_000, "x": 4, "c": [9]}, None)
        self.assertIsNone(minute.result()["c"])
        self.assertEqual(minute.result()["litShares"], 0)
        self.assertEqual(minute.result()["offExchangePrints"], 1)
        self.assertEqual(minute.result()["offExchangeShares"], 1_000_000)

    def test_off_exchange_reports_are_separate_from_lit_pressure_and_price_bars(self):
        state = MOD.TapeState()
        base = 1_780_760_400_000
        state.date = MOD.ct_date(base)
        state.awaiting_first_event = False
        state.drop_through_minute = base - 60_000
        state.ingest([
            {"ev": "T", "sym": "AMD", "t": base + 1_000, "pt": base + 900,
             "p": 100, "s": 200, "x": 4, "trfi": 201, "c": [9]},
            {"ev": "Q", "sym": "AMD", "t": base + 63_000, "bp": 100,
             "ap": 100.1, "bs": 100, "as": 100},
        ])
        snapshot = state.snapshot()
        self.assertEqual(snapshot["bars"]["AMD"], [])
        self.assertEqual(snapshot["offExchange"]["AMD"][0]["prints"], 1)
        self.assertEqual(snapshot["offExchange"]["AMD"][0]["shares"], 200)
        self.assertEqual(snapshot["offExchange"]["AMD"][0]["unknown"], 200)

    def test_off_exchange_side_estimate_keeps_ambiguous_shares_unknown(self):
        start = int(datetime(2026, 10, 8, 8, 30, tzinfo=MOD.CT).timestamp() * 1000)
        minute = MOD.Minute(start)
        quote = {"t": start + 1_000, "bp": 100, "ap": 100.10}
        def report(offset, price, size, *, pt=None, conditions=None):
            minute.trade({"t": start + offset, "pt": start + (pt if pt is not None else offset - 10),
                          "p": price, "s": size, "x": 4, "trfi": 201,
                          "c": conditions or []}, quote)
        report(1_100, 100.10, 100)
        report(1_200, 100, 200)
        report(1_300, 100.05, 300)
        report(4_000, 100.10, 400)  # Stale quote.
        report(4_100, 100, 500, pt=1_050)  # Delayed TRF report.
        report(1_400, 100.10, 600, conditions=[9])  # Opening cross.
        report(1_500, 100.10, 700, pt=900)  # Quote after execution.
        result = minute.result()
        self.assertEqual(result["offExchangeEstimatedBuy"], 100)
        self.assertEqual(result["offExchangeEstimatedSell"], 200)
        self.assertEqual(result["offExchangeUnknown"], 2_500)
        self.assertEqual(result["offExchangeShares"], 2_800)
        self.assertEqual((result["buy"], result["sell"]), (0, 0))

    def test_off_exchange_traffic_recovers_from_today_raw_journal(self):
        base = int(datetime.now(MOD.CT).replace(
            hour=8, minute=30, second=0, microsecond=0).timestamp() * 1000)
        rows = [
            {"ev": "Q", "sym": "AMD", "t": base + 1_000,
             "bp": 100, "ap": 100.1, "bs": 100, "as": 100},
            {"ev": "T", "sym": "AMD", "t": base + 61_000,
             "p": 100, "s": 350, "x": 4, "trfi": 201, "c": [9]},
            {"ev": "Q", "sym": "AMD", "t": base + 123_000,
             "bp": 100, "ap": 100.1, "bs": 100, "as": 100},
        ]
        with tempfile.TemporaryDirectory() as folder:
            MOD.append_raw(Path(folder), MOD.ct_date(base), rows)
            restored = MOD.TapeState()
            MOD.recover_today(restored, Path(folder))
            reports = restored.snapshot()["offExchange"]["AMD"]
            self.assertEqual(reports[-1]["t"], "08:31")
            self.assertEqual((reports[-1]["prints"], reports[-1]["shares"]), (1, 350))

    def test_extended_hours_form_t_sets_price(self):
        start = int(datetime(2026, 10, 7, 6, 0, tzinfo=ZoneInfo("America/Chicago")).timestamp() * 1000)
        minute = MOD.Minute(start)
        minute.trade({"t": start + 10, "pt": start + 9,
                      "p": 100, "s": 100, "x": 12, "c": [12]}, None)
        self.assertEqual(minute.result()["c"], 100)


if __name__ == "__main__":
    unittest.main()
