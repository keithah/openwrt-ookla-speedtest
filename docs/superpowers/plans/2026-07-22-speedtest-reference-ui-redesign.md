# Speedtest Reference UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current gauge and page composition with an original, ad-free Speedtest.net-inspired interface that fluidly tracks real Router → Internet and Device → Router measurements and presents both paths separately.

**Architecture:** Keep the package dependency-free and split the shared browser code into a test controller (`app.js`), gauge model/animator (`gauge.js`), result/network renderers (`results.js`), and supporting view renderers (`views.js`). The OpenWrt worker will emit real Ookla progress at 100 ms; the visible frontend will poll at 100 ms and retarget a requestAnimationFrame-driven 200 ms needle animation. LuCI, GL.iNet Applications, and GoodCloud continue to load the same static assets and authenticated RPC service.

**Tech Stack:** ES5-compatible browser JavaScript, SVG, CSS, Python 3 router service, OpenWrt Makefiles/IPKs, Node.js contract tests, Python `unittest`, shell integration tests, Chromium CDP, ffmpeg.

## Global Constraints

- Display `OpenWrt Ookla Speedtest (Unofficial)` and do not copy Ookla logos, source code, web assets, advertisements, surveys, or trackers.
- Author all SVG, CSS, icons, gradients, copy, animation logic, and screenshots in this repository.
- Keep Router → Internet, Device → Router, and Both; Both runs local first and internet second and never combines their values.
- Keep the Ookla CLI binary in the separate `ookla-speedtest-cli` dependency; never add a vendor archive or executable to this repository or an IPK.
- Use a 286 × 286 SVG, 130 px radius, 23 px arc, 270-degree sweep, 85 px tapered hubless needle, 20 px base, and 10 px tip.
- Use throughput labels `0, 5, 10, 50, 100, 250, 500, 750, 1000 Mbps` and ping labels `0, 5, 10, 20, 50, 100, 250, 500 ms`.
- Track real targets over 200 ms with ease-out and reset between phases over 500 ms with ease-in-out; never synthesize samples, overshoot, bounce, or keep moving after a real target settles.
- Use 100 ms CLI progress output and 100 ms frontend polling only while the test page is visible; animate locally with `requestAnimationFrame`.
- Terms acceptance gates Router → Internet and Both, but never Device → Router alone.
- Clearly identify the measured path, ISP, WAN type, server, and a named or cautious generic VPN/proxy context.
- Preserve authenticated LuCI, GL.iNet Applications, and GoodCloud access without opening a listener or port.
- Respect `prefers-reduced-motion`, keyboard navigation, visible focus, textual phase cues, throttled live announcements, and narrow embedded layouts.
- Release the redesign as package version `1.3.0`, capture documentation from the installed router UI, publish the signed feed, and push directly to `main` only after verification.

---

### Task 1: Fixed nonlinear gauge model and retargetable needle animator

**Files:**
- Modify: `package/shared/ookla-speedtest-web/gauge.js`
- Modify: `tests/test_gauge.js`

**Interfaces:**
- Consumes: numeric real samples and phase names `ping`, `download`, or `upload`.
- Produces: `SpeedtestGauge.labelsFor(phase)`, `SpeedtestGauge.angleFor(value, phase)`, `SpeedtestGauge.createAnimator(writeAngle, options)`, and the retained `pushTrace`/`tracePath` helpers.

- [ ] **Step 1: Replace adaptive-scale assertions with fixed nonlinear mapping tests**

Add these exact expectations to `tests/test_gauge.js` and remove the old `scaleFor` assertions:

```javascript
assert.deepEqual(gauge.labelsFor('download'), [0, 5, 10, 50, 100, 250, 500, 750, 1000]);
assert.deepEqual(gauge.labelsFor('upload'), [0, 5, 10, 50, 100, 250, 500, 750, 1000]);
assert.deepEqual(gauge.labelsFor('ping'), [0, 5, 10, 20, 50, 100, 250, 500]);
assert.equal(gauge.angleFor(0, 'download'), -135);
assert.equal(gauge.angleFor(5, 'download'), -101.25);
assert.equal(gauge.angleFor(30, 'download'), -50.625);
assert.equal(gauge.angleFor(1000, 'download'), 135);
assert.equal(gauge.angleFor(2000, 'download'), 135);
assert.equal(gauge.angleFor(20, 'ping'), -19.285714285714292);
assert.equal(gauge.angleFor(-1, 'ping'), -135);
assert.equal(gauge.angleFor(NaN, 'download'), -135);
```

Add a deterministic animation test with a fake clock:

```javascript
const frames = [];
let now = 0;
let queued = null;
const animator = gauge.createAnimator(angle => frames.push(angle), {
  now: () => now,
  requestFrame: callback => { queued = callback; return 1; },
  cancelFrame: () => { queued = null; },
  reducedMotion: () => false
});
animator.jump(-135);
animator.track(45);
now = 100; queued(now);
assert.ok(frames.at(-1) > -135 && frames.at(-1) < 45);
animator.track(90); // retarget from the rendered angle, not the old endpoint
now = 200; queued(now);
assert.ok(frames.at(-1) > frames.at(-2) && frames.at(-1) < 90);
now = 300; queued(now);
assert.equal(frames.at(-1), 90);
animator.reset();
now = 550; queued(now);
assert.ok(frames.at(-1) < 90 && frames.at(-1) > -135);
now = 800; queued(now);
assert.equal(frames.at(-1), -135);
```

- [ ] **Step 2: Run the gauge tests and confirm the old implementation fails**

Run: `node tests/test_gauge.js`

Expected: FAIL because `labelsFor` and `createAnimator` do not exist and `angleFor` still expects an adaptive maximum.

- [ ] **Step 3: Implement the fixed scale and animation API**

Replace `scaleFor`/linear `angleFor` in `gauge.js` with:

