import importlib.machinery
import importlib.util
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


SERVICE = (
    Path(__file__).resolve().parents[1]
    / "package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd"
)
WORKER = SERVICE.with_name("ookla-speedtest-webd-worker")


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
if mode == 'partial':
 os.write(1, b'{"type":"ping"')
 time.sleep(3)
 sys.exit(0)
if mode == 'malformed':
 print('{bad json', flush=True)
 sys.exit(0)
if mode == 'oversized':
 os.write(1, b'x' * (1024 * 1024 + 1))
 sys.exit(0)
if mode == 'nonzero':
 sys.exit(3)
delay = 0.35 if mode == 'slow' else 0.05
events = [
 {'type':'testStart','isp':'ISP','interface':{'name':'eth0'},'server':{'id':42,'name':'Test'}},
 {'type':'ping','ping':{'latency':12.5,'jitter':0.8,'progress':1}},
 {'type':'download','download':{'bandwidth':12500000,'progress':0.5,'latency':{'iqm':22}}},
 {'type':'upload','upload':{'bandwidth':2500000,'progress':0.5,'latency':{'iqm':33}}},
 {'type':'result','ping':{'latency':12.5},'download':{'bandwidth':12500000},'upload':{'bandwidth':2500000},'packetLoss':0,'isp':'ISP','interface':{'name':'eth0'},'server':{'id':42,'name':'Test'},'result':{'id':'result-id','url':'https://example.test/result'}},
]
if mode == 'trace':
 events = events[:2] + [dict(events[2], download=dict(events[2]['download'], progress=i/121)) for i in range(121)] + events[3:]
 delay = 0
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
            OOKLA_LIVE_TIMEOUT="1",
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

    def load_script(self, name, path):
        with mock.patch.dict(os.environ, self.environment), mock.patch(
            "sys.argv", [str(path)]
        ):
            loader = importlib.machinery.SourceFileLoader(name, str(path))
            spec = importlib.util.spec_from_loader(loader.name, loader)
            module = importlib.util.module_from_spec(spec)
            loader.exec_module(module)
            return module

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

    def poll_until_terminal(self, job_id, timeout=4):
        rows = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            row = self.rpc("live_status", job_id=job_id)
            rows.append(row)
            if row.get("state") in ("complete", "cancelled", "error"):
                return rows
            time.sleep(0.01)
        self.fail("job did not become terminal; last response: %r" % (rows[-1],))

    def test_start_streams_download_then_completes(self):
        started = self.start()

        self.assertTrue(started["ok"])
        self.assertRegex(started["job_id"], r"^[0-9a-f]{32}$")
        job_id = started["job_id"]
        complete = self.wait_for(job_id, lambda row: row.get("state") == "complete")
        self.assertEqual(complete["phase"], "complete")
        self.assertEqual(complete["ping_ms"], 12.5)
        self.assertEqual(complete["download_mbps"], 100.0)
        self.assertEqual(complete["upload_mbps"], 20.0)
        self.assertEqual(complete["result"]["server"]["id"], 42)
        self.assertIn("network_context", complete["result"])

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

    def test_partial_jsonl_line_still_times_out(self):
        self.mode_file.write_text("partial\n")
        started = self.start()

        failed = self.wait_for(
            started["job_id"], lambda row: row.get("state") == "error", timeout=2
        )

        self.assertEqual(failed["error"]["code"], "timeout")

    def test_worker_reports_stable_output_errors(self):
        for mode, code in (
            ("malformed", "malformed_output"),
            ("oversized", "output_too_large"),
            ("nonzero", "speedtest_failed"),
        ):
            with self.subTest(mode=mode):
                self.mode_file.write_text(mode + "\n")
                started = self.start()
                failed = self.wait_for(
                    started["job_id"],
                    lambda row: row.get("state") == "error",
                    timeout=2,
                )
                self.assertEqual(failed["error"]["code"], code)

    def test_transfer_trace_is_capped_at_120_points(self):
        self.mode_file.write_text("trace\n")
        self.environment["OOKLA_LIVE_TIMEOUT"] = "10"
        started = self.start()

        complete = self.wait_for(
            started["job_id"], lambda row: row.get("state") == "complete", timeout=8
        )

        self.assertEqual(len(complete["download_trace"]), 120)

    def test_simultaneous_starts_reserve_only_one_job(self):
        barrier = threading.Barrier(2)
        flock_released = threading.Event()
        flock_calls = 0
        observation_calls = 0
        call_lock = threading.Lock()
        environment = {
            "OOKLA_WEBD_RUN_DIR": str(self.run_dir),
            "OOKLA_WEBD_HISTORY": str(self.etc_dir / "history.jsonl"),
            "OOKLA_SPEEDTEST_BIN": str(self.speedtest),
            "OOKLA_FAKE_MODE_FILE": str(self.mode_file),
        }
        with mock.patch.dict(os.environ, environment), mock.patch(
            "sys.argv", [str(SERVICE)]
        ):
            loader = importlib.machinery.SourceFileLoader("race_service", str(SERVICE))
            spec = importlib.util.spec_from_loader(loader.name, loader)
            module = importlib.util.module_from_spec(spec)
            loader.exec_module(module)
            real_has_starting = module.has_starting
            real_flock = module.fcntl.flock

            def synchronized_observation():
                nonlocal observation_calls
                with call_lock:
                    observation_calls += 1
                    call_number = observation_calls
                if call_number <= 2:
                    barrier.wait(timeout=2)
                    return False
                return real_has_starting()

            def scheduled_flock(handle, operation):
                nonlocal flock_calls
                if operation == module.fcntl.LOCK_UN:
                    flock_released.set()
                    return real_flock(handle, operation)
                with call_lock:
                    flock_calls += 1
                    call_number = flock_calls
                if call_number == 2:
                    flock_released.wait(timeout=2)
                return real_flock(handle, operation)

            fake_child = mock.Mock(pid=12345)
            with mock.patch.object(
                module, "has_starting", side_effect=synchronized_observation
            ), mock.patch.object(
                module.fcntl, "flock", side_effect=scheduled_flock
            ), mock.patch.object(module.subprocess, "Popen", return_value=fake_child):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    responses = list(
                        executor.map(
                            module.main,
                            [
                                {"method": "start_live", "server_id": "42"},
                                {"method": "start_live", "server_id": "42"},
                            ],
                        )
                    )

        self.assertEqual(sum(row.get("ok") is True for row in responses), 1)
        self.assertEqual(
            [row.get("error", {}).get("code") for row in responses].count("busy"),
            1,
        )

    def test_post_spawn_state_failure_terminates_worker_and_releases_lock(self):
        self.mode_file.write_text("slow\n")
        module = self.load_script("spawn_failure_service", SERVICE)
        real_writejob = module.writejob
        real_popen = module.subprocess.Popen
        writes = 0
        children = []

        def fail_pid_write(job_id, state):
            nonlocal writes
            writes += 1
            if writes == 2:
                raise OSError("injected pid-state failure")
            return real_writejob(job_id, state)

        def capture_child(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child

        try:
            with mock.patch.dict(os.environ, self.environment), mock.patch.object(
                module, "writejob", side_effect=fail_pid_write
            ), mock.patch.object(
                module.subprocess, "Popen", side_effect=capture_child
            ):
                response = module.main({"method": "start_live", "server_id": "42"})

            self.assertEqual(response["error"]["code"], "storage_error")
            self.assertEqual(len(children), 1)
            deadline = time.monotonic() + 1
            while children[0].poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIsNotNone(children[0].poll(), "detached worker remained alive")
            self.assertLess(children[0].returncode, 0)
            held = module.lock()
            self.assertNotEqual(held, (None, None))
            module.unlock(held)
        finally:
            for child in children:
                if child.poll() is None:
                    os.killpg(child.pid, 15)
                    child.wait(timeout=2)

    def test_cleanup_removes_marker_owned_by_unrelated_live_pid(self):
        job_id = "b" * 32
        jobs_dir = self.run_dir / "jobs"
        jobs_dir.mkdir()
        job_file = jobs_dir / (job_id + ".json")
        marker = jobs_dir / (job_id + ".starting")
        job_file.write_text(
            json.dumps({"ok": True, "job_id": job_id, "state": "starting", "pid": os.getpid()})
        )
        marker.write_text(json.dumps({"job_id": job_id}))
        old = time.time() - 11
        os.utime(marker, (old, old))

        self.rpc("live_status", job_id=job_id)

        self.assertFalse(marker.exists())

    def test_worker_storage_error_is_terminal_and_releases_reservation(self):
        service = self.load_script("storage_error_service", SERVICE)
        worker_module = self.load_script("storage_error_worker", WORKER)
        job_id = "c" * 32
        service.writejob(
            job_id,
            {"ok": True, "job_id": job_id, "state": "starting", "started": int(time.time())},
        )
        Path(service.startingfile(job_id)).write_text(json.dumps({"job_id": job_id}))

        with mock.patch.object(worker_module, "load_service", return_value=service), mock.patch.object(
            service, "lock", return_value=("storage_error", None)
        ), mock.patch.object(
            worker_module.time, "sleep", side_effect=AssertionError("storage error retried")
        ):
            result = worker_module.run(job_id, "42")

        self.assertEqual(result, 0)
        state = service.readjob(job_id)
        self.assertEqual(state["state"], "error")
        self.assertEqual(state["error"]["code"], "storage_error")
        self.assertFalse(Path(service.startingfile(job_id)).exists())
        held = service.lock()
        self.assertNotEqual(held, (None, None))
        service.unlock(held)

    def test_cleanup_reconciles_dead_nonterminal_jobs(self):
        jobs_dir = self.run_dir / "jobs"
        jobs_dir.mkdir()
        for index, job_state in enumerate(("starting", "running")):
            with self.subTest(state=job_state):
                job_id = ("d" if index == 0 else "e") * 32
                job_file = jobs_dir / (job_id + ".json")
                marker = jobs_dir / (job_id + ".starting")
                job_file.write_text(
                    json.dumps(
                        {
                            "ok": True,
                            "job_id": job_id,
                            "state": job_state,
                            "phase": job_state,
                            "pid": 999_999_999,
                        }
                    )
                )
                marker.write_text(json.dumps({"job_id": job_id}))
                old = time.time() - 11
                os.utime(job_file, (old, old))
                os.utime(marker, (old, old))

                reconciled = self.rpc("live_status", job_id=job_id)

                self.assertEqual(reconciled["state"], "error")
                self.assertEqual(reconciled["error"]["code"], "worker_exited")
                self.assertFalse(marker.exists())

    def test_initial_worker_state_failure_becomes_terminal_and_releases_lock(self):
        service = self.load_script("initial_write_service", SERVICE)
        worker_module = self.load_script("initial_write_worker", WORKER)
        job_id = "f" * 32
        initial = {
            "ok": True,
            "job_id": job_id,
            "state": "starting",
            "phase": "starting",
            "started": int(time.time()),
            "pid": os.getpid(),
        }
        service.writejob(job_id, initial)
        Path(service.startingfile(job_id)).write_text(json.dumps({"job_id": job_id}))
        real_writejob = service.writejob
        writes = 0

        def fail_first_write(target_job_id, state):
            nonlocal writes
            writes += 1
            if writes == 1:
                raise OSError("injected initial worker-state failure")
            return real_writejob(target_job_id, state)

        with mock.patch.object(worker_module, "load_service", return_value=service), mock.patch.object(
            service, "writejob", side_effect=fail_first_write
        ):
            result = worker_module.run(job_id, "42")

        self.assertEqual(result, 0)
        state = service.readjob(job_id)
        self.assertEqual(state["state"], "error")
        self.assertEqual(state["error"]["code"], "storage_error")
        self.assertFalse(Path(service.startingfile(job_id)).exists())
        held = service.lock()
        self.assertNotEqual(held, (None, None))
        service.unlock(held)

    def test_cleanup_does_not_overwrite_concurrently_completed_job(self):
        service = self.load_script("cleanup_race_service", SERVICE)
        job_id = "1" * 32
        running = {
            "ok": True,
            "job_id": job_id,
            "state": "running",
            "phase": "upload",
            "pid": 999_999_999,
        }
        complete = {
            "ok": True,
            "job_id": job_id,
            "state": "complete",
            "phase": "complete",
            "finished": int(time.time()),
            "result": {"server": {"id": 42}},
        }
        service.writejob(job_id, running)
        old = time.time() - 11
        os.utime(service.jobfile(job_id), (old, old))
        real_lock = service.lock
        completed_before_lock = False

        def complete_then_lock(*args, **kwargs):
            nonlocal completed_before_lock
            if not completed_before_lock:
                completed_before_lock = True
                service.writejob(job_id, complete)
            return real_lock(*args, **kwargs)

        with mock.patch.object(service, "lock", side_effect=complete_then_lock):
            service.cleanup_live_jobs()

        self.assertTrue(completed_before_lock)
        self.assertEqual(service.readjob(job_id), complete)

    def test_cancellation_reservation_wins_cleanup_race(self):
        service = self.load_script("cancel_cleanup_race_service", SERVICE)
        job_id = "2" * 32
        service.writejob(
            job_id,
            {
                "ok": True,
                "job_id": job_id,
                "state": "running",
                "phase": "download",
                "pid": 12345,
            },
        )
        signalled = threading.Event()
        cancel_waiting = threading.Event()
        allow_cancel_lock = threading.Event()
        cancel_thread_id = []
        real_lock = service.lock

        def fake_killpg(pid, signal_number):
            self.assertEqual(pid, 12345)
            cancel_thread_id.append(threading.get_ident())
            old = time.time() - 11
            os.utime(service.jobfile(job_id), (old, old))
            signalled.set()

        def scheduled_lock(*args, **kwargs):
            if (
                signalled.is_set()
                and cancel_thread_id
                and threading.get_ident() == cancel_thread_id[0]
                and not allow_cancel_lock.is_set()
            ):
                cancel_waiting.set()
                allow_cancel_lock.wait(timeout=2)
            return real_lock(*args, **kwargs)

        def worker_is_alive(pid, target_job_id):
            return not signalled.is_set() and pid == 12345 and target_job_id == job_id

        with mock.patch.object(service.os, "killpg", side_effect=fake_killpg), mock.patch.object(
            service, "lock", side_effect=scheduled_lock
        ), mock.patch.object(
            service, "verified_worker_pid", side_effect=worker_is_alive
        ):
            with ThreadPoolExecutor(max_workers=1) as executor:
                cancelled_future = executor.submit(
                    service.main, {"method": "cancel_live", "job_id": job_id}
                )
                self.assertTrue(signalled.wait(timeout=2))
                self.assertTrue(cancel_waiting.wait(timeout=2))
                concurrent_status = service.main(
                    {"method": "live_status", "job_id": job_id}
                )
                allow_cancel_lock.set()
                cancelled = cancelled_future.result(timeout=2)

        self.assertTrue(cancelled["ok"])
        self.assertEqual(concurrent_status["state"], "running")
        self.assertEqual(service.readjob(job_id)["state"], "cancelled")
        self.assertEqual(service.readhist()[-1]["outcome"], "cancelled")
        self.assertFalse(Path(service.startingfile(job_id)).exists())


class LocalRunLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.runtime = tempfile.TemporaryDirectory()
        self.root = Path(self.runtime.name)
        self.run_dir = self.root / "run"
        self.etc_dir = self.root / "etc"
        self.run_dir.mkdir(parents=True)
        self.etc_dir.mkdir(parents=True)
        self.history = self.etc_dir / "history.jsonl"
        (self.etc_dir / "terms-accepted").write_text("accepted\n")
        self.environment = dict(
            os.environ,
            OOKLA_WEBD_RUN_DIR=str(self.run_dir),
            OOKLA_WEBD_HISTORY=str(self.history),
            OOKLA_HISTORY_RETENTION="2",
            OOKLA_LOCAL_RUN_LEASE="15",
            OOKLA_LOCAL_RUN_TTL="600",
        )

    def tearDown(self):
        self.runtime.cleanup()

    def rpc(self, method, **params):
        process = subprocess.run(
            [str(SERVICE), json.dumps(dict(params, method=method))],
            env=self.environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=True,
        )
        return json.loads(process.stdout)

    def load_service(self, name):
        with mock.patch.dict(os.environ, self.environment), mock.patch(
            "sys.argv", [str(SERVICE)]
        ):
            loader = importlib.machinery.SourceFileLoader(name, str(SERVICE))
            spec = importlib.util.spec_from_loader(loader.name, loader)
            module = importlib.util.module_from_spec(spec)
            loader.exec_module(module)
            return module

    def history_rows(self):
        if not self.history.exists():
            return []
        return [json.loads(line) for line in self.history.read_text().splitlines()]

    def prefill_full_history(self):
        rows = [
            {"id": "older-1", "kind": "device-router", "outcome": "success"},
            {"id": "older-2", "kind": "router-internet", "outcome": "success"},
        ]
        self.history.write_text("".join(json.dumps(row) + "\n" for row in rows))
        return rows

    def local_values(self, run_id):
        return {
            "run_id": run_id,
            "download_mbps": 125.5,
            "upload_mbps": 80.2,
            "ping_ms": 3.1,
        }

    def test_cancel_before_record_preserves_full_retention_history(self):
        original = self.prefill_full_history()
        begun = self.rpc("begin_local")
        self.assertRegex(begun["run_id"], r"^[0-9a-f]{32}$")

        cancelled = self.rpc("cancel_local", run_id=begun["run_id"])
        recorded = self.rpc("record_local", **self.local_values(begun["run_id"]))

        self.assertEqual(cancelled["state"], "cancelled")
        self.assertEqual(recorded["error"]["code"], "local_cancelled")
        self.assertEqual(self.history_rows(), original)

    def test_fresh_local_run_blocks_other_measurement_starts(self):
        run_id = self.rpc("begin_local")["run_id"]

        self.assertEqual(self.rpc("begin_local")["error"]["code"], "busy")
        self.assertEqual(self.rpc("start_live")["error"]["code"], "busy")
        self.assertEqual(self.rpc("start")["error"]["code"], "busy")
        self.assertEqual(
            self.rpc("local_download", run_id=run_id, bytes=1024)["bytes"], 1024
        )

    def test_two_simultaneous_local_begins_reserve_only_one_run(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(lambda _: self.rpc("begin_local"), range(2)))

        self.assertEqual(sum(response.get("ok") is True for response in responses), 1)
        self.assertEqual(
            sum(response.get("error", {}).get("code") == "busy" for response in responses),
            1,
        )

    def test_active_live_job_blocks_local_begin(self):
        jobs = self.run_dir / "jobs"
        jobs.mkdir(exist_ok=True)
        job_id = "c" * 32
        (jobs / f"{job_id}.json").write_text(
            json.dumps({"job_id": job_id, "state": "running", "pid": os.getpid()})
        )

        self.assertEqual(self.rpc("begin_local")["error"]["code"], "busy")

    def test_transfer_heartbeat_renews_active_lease(self):
        run_id = self.rpc("begin_local")["run_id"]
        marker = self.run_dir / "local-jobs" / f"{run_id}.json"
        row = json.loads(marker.read_text())
        row["updated"] = int(time.time()) - 14
        marker.write_text(json.dumps(row))

        downloaded = self.rpc("local_download", run_id=run_id, bytes=1024)
        renewed = json.loads(marker.read_text())

        self.assertTrue(downloaded["ok"])
        self.assertGreater(renewed["updated"], row["updated"])

    def test_rapid_transfer_heartbeats_do_not_rewrite_fresh_marker(self):
        run_id = self.rpc("begin_local")["run_id"]
        marker = self.run_dir / "local-jobs" / f"{run_id}.json"
        original = marker.read_bytes()
        original_mtime = marker.stat().st_mtime_ns

        self.rpc("local_download", run_id=run_id, bytes=1024)
        self.rpc("local_upload", run_id=run_id, data="1234")

        self.assertEqual(marker.read_bytes(), original)
        self.assertEqual(marker.stat().st_mtime_ns, original_mtime)

        row = json.loads(marker.read_text())
        row["updated"] = int(time.time()) - 6
        marker.write_text(json.dumps(row))
        stale_mtime = marker.stat().st_mtime_ns
        self.rpc("local_download", run_id=run_id, bytes=1024)
        renewed = json.loads(marker.read_text())

        self.assertGreater(renewed["updated"], row["updated"])
        self.assertGreater(marker.stat().st_mtime_ns, stale_mtime)

    def test_abandoned_local_lease_expires_and_releases_measurements(self):
        run_id = self.rpc("begin_local")["run_id"]
        marker = self.run_dir / "local-jobs" / f"{run_id}.json"
        row = json.loads(marker.read_text())
        row["updated"] = int(time.time()) - 16
        marker.write_text(json.dumps(row))

        replacement = self.rpc("begin_local")

        self.assertTrue(replacement["ok"])
        self.assertNotEqual(replacement["run_id"], run_id)
        self.assertFalse(marker.exists())

    def test_local_transfers_reject_cross_client_and_expired_runs(self):
        run_id = self.rpc("begin_local")["run_id"]
        invalid = self.rpc("local_upload", run_id="../bad", data="1234")
        other = self.rpc("local_download", run_id="d" * 32, bytes=1024)

        self.assertEqual(invalid["error"]["code"], "invalid_local_run_id")
        self.assertEqual(other["error"]["code"], "local_run_not_found")
        self.assertTrue(self.rpc("cancel_local", run_id=run_id)["ok"])

    def test_record_before_cancel_commits_once_and_cancel_is_too_late(self):
        self.prefill_full_history()
        run_id = self.rpc("begin_local")["run_id"]

        first = self.rpc("record_local", **self.local_values(run_id))
        replay = self.rpc("record_local", **self.local_values(run_id))
        cancelled = self.rpc("cancel_local", run_id=run_id)

        self.assertEqual(first["state"], "committed")
        self.assertEqual(replay["state"], "committed")
        self.assertEqual(first["item"]["id"], run_id)
        self.assertEqual(cancelled["error"]["code"], "too_late")
        self.assertEqual(cancelled["state"], "committed")
        rows = self.history_rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual([row["id"] for row in rows].count(run_id), 1)

    def test_history_commit_repairs_active_marker_after_power_loss(self):
        service = self.load_service("ookla_local_power_loss")
        run_id = service.main({"method": "begin_local"})["run_id"]
        original_write = service.writelocaljob

        def fail_committed(target_id, row):
            if target_id == run_id and row.get("state") == "committed":
                raise OSError("simulated power loss")
            return original_write(target_id, row)

        with mock.patch.object(service, "writelocaljob", side_effect=fail_committed):
            failed = service.main(
                dict(self.local_values(run_id), method="record_local")
            )

        self.assertEqual(failed["error"]["code"], "storage_error")
        self.assertEqual(service.readlocaljob(run_id)["state"], "active")
        self.assertEqual(service.readhist()[0]["run_id"], run_id)

        cancelled = service.main({"method": "cancel_local", "run_id": run_id})
        replayed = service.main(dict(self.local_values(run_id), method="record_local"))

        self.assertEqual(cancelled["error"]["code"], "too_late")
        self.assertEqual(cancelled["state"], "committed")
        self.assertEqual(replayed["state"], "committed")
        self.assertEqual(service.readlocaljob(run_id)["state"], "committed")
        self.assertEqual([row["run_id"] for row in service.readhist()], [run_id])

    def test_concurrent_cancel_and_record_have_one_atomic_winner(self):
        original = self.prefill_full_history()
        run_id = self.rpc("begin_local")["run_id"]
        with ThreadPoolExecutor(max_workers=2) as executor:
            cancel_future = executor.submit(self.rpc, "cancel_local", run_id=run_id)
            record_future = executor.submit(
                self.rpc, "record_local", **self.local_values(run_id)
            )
            cancelled = cancel_future.result(timeout=5)
            recorded = record_future.result(timeout=5)

        rows = self.history_rows()
        if cancelled.get("state") == "cancelled":
            self.assertEqual(recorded["error"]["code"], "local_cancelled")
            self.assertEqual(rows, original)
        else:
            self.assertEqual(cancelled["error"]["code"], "too_late")
            self.assertEqual(recorded["state"], "committed")
            self.assertEqual([row["id"] for row in rows], ["older-2", run_id])
        self.assertLessEqual([row["id"] for row in rows].count(run_id), 1)

    def test_expired_local_markers_are_cleaned_on_begin(self):
        run_id = self.rpc("begin_local")["run_id"]
        marker = self.run_dir / "local-jobs" / f"{run_id}.json"
        row = json.loads(marker.read_text())
        row["updated"] = 0
        marker.write_text(json.dumps(row))
        corrupt = self.run_dir / "local-jobs" / ("b" * 32 + ".json")
        corrupt.write_text("not json")
        os.utime(corrupt, (0, 0))
        self.environment["OOKLA_LOCAL_RUN_TTL"] = "1"

        self.rpc("begin_local")

        self.assertFalse(marker.exists())
        self.assertFalse(corrupt.exists())

    def test_local_run_ids_are_path_safe(self):
        for method in ("cancel_local", "record_local"):
            with self.subTest(method=method):
                response = self.rpc(method, **self.local_values("../bad"))
                self.assertEqual(response["error"]["code"], "invalid_local_run_id")
        self.assertFalse((self.root / "bad.json").exists())


if __name__ == "__main__":
    unittest.main()
