# Live Speed Gauges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ookla-inspired gauges driven by real ping, download, and upload samples to Router → Internet, Device → Router, and Both modes.

**Architecture:** Add an asynchronous JSONL worker to the router service and expose start, poll, and cancel RPC methods through LuCI and GL.iNet. Refactor the shared frontend around a single test state machine, a pure gauge model, and a live dial/trace renderer; local and internet tests feed the same sample interface and Both runs them sequentially.

**Tech Stack:** Python 3 standard library, Ookla Speedtest CLI 1.2 JSONL output, POSIX/OpenWrt process primitives, LuCI JavaScript RPC, GL.iNet Lua `oui-httpd`, browser DOM/SVG/CSS, Node.js contract tests, Python `unittest`, shell integration tests.

---

## File Structure

- `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd`: request validation, runtime job files, process lifecycle, JSONL reduction, history, and existing RPC behavior.
- `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd-worker`: detached CLI worker that streams bounded JSONL state and writes the terminal result.
- `package/shared/ookla-speedtest-web/gauge.js`: pure scale, angle, sample, and bounded-trace functions shared by every UI host.
- `package/shared/ookla-speedtest-web/app.js`: test state machine, RPC polling, local sampling, Both sequencing, cancellation, and DOM rendering.
- `package/shared/ookla-speedtest-web/index.html`: semantic gauge, metric strip, trace, cancellation, result, and metadata structure.
- `package/shared/ookla-speedtest-web/styles.css`: reference-matched layout, dial, needle, phase colors, responsive states, and reduced motion.
- `package/luci-app-ookla-speedtest-web/usr/libexec/rpcd/ookla-speedtest-web`: LuCI RPC method definitions.
- `package/luci-app-ookla-speedtest-web/usr/share/rpcd/acl.d/luci-app-ookla-speedtest-web.json`: authenticated live-method permissions.
- `package/luci-app-ookla-speedtest-web/www/luci-static/resources/view/ookla-speedtest-web/main.js`: LuCI bridge declarations and timeouts.
- `package/gl-app-ookla-speedtest-web/usr/lib/oui-httpd/rpc/ookla-speedtest-web`: GL.iNet Lua bridge methods.
- `tests/test_service_live.py`: asynchronous worker, progress, result, cancellation, stale-state, and validation tests.
- `tests/test_gauge.js`: pure gauge math and trace tests.
- Existing contract tests: package, bridge, frontend, and install regression coverage.

### Task 1: Parse and Reduce Ookla JSONL Events

**Files:**
- Modify: `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd`
- Create: `tests/test_service_live.py`

- [ ] **Step 1: Write failing parser tests**

Create a temporary runtime directory, import the extensionless service with
`importlib.machinery.SourceFileLoader`, and assert the reduced shapes:

```python
def test_reduce_download_event(self):
    event = {"type": "download", "download": {
        "bandwidth": 12_500_000, "bytes": 25_000_000,
        "elapsed": 2000, "progress": 0.4,
        "latency": {"iqm": 31.2}}}
    self.assertEqual(self.mod.reduce_event(event), {
        "phase": "download", "progress": 0.4,
        "download_mbps": 100.0, "loaded_ping_ms": 31.2})

def test_reduce_result_event_bounds_trace_fields(self):
    reduced = self.mod.reduce_event(self.fixture("speedtest-jsonl-result.json"))
    self.assertEqual(reduced["phase"], "complete")
    self.assertEqual(reduced["result"]["download"]["bandwidth"], 37_091_386)
```

- [ ] **Step 2: Run the parser tests and verify RED**

Run: `python3 -m unittest tests.test_service_live -v`

Expected: FAIL because `reduce_event` and the JSONL fixture do not exist.

- [ ] **Step 3: Add bounded JSONL reduction**

Add a side-effect-free `reduce_event(event)` before `main(req)` that accepts
only `testStart`, `ping`, `download`, `upload`, and `result`; converts CLI
bandwidth bytes/second to Mbps; clamps progress to `0..1`; copies only the
approved nested result fields; and returns `None` for log or unknown events.
Reject a JSONL line over 1 MiB before decoding.

