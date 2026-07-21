import gzip
import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

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
        return control_text, control_names, {item.name: (item.mode, item.isdir()) for item in archive.getmembers()}


class WebIpkBuilderTests(unittest.TestCase):
    def test_built_ipks_include_shared_frontend_and_version(self):
        with tempfile.TemporaryDirectory() as output:
            subprocess.run(["python3", str(ROOT / "scripts/build_web_ipks.py"), output], check=True)
            packages = {path.name: members(path) for path in Path(output).glob("*.ipk")}
        self.assertEqual(3, len(packages))
        for name, (control, _, _) in packages.items():
            self.assertIn("Version: 1.1.2-1", control, name)
        self.assertIn("postinst", packages["luci-app-ookla-speedtest-web_1.1.2-1_all.ipk"][1])
        luci = packages["luci-app-ookla-speedtest-web_1.1.2-1_all.ipk"][2]
        glinet = packages["gl-app-ookla-speedtest-web_1.1.2-1_all.ipk"][2]
        for filename in ("index.html", "app.js", "styles.css"):
            self.assertIn("www/luci-static/resources/ookla-speedtest-web/" + filename, luci)
            self.assertIn("www/ookla-speedtest-web/" + filename, glinet)
        self.assertEqual((0o755, True), luci["www/luci-static/resources/ookla-speedtest-web"])
        self.assertEqual((0o755, True), glinet["www/ookla-speedtest-web"])


if __name__ == "__main__":
    unittest.main()
