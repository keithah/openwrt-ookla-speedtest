# OpenWrt Ookla Speedtest Web Design

## Goal

Add a single OpenWrt package, `luci-app-ookla-speedtest-web`, that provides a polished Speedtest-style web frontend in both LuCI and GL.iNet Applications, runs tests from the router to the internet, and records useful history and analytics.

## Product shape

The package presents one shared frontend through two platform entry points:

- a native LuCI menu entry for stock OpenWrt;
- a GL.iNet Applications metadata entry that opens the same local application route.

On GL.iNet routers, the route is also reachable remotely through GoodCloud's
authenticated Remote Web Access / Remote GUI flow. The package does not add a
second public listener or require port forwarding: GoodCloud reaches the
router's existing authenticated admin surface, and the application reuses the
same LuCI session and CSRF protection. A remote user therefore sees the same
application and runs the same router-to-internet test as a local user.

The frontend is dependency-free JavaScript/CSS/HTML so the package does not require Node, a browser runtime, or a second UI implementation on the router.

The main view follows the supplied Speedtest reference: a dark navy surface, centered circular `GO` control with a cyan progress ring, compact controls in the upper-right, and server/network context beneath the control. The target is explicit: `router > internet`.

The context block displays the selected server name, sponsor, city, latency, detected ISP, and a connection badge using Wi-Fi, cellular, or Ethernet iconography. The ISP comes from the Ookla result when available, with a router-side active-WAN fallback. Connection type comes from OpenWrt network/device state.

The upper-right menu contains History, Analytics, Settings, and About. The main screen exposes automatic server selection, a searchable server list, and persistent manual server selection.

## Runtime architecture

The existing `ookla-speedtest-cli` package remains a separate dependency and continues to own the vendor binary. The web package never embeds that binary.

`ookla-speedtest-webd` is a small router-side service exposed through restricted `ubus` methods. It:

1. validates the requested server ID and fixed test options;
2. acquires a single-run lock;
3. launches `/usr/bin/speedtest --accept-license --format=json` with a validated server option when selected;
4. reports state and structured results to the frontend;
5. records successful and failed runs in bounded newline-delimited JSON history with atomic writes.

The browser uses one API contract in both LuCI, GL.iNet Applications, and
GoodCloud Remote Web Access. The preferred transport is event streaming where
supported, with short polling as a compatibility fallback.

The service caches the Ookla server list briefly, returns normalized server records, and maps missing binaries, busy state, network failure, malformed output, and storage errors to stable JSON error codes.

## Data and behavior

Each history record includes timestamp, server ID/name/sponsor/city, latency, download, upload, ISP, connection type, and outcome/error metadata. Retention is configurable with a conservative default and clear-all/delete-one actions.

Analytics provide rolling min/max/average values and a simple trend view for 7-day, 30-day, and all-time ranges. The UI remains usable on low-memory routers and does not require a charting dependency.

Settings include server preference, history retention, and display preferences that are safe to persist through UCI. About identifies the package, frontend version, dependency, and Ookla attribution.

The service never accepts arbitrary shell text from the browser. Server IDs are numeric and validated; command construction uses fixed argument arrays; output is size-limited and parsed as JSON; concurrent tests are rejected by a lock.

Remote access is never enabled by the package independently of GoodCloud. The
package relies on the router's existing GoodCloud account binding, Remote Web
Access setting, admin authentication, session expiry, and audit/logging path.
The UI should show a small “Remote via GoodCloud” context indicator when the
request headers or LuCI session identify the cloud-admin path, without exposing
credentials or cloud tokens to the frontend.

## Packaging

The package will include:

- LuCI controller/view/menu assets;
- shared static frontend assets;
- `ubus` service and init/ACL configuration;
- GL.iNet Applications metadata;
- UCI defaults and package lifecycle hooks;
- a runtime dependency on `ookla-speedtest-cli`.

The package will be added to the existing signed `openwrt-packages` feed alongside Starwatch, Wattline, and the CLI package. The CLI's existing updater and release workflow remain independent from this web package.

## Verification

Tests will cover package file layout, permissions, dependency metadata, LuCI and GL.iNet registration, service locking and command construction, malformed/oversized CLI output, history retention and atomic writes, frontend idle/running/result/error states, server selection, and history rendering. The implementation must pass repository tests and an OpenWrt package build for the supported target before release.

## Out of scope for the first release

- bundling or reimplementing the Ookla CLI;
- a standalone HTTP daemon or externally exposed port;
- an independent remote-access tunnel, cloud API, or GoodCloud credential flow;
- multi-user account synchronization;
- advanced telemetry beyond local history and aggregate analytics;
- a separate GL.iNet-only frontend.
