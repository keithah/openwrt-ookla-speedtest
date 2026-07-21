# OpenWrt Ookla Speedtest Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish one OpenWrt package that exposes a shared Speedtest-style dashboard through LuCI, GL.iNet Applications, and authenticated GoodCloud Remote Web Access.

**Architecture:** A small shell/ubus service owns test execution, server discovery, network metadata, locking, and bounded JSONL history. Shared dependency-free frontend assets render the same dashboard in a LuCI view and a GL.iNet view; both call the same ubus contract and inherit the router's authenticated session, including GoodCloud's remote GUI tunnel.

**Tech Stack:** OpenWrt package Makefiles, POSIX shell, ubus/rpcd ACLs, LuCI JavaScript view APIs, GL.iNet OUI menu/RPC conventions, dependency-free HTML/CSS/JavaScript, Python unittest and shell contract tests.

---

## File map

- Create `package/Makefile`: OpenWrt package metadata for `luci-app-ookla-speedtest-web`, runtime dependency on `ookla-speedtest-cli`, and package assembly.
- Create `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd`: restricted service implementation for ubus calls.
- Create `package/ookla-speedtest-webd/etc/init.d/ookla-speedtest-webd`: service lifecycle and runtime directory setup.
- Create `package/ookla-speedtest-webd/etc/config/ookla-speedtest-webd`: UCI defaults for server preference, history retention, and UI settings.
- Create `package/ookla-speedtest-webd/etc/uci-defaults/99-ookla-speedtest-webd`: idempotent first-install configuration.
- Create `package/ookla-speedtest-webd/CONTROL/control`, `CONTROL/conffiles`, and `CONTROL/postinst`: package metadata, preserved UCI config, and safe service/ACL reload.
- Create `package/luci-app-ookla-speedtest-web/CONTROL/control`: LuCI package metadata.
- Create `package/luci-app-ookla-speedtest-web/usr/share/luci/menu.d/luci-app-ookla-speedtest-web.json`: Applications menu route.
- Create `package/luci-app-ookla-speedtest-web/usr/share/rpcd/acl.d/luci-app-ookla-speedtest-web.json`: least-privilege ubus ACL.
- Create `package/luci-app-ookla-speedtest-web/www/luci-static/resources/view/ookla-speedtest-web/main.js`: LuCI adapter that mounts shared frontend assets and calls ubus.
- Create `package/shared/ookla-speedtest-web/index.html`, `app.js`, and `styles.css`: shared dashboard, history, analytics, settings, about, server picker, and result states.
- Create `package/gl-app-ookla-speedtest-web/CONTROL/control` and `CONTROL/postinst`: GL.iNet package metadata and install hooks.
- Create `package/gl-app-ookla-speedtest-web/usr/share/oui/menu.d/ookla-speedtest-web.json`: Applications entry.
- Create `package/gl-app-ookla-speedtest-web/usr/lib/oui-httpd/rpc/ookla-speedtest-web`: GL.iNet RPC adapter using the same service methods.
- Create `package/gl-app-ookla-speedtest-web/www/views/gl-sdk4-ui-ookla-speedtest-web.common.js`: GL.iNet wrapper mounting the shared frontend.
- Create `tests/test_package_layout.py`, `tests/test_service_contract.sh`, `tests/test_frontend_contract.js`, and `tests/fixtures/speedtest-result.json`: deterministic contract coverage.
- Modify `README.md`: installation, local LuCI route, GL.iNet/GoodCloud behavior, and supported dependency requirements.

### Task 1: Define package and UI contracts

**Files:** Create `tests/test_package_layout.py`, `tests/fixtures/speedtest-result.json`; modify `README.md`.

- [ ] **Step 1: Write failing package-layout tests.** Assert the package tree contains the service, init/config/ACL files, LuCI and GL.iNet entries, shared assets, and `ookla-speedtest-cli` in package dependencies. Assert no `.tgz`, Ookla binary, private key, or standalone HTTP daemon exists.
- [ ] **Step 2: Run the red test.** Run `python3 -m unittest tests.test_package_layout -v`; expect failure because the package tree does not exist.
- [ ] **Step 3: Add the fixture and README contract.** The fixture must include a realistic successful Ookla JSON object with `server`, `isp`, `interface`, `ping`, `download`, `upload`, and timestamp-compatible fields. README must document `http://router/cgi-bin/luci/admin/services/ookla-speedtest-web`, GL.iNet Applications, and GoodCloud Remote Web Access.
- [ ] **Step 4: Commit the contract.** Run `git add tests README.md && git commit -m "test: define speedtest web package contract"`.

### Task 2: Implement service parsing, locking, and history

**Files:** Create `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd`; test with `tests/test_service_contract.sh`.

