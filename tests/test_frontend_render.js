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

const ids = ['test-stage', 'live-graph', 'live-gauge', 'gauge-dial', 'gauge-labels', 'gauge-readout', 'gauge-value', 'gauge-unit',
  'phase-label', 'primary-metrics', 'metric-download', 'metric-upload', 'metric-ping', 'metric-jitter',
  'metric-loss', 'download-trace', 'upload-trace', 'go-control', 'cancel-test', 'live-announcer',
  'route-label', 'scope-note', 'status', 'isp-badge', 'network-badge', 'vpn-callout', 'server-name',
  'server-detail', 'results', 'view', 'phase-announcer', 'error-message', 'retry-test', 'terms-dialog',
  'accept-terms', 'server-picker', 'server-panel', 'server-search', 'server-results'];
const nodes = Object.fromEntries(ids.map(id => [id, new FakeNode()]));
nodes['gauge-dial'].setAttribute('hidden', '');
nodes['live-announcer'].setAttribute('data-throttle-ms', '1000');
const latency = new FakeNode();
let ready, reducedMotion = false;
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
assert.equal(Results.networkSummary({ network_context: { vpn: true } }),
  'Router → Internet via VPN tunnel');
assert.equal(Results.networkSummary({ network_context: { possible_vpn: true } }),
  'Router → Internet via possible VPN/proxy path');
assert.equal(Results.networkSummary({ network_context: { vpn: false } }),
  'Router → Internet via direct WAN path');

// Every number/Provider/Connection/Server/Location field is already live on the
// dashboard above, so the completion card only ever needs to show the local-test
// caveat and/or a share button -- never a duplicate of data shown elsewhere.
Results.render(nodes.results, 'both', {
  local: { download_mbps: 640, upload_mbps: 510, ping_ms: 2 },
  internet: { download_mbps: 920, upload_mbps: 850, ping_ms: 4 }
});
const bothResults = nodeText(nodes.results);
assert.match(bothResults, /not a public internet speed/i);
assert.doesNotMatch(bothResults, /640|920/, 'numbers already shown in the live metrics strip are not duplicated here');
assert.equal(nodes.results.children.length, 1, 'no share_url means the internet leg renders no card at all');
assert.match(nodes.results.className, /final-result/);

Results.render(nodes.results, 'device-router', { local: { download_mbps: 12, ping_ms: 3 } });
assert.match(nodeText(nodes.results), /not a public internet speed/i);

Results.render(nodes.results, 'router-internet', { internet: { download_mbps: 296.7, upload_mbps: 95, ping_ms: 11.554 } });
assert.equal(nodes.results.children.length, 0, 'a completed result with nothing unique to show renders no card');

Results.render(nodes.results, 'router-internet', {
  internet: { download_mbps: 100, upload_mbps: 20, ping_ms: 8, share_url: 'https://www.speedtest.net/result/c/example' }
});
const shareButtons = nodes.results.children[0].children.filter(node => node.getAttribute('data-share-url'));
assert.equal(shareButtons.length, 1, 'a completed result with a share URL renders exactly one share button');
assert.equal(shareButtons[0].textContent, 'Share result');
assert.equal(shareButtons[0].getAttribute('data-share-url'), 'https://www.speedtest.net/result/c/example');

let opened = null;
Views.render(nodes.view, 'history', {
  history: [
    { id: 'i', date: 'Today', kind: 'router-internet', outcome: 'success', location: 'Seattle, WA, United States', download_mbps: 100, upload_mbps: 20, ping_ms: 8 },
    { id: 'l', date: 'Today', kind: 'device-router', outcome: 'error', error_code: 'local_io', download_mbps: 900 }
  ]
}, { openResult(row) { opened = row; } });
const historyText = nodeText(nodes.view);
assert.match(historyText, /Router → Internet/);
assert.match(historyText, /Device → Router/);
assert.match(historyText, /Failed \(local_io\)/);
assert.match(historyText, /Location/, 'history table has a Location column header');
assert.match(historyText, /Seattle, WA, United States/, 'a recorded location renders in the history row');
assert.doesNotMatch(historyText, /Success/, 'a successful outcome renders blank, not the word Success');
const openButtons = nodes.view.children[1].children[0].children
  .map(row => row.children[row.children.length - 1])
  .filter(cell => cell && cell.children[0] && cell.children[0].textContent === 'View result');