```python
def bandwidth_mbps(value):
 return round(float(value) * 8 / 1_000_000, 2)

def clamp_progress(value):
 return max(0.0, min(1.0, float(value)))

def reduce_event(event):
 kind=event.get('type')
 if kind=='ping':
  ping=event.get('ping') or {}
  return {'phase':'ping','progress':clamp_progress(ping.get('progress',0)),
          'ping_ms':float(ping.get('latency',0)),
          'jitter_ms':float(ping.get('jitter',0))}
 if kind in ('download','upload'):
  row=event.get(kind) or {}
  return {'phase':kind,'progress':clamp_progress(row.get('progress',0)),
          kind+'_mbps':bandwidth_mbps(row.get('bandwidth',0)),
          'loaded_ping_ms':float((row.get('latency') or {}).get('iqm',0))}
 # testStart copies isp, interface, and server; result copies ping, download,
 # upload, packetLoss, isp, interface, server, and result.id/result.url only.
 return None
```

- [ ] **Step 4: Run parser and existing service tests**

Run: `python3 -m unittest tests.test_service_live -v && bash tests/test_service_contract.sh`

Expected: all tests pass.

- [ ] **Step 5: Commit the parser slice**

```bash
git add package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd tests/test_service_live.py tests/fixtures/speedtest-jsonl-result.json
git commit -m "feat: parse Ookla live progress events"
```

### Task 2: Add the Asynchronous Router Job Lifecycle

**Files:**
- Create: `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd-worker`
- Modify: `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd`
- Modify: `tests/test_service_live.py`
- Modify: `tests/test_service_contract.sh`

- [ ] **Step 1: Write failing lifecycle tests**

Use a fake speedtest executable that prints `testStart`, ping, download,
upload, and result JSONL records with 50 ms gaps. Exercise the service as a
subprocess and assert:

```python
started = self.call({"method": "start_live", "server_id": "42"})
self.assertTrue(started["ok"])
self.assertRegex(started["job_id"], r"^[0-9a-f]{32}$")
states = self.poll_until_terminal(started["job_id"])
self.assertIn("download", [row.get("phase") for row in states])
self.assertEqual(states[-1]["state"], "complete")
self.assertEqual(states[-1]["result"]["server"]["id"], 42)

cancelled = self.call({"method": "cancel_live", "job_id": slow_job})
self.assertTrue(cancelled["ok"])
self.assertEqual(self.call({"method": "live_status", "job_id": slow_job})["state"], "cancelled")
```

Also assert invalid IDs return `invalid_job_id`, a second start returns
`busy`, terminal jobs expire after the configured ten-minute TTL, and a
cancelled job adds `outcome: cancelled` history excluded by analytics inputs.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `python3 -m unittest tests.test_service_live.LiveJobTests -v`

Expected: FAIL with `unknown_method` for `start_live`.

- [ ] **Step 3: Implement the detached worker**

The worker accepts only `--job-id`, `--server-id`, and configured environment
paths. It launches:

```python
cmd=[binary,'--accept-license','--format=jsonl','--progress=yes',
     '--progress-update-interval=500']
if server_id is not None:
 cmd += ['--server-id', str(server_id)]
```

For each valid line, merge the reduced sample into an in-memory state, append
at most 120 `{timestamp, value}` points per download/upload trace, and
atomically replace `jobs/<job-id>.json`. On result, write history and the
complete state. On timeout, malformed output, or nonzero exit, write a stable
terminal error. The worker holds and releases the existing global start lock.

- [ ] **Step 4: Implement start, status, cancel, and cleanup requests**

`start_live` validates terms and server ID, reserves the lock with a
`jobs/<job-id>.starting` marker, starts the worker with
`subprocess.Popen(..., start_new_session=True, close_fds=True)`, stores its PID,
and returns immediately. `live_status` reads only validated hex job IDs.
`cancel_live` verifies that `/proc/<pid>/cmdline` names the worker and job ID
before signaling it. Each live request deletes terminal state older than 600
seconds.

- [ ] **Step 5: Run lifecycle and regression tests**

Run: `python3 -m unittest tests.test_service_live -v && bash tests/test_service_contract.sh`

Expected: all tests pass, including cancellation and subsequent lock reuse.

- [ ] **Step 6: Commit the job lifecycle**

