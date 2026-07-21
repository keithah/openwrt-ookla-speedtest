import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
RECIPE = REPOSITORY_ROOT / "Makefile"
UPDATE_WORKFLOW = REPOSITORY_ROOT / ".github" / "workflows" / "update-ookla.yml"

CASES = {
    ("aarch64", False): "aarch64",
    ("arm", False): "armhf",
    ("arm", True): "armel",
}

SIMULATED_UPDATE_HASHES = {
    "aarch64": "a" * 64,
    "armhf": "b" * 64,
    "armel": "c" * 64,
}


class RecipeTest(unittest.TestCase):
    def evaluate_recipe(self, arch, soft_float=False, recipe=RECIPE):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            include_directory = root / "include"
            include_directory.mkdir()
            (root / "rules.mk").write_text("", encoding="utf-8")
            (include_directory / "package.mk").write_text(
                "define BuildPackage\nendef\n", encoding="utf-8"
            )
            probe = root / "probe.mk"
            probe.write_text(
                textwrap.dedent(
                    f"""\
                    TOPDIR := {root}
                    INCLUDE_DIR := {include_directory}
                    ARCH := {arch}
                    CONFIG_SOFT_FLOAT := {'y' if soft_float else ''}
                    include {recipe}

                    .PHONY: probe
                    probe:
                    \t@printf '%s\\n' \\
                    \t  'OOKLA_ARCH=$(OOKLA_ARCH)' \\
                    \t  'PKG_HASH=$(PKG_HASH)' \\
                    \t  'PKG_VERSION=$(PKG_VERSION)' \\
                    \t  'PKG_RELEASE=$(PKG_RELEASE)' \\
                    \t  'PKG_SOURCE=$(PKG_SOURCE)'
                    """
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                ["make", "--no-print-directory", "-f", str(probe), "probe"],
                check=True,
                capture_output=True,
                text=True,
            )
        return dict(line.split("=", 1) for line in result.stdout.splitlines())

    def assert_supported_recipe_invariants(self, recipe=RECIPE):
        evaluated_recipes = []
        versions = []
        hashes = []

        for (arch, soft_float), expected_suffix in CASES.items():
            with self.subTest(arch=arch, soft_float=soft_float):
                values = self.evaluate_recipe(arch, soft_float, recipe)
                self.assertEqual(expected_suffix, values["OOKLA_ARCH"])
                self.assertRegex(values["PKG_VERSION"], r"^[0-9]+\.[0-9]+\.[0-9]+$")
                self.assertRegex(values["PKG_HASH"], r"^[0-9a-f]{64}$")
                self.assertIn(f"-linux-{expected_suffix}.tgz", values["PKG_SOURCE"])
                evaluated_recipes.append(values)
                versions.append(values["PKG_VERSION"])
                hashes.append(values["PKG_HASH"])

        self.assertEqual(1, len(set(versions)))
        self.assertTrue(all(hashes))
        self.assertEqual(len(CASES), len(set(hashes)))
        return evaluated_recipes

    def test_supported_architectures_select_vendor_suffix_and_hash(self):
        self.assert_supported_recipe_invariants()

    def test_supported_invariants_accept_simulated_update(self):
        recipe_text = RECIPE.read_text(encoding="utf-8")
        recipe_text, replacements = re.subn(
            r"^PKG_VERSION:=.*$",
            "PKG_VERSION:=1.3.0",
            recipe_text,
            flags=re.MULTILINE,
        )
        self.assertEqual(1, replacements)

        for suffix, simulated_hash in SIMULATED_UPDATE_HASHES.items():
            recipe_text, replacements = re.subn(
                rf"^OOKLA_HASH_{suffix}:=.*$",
                f"OOKLA_HASH_{suffix}:={simulated_hash}",
                recipe_text,
                flags=re.MULTILINE,
            )
            self.assertEqual(1, replacements)

        with tempfile.TemporaryDirectory() as temporary_directory:
            updated_recipe = Path(temporary_directory) / "Makefile"
            updated_recipe.write_text(recipe_text, encoding="utf-8")
            values = self.assert_supported_recipe_invariants(updated_recipe)

        self.assertEqual({"1.3.0"}, {value["PKG_VERSION"] for value in values})

    def test_unsupported_architecture_has_no_supported_suffix(self):
        values = self.evaluate_recipe("x86_64")
        self.assertEqual("", values["OOKLA_ARCH"])
        for suffix in ("aarch64", "armhf", "armel"):
            self.assertNotIn(f"-linux-{suffix}.tgz", values["PKG_SOURCE"])

    def test_package_dependency_and_install_contract(self):
        recipe = RECIPE.read_text(encoding="utf-8")
        self.assertIn("DEPENDS:=@(aarch64||arm)", recipe)
        self.assertIn(
            "$(INSTALL_BIN) $(PKG_BUILD_DIR)/speedtest $(1)/usr/bin/speedtest",
            recipe,
        )

    def test_update_workflow_policy(self):
        self.assertTrue(UPDATE_WORKFLOW.is_file(), "update workflow is missing")
        workflow = UPDATE_WORKFLOW.read_text(encoding="utf-8")

        for required in (
            "schedule:",
            "workflow_dispatch:",
            "contents: write",
            "group:",
            "python3 scripts/update_ookla.py",
            "python3 -m unittest discover -s tests -v",
            "github-actions[bot]",
            "git push origin HEAD:main",
        ):
            with self.subTest(required=required):
                self.assertIn(required, workflow)

        for forbidden in (
            "actions/upload-artifact",
            "actions/create-release",
            "softprops/action-gh-release",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, workflow)


if __name__ == "__main__":
    unittest.main()
