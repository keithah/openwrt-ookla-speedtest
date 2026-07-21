from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
import urllib.error
from unittest import mock

from scripts import update_ookla as updater

from scripts.update_ookla import (
    UpdateError,
    archive_sha256,
    discover_versions,
    latest_complete_release,
    render_makefile,
    validate_archive,
)


FIXTURES = Path(__file__).with_name("fixtures")
EXPECTED_ELF = {
    "aarch64": (2, 183, None),
    "armhf": (1, 40, 0x400),
    "armel": (1, 40, 0x200),
}


def elf_header(elf_class, machine, flags=None):
    size = 64 if elf_class == 2 else 52
    header = bytearray(size)
    header[:7] = b"\x7fELF" + bytes((elf_class, 1, 1))
    header[18:20] = machine.to_bytes(2, "little")
    if flags is not None:
        header[36:40] = flags.to_bytes(4, "little")
    return bytes(header)


def archive_with_speedtest(payload, *, directory=False, member_name="speedtest"):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        member = tarfile.TarInfo(member_name)
        if directory:
            member.type = tarfile.DIRTYPE
            member.size = 0
            archive.addfile(member)
        else:
            member.mode = 0o755
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))
    return output.getvalue()


def release_page(version):
    return "\n".join(
        "https://install.speedtest.net/app/cli/"
        f"ookla-speedtest-{version}-linux-{arch}.tgz"
        for arch in EXPECTED_ELF
    ).encode("utf-8")


class ReleaseDiscoveryTest(unittest.TestCase):
    def test_selects_latest_complete_release(self):
        html = (FIXTURES / "releases.html").read_text(encoding="utf-8")

        self.assertEqual(
            {
                "1.2.0": {"aarch64", "armhf", "armel"},
                "1.3.0": {"aarch64", "armhf"},
            },
            discover_versions(html),
        )
        self.assertEqual("1.2.0", latest_complete_release(html))

    def test_compares_semantic_versions_as_integer_triples(self):
        links = []
        for version in ("1.9.9", "1.10.0"):
            for arch in EXPECTED_ELF:
                links.append(
                    "https://install.speedtest.net/app/cli/"
                    f"ookla-speedtest-{version}-linux-{arch}.tgz"
                )

        self.assertEqual("1.10.0", latest_complete_release("\n".join(links)))

    def test_raises_when_no_complete_release_remains(self):
        html = """
        https://install.speedtest.net/app/cli/ookla-speedtest-1.3.0-linux-armhf.tgz
        https://install.speedtest.net/app/cli/ookla-speedtest-bad-linux-armel.tgz
        https://example.com/ookla-speedtest-2.0.0-linux-aarch64.tgz
        """

        with self.assertRaises(UpdateError):
            latest_complete_release(html)


class MakefileRenderingTest(unittest.TestCase):
    SOURCE = """include $(TOPDIR)/rules.mk

PKG_NAME:=ookla-speedtest-cli
PKG_VERSION:=1.2.0
PKG_RELEASE:=7

OOKLA_HASH_aarch64:=old-aarch64
OOKLA_HASH_armhf:=old-armhf
OOKLA_HASH_armel:=old-armel

UNCHANGED:=yes
"""
    HASHES = {
        "aarch64": "new-aarch64",
        "armhf": "new-armhf",
        "armel": "new-armel",
    }

    def test_updates_only_the_version_release_and_hash_values(self):
        rendered = render_makefile(self.SOURCE, "1.10.0", self.HASHES)
        expected = self.SOURCE
        expected = expected.replace("PKG_VERSION:=1.2.0", "PKG_VERSION:=1.10.0")
        expected = expected.replace("PKG_RELEASE:=7", "PKG_RELEASE:=1")
        for arch, digest in self.HASHES.items():
            expected = expected.replace(
                f"OOKLA_HASH_{arch}:=old-{arch}",
                f"OOKLA_HASH_{arch}:={digest}",
            )

        self.assertEqual(expected, rendered)

    def test_rejects_each_missing_assignment(self):
        assignments = (
            "PKG_VERSION",
            "PKG_RELEASE",
            "OOKLA_HASH_aarch64",
            "OOKLA_HASH_armhf",
            "OOKLA_HASH_armel",
        )
        for assignment in assignments:
            with self.subTest(assignment=assignment):
                text = "\n".join(
                    line
                    for line in self.SOURCE.splitlines()
                    if not line.startswith(f"{assignment}:=")
                )
                with self.assertRaises(UpdateError):
                    render_makefile(text, "1.10.0", self.HASHES)

    def test_rejects_each_duplicate_assignment(self):
        assignments = (
            "PKG_VERSION:=1.2.0",
            "PKG_RELEASE:=7",
            "OOKLA_HASH_aarch64:=old-aarch64",
            "OOKLA_HASH_armhf:=old-armhf",
            "OOKLA_HASH_armel:=old-armel",
        )
        for assignment in assignments:
            with self.subTest(assignment=assignment):
                with self.assertRaises(UpdateError):
                    render_makefile(
                        self.SOURCE + assignment + "\n", "1.10.0", self.HASHES
                    )

    def test_assignment_whitespace_cannot_cross_a_line_boundary(self):
        malformed = self.SOURCE.replace(
            "PKG_VERSION:=1.2.0", "PKG_VERSION:=\n1.2.0"
        )

        rendered = render_makefile(malformed, "1.10.0", self.HASHES)

        self.assertIn(
            "PKG_VERSION:=1.10.0\n1.2.0\nPKG_RELEASE:=1",
            rendered,
        )