```bash
git add package/ookla-speedtest-webd/usr/libexec tests/test_service_live.py tests/test_service_contract.sh
git commit -m "feat: stream asynchronous router speed tests"
```

### Task 3: Expose Live RPC Methods in LuCI and GL.iNet

**Files:**
- Modify: `package/luci-app-ookla-speedtest-web/usr/libexec/rpcd/ookla-speedtest-web`
- Modify: `package/luci-app-ookla-speedtest-web/usr/share/rpcd/acl.d/luci-app-ookla-speedtest-web.json`
- Modify: `package/luci-app-ookla-speedtest-web/www/luci-static/resources/view/ookla-speedtest-web/main.js`
- Modify: `package/gl-app-ookla-speedtest-web/usr/lib/oui-httpd/rpc/ookla-speedtest-web`
- Modify: `tests/test_frontend_contract.js`
- Modify: `tests/test_package_layout.py`

- [ ] **Step 1: Write failing bridge contract assertions**

Require `start_live`, `live_status`, and `cancel_live` in the rpcd list output,
ACL write list, LuCI `specs`, GL Lua `M` functions, and GL request timeout map.
Require `live_status` to use a normal 30-second request timeout and
`start_live`/`cancel_live` not to inherit the legacy 130-second start timeout.

- [ ] **Step 2: Run bridge tests and verify RED**

Run: `node tests/test_frontend_contract.js && python3 -m unittest tests.test_package_layout -v`

Expected: FAIL because the live methods are absent.

- [ ] **Step 3: Add the three fixed method declarations**

Add these exact schemas to the LuCI rpcd adapter:

```python
'start_live': {'server_id': ''},
'live_status': {'job_id': ''},
'cancel_live': {'job_id': ''},
```

Add the same names to ACL, LuCI `specs`, and GL Lua:

```lua
function M.start_live(params) return invoke("start_live", params) end
function M.live_status(params) return invoke("live_status", params) end
function M.cancel_live(params) return invoke("cancel_live", params) end
```

- [ ] **Step 4: Run bridge and service contracts**

Run: `node tests/test_frontend_contract.js && python3 -m unittest tests.test_package_layout -v && bash tests/test_service_contract.sh`

Expected: all pass.

- [ ] **Step 5: Commit the RPC slice**

```bash
git add package/luci-app-ookla-speedtest-web package/gl-app-ookla-speedtest-web tests
git commit -m "feat: expose live speedtest RPC methods"
```

### Task 4: Build the Pure Gauge Model

**Files:**
- Create: `package/shared/ookla-speedtest-web/gauge.js`
- Create: `tests/test_gauge.js`
- Modify: `package/shared/ookla-speedtest-web/index.html`
- Modify: `tests/test_frontend_contract.js`

- [ ] **Step 1: Write failing gauge model tests**

Test the CommonJS export and browser global with:

```javascript
assert.equal(gauge.scaleFor(0, 0), 10);
assert.equal(gauge.scaleFor(87, 50), 100);
assert.equal(gauge.scaleFor(624, 500), 1000);
assert.equal(gauge.scaleFor(20, 100), 100); // never shrink in a phase
assert.equal(gauge.angleFor(0, 500), -135);
assert.equal(gauge.angleFor(500, 500), 135);
assert.deepEqual(gauge.pushTrace([1,2],3,3),[1,2,3]);
assert.deepEqual(gauge.pushTrace([1,2,3],4,3),[2,3,4]);
```

- [ ] **Step 2: Run gauge tests and verify RED**

Run: `node tests/test_gauge.js`

Expected: FAIL because `gauge.js` does not exist.

- [ ] **Step 3: Implement the pure model**

Use a UMD wrapper exposing `SpeedtestGauge`. `scaleFor(value,current)` chooses
the first 1/2/5 × 10ⁿ value at least 20% above the sample and returns the larger
of it and `current`. `angleFor` clamps the ratio and maps it to `-135..135`.
`pushTrace` returns a new bounded array. `tracePath` maps samples into a fixed
SVG view box without emitting `NaN` or `Infinity`.

- [ ] **Step 4: Load the model before the application**

Add `<script src="gauge.js"></script>` immediately before `app.js`, and add a
frontend contract assertion that both scripts are present in that order.

