#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
README="$ROOT/README.md"
GL="$ROOT/package/gl-app-ookla-speedtest-web/www/views/gl-sdk4-ui-ookla-speedtest-web.common.js"
grep -qi 'GoodCloud' "$README"
grep -qi 'Remote Web Access' "$README"
grep -qi 'authenticated' "$README"
grep -q '/cgi-bin/luci/admin/services/ookla-speedtest-web' "$README"
grep -qi 'Applications' "$README"
! grep -Eqi 'custom port|public listener|port[[:space:]]*[:=]|credential flow' "$README" "$GL"
grep -q 'window\.\$request' "$GL"
grep -q 'SpeedtestWebAdapter' "$GL"
grep -q 'luci-static/resources/ookla-speedtest-web/index.html' "$GL"
echo 'GoodCloud route contract: ok'
