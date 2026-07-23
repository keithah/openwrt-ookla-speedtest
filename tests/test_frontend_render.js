const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..', 'package', 'shared', 'ookla-speedtest-web');
const SpeedtestGauge = require(path.join(root, 'gauge.js'));
const Results = require(path.join(root, 'results.js'));
const Views = require(path.join(root, 'views.js'));

class FakeNode {
  constructor() {
    this.attributes = {};
    this.children = [];
    this.classList = { toggle() {} };
    this.hidden = false;
    this.style = { values: {}, setProperty: (name, value) => { this.style.values[name] = value; } };
    this.textContent = '';
  }
  appendChild(node) { this.children.push(node); return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  getAttribute(name) { return this.attributes[name] || null; }
  click() { if (this.onclick) return this.onclick(); }
  addEventListener(name, fn) { this['on' + name] = fn; }
}

const ids = ['live-gauge', 'gauge-dial', 'gauge-labels', 'gauge-readout', 'gauge-needle', 'gauge-value', 'gauge-unit',
  'phase-label', 'primary-metrics', 'metric-download', 'metric-upload', 'metric-ping', 'metric-jitter',
  'metric-loss', 'download-trace', 'upload-trace', 'go-control', 'cancel-test', 'live-announcer',
  'route-label', 'scope-note', 'status', 'isp-badge', 'network-badge', 'vpn-callout', 'server-name',
  'server-detail', 'results', 'view', 'phase-announcer', 'error-message', 'retry-test', 'terms-dialog',
  'accept-terms', 'server-picker', 'server-panel', 'server-search', 'server-results'];
const nodes = Object.fromEntries(ids.map(id => [id, new FakeNode()]));
nodes['gauge-dial'].setAttribute('hidden', '');
nodes['live-announcer'].setAttribute('data-throttle-ms', '1000');
const latency = new FakeNode();
let ready, rafId = 0, reducedMotion = false;
const rafs = new Map();
const document = {
  visibilityState: 'visible',
  addEventListener(name, fn) { if (name === 'DOMContentLoaded') ready = fn; },
  removeEventListener() {},
  createElement() { return new FakeNode(); },
  createTextNode(value) { const node = new FakeNode(); node.textContent = value; return node; },
  getElementById(id) { return nodes[id] || null; },
  querySelector(selector) { return selector === '.latency-strip' ? latency : null; },
  querySelectorAll() { return []; }
};
Object.values(nodes).forEach(node => { node.ownerDocument = document; });
function nodeText(node) {
  return [node.textContent].concat(node.children.map(nodeText)).filter(Boolean).join(' ');
}

assert.equal(Results.networkSummary({ network_context: { vpn: true, vpn_kind: 'tailscale-exit', vpn_name: 'Tailscale' } }),
  'Router → Internet via Tailscale exit node');
assert.equal(Results.networkSummary({ network_context: { vpn: true, vpn_kind: 'speedify', vpn_name: 'Speedify' } }),
  'Router → Internet via Speedify');
assert.equal(Results.networkSummary({ network_context: { vpn: true, vpn_name: 'WireGuard' } }),
  'Router → Internet via WireGuard');
assert.equal(Results.networkSummary({ network_context: { possible_vpn: true } }),
  'Router → Internet via possible VPN/proxy path');
assert.equal(Results.networkSummary({ network_context: { vpn: false } }),
  'Router → Internet via direct WAN path');

Results.render(nodes.results, 'both', {
  local: { download_mbps: 640, upload_mbps: 510, ping_ms: 2 },
  internet: {
    download_mbps: 920, upload_mbps: 850, ping_ms: 4,
    idle_latency_ms: 4, download_latency_ms: 11, upload_latency_ms: 8,
    jitter_ms: 1.2, loss_percent: 0, isp: 'Sonic',
    interface: { name: 'wan', type: 'Ethernet' },
    server: { name: 'San Jose', sponsor: 'Example Host', location: 'West Coast' }
  }
});
const bothResults = nodeText(nodes.results);
assert.match(bothResults, /Device → Router/);
assert.match(bothResults, /640/);
assert.match(bothResults, /not a public internet speed/i);
assert.match(bothResults, /Router → Internet/);
assert.match(bothResults, /920/);
for (const expected of ['Idle latency 4 ms', 'Download latency 11 ms', 'Upload latency 8 ms',
  'Jitter 1.2 ms', 'Loss 0 %', 'Sonic', 'wan', 'Ethernet', 'San Jose', 'Example Host', 'West Coast',
  'direct WAN path']) assert.match(bothResults, new RegExp(expected));
assert.match(nodes.results.className, /final-result/);

Results.render(nodes.results, 'device-router', { local: { download_mbps: 12, ping_ms: 3 } });
assert.match(nodeText(nodes.results), /Upload — Mbps/);

Results.render(nodes.results, 'router-internet', {
  internet: {
    download_mbps: 296.7, upload_mbps: 95, ping_ms: 11.554,
    ping: { latency: 11.554 },
    download: { latency: { iqm: 27.932 } },
    upload: { latency: { iqm: 39.411 } }
  }
});
const nestedLatencyResults = nodeText(nodes.results);
assert.match(nestedLatencyResults, /Idle latency 11\.554 ms/);
assert.match(nestedLatencyResults, /Download latency 27\.932 ms/);
assert.match(nestedLatencyResults, /Upload latency 39\.411 ms/);
assert.doesNotMatch(nestedLatencyResults, /\[object Object\]/);

let opened = null;
Views.render(nodes.view, 'history', {
  history: [
    { id: 'i', date: 'Today', kind: 'router-internet', outcome: 'success', download_mbps: 100, upload_mbps: 20, ping_ms: 8 },
    { id: 'l', date: 'Today', kind: 'device-router', outcome: 'error', error_code: 'local_io', download_mbps: 900 }
  ]
}, { openResult(row) { opened = row; } });
const historyText = nodeText(nodes.view);
assert.match(historyText, /Router → Internet/);
assert.match(historyText, /Device → Router/);
assert.match(historyText, /Failed \(local_io\)/);
const openButtons = nodes.view.children[1].children[0].children
  .map(row => row.children[row.children.length - 1])
  .filter(cell => cell && cell.children[0] && cell.children[0].textContent === 'View result');
assert.equal(openButtons.length, 2);
openButtons[1].children[0].click();
assert.equal(opened.id, 'l');

Views.render(nodes.view, 'analytics', {
  history: [
    { kind: 'router-internet', outcome: 'success', download_mbps: 100 },
    { kind: 'router-internet', outcome: 'error', download_mbps: 1000 },
    { kind: 'device-router', outcome: 'success', download_mbps: 900 }
  ]
}, {});
const analyticsText = nodeText(nodes.view);
assert.match(analyticsText, /Router → Internet: 1 recorded test/);
assert.match(analyticsText, /Download average 100 Mbps/);
assert.match(analyticsText, /Device → Router: 1 recorded test/);
assert.match(analyticsText, /Download average 900 Mbps/);
assert.doesNotMatch(analyticsText, /Download average 500 Mbps/);

Views.render(nodes.view, 'settings', {
  settings: { server_name: 'San Jose', history_retention: 50, motion: 'reduced', terms_accepted: true }
}, {});
for (const expected of ['Server preference', 'San Jose', 'Retention', '50', 'Display options', 'reduced', 'Terms status', 'Accepted']) {
  assert.match(nodeText(nodes.view), new RegExp(expected, 'i'));
}

Views.render(nodes.view, 'about', {}, {});
assert.equal(nodeText(nodes.view).replace(/^About\s+/, ''),
  "OpenWrt Ookla Speedtest (Unofficial) runs Router → Internet tests on the router through the separately installed Ookla CLI. The web packages do not contain the Ookla binary. Device → Router measures this browser's authenticated path to the router, not the public internet. GoodCloud opens this same authenticated router interface; the package does not expose another public service.");
const window = {
  requestAnimationFrame(callback) { rafs.set(++rafId, callback); return rafId; },
  cancelAnimationFrame(id) { rafs.delete(id); },
  matchMedia() { return { matches: reducedMotion, addEventListener() {} }; }
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
  window, document, SpeedtestGauge, SpeedtestResults: Results, SpeedtestViews: Views, Promise,
  performance: { now: () => frameNow }, Date, setTimeout, clearTimeout,
  requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame
});

