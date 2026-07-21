#!/bin/sh
# Install the Ookla CLI dependency and web interfaces from the signed feed.
set -eu

version="1.1.2"
feed_url="${OOKLA_FEED_URL:-https://keithah.github.io/openwrt-packages}"

fail() {
	printf 'ookla-speedtest-web installer: %s\n' "$*" >&2
	exit 1
}

[ "$(id -u)" = 0 ] || fail 'must be run as root'
command -v opkg >/dev/null 2>&1 || fail 'opkg is required'
command -v wget >/dev/null 2>&1 || fail 'wget is required'

# The CLI installer installs the feed key, preserves unrelated feed entries,
# verifies architecture support, updates package lists, and installs the CLI.
wget -qO- "$feed_url/install-ookla-speedtest-cli.sh" |
	OOKLA_FEED_URL="$feed_url" sh

opkg install ookla-speedtest-webd luci-app-ookla-speedtest-web gl-app-ookla-speedtest-web

printf 'Installed Ookla Speedtest Web %s. Open Services > Ookla Speedtest in LuCI or Ookla Speedtest under GL.iNet Applications.\n' "$version"
