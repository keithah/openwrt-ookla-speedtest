import importlib.machinery
import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


SERVICE = (
    Path(__file__).resolve().parents[1]
    / "package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd"
)


class ServiceLiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = tempfile.TemporaryDirectory()
        root = Path(cls.runtime.name)
        environment = {
            "OOKLA_WEBD_RUN_DIR": str(root / "run"),
            "OOKLA_WEBD_HISTORY": str(root / "etc" / "history.jsonl"),
        }
        with mock.patch.dict(os.environ, environment), mock.patch(
            "sys.argv", [str(SERVICE)]
        ):
            loader = importlib.machinery.SourceFileLoader(
                "ookla_speedtest_webd", str(SERVICE)
            )
            spec = importlib.util.spec_from_loader(loader.name, loader)
            cls.mod = importlib.util.module_from_spec(spec)
            loader.exec_module(cls.mod)

    @classmethod
    def tearDownClass(cls):
        cls.runtime.cleanup()

    def fixture(self, name):
        with (Path(__file__).parent / "fixtures" / name).open() as handle:
            return json.load(handle)

    def test_reduce_download_event(self):
        event = {
            "type": "download",
            "download": {
                "bandwidth": 12_500_000,
                "bytes": 25_000_000,
                "elapsed": 2000,
                "progress": 0.4,
                "latency": {"iqm": 31.2},
            },
        }

        self.assertEqual(
            self.mod.reduce_event(event),
            {
                "phase": "download",
                "progress": 0.4,
                "download_mbps": 100.0,
                "loaded_ping_ms": 31.2,
            },
        )

    def test_reduce_result_event_bounds_trace_fields(self):
        reduced = self.mod.reduce_event(self.fixture("speedtest-jsonl-result.json"))

        self.assertEqual(reduced["phase"], "complete")
        self.assertEqual(reduced["result"]["download"]["bandwidth"], 37_091_386)
        self.assertEqual(
            set(reduced["result"]),
            {
                "ping",
                "download",
                "upload",
                "packetLoss",
                "isp",
                "interface",
                "server",
                "result",
            },
        )
        self.assertEqual(
            reduced["result"]["result"],
            {
                "id": "375b2533-36b8-4f45-8e0a-46dfef77c282",
                "url": "https://www.speedtest.net/result/c/375b2533-36b8-4f45-8e0a-46dfef77c282",
            },
        )

    def test_reduce_test_start_copies_context_only(self):
        event = {
            "type": "testStart",
            "isp": "Example ISP",
            "interface": {"name": "eth0"},
            "server": {"id": 42, "name": "Example Server"},
            "timestamp": "must not be copied",
        }

        self.assertEqual(
            self.mod.reduce_event(event),
            {
                "phase": "starting",
                "progress": 0.0,
                "isp": "Example ISP",
                "interface": {"name": "eth0"},
                "server": {"id": 42, "name": "Example Server"},
            },
        )

    def test_reduce_ping_event(self):
        event = {
            "type": "ping",
            "ping": {
                "latency": 12.75,
                "jitter": 0.84,
                "progress": 1.25,
                "low": 11.2,
            },
        }

        self.assertEqual(
            self.mod.reduce_event(event),
            {
                "phase": "ping",
                "progress": 1.0,
                "ping_ms": 12.75,
                "jitter_ms": 0.84,
            },
        )

    def test_parse_jsonl_record_rejects_oversize_before_decoding(self):
        with mock.patch.object(self.mod.json, "loads") as loads:
            with self.assertRaisesRegex(ValueError, "oversized_jsonl_record"):
                self.mod.parse_jsonl_record("x" * (1024 * 1024 + 1))

        loads.assert_not_called()

    def test_reduce_upload_event_clamps_progress(self):
        event = {
            "type": "upload",
            "upload": {
                "bandwidth": 2_500_000,
                "progress": -0.25,
                "latency": {"iqm": 44.6},
            },
        }

        self.assertEqual(
            self.mod.reduce_event(event),
            {
                "phase": "upload",
                "progress": 0.0,
                "upload_mbps": 20.0,
                "loaded_ping_ms": 44.6,
            },
        )

    def test_reduce_ignores_log_and_unknown_events(self):
        for event in ({"type": "log", "message": "noise"}, {"type": "future"}):
            with self.subTest(event=event):
                self.assertIsNone(self.mod.reduce_event(event))


