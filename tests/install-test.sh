#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PKG="$ROOT/package"
version=$(sed -n 's/^PKG_VERSION:=//p' "$PKG/Makefile")
grep -q "version=\"$version\"" "$ROOT/install.sh"

# Reproduce the Makefile's source-to-payload copies and ensure control metadata
# never leaks into an installed root.
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE"/usr "$STAGE"/etc "$STAGE"/www
mkdir -p "$STAGE/www/luci-static/resources/ookla-speedtest-web"
cp -R "$PKG/ookla-speedtest-webd/etc/." "$STAGE/etc/"
cp -R "$PKG/ookla-speedtest-webd/usr/." "$STAGE/usr/"
cp -R "$PKG/luci-app-ookla-speedtest-web/usr/." "$STAGE/usr/"
cp -R "$PKG/luci-app-ookla-speedtest-web/www/." "$STAGE/www/"
cp -R "$PKG/gl-app-ookla-speedtest-web/usr/." "$STAGE/usr/"
cp -R "$PKG/gl-app-ookla-speedtest-web/www/." "$STAGE/www/"
cp -R "$PKG/shared/ookla-speedtest-web/." "$STAGE/www/luci-static/resources/ookla-speedtest-web/"
test ! -e "$STAGE/CONTROL"
! grep -Eqi '\$\(CP\).*CONTROL|/CONTROL' "$PKG/Makefile"
test ! -f "$PKG/ookla-speedtest-webd/usr/bin/speedtest"
for f in \
  ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd \
  ookla-speedtest-webd/etc/init.d/ookla-speedtest-webd \
  luci-app-ookla-speedtest-web/usr/libexec/rpcd/ookla-speedtest-web \
  gl-app-ookla-speedtest-web/usr/lib/oui-httpd/rpc/ookla-speedtest-web; do
  test -x "$PKG/$f"
done
grep -q 'ookla-speedtest-cli' "$PKG/ookla-speedtest-webd/CONTROL/control"
grep -q 'ookla-speedtest-webd' "$PKG/luci-app-ookla-speedtest-web/CONTROL/control"
grep -q 'luci-app-ookla-speedtest-web' "$PKG/gl-app-ookla-speedtest-web/CONTROL/control"
if command -v rg >/dev/null 2>&1; then
  ! rg -n -i 'http\.server|serve_forever|socket\.listen|listen\s*\(' "$PKG" --glob '!**/*.pyc'
else
  ! grep -RniE 'http\.server|serve_forever|socket\.listen|listen[[:space:]]*\(' "$PKG" --exclude='*.pyc'
fi
echo 'install layout contract: ok'