```javascript
var SPEED_LABELS = [0, 5, 10, 50, 100, 250, 500, 750, 1000];
var PING_LABELS = [0, 5, 10, 20, 50, 100, 250, 500];
var START_ANGLE = -135;
var SWEEP = 270;

function labelsFor(phase) {
  return (phase === 'ping' ? PING_LABELS : SPEED_LABELS).slice();
}

function angleFor(value, phase) {
  var labels = labelsFor(phase);
  var sample = Math.max(0, finite(value, 0));
  if (sample >= labels[labels.length - 1]) return START_ANGLE + SWEEP;
  var index = 0;
  while (index + 1 < labels.length && sample > labels[index + 1]) index += 1;
  var low = labels[index], high = labels[index + 1];
  var segment = high === low ? 0 : (sample - low) / (high - low);
  return START_ANGLE + (index + segment) / (labels.length - 1) * SWEEP;
}

function createAnimator(writeAngle, supplied) {
  var options = supplied || {};
  var now = options.now || function() { return performance.now(); };
  var requestFrame = options.requestFrame || function(callback) { return requestAnimationFrame(callback); };
  var cancelFrame = options.cancelFrame || function(id) { cancelAnimationFrame(id); };
  var reducedMotion = options.reducedMotion || function() { return false; };
  var rendered = START_ANGLE, frame = null, generation = 0;
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }
  function move(target, duration, easing) {
    generation += 1;
    var token = generation, start = rendered, started = now();
    if (frame !== null) cancelFrame(frame);
    if (reducedMotion()) { rendered = target; writeAngle(rendered); frame = null; return; }
    function tick(timestamp) {
      if (token !== generation) return;
      var progress = Math.max(0, Math.min(1, (timestamp - started) / duration));
      rendered = start + (target - start) * easing(progress);
      writeAngle(rendered);
      frame = progress < 1 ? requestFrame(tick) : null;
    }
    frame = requestFrame(tick);
  }
  return {
    jump: function(angle) { generation += 1; if (frame !== null) cancelFrame(frame); frame = null; rendered = angle; writeAngle(angle); },
    track: function(angle) { move(angle, 200, easeOut); },
    reset: function() { move(START_ANGLE, 500, easeInOut); },
    current: function() { return rendered; }
  };
}
```

Export `labelsFor`, `angleFor`, and `createAnimator`; retain the bounded trace helpers unchanged.

- [ ] **Step 4: Run the model test**

Run: `node tests/test_gauge.js`

Expected: `gauge model ok`.

- [ ] **Step 5: Commit the isolated model change**

```bash
git add package/shared/ookla-speedtest-web/gauge.js tests/test_gauge.js
git commit -m "feat: model reference speedtest gauge"
```

### Task 2: Reference gauge markup and ad-free page shell

**Files:**
- Modify: `package/shared/ookla-speedtest-web/index.html`
- Modify: `package/shared/ookla-speedtest-web/styles.css`
- Modify: `tests/test_frontend_contract.js`

**Interfaces:**
- Consumes: the gauge angles and phase attributes supplied by Task 1 and `app.js`.
- Produces: stable DOM IDs for the controller, exact SVG geometry, navigation, mode control, metrics strip, network context, server action, and result stage.

- [ ] **Step 1: Write failing structural and geometry assertions**

Update `tests/test_frontend_contract.js` to require:

