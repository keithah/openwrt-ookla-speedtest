import gzip
import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from scripts.build_web_ipks import tar_bytes

ROOT = Path(__file__).resolve().parents[1]


def members(ipk):
    with gzip.GzipFile(fileobj=io.BytesIO(ipk.read_bytes())) as stream:
        with tarfile.open(fileobj=stream, mode="r:") as outer:
            control = outer.extractfile("control.tar.gz").read()
            data = outer.extractfile("data.tar.gz").read()
    with tarfile.open(fileobj=io.BytesIO(control), mode="r:gz") as archive:
        control_text = archive.extractfile("control").read().decode()
        control_names = set(archive.getnames())
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        data_members = {item.name: (item.mode, item.isdir()) for item in archive.getmembers()}
        data_files = {
            item.name: archive.extractfile(item).read()
            for item in archive.getmembers()
            if item.isfile()
        }
        return control_text, control_names, data_members, data_files


class WebIpkBuilderTests(unittest.TestCase):
    def test_tar_output_normalizes_executable_modes(self):
        with tempfile.TemporaryDirectory() as left, tempfile.TemporaryDirectory() as right:
            a, b = Path(left) / "tool", Path(right) / "tool"
            a.write_text("#!/bin/sh\nexit 0\n"); b.write_bytes(a.read_bytes())
            a.chmod(0o700); b.chmod(0o755)
            self.assertEqual(tar_bytes([a], Path(left)), tar_bytes([b], Path(right)))

    def test_built_ipks_include_shared_frontend_and_version(self):
        with tempfile.TemporaryDirectory() as output:
            subprocess.run(["python3", str(ROOT / "scripts/build_web_ipks.py"), output], check=True)
            packages = {path.name: members(path) for path in Path(output).glob("*.ipk")}
        self.assertEqual(3, len(packages))
        for name, (control, _, _, _) in packages.items():
            self.assertIn("Version: 1.2.0-1", control, name)
        self.assertIn("postinst", packages["luci-app-ookla-speedtest-web_1.2.0-1_all.ipk"][1])
        luci = packages["luci-app-ookla-speedtest-web_1.2.0-1_all.ipk"][2]
        glinet = packages["gl-app-ookla-speedtest-web_1.2.0-1_all.ipk"][2]
        service = packages["ookla-speedtest-webd_1.2.0-1_all.ipk"][2]
        for filename in ("index.html", "app.js", "gauge.js", "styles.css"):
            self.assertIn("www/luci-static/resources/ookla-speedtest-web/" + filename, luci)
            self.assertIn("www/ookla-speedtest-web/" + filename, glinet)
        self.assertEqual((0o755, True), luci["www/luci-static/resources/ookla-speedtest-web"])
        self.assertEqual((0o755, True), glinet["www/ookla-speedtest-web"])
        self.assertEqual((0o755, False), service["usr/libexec/ookla-speedtest-webd-worker"])
        self.assertEqual((0o644, False), glinet["usr/lib/oui-httpd/rpc/ookla-speedtest-web"])

        for name, (_, _, _, files) in packages.items():
            self.assertNotIn("usr/bin/speedtest", files, name)
            for path, payload in files.items():
                self.assertFalse(payload.startswith((b"\x7fELF", b"MZ")), path)
                self.assertNotIn(b"speedtest-linux", payload.lower(), path)

    def test_complete_ipk_build_is_deterministic(self):
        with tempfile.TemporaryDirectory() as left, tempfile.TemporaryDirectory() as right:
            for output in (left, right):
                subprocess.run(
                    ["python3", str(ROOT / "scripts/build_web_ipks.py"), output],
                    check=True,
                )
            left_packages = {path.name: path.read_bytes() for path in Path(left).glob("*.ipk")}
            right_packages = {path.name: path.read_bytes() for path in Path(right).glob("*.ipk")}
        self.assertEqual(
            {
                "ookla-speedtest-webd_1.2.0-1_all.ipk",
                "luci-app-ookla-speedtest-web_1.2.0-1_all.ipk",
                "gl-app-ookla-speedtest-web_1.2.0-1_all.ipk",
            },
            set(left_packages),
        )
        self.assertEqual(left_packages, right_packages)


if __name__ == "__main__":
    unittest.main()
