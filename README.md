# OpenWrt package for Ookla Speedtest CLI

This repository provides an unofficial, source-only OpenWrt package recipe for
the [Ookla Speedtest CLI](https://www.speedtest.net/apps/cli). It does not
contain or distribute Ookla binaries, release archives, or prebuilt OpenWrt
packages.

## Supported targets

The recipe supports Ookla's Linux ARM releases for:

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

Copy the generated `.ipk` from the build host's `bin/packages/` tree to
`/tmp` on the OpenWrt router. Then run these commands on the router (the
`/tmp` path below is the router's filesystem, not the build host's):

```bash
opkg install /tmp/ookla-speedtest-cli_*.ipk
speedtest
```

On first use, `speedtest` asks you to accept Ookla's license agreement and
privacy policy. Review the [Ookla EULA](https://www.speedtest.net/about/eula)
before accepting it.

## Updates

A scheduled GitHub Actions workflow checks Ookla's official CLI page daily for
a complete newer ARM release. It downloads the three supported archives in
temporary runner storage, validates their archive and ELF architecture, and
updates only the version and pinned checksums in the recipe. After the test
suite passes, the workflow commits that text-only recipe update directly to
`main`. It never commits or publishes the vendor archives, executables, or
generated `.ipk` files.

## Licensing and trademarks

The MIT license in [LICENSE](LICENSE) applies only to the repository-authored
package recipe, automation, tests, and documentation. It does not apply to or
relicense the proprietary Ookla Speedtest CLI binary. Use of that binary is
governed by Ookla's EULA.

This project is not affiliated with, endorsed by, or sponsored by Ookla.
Speedtest and Ookla are trademarks of their respective owners. The package is
maintained by Keith Herrington.