const app = window.SpeedtestWeb;
let frameNow = 0;
function stepFrame(at) { frameNow = at; const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(fn => fn(at)); }
ready();
app.render();
assert.equal(nodes['gauge-dial'].hidden, true, 'idle hides the full dial');
assert.equal(nodes['gauge-readout'].hidden, true, 'idle hides the live readout');
assert.equal(nodes['go-control'].hidden, false, 'idle shows GO');
assert.equal(nodes['cancel-test'].hidden, true, 'idle hides cancel');
assert.equal(nodes['primary-metrics'].hidden, true, 'idle hides throughput metrics');
assert.equal(latency.hidden, true, 'idle hides latency metrics');
assert.equal(nodes['phase-label'].textContent, 'Ready');
assert.equal(nodes['live-gauge'].attributes['data-shape'], 'disc');

Object.assign(app.state, { status: 'preparing', phase: 'preparing' });
app.render();
assert.equal(nodes['gauge-dial'].hidden, true);
assert.equal(nodes['go-control'].hidden, true);
assert.equal(nodes['cancel-test'].hidden, true);
assert.equal(nodes['live-gauge'].attributes['aria-busy'], 'true');
assert.equal(nodes.status.textContent, 'Preparing…');
assert.equal(nodes['live-gauge'].attributes['data-shape'], 'ring');