```javascript
for (const id of ['app-title','path-badge','nav-history','nav-analytics','nav-settings','nav-about',
  'mode-picker','metric-ping','metric-download','metric-upload','live-gauge','gauge-track',
  'gauge-progress','gauge-needle','gauge-value','gauge-unit','network-context','server-picker',
  'go-control','cancel-test','results']) assert.match(html, new RegExp(`id=["']${id}["']`));
assert.match(html, /viewBox=["']0 0 286 286["']/);
assert.match(html, /<path id=["']gauge-needle["'] class=["']gauge-needle["'] d=["']M133 143 L138 58 L148 143 Z["']/);
assert.match(css, /\.gauge-shell\s*\{[^}]*width:\s*286px;[^}]*height:\s*286px/s);
assert.match(css, /\.gauge-track[^}]*stroke-width:\s*23/);
assert.doesNotMatch(html, /<circle[^>]+(?:hub|needle)/i);
assert.match(html, /OpenWrt Ookla Speedtest/);
assert.match(html, /UNOFFICIAL/i);
assert.doesNotMatch(html, /advert|survey/i);
```

- [ ] **Step 2: Run the frontend contract and observe the geometry failure**

Run: `node tests/test_frontend_contract.js`

Expected: FAIL on the 460 × 390 viewBox, line-and-circle needle, and missing icon-nav IDs.

- [ ] **Step 3: Replace the main test-stage markup**

Use this SVG core inside the centered gauge shell:

```html
<div id="live-gauge" class="gauge-shell" data-phase="idle" data-status="idle" aria-busy="false">
  <svg id="gauge-dial" viewBox="0 0 286 286" role="img" aria-labelledby="phase-label gauge-value gauge-unit" hidden>
    <defs>
      <linearGradient id="download-gradient"><stop stop-color="#29d3c2"/><stop offset="1" stop-color="#36a7ff"/></linearGradient>
      <linearGradient id="upload-gradient"><stop stop-color="#855cff"/><stop offset="1" stop-color="#ef5ad7"/></linearGradient>
      <linearGradient id="ping-gradient"><stop stop-color="#4cc9ff"/><stop offset="1" stop-color="#5d86ff"/></linearGradient>
    </defs>
    <path id="gauge-track" class="gauge-track" pathLength="100"></path>
    <path id="gauge-progress" class="gauge-progress" pathLength="100"></path>
    <g id="gauge-labels" class="gauge-labels" aria-hidden="true"></g>
    <path id="gauge-needle" class="gauge-needle" d="M133 143 L138 58 L148 143 Z" aria-hidden="true"></path>
  </svg>
  <div id="gauge-readout" class="gauge-readout" hidden>
    <span id="phase-label">Ready</span><strong id="gauge-value">0</strong><small id="gauge-unit">Mbps</small>
  </div>
  <button id="go-control" class="go" aria-label="Start Router to Internet test">GO</button>
  <button id="cancel-test" class="cancel" hidden>Cancel test</button>
</div>
```

Use `d="M51.076 234.924 A130 130 0 1 1 234.924 234.924"` for both
track and progress paths: this is a clockwise 270-degree arc with a 130 px
radius centered at `(143,143)`. Add `id="mode-picker"`, the four named nav
buttons with inline original SVG icons, a `path-badge`, three primary metrics,
`network-context`, and the existing server/result controls. Keep terms dialog
IDs and all controller-required IDs.

- [ ] **Step 4: Replace the old gauge and page CSS**

Define the shared geometry and state styling exactly once:

```css
:root { --canvas:#070a0d; --panel:#10151b; --ink:#f7fafc; --muted:#8794a1; --line:#26313b; --download:#29d3c2; --upload:#b26cff; --ping:#4cc9ff; }
body { margin:0; min-height:100vh; color:var(--ink); background:var(--canvas); font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
.gauge-shell { position:relative; width:286px; height:286px; max-width:calc(100vw - 40px); aspect-ratio:1; margin:18px auto; }
.gauge-shell > svg { width:100%; height:100%; overflow:visible; }
.gauge-track,.gauge-progress { fill:none; stroke-width:23; stroke-linecap:round; }
.gauge-track { stroke:#202932; }
.gauge-shell[data-phase="download"] .gauge-progress { stroke:url(#download-gradient); }
.gauge-shell[data-phase="upload"] .gauge-progress { stroke:url(#upload-gradient); }
.gauge-shell[data-phase="ping"] .gauge-progress { stroke:url(#ping-gradient); }
.gauge-needle { fill:var(--ink); transform-origin:143px 143px; transform-box:view-box; }
.gauge-readout { position:absolute; left:50%; bottom:16px; display:grid; justify-items:center; transform:translateX(-50%); }
.gauge-readout strong { font:400 36px/1 ui-monospace,SFMono-Regular,monospace; font-variant-numeric:tabular-nums; }
.gauge-readout small { margin-top:5px; color:var(--muted); letter-spacing:.11em; text-transform:uppercase; }
@media (max-width:520px) { .metrics-strip,.final-result { grid-template-columns:1fr; } .gauge-shell { width:min(286px,calc(100vw - 56px)); height:auto; } }
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; animation-duration:.01ms!important; animation-iteration-count:1!important; transition-duration:.01ms!important; } }
```

Add the disc→ring→arc state classes, 80 ms label stagger, compact final GO ring, responsive final grid, visible `:focus-visible`, icon tooltips, and embedded-view overflow protection. Do not add a CSS transition to `.gauge-needle`; Task 1 owns needle timing.

- [ ] **Step 5: Run the frontend contract**

Run: `node tests/test_frontend_contract.js`

Expected: `frontend contract ok`.

- [ ] **Step 6: Commit the page shell**

```bash
git add package/shared/ookla-speedtest-web/index.html package/shared/ookla-speedtest-web/styles.css tests/test_frontend_contract.js
git commit -m "feat: build ad-free reference test stage"
```

### Task 3: Results and supporting-view renderer modules

**Files:**
- Create: `package/shared/ookla-speedtest-web/results.js`
- Create: `package/shared/ookla-speedtest-web/views.js`
- Modify: `package/shared/ookla-speedtest-web/index.html`
- Modify: `tests/test_frontend_render.js`
- Modify: `tests/test_frontend_contract.js`

**Interfaces:**
- Consumes: normalized result objects, history rows, selected mode, network context, and a DOM document.
- Produces: `SpeedtestResults.render(container, mode, results)`, `SpeedtestResults.networkSummary(result)`, `SpeedtestViews.render(container, view, state, actions)`, and path-separated final/history/analytics markup.

- [ ] **Step 1: Add failing renderer tests**

Require the modules and assert these outputs in `tests/test_frontend_render.js`:

```javascript
const Results = require(path.join(root, 'results.js'));
assert.equal(Results.networkSummary({ network_context:{ vpn:true, vpn_kind:'tailscale-exit', vpn_name:'Tailscale' } }),
  'Router → Internet via Tailscale exit node');
assert.equal(Results.networkSummary({ network_context:{ vpn:true, vpn_kind:'speedify', vpn_name:'Speedify' } }),
  'Router → Internet via Speedify');
assert.equal(Results.networkSummary({ network_context:{ possible_vpn:true } }),
  'Router → Internet via possible VPN/proxy path');
assert.equal(Results.networkSummary({ network_context:{ vpn:false } }),
  'Router → Internet via direct WAN path');
```

Render Both and assert two headings, independent values, and the local warning:

```javascript
Results.render(nodes.results, 'both', {
  local:{ download_mbps:640, upload_mbps:510, ping_ms:2 },
  internet:{ download_mbps:920, upload_mbps:850, ping_ms:4, isp:'Sonic', server:{name:'San Jose'} }
});
assert.match(nodeText(nodes.results), /Device → Router/);
assert.match(nodeText(nodes.results), /640/);
assert.match(nodeText(nodes.results), /not a public internet speed/i);
assert.match(nodeText(nodes.results), /Router → Internet/);
assert.match(nodeText(nodes.results), /920/);
assert.match(nodeText(nodes.results), /Sonic/);
```

- [ ] **Step 2: Run render tests and confirm the modules are missing**

Run: `node tests/test_frontend_render.js`

Expected: FAIL with `Cannot find module ... results.js`.

- [ ] **Step 3: Implement the result renderer**

Use a UMD wrapper matching `gauge.js`. Export `networkSummary` and `render`. The network mapping must be:

```javascript
function networkSummary(result) {
  var context = result && result.network_context || {};
  if (context.vpn_kind === 'tailscale-exit') return 'Router → Internet via Tailscale exit node';
  if (context.vpn_kind === 'speedify') return 'Router → Internet via Speedify';
  if (context.vpn === true) return 'Router → Internet via ' + (context.vpn_name || 'VPN tunnel');
  if (context.possible_vpn === true) return 'Router → Internet via possible VPN/proxy path';
  return 'Router → Internet via direct WAN path';
}
```

`render` must construct elements with `textContent`, not result-derived HTML. A local section contains download/upload/ping and `Device → Router measures this browser's path to the router; it is not a public internet speed.` An internet section contains download/upload; idle/download/upload latency, jitter, and loss when present; ISP; WAN interface/type; server/sponsor/location; and `networkSummary`. Both appends local then internet into one `.final-result` surface.

- [ ] **Step 4: Implement the supporting views module**

`SpeedtestViews.render(container, view, state, actions)` will own History, Analytics, Settings, and About. History keeps mode badges and opens full results through `actions.openResult(row)`. Analytics filters successful records by `kind` before computing each series. Settings renders server preference, retention, display options, and terms status. About must include this exact explanatory copy:

```text
OpenWrt Ookla Speedtest (Unofficial) runs Router → Internet tests on the router through the separately installed Ookla CLI. The web packages do not contain the Ookla binary. Device → Router measures this browser's authenticated path to the router, not the public internet. GoodCloud opens this same authenticated router interface; the package does not expose another public service.
```

- [ ] **Step 5: Load modules before the controller and update asset contracts**

In `index.html`, use this order with the current package version query string
(`1.2.0` at this intermediate commit; Task 8 changes all assets to `1.3.0`):

```html
<script src="gauge.js?v=1.2.0"></script>
<script src="results.js?v=1.2.0"></script>
<script src="views.js?v=1.2.0"></script>
<script src="app.js?v=1.2.0"></script>
```

Update contract/build tests so `results.js` and `views.js` are required in both LuCI and GL.iNet IPKs.

- [ ] **Step 6: Run focused renderer and package tests**

Run:

```bash
node tests/test_frontend_render.js
node tests/test_frontend_contract.js
python3 -m unittest tests.test_package_layout tests.test_build_web_ipks -v
```

Expected: all pass.

- [ ] **Step 7: Commit the renderer split**

```bash
git add package/shared/ookla-speedtest-web/results.js package/shared/ookla-speedtest-web/views.js package/shared/ookla-speedtest-web/index.html tests/test_frontend_render.js tests/test_frontend_contract.js tests/test_package_layout.py tests/test_build_web_ipks.py
git commit -m "refactor: separate result and support views"
```

### Task 4: Real-sample animation, phase morphs, and 100 ms frontend polling

**Files:**
- Modify: `package/shared/ookla-speedtest-web/app.js`
- Modify: `tests/test_frontend_live.js`
- Modify: `tests/test_frontend_render.js`

**Interfaces:**
- Consumes: Task 1 gauge API, Task 2 DOM IDs, Task 3 renderer APIs, live RPC status, and local batch measurements.
- Produces: a single test controller whose rendered needle is independently animated from state, whose poll cadence is 100 ms while visible, and whose phase/reset/result transitions are deterministic.

- [ ] **Step 1: Extend the test harness with requestAnimationFrame and visibility**

Add a fake animation clock to the existing VM harness:

```javascript
let rafId = 0;
const rafs = new Map();
window.requestAnimationFrame = callback => { rafs.set(++rafId, callback); return rafId; };
window.cancelAnimationFrame = id => rafs.delete(id);
window.matchMedia = () => ({ matches:false, addEventListener(){} });
document.visibilityState = 'visible';
harness.stepFrame = at => { const callbacks=[...rafs.values()]; rafs.clear(); callbacks.forEach(fn => fn(at)); };
```

Add assertions that a real target does not jump instantly, reaches it at 200 ms, retargets from the displayed angle, returns to `-135` after 500 ms at a phase change, and jumps immediately under reduced motion.

- [ ] **Step 2: Change polling expectations from 500 ms to 100 ms**

For successful live polling assert call timestamps `[0, 100, 200]`. For retries assert `[0, 100, 600, 1600, 3600]`, preserving the existing bounded failure behavior after the first normal interval. Add a visibility test that changes `document.visibilityState` to `hidden`, dispatches `visibilitychange`, advances 1000 ms, and observes no status request until visibility becomes `visible` again.

- [ ] **Step 3: Run the live/render tests and confirm failures**

Run:

```bash
node tests/test_frontend_live.js
node tests/test_frontend_render.js
```

Expected: FAIL because render writes needle transforms directly, polling uses 500 ms, and the controller has no visibility pause.

- [ ] **Step 4: Integrate one animator instance into `app.js`**

Create it once after DOM readiness:

```javascript
var needleAnimator;
function createNeedleAnimator() {
  needleAnimator = SpeedtestGauge.createAnimator(function(angle) {
    var needle = el('gauge-needle');
    if (needle) needle.style.transform = 'rotate(' + angle + 'deg)';
  }, { reducedMotion:function() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } });
  needleAnimator.jump(-135);
}
```

`renderGauge` calls `needleAnimator.track(SpeedtestGauge.angleFor(state.gaugeValue, phase))` only when a new real sample/target is applied. On phase change it calls `needleAnimator.reset()`, waits for the phase-reset state without blocking measurement ingestion, then retargets the newest value. It builds scale labels from `labelsFor(phase)` around the SVG center and places the number at the gauge bottom. Remove `state.gaugeScale`, every `scaleFor` call, and CSS-driven needle transition logic.

- [ ] **Step 5: Implement phase morph and metric retention**

Track `renderedPhase` separately. Idle uses `data-shape="disc"`, preparation uses `ring`, and active phases use `arc`. Completed metrics stay visible in the top strip; only the active metric receives `aria-current="true"`. Both mode shows a short textual `Device → Router complete. Starting Router → Internet…` transition while resetting the needle.

- [ ] **Step 6: Implement visible-page 100 ms polling**

Use exact constants:

```javascript
var LIVE_POLL_MS = 100;
var RETRY_DELAYS = [500, 1000, 2000];
function nextPollDelay(failures) { return failures ? RETRY_DELAYS[Math.min(failures - 1, RETRY_DELAYS.length - 1)] : LIVE_POLL_MS; }
function waitUntilVisible() {
  if (document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise(function(resolve) {
    function visible() { if (document.visibilityState !== 'hidden') { document.removeEventListener('visibilitychange', visible); resolve(); } }
    document.addEventListener('visibilitychange', visible);
  });
}
```

The polling loop awaits `waitUntilVisible()` before both its delay and request. Preserve generation/job ownership checks and cancel wakeups.

- [ ] **Step 7: Delegate DOM composition to the new renderers**

Replace `resultCard`, `renderResults`, `renderHistory`, and `renderAnalytics` with calls to:

```javascript
SpeedtestResults.render(el('results'), state.mode, state.results);
SpeedtestViews.render(el('view'), state.view, state, {
  deleteHistory:function(id) { return checked('delete_history',{id:id}).then(loadHistory); },
  clearHistory:function() { return checked('clear_history',{}).then(loadHistory); },
  openResult:function(row) { state.selectedHistory=row; state.view='result'; render(); }
});
```

- [ ] **Step 8: Run frontend tests**

Run:

```bash
node tests/test_gauge.js
node tests/test_frontend_contract.js
node tests/test_frontend_render.js
node tests/test_frontend_live.js
```

Expected: all print their success message and exit zero.

- [ ] **Step 9: Commit the controller integration**

```bash
git add package/shared/ookla-speedtest-web/app.js tests/test_frontend_live.js tests/test_frontend_render.js
git commit -m "feat: animate real speedtest samples smoothly"
```

### Task 5: Faster worker events and precise VPN-path context

**Files:**
- Modify: `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd-worker`
- Modify: `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd`
- Modify: `tests/test_service_live.py`
- Modify: `tests/test_service_contract.sh`

**Interfaces:**
- Consumes: Ookla CLI JSONL events, OpenWrt interface/process/routing state, and the final result ISP.
- Produces: 100 ms real progress samples and normalized `network_context` keys `vpn`, `vpn_kind`, `vpn_name`, `possible_vpn`, and `note`.

- [ ] **Step 1: Write failing service tests**

Assert the worker command contains exactly `--progress-update-interval=100`. Add table-driven `network_context` tests by mocking interface names/process checks:

```python
cases = [
    ({"interfaces":["tailscale0"], "processes":["tailscaled"]}, (True,"tailscale-exit","Tailscale")),
    ({"interfaces":["speedify"], "processes":["speedify"]}, (True,"speedify","Speedify")),
    ({"interfaces":["wg0"], "processes":[]}, (True,"wireguard","WireGuard")),
    ({"interfaces":["tun0"], "processes":["openvpn"]}, (True,"openvpn","OpenVPN")),
    ({"interfaces":["wan"], "processes":[]}, (False,None,None)),
]
```

Also assert an otherwise-direct context becomes `possible_vpn:true` only when a normalized CLI ISP and router WAN ISP are both present and differ; missing ISP evidence must not trigger the warning.

- [ ] **Step 2: Run service tests and confirm failures**

Run:

```bash
python3 -m unittest tests.test_service_live -v
bash -x tests/test_service_contract.sh
```

Expected: FAIL on the 500 ms command and missing normalized context keys.

- [ ] **Step 3: Change the real CLI event interval**

Change only the fixed worker argument:

```python
"--progress-update-interval=100",
```

Retain selector timeout, maximum record size, bounded 120-sample trace arrays, atomic job writes, and process ownership unchanged.

- [ ] **Step 4: Normalize VPN detection**

Return one context shape. Interface precedence is Tailscale, Speedify, WireGuard, OpenVPN/tun/tap, then generic tunnel. Mark `tailscale-exit` only when router routing state shows the default path using `tailscale0`; otherwise use `tailscale`. Use these user-facing notes:

```python
labels = {
    "tailscale-exit": "Test reflects router traffic through a Tailscale exit node.",
    "tailscale": "Test reflects router traffic through Tailscale.",
    "speedify": "Test reflects router traffic through Speedify.",
    "wireguard": "Test reflects router traffic through WireGuard.",
    "openvpn": "Test reflects router traffic through OpenVPN.",
    "tunnel": "Test reflects router traffic through a VPN tunnel.",
}
```

Change the function signature to `network_context(result_isp=None)`. Read the
optional configured WAN provider with `uci -q get network.wan.provider`, pass
the CLI's `result["isp"]` from both synchronous and worker completion paths,
and compare normalized non-empty names. If they differ without a named tunnel,
return `possible_vpn:true` and `Possible VPN/proxy path: the public test
provider differs from the configured router WAN provider.` Missing configured
provider evidence never triggers this warning. Otherwise return `vpn:false`,
`possible_vpn:false`, and `No VPN path detected; test reflects the router WAN
path.`

- [ ] **Step 5: Run service tests**

Run:

```bash
python3 -m unittest tests.test_service_live -v
bash -x tests/test_service_contract.sh
```

Expected: all pass.

- [ ] **Step 6: Commit worker and network context changes**

```bash
git add package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd-worker package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd tests/test_service_live.py tests/test_service_contract.sh
git commit -m "feat: report fast samples and VPN paths"
```

### Task 6: Persisted server, mode, retention, and display settings

**Files:**
- Modify: `package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd`
- Modify: `package/luci-app-ookla-speedtest-web/usr/libexec/rpcd/ookla-speedtest-web`
- Modify: `package/luci-app-ookla-speedtest-web/usr/share/rpcd/acl.d/luci-app-ookla-speedtest-web.json`
- Modify: `package/gl-app-ookla-speedtest-web/usr/lib/oui-httpd/rpc/ookla-speedtest-web.lua`
- Modify: `package/shared/ookla-speedtest-web/app.js`
- Modify: `package/shared/ookla-speedtest-web/views.js`
- Modify: `tests/test_service_contract.sh`
- Modify: `tests/test_package_layout.py`
- Modify: `tests/test_frontend_live.js`

**Interfaces:**
- Consumes: authenticated fixed-shape RPC calls and the Settings/server UI from earlier tasks.
- Produces: `settings` fields `default_mode`, `server_id`, `history_retention`, and `motion`; `save_settings` with the same validated fields; persisted manual/automatic server selection; and bounded history matching the saved retention.

- [ ] **Step 1: Write failing service and bridge contracts**

Require `save_settings` in rpcd, ACL, and GL.iNet bridges with only these string
parameters:

```json
{"default_mode":"", "server_id":"", "history_retention":"", "motion":""}
```

Exercise the service with:

```sh
printf '%s\n' '{"method":"save_settings","default_mode":"both","server_id":"42","history_retention":"50","motion":"full"}' | "$SVC" | grep -q '"ok":true'
printf '%s\n' '{"method":"settings"}' | "$SVC" | grep -q '"default_mode":"both"'
printf '%s\n' '{"method":"save_settings","default_mode":"invalid"}' | "$SVC" | grep -q 'invalid_settings'
```

Add a retention test that stores 51 completed records after selecting `50` and
asserts the history response contains exactly 50 newest records.

- [ ] **Step 2: Run service/package contracts and confirm failure**

Run:

```bash
bash -x tests/test_service_contract.sh
python3 -m unittest tests.test_package_layout -v
```

Expected: FAIL because `save_settings` is not exposed.

- [ ] **Step 3: Implement atomic settings storage and validation**

Store `/etc/ookla-speedtest-webd/settings.json` through the service's existing
atomic JSON writer. Defaults and allowed values are:

```python
DEFAULT_SETTINGS = {"default_mode":"router-internet", "server_id":"", "history_retention":100, "motion":"system"}
ALLOWED_MODES = ("router-internet", "device-router", "both")
ALLOWED_RETENTION = (25, 50, 100, 250)
ALLOWED_MOTION = ("system", "full", "reduced")
```

Accept an empty or decimal numeric server ID, reject IDs longer than 20 digits,
merge only supplied fields, and write the complete validated object atomically.
`settings` returns these fields plus `terms_accepted`. `append_history` reads
the saved retention and keeps the newest configured number of records.

- [ ] **Step 4: Expose the fixed API through both platform bridges**

Add `save_settings` to rpcd's method table and write ACL, and implement the GL
bridge as:

```lua
function M.save_settings(params) return invoke("save_settings", params) end
```

Do not expose arbitrary UCI keys or shell arguments.

- [ ] **Step 5: Persist frontend choices**

On startup, apply settings before the first render. Server picker selections
call `save_settings` with the numeric ID; Reset to Automatic sends an empty ID.
Settings controls call `save_settings`, then replace local state with the
validated response. `motion:"reduced"` forces direct needle updates,
`motion:"full"` permits animation unless the browser accessibility preference
requires reduced motion, and `motion:"system"` follows the browser preference.

- [ ] **Step 6: Run focused settings tests**

Run:

```bash
bash -x tests/test_service_contract.sh
python3 -m unittest tests.test_package_layout -v
node tests/test_frontend_live.js
```

Expected: all pass.

- [ ] **Step 7: Commit persisted settings**

```bash
git add package/ookla-speedtest-webd/usr/libexec/ookla-speedtest-webd package/luci-app-ookla-speedtest-web/usr/libexec/rpcd/ookla-speedtest-web package/luci-app-ookla-speedtest-web/usr/share/rpcd/acl.d/luci-app-ookla-speedtest-web.json package/gl-app-ookla-speedtest-web/usr/lib/oui-httpd/rpc/ookla-speedtest-web.lua package/shared/ookla-speedtest-web/app.js package/shared/ookla-speedtest-web/views.js tests/test_service_contract.sh tests/test_package_layout.py tests/test_frontend_live.js
git commit -m "feat: persist speedtest web settings"
```

### Task 7: Accessibility, responsive layout, terms, and full frontend behavior

**Files:**
- Modify: `package/shared/ookla-speedtest-web/app.js`
- Modify: `package/shared/ookla-speedtest-web/results.js`
- Modify: `package/shared/ookla-speedtest-web/views.js`
- Modify: `package/shared/ookla-speedtest-web/styles.css`
- Modify: `tests/test_frontend_live.js`
- Modify: `tests/test_frontend_render.js`
- Modify: `tests/test_frontend_contract.js`

**Interfaces:**
- Consumes: completed UI/controller modules from Tasks 1–5.
- Produces: the complete keyboard, reduced-motion, terms, server-selection, Both-mode, error, history, analytics, settings, and About experience.

- [ ] **Step 1: Add failing user-flow assertions**

Cover these exact contracts:

```javascript
// Terms: local starts directly; internet and Both open the dialog before start_live.
// Server: selected server ID is sent to start_live and remains selected after render.
// Both: local result remains visible during the internet phase and two final sections remain separate.
// VPN: named, generic, possible, and direct messages are all visibly different.
// Accessibility: phase announces once; numeric samples remain throttled to 1000 ms.
// Keyboard: icon nav, mode buttons, GO, Cancel, Retry, Change Server, and dialog actions are buttons with accessible names.
// Responsive: final and metric sections stack at 520 px and neither body nor embedded app permits horizontal overflow.
```

Add static assertions for `aria-current`, `aria-pressed`, `aria-live`, `aria-atomic`, `role="dialog"`/native dialog labeling, `:focus-visible`, and `prefers-reduced-motion`.

- [ ] **Step 2: Run all frontend tests and confirm the new assertions fail**

Run:

```bash
node tests/test_frontend_contract.js
node tests/test_frontend_render.js
node tests/test_frontend_live.js
```

Expected: FAIL only on the newly added behavior contracts.

- [ ] **Step 3: Complete the interaction states**

Keep existing generation-token cancellation semantics. Apply `aria-current="true"` only to the active metric and remove it elsewhere. Change the GO label to `RETEST` only in complete/cancel/error states while retaining the accessible name `Run <selected path> test again`. During Both, keep `state.results.local` when resetting measurements for internet. Declining/cancelling terms returns to idle with Device → Router still usable.

- [ ] **Step 4: Finish keyboard and screen-reader behavior**

Each icon button contains an SVG with `aria-hidden="true"` and a visible-on-focus tooltip. Keep phase announcements immediate and numeric announcements at the existing 1000 ms throttle. Do not announce each 100 ms sample. Move focus to the terms heading when opened, to the server search when opened, and to the result heading after completion. Restore focus to the invoking control when a dialog/panel closes.

- [ ] **Step 5: Finish narrow and embedded CSS**

At `max-width:520px`, stack metric/final columns, retain at least 44 × 44 px controls, scale the gauge via `min(286px, calc(100vw - 56px))`, wrap server details, and set `html,body,#app { max-width:100%; overflow-x:hidden; }`. At wider sizes center the result stage with a readable maximum width and preserve the 286 px gauge dimensions.

- [ ] **Step 6: Run frontend and GoodCloud contracts**

Run:

```bash
node tests/test_frontend_contract.js
node tests/test_frontend_render.js
node tests/test_frontend_live.js
bash -x tests/goodcloud-contract-test.sh
```

Expected: all pass.

- [ ] **Step 7: Commit the complete experience**

```bash
git add package/shared/ookla-speedtest-web/app.js package/shared/ookla-speedtest-web/results.js package/shared/ookla-speedtest-web/views.js package/shared/ookla-speedtest-web/styles.css tests/test_frontend_contract.js tests/test_frontend_render.js tests/test_frontend_live.js
git commit -m "feat: polish complete speedtest experience"
```

### Task 8: Version 1.3.0, package assets, and repository verification

**Files:**
- Modify: `package/Makefile`
- Modify: `package/shared/ookla-speedtest-web/index.html`
- Modify: `install.sh`
- Modify: `tests/test_build_web_ipks.py`
- Modify: `tests/test_package_layout.py`
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: all implementation commits.
- Produces: deterministic version `1.3.0-1` IPKs containing every new frontend module and no Ookla binary.

- [ ] **Step 1: Add failing package-asset expectations**

Require all IPKs and shared roots to contain `index.html`, `styles.css`, `gauge.js`, `results.js`, `views.js`, and `app.js`. Require every HTML asset query to be `?v=1.3.0`; require package version `1.3.0`, release `1`, architecture `all`; and reject `.tgz`, `.tar.gz`, vendor executables, keys, listeners, or bundled Speedtest archives.

- [ ] **Step 2: Run package tests and confirm the version/asset failure**

Run:

```bash
python3 -m unittest tests.test_package_layout tests.test_build_web_ipks -v
bash -x tests/install-test.sh
```

Expected: FAIL until the version and new asset list are updated.

- [ ] **Step 3: Bump and synchronize package version**

Set:

```make
PKG_VERSION:=1.3.0
PKG_RELEASE:=1
```

Update every shared asset query string to `1.3.0`, update `install.sh`'s release version, and add the two Node renderer modules to package/release contracts. Add a `node --check` step for all four JavaScript files to `.github/workflows/test.yml`.

- [ ] **Step 4: Run the complete local verification suite**

Run:

```bash
python3 -m unittest discover -s tests -v
bash -x tests/test_service_contract.sh
node --check package/shared/ookla-speedtest-web/gauge.js
node --check package/shared/ookla-speedtest-web/results.js
node --check package/shared/ookla-speedtest-web/views.js
node --check package/shared/ookla-speedtest-web/app.js
node tests/test_frontend_contract.js
node tests/test_frontend_render.js
node tests/test_frontend_live.js
node tests/test_gauge.js
bash -x tests/install-test.sh
bash -x tests/goodcloud-contract-test.sh
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 5: Build and inspect all three IPKs**

Run:

```bash
release_dir="$(mktemp -d /tmp/ookla-web-release-XXXXXX)"
python3 scripts/build_web_ipks.py "$release_dir"
find "$release_dir" -maxdepth 1 -name '*1.3.0-1*.ipk' -print
```

Expected: one `ookla-speedtest-webd`, one `luci-app-ookla-speedtest-web`, and one `gl-app-ookla-speedtest-web` IPK. Extract each with `scripts/build_web_ipks.py`'s test helper or `ar`/`tar` and confirm the CLI executable is absent and all shared frontend modules are present where applicable.

- [ ] **Step 6: Commit the release version**

```bash
git add package/Makefile package/shared/ookla-speedtest-web/index.html install.sh tests/test_build_web_ipks.py tests/test_package_layout.py .github/workflows/test.yml
git commit -m "chore: prepare web app 1.3.0"
```

### Task 9: Install on the GL.iNet router and verify the real interface

**Files:**
- Replace: `docs/screenshots/dashboard.png`
- Replace: `docs/screenshots/live-download.png`
- Replace: `docs/screenshots/final-results.png`
- Replace: `docs/screenshots/speedtest-demo.gif`

**Interfaces:**
- Consumes: verified `1.3.0-1` IPKs, router `100.66.177.126`, and the authenticated Chromium/CDP session.
- Produces: installed packages, real-browser evidence, fresh screenshots, and an animated GIF containing genuine measurements.

- [ ] **Step 1: Build IPKs into an explicit temporary directory**

Run:

```bash
build_dir="$(mktemp -d /tmp/ookla-web-1.3.0-XXXXXX)"
python3 scripts/build_web_ipks.py "$build_dir"
find "$build_dir" -maxdepth 1 -name '*.ipk' -print
```

Expected: exactly three web IPKs with version `1.3.0-1`.

- [ ] **Step 2: Copy and install the packages on `100.66.177.126`**

Export `SSHPASS` in the invoking shell from the already configured router
credential without printing or committing it, then run:

```bash
test -n "$SSHPASS"
sshpass -e scp -O "$build_dir"/*.ipk root@100.66.177.126:/tmp/
sshpass -e ssh -o StrictHostKeyChecking=no root@100.66.177.126 \
  'opkg install --force-reinstall /tmp/ookla-speedtest-webd_1.3.0-1_all.ipk /tmp/luci-app-ookla-speedtest-web_1.3.0-1_all.ipk /tmp/gl-app-ookla-speedtest-web_1.3.0-1_all.ipk && /etc/init.d/rpcd restart && rm -f /tmp/*ookla-speedtest-web*_1.3.0-1_all.ipk'
```

Expected: `opkg list-installed | grep ookla-speedtest` shows CLI plus all three web packages, with web packages at `1.3.0-1`.

- [ ] **Step 3: Verify GL.iNet Applications and LuCI routes in Chromium**

Reload the authenticated GL.iNet route, clear cache, and assert in the live DOM:

```javascript
document.querySelector('#app-title').textContent.includes('Unofficial') &&
document.querySelector('#live-gauge').getBoundingClientRect().width <= 286 &&
getComputedStyle(document.querySelector('#gauge-needle')).transformOrigin.includes('143') &&
['router-internet','device-router','both'].every(mode => document.querySelector(`[data-mode="${mode}"]`))
```

Open the native LuCI route and the GoodCloud-compatible embedded route and confirm the same asset version, no white screen, no horizontal overflow, and no failed network requests.

- [ ] **Step 4: Run and inspect all three real modes**

For Router → Internet, confirm ping/download/upload targets update about every 100 ms, the needle animates between them, the pivot is visually centered, the number/unit do not overlap it, the selected server is used, and ISP/WAN/VPN wording matches router state. For Device → Router, confirm the result says it is not an internet test. For Both, confirm local finishes first and final values appear in two separate sections.

Record browser timestamps and angles during download:

```javascript
window.__needleEvidence = [];
const needle = document.querySelector('#gauge-needle');
const sample = setInterval(() => window.__needleEvidence.push({at:performance.now(), value:document.querySelector('#gauge-value').textContent, transform:getComputedStyle(needle).transform}), 20);
```

Expected: multiple distinct transforms occur between successive real numeric values, no overshoot beyond the target angle occurs, and the final transform settles.

- [ ] **Step 5: Capture fresh installed screenshots**

Capture the application viewport at idle, active download, and completed Both result into the three existing PNG paths. Inspect each with the image viewer. Reject any capture with clipped controls, overlap, stale 1.2.0 assets, blank content, or private router/browser chrome.

- [ ] **Step 6: Replace the stale GIF with a real 1.3.0 run**

Capture iframe-only PNG frames every 250 ms through a successful Router → Internet run, including idle, ping, download, upload, and complete. Encode:

```bash
ffmpeg -y -framerate 8 -i "$capture_dir/frame-%05d.png" \
  -vf "fps=8,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 docs/screenshots/speedtest-demo.gif
```

Verify with `ffprobe` that it is 900 px wide, loops, contains at least 96 frames, lasts 12–18 seconds, and is below 12 MB. Inspect a contact sheet containing all five states.

- [ ] **Step 7: Commit only verified installed-interface captures**

```bash
git add docs/screenshots/dashboard.png docs/screenshots/live-download.png docs/screenshots/final-results.png docs/screenshots/speedtest-demo.gif
git commit -m "docs: capture redesigned speedtest interface"
```

### Task 10: User-facing README, direct main publication, release, and signed feed

**Files:**
- Modify: `README.md`
- Modify in feed repository: `/home/keith/src/openwrt-packages` generated index/package artifacts and installer metadata through its existing publisher workflow.

**Interfaces:**
- Consumes: verified router screenshots/GIF and `1.3.0` commits.
- Produces: accurate public documentation, GitHub release `v1.3.0`, signed feed packages/index, and the one-line installer serving `1.3.0-1`.

- [ ] **Step 1: Update the README to describe the shipped interface**

Place the real GIF before the static gallery:

```markdown
![A real Router to Internet test running in OpenWrt Ookla Speedtest](docs/screenshots/speedtest-demo.gif)
```

Replace adaptive-scale language with the fixed nonlinear reference dial and fluid real-sample tracking. Explain the ad-free UI, tapered hubless needle, Router → Internet versus Device → Router, Both separation, server selection, ISP/WAN/VPN interpretation, terms gate, CLI dependency boundary, LuCI/GL.iNet/GoodCloud access, and the existing one-line installer. Do not refer to the maintainer in third person.

- [ ] **Step 2: Verify docs and repository state**

Run:

```bash
rg -n "adaptive gauge|adaptive needle|1\.2\.0" README.md package/shared/ookla-speedtest-web
test "$(git status --short | wc -l)" -eq 1
git diff --check
python3 -m unittest discover -s tests -v
node tests/test_frontend_contract.js && node tests/test_frontend_render.js && node tests/test_frontend_live.js && node tests/test_gauge.js
bash tests/test_service_contract.sh && bash tests/install-test.sh && bash tests/goodcloud-contract-test.sh
```

Expected: the first command has no matches; only `README.md` is uncommitted before the commit; all checks pass.

- [ ] **Step 3: Commit README and push the reviewed history directly to main**

```bash
git add README.md
git commit -m "docs: explain redesigned router speedtest"
git fetch origin main
git rebase origin/main
git push origin HEAD:main
```

Expected: `main` fast-forwards with no force push and no uncommitted files except ignored local workflow state.

- [ ] **Step 4: Require green main CI**

Run:

```bash
run_id="$(gh run list --repo keithah/openwrt-ookla-speedtest --branch main --workflow Test --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" --repo keithah/openwrt-ookla-speedtest --exit-status
```

Expected: Test concludes `success`.

- [ ] **Step 5: Tag and publish the GitHub release**

Run:

```bash
git tag -a v1.3.0 -m "OpenWrt Ookla Speedtest 1.3.0"
git push origin v1.3.0
release_run="$(gh run list --repo keithah/openwrt-ookla-speedtest --workflow 'Release web app' --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$release_run" --repo keithah/openwrt-ookla-speedtest --exit-status
gh release view v1.3.0 --repo keithah/openwrt-ookla-speedtest
```

Expected: the release succeeds and contains exactly the installer plus three `1.3.0-1` web IPKs.

- [ ] **Step 6: Publish into the existing signed feed**

In `/home/keith/src/openwrt-packages`, use its documented package-ingest/publish workflow to add the three `v1.3.0` release IPKs without changing Starwatch, Wattline, or CLI artifacts. Regenerate and sign the feed index, update the web installer metadata if version-pinned, commit, and push `main`.

Verify the public index and installer:

```bash
curl -fsS https://keithah.github.io/openwrt-packages/Packages | rg -A8 'Package: (ookla-speedtest-webd|luci-app-ookla-speedtest-web|gl-app-ookla-speedtest-web)'
curl -fsS https://keithah.github.io/openwrt-packages/install-ookla-speedtest-web.sh | rg 'ookla-speedtest-cli|ookla-speedtest-webd|luci-app-ookla-speedtest-web|gl-app-ookla-speedtest-web'
```

Expected: all three web stanzas report `Version: 1.3.0-1`, the CLI remains a separate package, and the installer requests all four packages.

- [ ] **Step 7: Reinstall through the public one-liner and perform final smoke test**

On `100.66.177.126`, run the public installer:

```bash
wget -qO- https://keithah.github.io/openwrt-packages/install-ookla-speedtest-web.sh | sh
```

Then open the GL.iNet Applications entry, run a Router → Internet test, confirm the final ISP/server/VPN context and fluid gauge, and verify `opkg list-installed` reports web version `1.3.0-1`.
