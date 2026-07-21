"""Contract tests for the planned LuCI/GL.iNet speedtest web package."""

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "package"


class PackageLayoutContractTests(unittest.TestCase):
    def test_required_package_entries_and_assets_exist(self):
        required = [
            "Makefile",
            "ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd",
            "ookla-speedtest-webd/etc/init.d/ookla-speedtest-webd",
            "ookla-speedtest-webd/etc/config/ookla-speedtest-webd",
            "ookla-speedtest-webd/etc/uci-defaults/99-ookla-speedtest-webd",
            "ookla-speedtest-webd/CONTROL/control",
            "ookla-speedtest-webd/CONTROL/conffiles",
            "ookla-speedtest-webd/CONTROL/postinst",
            "luci-app-ookla-speedtest-web/CONTROL/control",
            "luci-app-ookla-speedtest-web/usr/share/luci/menu.d/luci-app-ookla-speedtest-web.json",
            "luci-app-ookla-speedtest-web/usr/share/rpcd/acl.d/luci-app-ookla-speedtest-web.json",
            "luci-app-ookla-speedtest-web/www/luci-static/resources/view/ookla-speedtest-web/main.js",
            "shared/ookla-speedtest-web/index.html",
            "shared/ookla-speedtest-web/app.js",
            "shared/ookla-speedtest-web/styles.css",
            "gl-app-ookla-speedtest-web/CONTROL/control",
            "gl-app-ookla-speedtest-web/CONTROL/postinst",
            "gl-app-ookla-speedtest-web/usr/share/oui/menu.d/ookla-speedtest-web.json",
            "gl-app-ookla-speedtest-web/usr/lib/oui-httpd/rpc/ookla-speedtest-web",
            "gl-app-ookla-speedtest-web/www/views/gl-sdk4-ui-ookla-speedtest-web.common.js",
        ]
        for relative in required:
            with self.subTest(relative=relative):
                self.assertTrue((PACKAGE / relative).is_file(), relative)

    def test_declares_cli_dependency(self):
        makefile_path = PACKAGE / "Makefile"
        self.assertTrue(makefile_path.is_file(), makefile_path)
        if not makefile_path.is_file():
            return
        makefile = makefile_path.read_text()
        self.assertRegex(makefile, r"(?m)^\s*DEPENDS.*ookla-speedtest-cli")

    def test_package_does_not_vendor_binary_archive_key_or_http_daemon(self):
        package_path = PACKAGE / "ookla-speedtest-webd"
        self.assertTrue(package_path.is_dir(), package_path)
        if not package_path.is_dir():
            return
        forbidden_markers = (".tgz", ".tar.gz", ".ipk", ".apk", ".pem", ".key", "private-key")
        files = [path for path in PACKAGE.rglob("*") if path.is_file()]
        self.assertFalse(
            any(any(marker in path.name.lower() for marker in forbidden_markers) for path in files)
        )
        for path in files:
            data = path.read_bytes()
            self.assertFalse(data.startswith((b"\x7fELF", b"MZ")), path)
            text = data.decode(errors="replace").lower()
            self.assertNotIn("speedtest-linux", text)
            self.assertNotIn("private key", text)
            self.assertNotRegex(text, r"(?:http\.server|listen\s*\(|serve_forever|socket\.listen)")

    def test_fixture_contains_successful_result_shape(self):
        fixture = ROOT / "tests" / "fixtures" / "speedtest-result.json"
        result = json.loads(fixture.read_text())
        self.assertEqual(result["type"], "result")
        self.assertEqual(result["server"]["name"], "Example Server")
        for key in ("isp", "interface", "ping", "download", "upload"):
            self.assertIn(key, result)

    def test_readme_documents_supported_web_entrypoints(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("http://router/cgi-bin/luci/admin/services/ookla-speedtest-web", readme)
        self.assertRegex(readme, r"(?i)GL\.iNet.*Applications")
        self.assertRegex(readme, r"(?i)GoodCloud.*Remote Web Access")


if __name__ == "__main__":
    unittest.main()
