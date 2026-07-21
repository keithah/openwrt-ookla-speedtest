# Ookla Speedtest Web for OpenWrt

Run an Ookla Speedtest from your router and view the result in a native
LuCI or GL.iNet Applications experience. The test is explicitly labeled
**router → internet**: the measurements describe the path from the router,
not the phone or computer displaying the page.

![Ookla Speedtest Web dashboard](docs/screenshots/dashboard.png)

This screenshot is captured from the actual shared frontend shipped in this
repository—not from the macOS Speedtest application.

## What you get

- A Speedtest-style **GO** dashboard with download, upload, ping, ISP, and
  connection details.
- Manual server selection with search, alongside automatic server selection.
- Persistent test history and simple trend analytics.
- Settings and About views from the upper-right menu.
- A LuCI page under **Services → Ookla Speedtest**.
- A GL.iNet **Applications** entry using the same frontend and service.
- GoodCloud Remote Web Access through the router’s existing authenticated
  LuCI/GL.iNet session. No extra public listener or custom port is added.

## Install

Install the CLI dependency and all web components from the signed OpenWrt feed
with one command:

```sh
wget -qO- https://keithah.github.io/openwrt-packages/install-ookla-speedtest-web.sh | sh
```

The installer configures the signed feed, installs `ookla-speedtest-cli`, and
then installs:

- `ookla-speedtest-webd` — router-side RPC service;
- `luci-app-ookla-speedtest-web` — LuCI integration;
- `gl-app-ookla-speedtest-web` — GL.iNet Applications integration.

The Ookla executable is not stored in this repository or bundled into these
packages. It is provided by the separate CLI package and downloaded according
to that package’s OpenWrt recipe.

## How it works

When you press **GO**, the web view calls the authenticated router RPC
service. The service launches `/usr/bin/speedtest` on the router, parses the
JSON result, stores a bounded history, and returns the result to the view.
LuCI and GL.iNet use the same frontend and service, so the results and behavior
are consistent between both views.

The server picker passes the selected Ookla server ID to the router-side test.
If no server is selected, Ookla chooses the best available server.

### VPN-aware results

Before returning a result, the service checks the router’s active interfaces
and processes for common VPN paths, including Tailscale, WireGuard, tun/tap,
ZeroTier, and Speedify. The dashboard calls out whether the result reflects a
detected VPN path or the direct WAN path. This makes it clear when an exit
node, tunnel, or traffic-acceleration service is part of the measurement.

## Remote testing with GoodCloud

Enable **Remote Web Access** for the router in GoodCloud, authenticate to the
router, and open the Ookla Speedtest application. The request follows the
existing authenticated remote LuCI/GL.iNet path; this package does not create
an unauthenticated service or require port forwarding.

## Build from source

Add both repositories to an OpenWrt source tree, select the web packages in
`make menuconfig`, and build:

```sh
git clone https://github.com/keithah/openwrt-ookla-speedtest-web.git \
  package/openwrt-ookla-speedtest-web
git clone https://github.com/keithah/openwrt-ookla-speedtest-cli.git \
  package/openwrt-ookla-speedtest-cli
make menuconfig
make package/ookla-speedtest-web/compile V=s
```

The web package depends on `ookla-speedtest-cli`; it does not package the
vendor binary. The resulting package format follows the OpenWrt release:
`.ipk` for older releases and `.apk` for newer releases.

## Updates and licensing

GitHub Actions checks for new upstream releases and updates the package
metadata when a newer compatible version is detected. The repository contains
only package code, frontend assets, tests, and automation. Ookla’s proprietary
binary remains subject to the [Ookla EULA](https://www.speedtest.net/about/eula).

This project is not affiliated with or endorsed by Ookla.
