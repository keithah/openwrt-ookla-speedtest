#!/bin/sh
set -eu

version="1.0.1"
base="https://github.com/keithah/openwrt-ookla-speedtest-web/releases/download/v${version}"

command -v opkg >/dev/null 2>&1 || {
	printf '%s\n' 'opkg is required' >&2
	exit 1
}

for package in \
	ookla-speedtest-webd \
	luci-app-ookla-speedtest-web \
	gl-app-ookla-speedtest-web
do
	opkg install "${base}/${package}_${version}-1_all.ipk"
done