Object.assign(app.state, {
  status: 'running', phase: 'download', progress: 25, gaugeValue: 50, gaugeUnit: 'Mbps',
  download: 50.25, upload: null, ping: 8.4, jitter: 1.2, loss: 0,
  traces: { download: [10, 30, 50], upload: [] }
});
app.render();
assert.equal(nodes['gauge-dial'].hidden, false, 'running shows the dial');
assert.equal(nodes['gauge-dial'].hasAttribute('hidden'), false, 'running removes the SVG hidden attribute');
assert.equal(nodes['gauge-readout'].hidden, false, 'running shows the live readout');
assert.equal(nodes['go-control'].hidden, true, 'running hides GO');
assert.equal(nodes['cancel-test'].hidden, false, 'running shows cancel');
assert.equal(nodes['primary-metrics'].hidden, false);
assert.equal(latency.hidden, false);
assert.equal(nodes['live-gauge'].attributes['data-phase'], 'download');
assert.equal(nodes['phase-label'].textContent, 'Download');
assert.equal(nodes['phase-announcer'].textContent, 'Download phase');
assert.equal(nodes['live-gauge'].attributes['aria-busy'], 'true');
assert.equal(nodes['gauge-value'].textContent, '50');
assert.equal(nodes['metric-download'].textContent, '50.25');
assert.equal(nodes['metric-ping'].textContent, '8.4');
assert.equal(nodes['download-trace'].attributes.d, SpeedtestGauge.tracePath([10, 30, 50], 1000));
assert.equal(nodes['upload-trace'].attributes.d, '');
assert.deepEqual(nodes['gauge-labels'].children.map(node => node.textContent), SpeedtestGauge.labelsFor('download').map(String));
assert.equal(nodes['gauge-needle'].style.transform, 'rotate(-135deg)', 'render alone does not invent a needle sample');
assert.equal(nodes['live-gauge'].attributes['data-shape'], 'arc');
assert.equal(nodes['metric-download'].attributes['aria-current'], 'true');
assert.equal(nodes['live-gauge'].style.values['--gauge-progress'], '25');

app.applyLocalSample('download', 50);
assert.equal(nodes['gauge-needle'].style.transform, 'rotate(-135deg)', 'a real sample does not jump instantly');
stepFrame(100);
const halfwayAngle = parseFloat(nodes['gauge-needle'].style.transform.slice(7));
assert.ok(halfwayAngle > -135 && halfwayAngle < SpeedtestGauge.angleFor(50, 'download'));
stepFrame(200);
assert.equal(nodes['gauge-needle'].style.transform, 'rotate(' + SpeedtestGauge.angleFor(50, 'download') + 'deg)');

