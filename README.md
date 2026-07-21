# OpenWrt Ookla Speedtest Web

This repository provides an unofficial OpenWrt web frontend for the
[Ookla Speedtest CLI](https://www.speedtest.net/apps/cli). It packages the
router-side service plus LuCI and GL.iNet Applications views; the Ookla binary
itself remains a dependency supplied by the separate CLI package. It does not
contain or distribute Ookla binaries or vendor release archives.

## CLI dependency

The companion `ookla-speedtest-cli` package downloads Ookla's Linux ARM
release for:

- 64-bit ARM (`aarch64`)
- 32-bit ARM with the hard-float ABI (`armhf`)
- 32-bit ARM with the soft-float ABI (`armel`)

Other architectures are not selectable for this package.

## Build and install

From the root of an OpenWrt source tree on the build host, clone the package,
select **Utilities → ookla-speedtest-cli** in the configuration menu, and
build it:

```bash
git clone https://github.com/keithah/openwrt-ookla-speedtest-cli.git \
  package/openwrt-ookla-speedtest-cli
make menuconfig
make package/ookla-speedtest-cli/compile V=s
```

The OpenWrt build downloads the matching vendor archive and verifies it
against the architecture-specific SHA-256 checksum pinned in the recipe.

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
opkg install /tmp/ookla-speedtest-cli_*.ipk
```

On an OpenWrt 25.12 or newer router, install the locally built, unsigned
`.apk` with the required `--allow-untrusted` option:

```bash
apk add --allow-untrusted /tmp/ookla-speedtest-cli-*.apk
```

Then run `speedtest` on the router:

```bash
speedtest
```

On first use, `speedtest` asks you to accept Ookla's license agreement and
privacy policy. Review the [Ookla EULA](https://www.speedtest.net/about/eula)
before accepting it.

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
