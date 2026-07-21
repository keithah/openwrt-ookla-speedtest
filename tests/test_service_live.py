import importlib.machinery
import importlib.util
import json
import os
import tempfile
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


if __name__ == "__main__":
    unittest.main()