app.applyLocalSample('download', 100);
stepFrame(250);
const retargetedAngle = parseFloat(nodes['gauge-needle'].style.transform.slice(7));
assert.ok(retargetedAngle > SpeedtestGauge.angleFor(50, 'download'), 'retarget starts from the displayed angle');

Object.assign(app.state, { phase: 'upload', progress: 60, gaugeValue: 100, upload: 42.75, traces: { download: [10, 30, 50], upload: [20] } });
app.render();
app.applyLocalSample('upload', 42.75);
assert.equal(nodes['live-gauge'].attributes['data-phase'], 'upload');
assert.equal(nodes['phase-label'].textContent, 'Upload');
assert.equal(nodes['phase-announcer'].textContent, 'Upload phase');
assert.equal(nodes['metric-upload'].textContent, '42.75');
assert.equal(nodes['upload-trace'].attributes.d, SpeedtestGauge.tracePath([20, 42.75], 1000));
stepFrame(750);
assert.equal(nodes['gauge-needle'].style.transform, 'rotate(-135deg)', 'phase change resets over 500 ms');
stepFrame(950);
assert.equal(nodes['gauge-needle'].style.transform, 'rotate(' + SpeedtestGauge.angleFor(42.75, 'upload') + 'deg)', 'newest phase sample retargets after reset');
assert.equal(nodes['metric-download'].attributes['aria-current'], undefined, 'completed metric remains visible but inactive');
assert.equal(nodes['metric-upload'].attributes['aria-current'], 'true');

Object.assign(app.state, { status: 'done', phase: 'complete', progress: 100 });
app.render();
assert.equal(nodes['live-gauge'].attributes['data-status'], 'done');
assert.equal(nodes['live-gauge'].attributes['data-phase'], 'complete');
assert.equal(nodes['gauge-dial'].hidden, true, 'complete returns to the compact GO shell');
assert.equal(nodes['gauge-readout'].hidden, true, 'complete hides the live readout');
assert.equal(nodes['go-control'].hidden, false, 'complete restores GO');
assert.equal(nodes['cancel-test'].hidden, true, 'complete hides cancel');
assert.equal(nodes['primary-metrics'].hidden, false, 'complete retains throughput metrics');
assert.equal(latency.hidden, false, 'complete retains latency metrics');
assert.equal(nodes['metric-download'].textContent, '100');
assert.equal(nodes['metric-upload'].textContent, '42.75');
assert.equal(nodes['download-trace'].attributes.d, SpeedtestGauge.tracePath([10, 30, 50], 1000));
assert.equal(nodes['upload-trace'].attributes.d, SpeedtestGauge.tracePath([20, 42.75], 1000));
assert.equal(nodes['phase-label'].textContent, 'Complete');
assert.equal(nodes['phase-announcer'].textContent, 'Test complete');
assert.equal(nodes['live-gauge'].attributes['aria-busy'], 'false');

Object.assign(app.state, { status: 'error', phase: 'error', errorPath: 'internet', errorCode: 'network_timeout', failedPhase: 'download', failedMode: 'both' });
app.render();
assert.equal(nodes['error-message'].hidden, false);
assert.match(nodes['error-message'].textContent, /Router → Internet/);
assert.match(nodes['error-message'].textContent, /download failed/);
assert.match(nodes['error-message'].textContent, /network_timeout/);
assert.match(nodes['phase-announcer'].textContent, /Router → Internet download failed/);
assert.equal(nodes['retry-test'].hidden, false);

reducedMotion = true;
Object.assign(app.state, { status: 'running', phase: 'download' });
app.render();
app.applyLocalSample('download', 250);
assert.equal(nodes['gauge-needle'].style.transform, 'rotate(' + SpeedtestGauge.angleFor(250, 'download') + 'deg)', 'reduced motion jumps immediately');

console.log('frontend render ok');