- [ ] **Step 5: Run gauge and frontend contracts**

Run: `node tests/test_gauge.js && node tests/test_frontend_contract.js`

Expected: both pass.

- [ ] **Step 6: Commit the gauge model**

```bash
git add package/shared/ookla-speedtest-web/gauge.js package/shared/ookla-speedtest-web/index.html tests/test_gauge.js tests/test_frontend_contract.js
git commit -m "feat: add adaptive speed gauge model"
```

### Task 5: Implement the Reference-Matched Gauge UI

**Files:**
- Modify: `package/shared/ookla-speedtest-web/index.html`
- Modify: `package/shared/ookla-speedtest-web/styles.css`
- Modify: `package/shared/ookla-speedtest-web/app.js`
- Modify: `tests/test_frontend_contract.js`

- [ ] **Step 1: Write failing semantic UI contracts**

Assert the page contains `#live-gauge`, `#gauge-needle`, `#gauge-value`,
`#gauge-unit`, `#phase-label`, `#metric-download`, `#metric-upload`,
`#metric-ping`, `#metric-jitter`, `#metric-loss`, `#download-trace`,
`#upload-trace`, `#cancel-test`, a throttled `aria-live` node, and explicit
Router → Internet text. Assert CSS includes `prefers-reduced-motion`, cyan and
violet variables, and a narrow single-column breakpoint.

- [ ] **Step 2: Run frontend contracts and verify RED**

Run: `node tests/test_frontend_contract.js`

Expected: FAIL on missing gauge semantics.

- [ ] **Step 3: Add semantic dial and result markup**

Replace the static GO-only center with one `.test-stage` containing the top
metric strip, an SVG trace layer, an SVG semicircular dial, the numeric live
region, GO button, cancel button, server row, ISP/connection row, and result
panel container. Keep history, analytics, settings, About, server picker, and
terms dialog IDs stable.

- [ ] **Step 4: Add reference-matched styling**

Use a deep navy surface; cyan `--download`, violet `--upload`, muted ring and
text colors; a large centered 270-degree SVG dial; a transform-origin at the
needle hub; thin trace paths; an 860 px maximum stage; and single-column final
cards below 640 px. Under reduced motion, set needle and trace transitions to
`none`.

- [ ] **Step 5: Render all gauge phases from state**

Add `renderGauge()` that sets phase color, scale labels, needle transform,
numeric value, units, trace paths, top metrics, running/complete visibility,
and cancel visibility. The function receives only state and the pure gauge
model; it must not perform RPC calls.

- [ ] **Step 6: Run frontend and syntax tests**

Run: `node tests/test_frontend_contract.js && node --check package/shared/ookla-speedtest-web/app.js && node --check package/shared/ookla-speedtest-web/gauge.js`

Expected: all pass.

- [ ] **Step 7: Commit the UI shell**

```bash
git add package/shared/ookla-speedtest-web tests/test_frontend_contract.js
git commit -m "feat: render Ookla-inspired live gauge"
```

### Task 6: Drive Router Gauges from Real Polled Samples

**Files:**
- Modify: `package/shared/ookla-speedtest-web/app.js`
- Create: `tests/test_frontend_live.js`

- [ ] **Step 1: Write failing frontend state-machine tests**

Run `app.js` in a minimal fake DOM/adapter harness. Queue status payloads for
ping, download, upload, and complete, then assert:

```javascript
await app.internetTest();
assert.deepEqual(calls.map(x => x.method).slice(0,2), ['start_live','live_status']);
assert.equal(app.state.phase,'complete');
assert.equal(app.state.results.internet.download_mbps,296.73);
assert.ok(app.state.traces.download.length > 0);
```

Use fake timers to assert 500 ms polling, bounded backoff after two transient
failures, terminal failure after the retry limit, and `cancel_live` with the
active job ID.

- [ ] **Step 2: Run live frontend tests and verify RED**

Run: `node tests/test_frontend_live.js`

Expected: FAIL because internet tests still call synchronous `runTest`.

- [ ] **Step 3: Add the explicit frontend state machine**

Extend state with `phase`, `progress`, `gaugeValue`, `gaugeUnit`, `gaugeScale`,
`traces`, `activeJob`, `cancelRequested`, and `pollFailures`. Add
`applyLiveStatus(payload)` and allow only:

```text
idle -> ping -> download -> upload -> complete
ping|download|upload -> cancelled|error
```

Ignore stale responses whose job ID no longer matches `activeJob`.

- [ ] **Step 4: Replace internetTest with start/poll flow**

Call `start_live`, save `job_id`, poll `live_status` every 500 ms, append only
real samples, and resolve after terminal complete. Retry transient transport
errors at 500, 1000, and 2000 ms; then enter error. `cancelTest()` sets the
local cancellation flag immediately and calls `cancel_live` once.

- [ ] **Step 5: Run state-machine and existing frontend tests**

Run: `node tests/test_frontend_live.js && node tests/test_frontend_contract.js`

Expected: all pass.

- [ ] **Step 6: Commit live router rendering**

```bash
git add package/shared/ookla-speedtest-web/app.js tests/test_frontend_live.js
git commit -m "feat: animate router tests from live samples"
```

### Task 7: Stream Local Samples and Sequence Both Mode

**Files:**
- Modify: `package/shared/ookla-speedtest-web/app.js`
- Modify: `tests/test_frontend_live.js`
- Modify: `tests/test_service_contract.sh`

- [ ] **Step 1: Write failing local and Both tests**

Assert local calls occur in ping → download batches → upload batches →
`record_local` order, the gauge receives more than one real throughput sample,
cancellation stops new batches, and Both does not call `start_live` until the
local Promise has resolved. Assert final results retain separate `local` and
`internet` objects.

- [ ] **Step 2: Run the targeted tests and verify RED**

Run: `node tests/test_frontend_live.js`

Expected: FAIL because local transfers use one aggregate `Promise.all` and Both
starts both paths concurrently.

- [ ] **Step 3: Implement rolling local batches**

Measure three latency requests and use the median. Run bounded groups of eight
32 KiB requests for at least three seconds per transfer phase, calculate each
batch's Mbps from completed bytes and elapsed time, and pass each sample to
`applyLocalSample`. Stop after the measurement window or immediately after
`cancelRequested`. Record only the aggregate completed result.

- [ ] **Step 4: Make Both sequential**

Change `executeMode('both')` to await `localTest()` and then `internetTest()`.
Reset per-phase traces but retain completed local results before starting the
internet phase. A failure identifies its path and retains the earlier completed
path panel.

- [ ] **Step 5: Run local, Both, and service tests**

Run: `node tests/test_frontend_live.js && bash tests/test_service_contract.sh`

Expected: all pass.

- [ ] **Step 6: Commit local and Both behavior**

```bash
git add package/shared/ookla-speedtest-web/app.js tests/test_frontend_live.js tests/test_service_contract.sh
git commit -m "feat: stream local tests and sequence both paths"
```

### Task 8: Complete Results, History, Errors, and Accessibility

**Files:**
- Modify: `package/shared/ookla-speedtest-web/app.js`
- Modify: `package/shared/ookla-speedtest-web/index.html`
- Modify: `package/shared/ookla-speedtest-web/styles.css`
- Modify: `tests/test_frontend_live.js`
- Modify: `tests/test_frontend_contract.js`

- [ ] **Step 1: Write failing completion/error/accessibility tests**

