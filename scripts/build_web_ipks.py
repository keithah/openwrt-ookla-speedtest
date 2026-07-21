#!/usr/bin/env python3
"""Build deterministic repository-only IPKs for the three web packages."""
import io, os, tarfile, tempfile, gzip
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = ROOT / "package"
PACKAGES = ("ookla-speedtest-webd", "luci-app-ookla-speedtest-web", "gl-app-ookla-speedtest-web")

def tar_bytes(files, base, mode_control=False):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.GNU_FORMAT) as t:
        for p in sorted(files):
            rel = p.relative_to(base)
            if rel.parts and rel.parts[0] == "CONTROL": rel = Path(rel.name)
            info = tarfile.TarInfo(str(rel)); info.size = p.stat().st_size; info.mtime = 0
            info.uid = info.gid = 0; info.uname = info.gname = ""; info.mode = p.stat().st_mode & 0o777
            t.addfile(info, p.open("rb"))
    return gzip.compress(out.getvalue(), mtime=0)

def build(name, version, release, outdir):
    root = PKG / name; control = root / "CONTROL"
    ctl = (control / "control").read_bytes()
    cfiles = [control / "control"] + ([control / "conffiles"] if (control / "conffiles").exists() else [])
    data = [p for p in root.rglob("*") if p.is_file() and "CONTROL" not in p.parts and "__pycache__" not in p.parts and p.suffix != ".pyc"]
    with tempfile.TemporaryDirectory() as d:
        ipk = Path(d) / name
        with ipk.open("wb") as f:
            f.write(b"!<arch>\n")
            for name_, payload in (("debian-binary", b"2.0\n"), ("control.tar.gz", tar_bytes(cfiles, root)), ("data.tar.gz", tar_bytes(data, root))):
                header = f"{name_}/           ".encode()[:16] + f"{0:<12}{0:<6}{0:<6}{'100644':<8}{len(payload):<10}`\n".encode()
                assert len(header) == 60
                f.write(header); f.write(payload)
                if len(payload) % 2: f.write(b"\n")
        target = outdir / f"{name}_{version}-{release}_all.ipk"; target.write_bytes(ipk.read_bytes())

if __name__ == "__main__":
    import sys
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "dist"); out.mkdir(parents=True, exist_ok=True)
    mk = (PKG / "Makefile").read_text(); import re
    version = re.search(r"^PKG_VERSION:=(.+)$", mk, re.M).group(1); release = re.search(r"^PKG_RELEASE:=(.+)$", mk, re.M).group(1)
    for n in PACKAGES: build(n, version, release, out)