- [ ] **Step 1: Write failing shell tests.** Exercise the service in a temporary fake root with fake `speedtest` output. Assert `status` returns idle, `start` rejects non-numeric server IDs, constructs only fixed arguments, `start` returns busy while the lock exists, malformed/oversized JSON produces stable errors, and history keeps only the configured newest records.
- [ ] **Step 2: Run the red test.** Run `sh tests/test_service_contract.sh`; expect failure because the service is missing.
- [ ] **Step 3: Implement the minimal service.** Use a fixed method dispatcher (`status`, `servers`, `start`, `history`, `delete_history`, `clear_history`, `settings`) and JSON output. Store state in `/var/run/ookla-speedtest-webd`, history in `/etc/ookla-speedtest-webd/history.jsonl`, and use `flock` where available with an atomic lock-directory fallback. Invoke only `/usr/bin/speedtest --accept-license --format=json`, adding `--server-id` followed by a validated decimal ID when requested. Limit captured output before parsing and normalize result/error objects.
- [ ] **Step 4: Run the green service test.** Run `sh tests/test_service_contract.sh`; expect all assertions to pass.
- [ ] **Step 5: Commit.** Run `git add package/ookla-speedtest-webd tests/test_service_contract.sh && git commit -m "feat: add router speedtest service"`.

### Task 3: Add OpenWrt lifecycle and access control

**Files:** Create service init/config/defaults/CONTROL files and `package/luci-app-ookla-speedtest-web/usr/share/rpcd/acl.d/luci-app-ookla-speedtest-web.json`.

- [ ] **Step 1: Write failing metadata assertions.** Extend `tests/test_package_layout.py` to require UCI defaults, an executable init script, conffiles, postinst, and ACL entries limited to the seven service methods; reject wildcard ubus permissions and network-facing init listeners.
- [ ] **Step 2: Run the red test.** Run `python3 -m unittest tests.test_package_layout -v`; expect failure for missing lifecycle and ACL files.
- [ ] **Step 3: Implement lifecycle files.** The init script must create the runtime directory, validate the CLI dependency at start, and never bind a TCP port. UCI defaults must create `config ookla-speedtest-webd`, set retention to 100, and be idempotent. `postinst` must reload rpcd/ubus safely and avoid running tests during installation. ACL must allow only the named service methods and read-only UCI access except for settings writes.
- [ ] **Step 4: Run package metadata tests.** Run `python3 -m unittest tests.test_package_layout -v`; expect PASS.
- [ ] **Step 5: Commit.** Run `git add package tests/test_package_layout.py && git commit -m "feat: add OpenWrt service lifecycle and ACL"`.

### Task 4: Build the shared Speedtest-style frontend

**Files:** Create `package/shared/ookla-speedtest-web/index.html`, `app.js`, `styles.css`; test with `tests/test_frontend_contract.js`.

- [ ] **Step 1: Write failing frontend contract tests.** Use a tiny Node-compatible DOM harness or static contract checks to assert the app exposes `router > internet`, a `GO` control, server picker, ISP/connection badges, upper-right links for History/Analytics/Settings/About, and render functions for idle/running/result/error states.
- [ ] **Step 2: Run the red test.** Run `node tests/test_frontend_contract.js`; expect failure because shared assets do not exist.
- [ ] **Step 3: Implement the shared view.** Build the dark navy reference layout with a responsive central ring, accessible button labels, cyan progress state, server/ISP/network context cards, menu drawer, searchable server list, bounded history table, lightweight SVG trend chart, settings form, and about/attribution panel. Define a small adapter interface: `call(method, params)`, `subscribe(listener)`, and `navigate(view)`. Use textContent/DOM APIs for result data, never innerHTML with router output.
- [ ] **Step 4: Run the green frontend contract test.** Run `node tests/test_frontend_contract.js`; expect PASS.
- [ ] **Step 5: Commit.** Run `git add package/shared tests/test_frontend_contract.js && git commit -m "feat: add shared Speedtest dashboard"`.

### Task 5: Add LuCI and GL.iNet adapters

**Files:** Create LuCI menu/view/ACL adapter and GL.iNet menu/RPC/view files; extend frontend contract tests for both adapters.

- [ ] **Step 1: Write failing adapter assertions.** Assert LuCI points to the shared app, calls ubus through the authenticated session, and declares no external origin. Assert GL.iNet metadata routes to the same app and RPC methods; assert the GoodCloud path uses the existing admin route and does not expose credentials or a custom port.
- [ ] **Step 2: Run the red test.** Run `node tests/test_frontend_contract.js`; expect failure for missing adapters.
- [ ] **Step 3: Implement LuCI adapter.** Use LuCI `view.extend` and `rpc.declare` for the fixed service methods, mount shared assets, and preserve LuCI session/CSRF behavior. Add the menu route under Services/Applications.
- [ ] **Step 4: Implement GL.iNet adapter.** Follow the existing `gl-app-*` package convention: register an Applications item and an OUI RPC bridge that delegates to the same service without a new listener. Include a remote-context flag derived only from server-provided request metadata.
- [ ] **Step 5: Run adapter tests.** Run `node tests/test_frontend_contract.js`; expect PASS.
- [ ] **Step 6: Commit.** Run `git add package tests/test_frontend_contract.js && git commit -m "feat: expose dashboard in LuCI and GL.iNet"`.

