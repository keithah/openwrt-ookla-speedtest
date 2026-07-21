import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
RECIPE = REPOSITORY_ROOT / "Makefile"

CASES = {
    ("aarch64", False): (
        "aarch64",
        "3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3",
    ),
    ("arm", False): (
        "armhf",
        "e45fcdebbd8a185553535533dd032d6b10bc8c64eee4139b1147b9c09835d08d",
    ),
    ("arm", True): (
        "armel",
        "629a455a2879224bd0dbd4b36d8c721dda540717937e4660b4d2c966029466bf",
    ),
}


class RecipeTest(unittest.TestCase):
    def evaluate_recipe(self, arch, soft_float=False):
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
                    include {RECIPE}

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

    def test_supported_architectures_select_vendor_suffix_and_hash(self):
        for (arch, soft_float), (expected_suffix, expected_hash) in CASES.items():
            with self.subTest(arch=arch, soft_float=soft_float):
                values = self.evaluate_recipe(arch, soft_float)
                self.assertEqual(expected_suffix, values["OOKLA_ARCH"])
                self.assertEqual(expected_hash, values["PKG_HASH"])
                self.assertEqual("1.2.0", values["PKG_VERSION"])
                self.assertEqual("1", values["PKG_RELEASE"])
                self.assertIn(f"-linux-{expected_suffix}.tgz", values["PKG_SOURCE"])

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


if __name__ == "__main__":
    unittest.main()