assert.equal(openButtons.length, 2);
openButtons[1].children[0].click();
assert.equal(opened.id, 'l');

let wentHome = false;
Views.render(nodes.view, 'settings', { settings: { terms_accepted: true } }, { goHome() { wentHome = true; } });
const backButtons = nodes.view.children.filter(node => node.className === 'back-home');
assert.equal(backButtons.length, 1, 'a non-home view with a goHome action offers exactly one back button');
backButtons[0].click();
assert.ok(wentHome, 'clicking the back button invokes goHome');

Views.render(nodes.view, 'home', {}, { goHome() {} });
assert.equal(nodes.view.children.length, 0, 'the home view never renders a back button or its own content');

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
  matchMedia() { return { matches: reducedMotion, addEventListener() {} }; }
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
  window, document, SpeedtestGauge, SpeedtestResults: Results, SpeedtestViews: Views, Promise,
  performance: { now: () => 0 }, Date, setTimeout, clearTimeout
});

const app = window.SpeedtestWeb;
ready();
app.render();
assert.equal(nodes['server-picker'].attributes['aria-label'], 'Change server');
assert.equal(nodes['gauge-dial'].hidden, true, 'idle hides the full dial');
assert.equal(nodes['gauge-readout'].hidden, true, 'idle hides the live readout');
assert.equal(nodes['go-control'].hidden, false, 'idle shows GO');
assert.equal(nodes['cancel-test'].hidden, true, 'idle hides cancel');
assert.equal(nodes['primary-metrics'].hidden, true, 'idle hides throughput metrics');
assert.equal(latency.hidden, true, 'idle hides latency metrics');
assert.equal(nodes['phase-label'].textContent, 'Ready');
assert.equal(nodes['live-gauge'].attributes['data-shape'], 'disc');
assert.equal(nodes['test-stage'].hidden, false, 'the dashboard is visible on the home view');

app.state.view = 'history';
app.render();
assert.equal(nodes['test-stage'].hidden, true, 'switching to History hides the dashboard instead of pushing it below the page');
app.state.view = 'home';
app.render();
assert.equal(nodes['test-stage'].hidden, false, 'returning to the home view restores the dashboard');

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
assert.equal(nodes['live-gauge'].attributes['data-shape'], 'arc');
assert.equal(nodes['metric-download'].attributes['aria-current'], 'true');
assert.equal(nodes['live-gauge'].style.values['--gauge-progress'], '25');

app.applyLocalSample('download', 50);
app.applyLocalSample('download', 100);

Object.assign(app.state, { phase: 'upload', progress: 60, gaugeValue: 100, upload: 42.75, traces: { download: [10, 30, 50], upload: [20] } });
app.render();
app.applyLocalSample('upload', 42.75);
assert.equal(nodes['live-gauge'].attributes['data-phase'], 'upload');
assert.equal(nodes['phase-label'].textContent, 'Upload');
assert.equal(nodes['phase-announcer'].textContent, 'Upload phase');
assert.equal(nodes['metric-upload'].textContent, '42.75');
assert.equal(nodes['upload-trace'].attributes.d, SpeedtestGauge.tracePath([20, 42.75], 1000));
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
assert.equal(nodes['go-control'].textContent, 'RETEST');
assert.equal(nodes['go-control'].attributes['aria-label'], 'Run Router to Internet test again');
for (const id of ['metric-ping', 'metric-download', 'metric-upload']) {
  assert.equal(nodes[id].attributes['aria-current'], undefined, 'terminal states have no active metric');
}

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
assert.equal(nodes['metric-download'].textContent, '250');

console.log('frontend render ok');
