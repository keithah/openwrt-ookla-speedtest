import hashlib
import io
import tarfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