### Task 6: Assemble the OpenWrt package

**Files:** Create `package/Makefile` and package `CONTROL` metadata; extend `tests/test_package_layout.py`.

- [ ] **Step 1: Add failing Makefile assertions.** Require package name `luci-app-ookla-speedtest-web`, release number, `DEPENDS:=+ookla-speedtest-cli`, and package output names for the service, LuCI, and GL.iNet components.
- [ ] **Step 2: Run the red test.** Run `python3 -m unittest tests.test_package_layout -v`; expect failure because the Makefile is missing.
- [ ] **Step 3: Implement package assembly.** Use OpenWrt `package.mk` conventions to install each tree into the correct root, set executable modes on service/init/RPC files, preserve UCI config through `CONFFILES`, and declare the runtime CLI dependency. Do not add a `Build/Compile` download or vendor archive.
- [ ] **Step 4: Run package tests.** Run `python3 -m unittest discover -s tests -v`; expect PASS.
- [ ] **Step 5: Commit.** Run `git add package/Makefile package/*/CONTROL tests/test_package_layout.py && git commit -m "feat: package Ookla Speedtest web app"`.

### Task 7: Verify build, migration, and GoodCloud-safe behavior

**Files:** Modify `README.md`, add `tests/install-test.sh` and `tests/goodcloud-contract-test.sh`.

- [ ] **Step 1: Write failing integration assertions.** Validate the generated IPK contains the expected files and dependency, excludes vendor binaries and listeners, installs the LuCI/GL entries, and has an ACL with only fixed service methods. Assert GoodCloud documentation text and route reuse are present.
- [ ] **Step 2: Run the red integration tests.** Run `sh tests/install-test.sh` and `sh tests/goodcloud-contract-test.sh`; expect failures until the package build/metadata is complete.
- [ ] **Step 3: Implement exact README and test fixtures.** Document enabling GoodCloud Remote Web Access, opening the package from the authenticated Remote GUI, and the limitation that GoodCloud must be enabled by the router owner. Do not document a custom port or public URL.
- [ ] **Step 4: Run the full verification suite.** Run:

```sh
python3 -m unittest discover -s tests -v
sh tests/install-test.sh
sh tests/goodcloud-contract-test.sh
make -C package test
make -C package clean all
```

Expected: all tests pass; the IPK is produced with no embedded Ookla binary and no network listener.

- [ ] **Step 5: Commit.** Run `git add README.md tests && git commit -m "test: verify web package and GoodCloud route"`.

### Task 8: Release and feed publication

**Files:** Create `.github/workflows/test.yml` and `.github/workflows/release.yml`; modify `README.md` and the feed manifest in the publisher repository after the package repository is public.

- [ ] **Step 1: Write workflow contract tests.** Assert test workflow runs package tests/builds on pushes and pull requests, release workflow validates one package version, builds the IPK, checks for forbidden binaries/listeners, and publishes the release asset and installer metadata.
- [ ] **Step 2: Run the red workflow contract.** Run `python3 -m unittest discover -s tests -v`; expect only the new workflow assertions to fail.
- [ ] **Step 3: Implement workflows.** Use pinned GitHub Actions versions consistent with the existing repositories, build the package in a deterministic OpenWrt-compatible harness, create a versioned GitHub release, and dispatch the publisher feed update after release. Keep signing credentials in the publisher repository only.
- [ ] **Step 4: Run workflow/static verification.** Run `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/*.yml`, then the complete local suite and package build.
- [ ] **Step 5: Commit and publish.** Run `git add .github README.md tests && git commit -m "ci: release Ookla Speedtest web app"`; push `main`, create the public repository if needed, add the new source to `openwrt-packages`, dispatch the feed publisher, and verify the signed feed inventory.

## Plan self-review

- Spec coverage: shared LuCI/GL views (Tasks 4–5), router execution and history (Task 2), server selection and metadata (Tasks 2 and 4), GoodCloud remote access (Tasks 3, 5, and 7), packaging (Tasks 3 and 6), testing (all tasks), and signed-feed release (Task 8) are mapped.
- Placeholder scan: no TODO/TBD/“implement later” steps remain.
- Interface consistency: the frontend adapter uses `call(method, params)`, `subscribe(listener)`, and `navigate(view)`; the service methods are fixed as `status`, `servers`, `start`, `history`, `delete_history`, `clear_history`, and `settings` throughout.
- Scope: one package and one release plan; GoodCloud is an access path through existing authenticated LuCI rather than a second subsystem or cloud integration.
