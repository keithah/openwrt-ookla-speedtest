#!/usr/bin/env python3
"""Build deterministic repository-only IPKs for the three web packages."""
import io, os, tarfile, tempfile, gzip, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = ROOT / "package"
PACKAGES = ("ookla-speedtest-webd", "luci-app-ookla-speedtest-web", "gl-app-ookla-speedtest-web")

def tar_bytes(files, base, mode_control=False):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.USTAR_FORMAT) as t:
        directories = set()
        for p in files:
            rel = p.relative_to(base) if p.is_relative_to(base) else Path("control")
            if rel.parts and rel.parts[0] == "CONTROL": rel = Path(rel.name)
            directories.update(rel.parents)
        for rel in sorted((d for d in directories if str(d) != "."), key=lambda d: (len(d.parts), str(d))):
            info = tarfile.TarInfo(str(rel)); info.type = tarfile.DIRTYPE; info.mtime = 0
            info.uid = info.gid = 0; info.uname = info.gname = ""; info.mode = 0o755
            t.addfile(info)
        for p in sorted(files):
            rel = p.relative_to(base) if p.is_relative_to(base) else Path("control")
            if rel.parts and rel.parts[0] == "CONTROL": rel = Path(rel.name)
            info = tarfile.TarInfo(str(rel)); info.size = p.stat().st_size; info.mtime = 0
            info.uid = info.gid = 0; info.uname = info.gname = ""; info.mode = 0o755 if p.stat().st_mode & 0o111 else 0o644
            with p.open("rb") as source: t.addfile(info, source)
    return gzip.compress(out.getvalue(), mtime=0)

def build(name, version, release, outdir):
    root = PKG / name; control = root / "CONTROL"
    ctl = (control / "control").read_text()
    ctl = __import__('re').sub(r"^Version:.*$", f"Version: {version}-{release}", ctl, flags=__import__('re').M).encode()
    cfiles = [control / "control"] + sorted(p for p in control.iterdir() if p.is_file() and p.name != "control")
    with tempfile.NamedTemporaryFile() as generated, tempfile.TemporaryDirectory() as staged:
        generated.write(ctl); generated.flush(); cfiles[0] = Path(generated.name)
        data_root = Path(staged)
        for source in root.iterdir():
            if source.name == "CONTROL": continue
            target = data_root / source.name
            if source.is_dir(): shutil.copytree(source, target)
            else: shutil.copy2(source, target)
        shared = PKG / "shared" / "ookla-speedtest-web"
        if name == "luci-app-ookla-speedtest-web":
            shutil.copytree(shared, data_root / "www/luci-static/resources/ookla-speedtest-web", dirs_exist_ok=True)
        elif name == "gl-app-ookla-speedtest-web":
            shutil.copytree(shared, data_root / "www/ookla-speedtest-web", dirs_exist_ok=True)
        _build(name, version, release, outdir, data_root, cfiles, root)

def _build(name, version, release, outdir, root, cfiles, control_root):
    data = [p for p in root.rglob("*") if p.is_file() and "CONTROL" not in p.parts and "__pycache__" not in p.parts and p.suffix != ".pyc"]
    with tempfile.TemporaryDirectory() as d:
        ipk = Path(d) / name
        with tarfile.open(ipk, "w", format=tarfile.USTAR_FORMAT) as t:
            for name_, payload in (("debian-binary", b"2.0\n"), ("control.tar.gz", tar_bytes(cfiles, control_root)), ("data.tar.gz", tar_bytes(data, root))):
                info = tarfile.TarInfo(name_); info.size = len(payload); info.mtime = 0; info.uid = info.gid = 0; info.mode = 0o644
                t.addfile(info, io.BytesIO(payload))
        ipk.write_bytes(gzip.compress(ipk.read_bytes(), mtime=0))
        target = outdir / f"{name}_{version}-{release}_all.ipk"; target.write_bytes(ipk.read_bytes())

if __name__ == "__main__":
    import sys
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "dist"); out.mkdir(parents=True, exist_ok=True)
    mk = (PKG / "Makefile").read_text(); import re
    version = re.search(r"^PKG_VERSION:=(.+)$", mk, re.M).group(1); release = re.search(r"^PKG_RELEASE:=(.+)$", mk, re.M).group(1)
    for n in PACKAGES: build(n, version, release, out)
