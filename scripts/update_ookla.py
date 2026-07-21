#!/usr/bin/env python3
"""Safely update the packaged Ookla Speedtest CLI release."""

import argparse
import hashlib
import os
from pathlib import Path
import re
import sys
import tarfile
import tempfile
from io import BytesIO
import urllib.error
import urllib.request


RELEASE_RE = re.compile(
    r"https://install\.speedtest\.net/app/cli/"
    r"ookla-speedtest-(\d+\.\d+\.\d+)-linux-"
    r"(aarch64|armhf|armel)\.tgz"
)
REQUIRED_ARCHES = frozenset(("aarch64", "armhf", "armel"))
EXPECTED_ELF = {
    "aarch64": (2, 183, None),
    "armhf": (1, 40, 0x400),
    "armel": (1, 40, 0x200),
}
PAGE_URL = "https://www.speedtest.net/apps/cli"
REPOSITORY_MAKEFILE = Path(__file__).resolve().parents[1] / "Makefile"


class UpdateError(Exception):
    """Raised when upstream data or the local recipe is unsafe to update."""


def discover_versions(html):
    """Return official semantic releases and their available architectures."""
    versions = {}
    for match in RELEASE_RE.finditer(html):
        version, arch = match.groups()
        versions.setdefault(version, set()).add(arch)
    return versions


def latest_complete_release(html):
    """Return the highest release containing every required architecture."""
    complete = [
        version
        for version, arches in discover_versions(html).items()
        if REQUIRED_ARCHES.issubset(arches)
    ]
    if not complete:
        raise UpdateError("upstream page contains no complete semantic release")
    return max(
        complete,
        key=lambda value: tuple(int(part) for part in value.split(".")),
    )


def archive_sha256(data):
    return hashlib.sha256(data).hexdigest()


def validate_archive(arch, data):
    """Validate that an archive contains an ELF executable for *arch*."""
    if arch not in EXPECTED_ELF:
        raise UpdateError(f"unsupported architecture: {arch}")

    try:
        with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as archive:
            member = archive.getmember("speedtest")
            if not member.isfile():
                raise UpdateError("archive speedtest member is not a regular file")
            extracted = archive.extractfile(member)
            if extracted is None:
                raise UpdateError("archive speedtest member cannot be read")
            header = extracted.read(64)
    except (KeyError, tarfile.TarError, EOFError, OSError) as error:
        raise UpdateError(f"invalid archive: {error}") from error

    expected_class, expected_machine, expected_float_flag = EXPECTED_ELF[arch]
    required_size = 64 if expected_class == 2 else 52
    if len(header) < required_size:
        raise UpdateError("speedtest has a truncated ELF header")
    if header[:4] != b"\x7fELF":
        raise UpdateError("speedtest is not an ELF executable")
    if header[4] != expected_class:
        raise UpdateError(f"speedtest has the wrong ELF class for {arch}")
    if header[5] != 1:
        raise UpdateError("speedtest ELF is not little-endian")
    machine = int.from_bytes(header[18:20], "little")
    if machine != expected_machine:
        raise UpdateError(f"speedtest has the wrong ELF machine for {arch}")

    if expected_float_flag is not None:
        flags = int.from_bytes(header[36:40], "little")
        opposite_flag = 0x200 if expected_float_flag == 0x400 else 0x400
        if not flags & expected_float_flag or flags & opposite_flag:
            raise UpdateError(f"speedtest has the wrong ARM float ABI for {arch}")


def _replace_assignment(text, name, value):
    pattern = re.compile(rf"(?m)^({re.escape(name)}\s*:=\s*)[^\r\n]*$")
    if len(pattern.findall(text)) != 1:
        raise UpdateError(f"expected exactly one {name} assignment")
    return pattern.sub(lambda match: match.group(1) + value, text)


def render_makefile(text, version, hashes):
    """Render the exact version, release, and architecture hash assignments."""
    if set(hashes) != REQUIRED_ARCHES:
        raise UpdateError("hashes must contain exactly the required architectures")

    rendered = _replace_assignment(text, "PKG_VERSION", version)
    rendered = _replace_assignment(rendered, "PKG_RELEASE", "1")
    for arch in ("aarch64", "armhf", "armel"):
        rendered = _replace_assignment(rendered, f"OOKLA_HASH_{arch}", hashes[arch])
    return rendered


def _download(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            status = getattr(response, "status", 200)
            if status is None:
                status = 200
            if not 200 <= status < 300:
                raise UpdateError(f"HTTP {status} fetching {url}")
            return response.read()
    except UpdateError:
        raise
    except (urllib.error.URLError, OSError) as error:
        raise UpdateError(f"failed to fetch {url}: {error}") from error


def _read_current_version(makefile_text):
    match = re.findall(r"(?m)^PKG_VERSION\s*:=\s*(\d+\.\d+\.\d+)\s*$", makefile_text)
    if len(match) != 1:
        raise UpdateError("expected exactly one semantic PKG_VERSION assignment")
    return match[0]


def _write_atomic(path, text):
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(text)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_name, path.stat().st_mode)
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def update(page_url=PAGE_URL, makefile=REPOSITORY_MAKEFILE, check=False):
    makefile = Path(makefile)
    try:
        recipe = makefile.read_text(encoding="utf-8")
    except OSError as error:
        raise UpdateError(f"failed to read {makefile}: {error}") from error

    current = _read_current_version(recipe)
    try:
        page = _download(page_url).decode("utf-8")
    except UnicodeDecodeError as error:
        raise UpdateError("upstream page is not valid UTF-8") from error
    latest = latest_complete_release(page)

    if latest == current:
        print(f"ookla-speedtest-cli is already at {current}")
        return
    if check:
        print(f"new Ookla Speedtest CLI version available: {current} -> {latest}")
        return

    archives = {}
    for arch in ("aarch64", "armhf", "armel"):
        url = (
            "https://install.speedtest.net/app/cli/"
            f"ookla-speedtest-{latest}-linux-{arch}.tgz"
        )
        data = _download(url)
        validate_archive(arch, data)
        archives[arch] = data

    hashes = {arch: archive_sha256(data) for arch, data in archives.items()}
    rendered = render_makefile(recipe, latest, hashes)
    _write_atomic(makefile, rendered)
    print(f"updated ookla-speedtest-cli: {current} -> {latest}")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page-url", default=PAGE_URL, metavar="URL")
    parser.add_argument(
        "--makefile", type=Path, default=REPOSITORY_MAKEFILE, metavar="PATH"
    )
    parser.add_argument(
        "--check", action="store_true", help="report availability without writing"
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        update(args.page_url, args.makefile, args.check)
    except UpdateError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
