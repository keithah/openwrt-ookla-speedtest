"""Contract tests for the planned LuCI/GL.iNet speedtest web package."""

import json
import re
import subprocess
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
            "luci-app-ookla-speedtest-web/CONTROL/postinst",
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

    def test_makefile_defines_all_binary_package_outputs_without_downloads(self):
        makefile = (PACKAGE / "Makefile").read_text()
        for package_name in (
            "ookla-speedtest-webd",
            "luci-app-ookla-speedtest-web",
            "gl-app-ookla-speedtest-web",
        ):
            self.assertIn("Package/" + package_name, makefile)
        self.assertRegex(makefile, r"PKG_VERSION\s*:=")
        self.assertRegex(makefile, r"PKG_RELEASE\s*:=")
        self.assertRegex(makefile, r"PKGARCH\s*:=\s*all")
        self.assertNotRegex(makefile, r"(?i)(wget|curl|https?://|Build/Compile.*download)")

    def test_package_metadata_and_modes(self):
        controls = {
            "ookla-speedtest-webd": ("ookla-speedtest-cli",),
            "luci-app-ookla-speedtest-web": ("ookla-speedtest-webd", "luci-base", "rpcd"),
            "gl-app-ookla-speedtest-web": ("luci-app-ookla-speedtest-web",),
        }
        for name, deps in controls.items():
            control = PACKAGE / name / "CONTROL/control"
            self.assertTrue(control.is_file(), control)
            text = control.read_text()
            self.assertIn("Package: " + name, text)
            self.assertIn("Version: 1.1.5", text)
            for dep in deps:
                self.assertRegex(text, rf"(?im)^Depends:.*\b{dep}\b")
        self.assertTrue((PACKAGE / "ookla-speedtest-webd/CONTROL/conffiles").is_file())
        for relative in (
            "ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd",
            "ookla-speedtest-webd/etc/init.d/ookla-speedtest-webd",
            "luci-app-ookla-speedtest-web/usr/libexec/rpcd/ookla-speedtest-web",
        ):
            self.assertTrue((PACKAGE / relative).stat().st_mode & 0o111, relative)

    def test_install_rules_exclude_control_metadata_and_luci_runtime_deps(self):
        makefile = (PACKAGE / "Makefile").read_text()
        self.assertNotRegex(makefile, r"\$\(CP\) \./(?:ookla-speedtest-webd|luci-app-ookla-speedtest-web|gl-app-ookla-speedtest-web)/\* \$\(1\)/")
        self.assertRegex(makefile, r"Package/luci-app-ookla-speedtest-web[\s\S]*DEPENDS:=.*\+luci-base")
        self.assertRegex(makefile, r"Package/luci-app-ookla-speedtest-web[\s\S]*DEPENDS:=.*\+rpcd")

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

    def test_service_uses_only_core_id_generation(self):
        service = (PACKAGE / "ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd").read_text()
        self.assertNotRegex(service, r"\bimport\s+uuid\b|\buuid\.")
        self.assertIn("os.urandom", service)

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

    def test_ci_and_release_workflow_contracts(self):
        workflows = ROOT / ".github" / "workflows"
        test_workflow = (workflows / "test.yml").read_text()
        release_workflow = (workflows / "release.yml").read_text()
        for marker in ("push:", "pull_request:", "actions/setup-python@v5", "actions/setup-node@v4",
                       "python3 -m unittest", "tests/test_service_contract.sh", "tests/test_frontend_contract.js",
                       "tests/test_frontend_render.js",
                       "tests/install-test.sh", "tests/goodcloud-contract-test.sh",
                       "stage", "package/Makefile"):
            self.assertIn(marker, test_workflow)
        for marker in ("workflow_dispatch:", "tags:", "PKG_VERSION", "PKG_RELEASE", "PKGARCH",
                       "deterministic", "forbidden", "gh release create", "contents: write",
                       "tag_name", "GITHUB_REF_NAME", "TAG_INPUT", "inputs.tag_name", "with:"):
            self.assertIn(marker, release_workflow)
        self.assertNotIn("secrets.", release_workflow)

    def test_service_lifecycle_files_have_safe_contract(self):
        service = PACKAGE / "ookla-speedtest-webd"
        init = service / "etc/init.d/ookla-speedtest-webd"
        self.assertTrue(init.stat().st_mode & 0o111)
        init_text = init.read_text()
        self.assertIn("/var/run/ookla-speedtest-webd", init_text)
        self.assertIn("speedtest", init_text)
        self.assertNotIn("procd_set_param command", init_text)
        self.assertNotIn("respawn", init_text)
        self.assertIn("Request-scoped", init_text)
        self.assertNotRegex(init_text, r"listen|http\.server|0\.0\.0\.0")
        defaults = (service / "etc/uci-defaults/99-ookla-speedtest-webd").read_text()
        self.assertRegex(defaults, r"retention")
        self.assertRegex(defaults, r"100")
        self.assertIn("uci", defaults)
        self.assertIn("/etc/config/ookla-speedtest-webd", (service / "CONTROL/conffiles").read_text())
        postinst = (service / "CONTROL/postinst").read_text()
        self.assertRegex(postinst, r"rpcd|ubus")
        self.assertNotRegex(postinst, r"pytest|test_")
        luci_postinst = (PACKAGE / "luci-app-ookla-speedtest-web/CONTROL/postinst").read_text()
        self.assertIn("rpcd", luci_postinst)
        gl_postinst = (PACKAGE / "gl-app-ookla-speedtest-web/CONTROL/postinst").read_text()
        self.assertIn("nginx", gl_postinst)

    def test_rpcd_acl_is_limited_to_fixed_methods(self):
        acl = PACKAGE / "luci-app-ookla-speedtest-web/usr/share/rpcd/acl.d/luci-app-ookla-speedtest-web.json"
        rpcd = PACKAGE / "luci-app-ookla-speedtest-web/usr/libexec/rpcd/ookla-speedtest-web"
        luci = PACKAGE / "luci-app-ookla-speedtest-web/www/luci-static/resources/view/ookla-speedtest-web/main.js"
        data = json.loads(acl.read_text())
        text = acl.read_text()
        self.assertNotIn('"*"', text)
        self.assertNotRegex(text, r"network|0\.0\.0\.0|listen")
        methods = {"status", "servers", "start", "start_live", "live_status", "cancel_live", "history", "delete_history", "clear_history", "settings", "local_download", "local_upload", "record_local"}
        blob = json.dumps(data)
        for method in methods:
            self.assertIn(method, blob)
        acl_data = data["luci-app-ookla-speedtest-web"]
        rpcd_object = rpcd.name
        luci_object = re.search(r"rpc\.declare\(\{object:['\"]([^'\"]+)", luci.read_text())
        self.assertIsNotNone(luci_object)
        self.assertEqual(luci_object.group(1), rpcd_object)
        self.assertEqual(list(acl_data["read"]["ubus"]), [rpcd_object])
        self.assertEqual(list(acl_data["write"]["ubus"]), [rpcd_object])
        self.assertEqual(acl_data["read"]["ubus"][rpcd_object], ["status", "servers", "history"])
        self.assertEqual(acl_data["write"]["ubus"][rpcd_object], ["start", "start_live", "live_status", "cancel_live", "delete_history", "clear_history", "settings", "accept_terms", "local_download", "local_upload", "record_local"])

    def test_rpcd_live_method_schemas_are_exact(self):
        rpcd = PACKAGE / "luci-app-ookla-speedtest-web/usr/libexec/rpcd/ookla-speedtest-web"
        result = subprocess.run(
            [str(rpcd), "list"],
            check=True,
            capture_output=True,
            text=True,
        )
        methods = json.loads(result.stdout)
        self.assertEqual(methods["start_live"], {"server_id": ""})
        self.assertEqual(methods["live_status"], {"job_id": ""})
        self.assertEqual(methods["cancel_live"], {"job_id": ""})


if __name__ == "__main__":
    unittest.main()