Assert complete state restores GO while retaining top download/upload values,
ping, jitter, loss, server, ISP, interface/VPN callout, and traces. Assert Both
renders two labeled panels. Assert cancelled history rows display Cancelled and
analytics filters `outcome !== 'success'`. Assert Retry restarts the failed
mode, phase announcements are throttled, and reduced-motion CSS exists.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node tests/test_frontend_live.js && node tests/test_frontend_contract.js`

Expected: FAIL on the first missing completion behavior.

- [ ] **Step 3: Implement final and failure rendering**

Render the reference-style top metric pair and trace lines above the restored
GO ring. Populate network metadata from the result, retain VPN warnings, add
Retry and phase-specific error text, display cancelled history entries, and
exclude non-success outcomes from analytics counts.

- [ ] **Step 4: Implement accessibility behavior**

Announce phase transitions once. Throttle numeric live-region changes to one
per second. Keep exact numbers visible outside the live region. Ensure GO,
cancel, mode, navigation, server, terms, and retry controls are native buttons
with focus-visible styles.

- [ ] **Step 5: Run all frontend checks**

Run: `node tests/test_gauge.js && node tests/test_frontend_live.js && node tests/test_frontend_contract.js && node --check package/shared/ookla-speedtest-web/app.js`

Expected: all pass without warnings.

- [ ] **Step 6: Commit the completed experience**

```bash
git add package/shared/ookla-speedtest-web tests
git commit -m "feat: finish live speedtest result experience"
```

### Task 9: Build, Install, Exercise, and Capture the Real UI

**Files:**
- Modify: `package/Makefile`
- Modify: `package/*/CONTROL/control`
- Modify: `install.sh`
- Modify: `tests/test_package_layout.py`
- Modify: `tests/test_build_web_ipks.py`
- Replace: `docs/screenshots/dashboard.png`
- Create: `docs/screenshots/live-download.png`
- Create: `docs/screenshots/final-results.png`
- Modify: `README.md`

- [ ] **Step 1: Bump the package version consistently**

Increment the current patch version in `PKG_VERSION`, all three control files,
the installer, and exact-version tests. Run:

`python3 -m unittest tests.test_package_layout tests.test_build_web_ipks -v`

Expected: PASS with the new version and three deterministic IPKs.

- [ ] **Step 2: Run the complete local verification suite**

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
bash tests/test_service_contract.sh
node tests/test_gauge.js
node tests/test_frontend_live.js
node tests/test_frontend_contract.js
bash tests/install-test.sh
bash tests/goodcloud-contract-test.sh
node --check package/shared/ookla-speedtest-web/gauge.js
node --check package/shared/ookla-speedtest-web/app.js
python3 -m py_compile package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd-worker
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 3: Build and inspect all IPKs**

Run `python3 scripts/build_web_ipks.py "$release_dir"`, list each archive, and
verify the service IPK contains the worker while the GL IPK contains the Lua
bridge as mode 0644.

- [ ] **Step 4: Install the exact build on the GL.iNet router**

Copy all three IPKs to `100.66.177.126`, install with `opkg install
--force-reinstall`, reload nginx/rpcd, and verify the installed versions and
file modes.

- [ ] **Step 5: Exercise all modes in the actual Applications view**

Use the existing authenticated Chromium/CDP session to run Device → Router,
Router → Internet, and Both. During each phase, sample the DOM at least twice
and prove the numeric value and needle transform changed. Cancel one additional
test and prove a later test can acquire the lock. Confirm the app remains
usable through the authenticated GL route without a new listener.

- [ ] **Step 6: Capture and install real screenshots**

Capture the actual idle, live download, and final Both states from the installed
interface. Replace the README screenshot with these files and state that they
come from the shipped GL.iNet view.

- [ ] **Step 7: Re-run final tests and commit release content**

Run the complete suite from Step 2, then:

```bash
git add package install.sh tests README.md docs/screenshots
git commit -m "release: publish live speed gauges"
```

### Task 10: Publish Main, Release, and Signed Feed

**Files:**
- No additional source files unless CI exposes a defect.

- [ ] **Step 1: Push commits directly to main**

Run `git push origin HEAD:main` and verify the remote main SHA equals local
HEAD.

- [ ] **Step 2: Monitor the main Test workflow**

Use the repository workflow monitor required by the GitHub workflow skill. If
it is unavailable, use read-only `gh run` inspection. Do not tag until the main
test concludes successfully.

- [ ] **Step 3: Tag and publish the incremented version**

Create an annotated `v<version>` tag, push it, and monitor both Test and Release
web app workflows. Verify the release contains three versioned IPKs and
`install.sh`.

- [ ] **Step 4: Refresh the signed feed**

Dispatch `Publish signed OpenWrt feed` in `keithah/openwrt-packages`, wait for
build and Pages deployment success, and confirm `Packages.gz` lists the new
versions.

- [ ] **Step 5: Upgrade through the public one-line installer**

On `100.66.177.126`, run:

```sh
wget -qO- https://keithah.github.io/openwrt-packages/install-ookla-speedtest-web.sh | sh
```

Verify the CLI and all three web packages, reload the Applications page, run a
final Device → Router test, clear test-only history, and confirm the rendered
page is nonblank.