class LiveJobTests(unittest.TestCase):
    def setUp(self):
        self.runtime = tempfile.TemporaryDirectory()
        self.root = Path(self.runtime.name)
        self.run_dir = self.root / "run"
        self.etc_dir = self.root / "etc"
        self.bin_dir = self.root / "bin"
        for directory in (self.run_dir, self.etc_dir, self.bin_dir):
            directory.mkdir(parents=True)
        (self.etc_dir / "terms-accepted").write_text("accepted\n")
        self.mode_file = self.root / "fake-mode"
        self.mode_file.write_text("normal\n")
        self.speedtest = self.bin_dir / "speedtest"
        self.speedtest.write_text(
            """#!/usr/bin/env python3
import json, os, sys, time
mode = open(os.environ['OOKLA_FAKE_MODE_FILE']).read().strip()
delay = 0.35 if mode == 'slow' else 0.05
events = [
 {'type':'testStart','isp':'ISP','interface':{'name':'eth0'},'server':{'id':42,'name':'Test'}},
 {'type':'ping','ping':{'latency':12.5,'jitter':0.8,'progress':1}},
 {'type':'download','download':{'bandwidth':12500000,'progress':0.5,'latency':{'iqm':22}}},
 {'type':'upload','upload':{'bandwidth':2500000,'progress':0.5,'latency':{'iqm':33}}},
 {'type':'result','ping':{'latency':12.5},'download':{'bandwidth':12500000},'upload':{'bandwidth':2500000},'packetLoss':0,'isp':'ISP','interface':{'name':'eth0'},'server':{'id':42,'name':'Test'},'result':{'id':'result-id','url':'https://example.test/result'}},
]
for event in events:
 print(json.dumps(event), flush=True)
 time.sleep(delay)
"""
        )
        self.speedtest.chmod(0o755)
        self.environment = dict(
            os.environ,
            OOKLA_WEBD_RUN_DIR=str(self.run_dir),
            OOKLA_WEBD_HISTORY=str(self.etc_dir / "history.jsonl"),
            OOKLA_SPEEDTEST_BIN=str(self.speedtest),
            OOKLA_FAKE_MODE_FILE=str(self.mode_file),
            OOKLA_LIVE_JOB_TTL="1",
        )
        self.jobs = []

    def tearDown(self):
        for job_id in self.jobs:
            self.rpc("cancel_live", job_id=job_id)
        self.runtime.cleanup()

    def rpc(self, method, **params):
        request = dict(params, method=method)
        process = subprocess.run(
            [str(SERVICE), json.dumps(request)],
            env=self.environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=True,
        )
        return json.loads(process.stdout)

    def start(self):
        response = self.rpc("start_live", server_id="42")
        if response.get("job_id"):
            self.jobs.append(response["job_id"])
        return response

    def wait_for(self, job_id, predicate, timeout=4):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = self.rpc("live_status", job_id=job_id)
            if predicate(last):
                return last
            time.sleep(0.02)
        self.fail("job did not reach expected state; last response: %r" % (last,))

    def test_start_streams_download_then_completes(self):
        started = self.start()

        self.assertTrue(started["ok"])
        self.assertRegex(started["job_id"], r"^[0-9a-f]{32}$")
        job_id = started["job_id"]
        download = self.wait_for(job_id, lambda row: row.get("phase") == "download")
        self.assertEqual(download["download_mbps"], 100.0)

        complete = self.wait_for(job_id, lambda row: row.get("state") == "complete")
        self.assertEqual(complete["result"]["server"]["id"], 42)

    def test_cancel_records_history_and_allows_a_new_job(self):
        self.mode_file.write_text("slow\n")
        first = self.start()
        job_id = first["job_id"]
        self.wait_for(job_id, lambda row: row.get("state") == "running")

        cancelled = self.rpc("cancel_live", job_id=job_id)

        self.assertTrue(cancelled["ok"])
        status = self.rpc("live_status", job_id=job_id)
        self.assertEqual(status["state"], "cancelled")
        history = self.rpc("history")
        self.assertEqual(history["items"][-1]["outcome"], "cancelled")
        self.mode_file.write_text("normal\n")
        second = self.start()
        self.assertTrue(second["ok"])
        self.wait_for(second["job_id"], lambda row: row.get("state") == "complete")

    def test_invalid_job_ids_are_rejected(self):
        for method in ("live_status", "cancel_live"):
            with self.subTest(method=method):
                response = self.rpc(method, job_id="../../proc/1")
                self.assertEqual(response["error"]["code"], "invalid_job_id")

    def test_second_concurrent_start_is_busy(self):
        self.mode_file.write_text("slow\n")
        first = self.start()
        self.wait_for(first["job_id"], lambda row: row.get("state") == "running")

        second = self.start()

        self.assertFalse(second["ok"])
        self.assertEqual(second["error"]["code"], "busy")

    def test_terminal_jobs_expire_after_configured_ttl(self):
        job_id = "a" * 32
        jobs_dir = self.run_dir / "jobs"
        jobs_dir.mkdir()
        job_file = jobs_dir / (job_id + ".json")
        job_file.write_text(
            json.dumps({"ok": True, "job_id": job_id, "state": "complete", "finished": 1})
        )
        old = time.time() - 2
        os.utime(job_file, (old, old))

        response = self.rpc("live_status", job_id=job_id)

        self.assertEqual(response["error"]["code"], "job_not_found")
        self.assertFalse(job_file.exists())

    def test_worker_launch_failure_becomes_terminal_error(self):
        self.environment["OOKLA_SPEEDTEST_BIN"] = str(self.bin_dir / "missing")
        started = self.start()

        failed = self.wait_for(
            started["job_id"], lambda row: row.get("state") == "error", timeout=1
        )

        self.assertEqual(failed["error"]["code"], "speedtest_failed")


if __name__ == "__main__":
    unittest.main()
