# OpenWrt Ookla Speedtest Web

This repository provides an unofficial OpenWrt web frontend for the
[Ookla Speedtest CLI](https://www.speedtest.net/apps/cli). It packages the
router-side service plus LuCI and GL.iNet Applications views; the Ookla binary
itself remains a dependency supplied by the separate CLI package. It does not
contain or distribute Ookla binaries or vendor release archives.

## Dependency and install

This package depends on the separate `ookla-speedtest-cli` OpenWrt package.
Install both components from Keith's signed feed with one command:

```sh
wget -qO- https://keithah.github.io/openwrt-packages/install-ookla-speedtest-web.sh | sh
```

The installer installs the CLI dependency first, then the web service and
both frontend adapters. For source builds, add `ookla-speedtest-cli` to the
same OpenWrt feed or build it separately before selecting this package.

## Screenshots

The Speedtest-style interface, including the router→internet label, history,
analytics, settings, and server selection, is shown in the
[UI screenshot gallery](https://imgur.com/a/HPLlPnS).

## Source build

From the root of an OpenWrt source tree on the build host, clone this package
and its CLI dependency, select the web packages in `make menuconfig`, and
build them:

```bash
git clone https://github.com/keithah/openwrt-ookla-speedtest-web.git \
  package/openwrt-ookla-speedtest-web
git clone https://github.com/keithah/openwrt-ookla-speedtest-cli.git \
  package/openwrt-ookla-speedtest-cli
make menuconfig
make package/ookla-speedtest-web/compile V=s
```

The web package uses the CLI package at runtime; it does not bundle the Ookla
binary.

The output package format and package manager depend on the OpenWrt version:

- OpenWrt 24.10 and older produce an `.ipk`, installed with `opkg`.
- OpenWrt 25.12 and newer produce an `.apk`, installed with `apk`.

See OpenWrt's [package-management overview](https://openwrt.org/docs/guide-user/additional-software/managing_packages)
and [APK documentation](https://openwrt.org/docs/guide-user/additional-software/apk)
for the official version-specific guidance.

Copy the generated `.ipk` or `.apk` from the build host's `bin/packages/`
tree to `/tmp` on the OpenWrt router. The `/tmp` paths in the commands below
refer to the router's filesystem, not the build host's.

On an OpenWrt 24.10 or older router, install the `.ipk`:

```bash
opkg install /tmp/ookla-speedtest-cli_*.ipk /tmp/*ookla-speedtest-web*.ipk
```

On an OpenWrt 25.12 or newer router, install the locally built, unsigned
`.apk` with the required `--allow-untrusted` option:

```bash
apk add --allow-untrusted /tmp/ookla-speedtest-cli-*.apk /tmp/*ookla-speedtest-web*.apk
```

Then open the web interface on the router:

```bash
http://router/cgi-bin/luci/admin/services/ookla-speedtest-web
```

## Updates

A scheduled GitHub Actions workflow checks Ookla's official CLI page daily for
a complete newer ARM release. It downloads the three supported archives in
temporary runner storage, validates their archive and ELF architecture, and
changes `PKG_VERSION`, resets `PKG_RELEASE` to `1`, and replaces all three
architecture-specific checksums in the recipe.
After the test suite passes, the workflow commits that text-only recipe update
directly to `main`. It never commits or publishes the vendor archives,
executables, or generated `.ipk` or `.apk` files.

## Licensing and trademarks

The MIT license in [LICENSE](LICENSE) applies only to the repository-authored
package recipe, automation, tests, and documentation. It does not apply to or
relicense the proprietary Ookla Speedtest CLI binary. Use of that binary is
governed by Ookla's EULA.

This project is not affiliated with, endorsed by, or sponsored by Ookla.
Speedtest and Ookla are trademarks of their respective owners. The package is
maintained by Keith Herrington.

## Speedtest web interface

The optional `ookla-speedtest-web` package adds a LuCI and GL.iNet web
interface around the CLI package. On a local router, open LuCI at:

Install the published web packages from Keith's signed feed with one command:

```sh
wget -qO- https://keithah.github.io/openwrt-packages/install-ookla-speedtest-web.sh | sh
```

```
http://router/cgi-bin/luci/admin/services/ookla-speedtest-web
```

On GL.iNet firmware, launch it from **Applications**. Devices enrolled in
GoodCloud must have **Remote Web Access** enabled in the router's GoodCloud
settings; after authenticating to GoodCloud, open the Ookla Speedtest
application there. This authenticated remote path reuses the same LuCI route:

```
http://router/cgi-bin/luci/admin/services/ookla-speedtest-web
```

The package does not add a custom port, public HTTP listener, or separate
credential flow. All requests use the router's existing LuCI/GL.iNet session.