class ArchiveValidationTest(unittest.TestCase):
    def test_accepts_expected_elf_for_each_architecture(self):
        for arch, (elf_class, machine, flags) in EXPECTED_ELF.items():
            with self.subTest(arch=arch):
                validate_archive(
                    arch,
                    archive_with_speedtest(elf_header(elf_class, machine, flags)),
                )

    def test_rejects_missing_speedtest_member(self):
        data = archive_with_speedtest(b"not relevant", member_name="README.md")

        with self.assertRaises(UpdateError):
            validate_archive("aarch64", data)

    def test_rejects_directory_in_place_of_speedtest(self):
        data = archive_with_speedtest(b"", directory=True)

        with self.assertRaises(UpdateError):
            validate_archive("aarch64", data)

    def test_rejects_wrong_elf_class(self):
        data = archive_with_speedtest(elf_header(1, 183))

        with self.assertRaises(UpdateError):
            validate_archive("aarch64", data)

    def test_rejects_wrong_machine(self):
        data = archive_with_speedtest(elf_header(2, 40))

        with self.assertRaises(UpdateError):
            validate_archive("aarch64", data)

    def test_rejects_opposite_arm_float_abi(self):
        for arch, opposite_flag in (("armhf", 0x200), ("armel", 0x400)):
            with self.subTest(arch=arch):
                data = archive_with_speedtest(elf_header(1, 40, opposite_flag))
                with self.assertRaises(UpdateError):
                    validate_archive(arch, data)

    def test_rejects_truncated_elf_header(self):
        for arch in EXPECTED_ELF:
            with self.subTest(arch=arch):
                data = archive_with_speedtest(b"\x7fELF\x02\x01")
                with self.assertRaises(UpdateError):
                    validate_archive(arch, data)

    def test_hashes_the_original_archive_bytes(self):
        data = archive_with_speedtest(elf_header(*EXPECTED_ELF["aarch64"]))

        self.assertEqual(hashlib.sha256(data).hexdigest(), archive_sha256(data))


class UpdateTransactionTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.makefile = Path(self.temporary_directory.name) / "Makefile"
        self.makefile.write_text(MakefileRenderingTest.SOURCE, encoding="utf-8")

    def test_newer_check_reports_without_archive_downloads_or_writes(self):
        original = self.makefile.read_bytes()
        downloader = mock.Mock(return_value=release_page("1.10.0"))
        output = io.StringIO()

        with mock.patch.object(updater, "_download", downloader):
            with redirect_stdout(output):
                updater.update("https://page.test/cli", self.makefile, check=True)

        self.assertEqual(
            "new Ookla Speedtest CLI version available: 1.2.0 -> 1.10.0\n",
            output.getvalue(),
        )
        downloader.assert_called_once_with("https://page.test/cli")
        self.assertEqual(original, self.makefile.read_bytes())

    def test_equal_or_older_release_is_a_successful_no_op(self):
        original = self.makefile.read_bytes()
        for latest in ("1.2.0", "1.1.9"):
            with self.subTest(latest=latest):
                downloader = mock.Mock(return_value=release_page(latest))
                output = io.StringIO()
                with mock.patch.object(updater, "_download", downloader):
                    with redirect_stdout(output):
                        updater.update("https://page.test/cli", self.makefile)

                self.assertEqual(
                    "ookla-speedtest-cli is already at 1.2.0\n",
                    output.getvalue(),
                )
                downloader.assert_called_once_with("https://page.test/cli")
                self.assertEqual(original, self.makefile.read_bytes())

    def test_download_failure_propagates_without_writing(self):
        original = self.makefile.read_bytes()
        failure = UpdateError("upstream unavailable")

        with mock.patch.object(updater, "_download", side_effect=failure):
            with self.assertRaisesRegex(UpdateError, "upstream unavailable"):
                updater.update("https://page.test/cli", self.makefile)

        self.assertEqual(original, self.makefile.read_bytes())

    def test_invalid_third_archive_leaves_recipe_unchanged(self):
        original = self.makefile.read_bytes()
        archives = {
            arch: archive_with_speedtest(elf_header(*expected))
            for arch, expected in EXPECTED_ELF.items()
        }
        archives["armel"] = b"not a tarball"
        requested = []

        def download(url):
            requested.append(url)
            if url == "https://page.test/cli":
                return release_page("1.10.0")
            return next(
                data
                for arch, data in archives.items()
                if f"-{arch}.tgz" in url
            )

        with mock.patch.object(updater, "_download", side_effect=download):
            with self.assertRaises(UpdateError):
                updater.update("https://page.test/cli", self.makefile)

        self.assertEqual(4, len(requested))
        self.assertTrue(requested[-1].endswith("-armel.tgz"))
        self.assertEqual(original, self.makefile.read_bytes())

    def test_update_validates_archives_and_atomically_replaces_recipe(self):
        archives = {
            arch: archive_with_speedtest(elf_header(*expected))
            for arch, expected in EXPECTED_ELF.items()
        }

        def download(url):
            if url == "https://page.test/cli":
                return release_page("1.10.0")
            return next(
                data
                for arch, data in archives.items()
                if f"-{arch}.tgz" in url
            )

        output = io.StringIO()
        with mock.patch.object(updater, "_download", side_effect=download):
            with mock.patch.object(
                updater.os, "replace", wraps=updater.os.replace
            ) as replace:
                with redirect_stdout(output):
                    updater.update("https://page.test/cli", self.makefile)

        self.assertEqual(
            "updated ookla-speedtest-cli: 1.2.0 -> 1.10.0\n", output.getvalue()
        )
        rendered = self.makefile.read_text(encoding="utf-8")
        self.assertIn("PKG_VERSION:=1.10.0", rendered)
        self.assertIn("PKG_RELEASE:=1", rendered)
        for arch, data in archives.items():
            self.assertIn(f"OOKLA_HASH_{arch}:={archive_sha256(data)}", rendered)
        replace.assert_called_once()
        source, destination = map(Path, replace.call_args.args)
        self.assertEqual(self.makefile.parent, source.parent)
        self.assertEqual(self.makefile, destination)


class CliContractTest(unittest.TestCase):
    def test_http_failure_becomes_update_error_and_identifies_updater(self):
        with mock.patch.object(
            updater.urllib.request,
            "urlopen",
            side_effect=urllib.error.URLError("offline"),
        ) as urlopen:
            with self.assertRaisesRegex(UpdateError, "failed to fetch"):
                updater._download("https://page.test/cli")

        urlopen.assert_called_once()
        request = urlopen.call_args.args[0]
        self.assertIsInstance(request, urllib.request.Request)
        self.assertEqual(
            "openwrt-ookla-speedtest-cli-updater/1.0",
            request.get_header("User-agent"),
        )
        self.assertEqual(30, urlopen.call_args.kwargs["timeout"])

    def test_main_returns_nonzero_and_reports_update_error(self):
        error = io.StringIO()
        with mock.patch.object(
            updater, "update", side_effect=UpdateError("invalid upstream state")
        ):
            with redirect_stderr(error):
                result = updater.main(["--check"])

        self.assertEqual(1, result)
        self.assertEqual("error: invalid upstream state\n", error.getvalue())


if __name__ == "__main__":
    unittest.main()
