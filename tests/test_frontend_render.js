const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..', 'package', 'shared', 'ookla-speedtest-web');
const SpeedtestGauge = require(path.join(root, 'gauge.js'));

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
}

const ids = ['live-gauge', 'gauge-dial', 'gauge-readout', 'gauge-needle', 'gauge-value', 'gauge-unit',
  'phase-label', 'primary-metrics', 'metric-download', 'metric-upload', 'metric-ping', 'metric-jitter',
  'metric-loss', 'download-trace', 'upload-trace', 'go-control', 'cancel-test', 'live-announcer',
  'route-label', 'scope-note', 'status', 'isp-badge', 'network-badge', 'vpn-callout', 'server-name',
  'server-detail', 'results', 'view', 'phase-announcer', 'error-message', 'retry-test'];
const nodes = Object.fromEntries(ids.map(id => [id, new FakeNode()]));
nodes['gauge-dial'].setAttribute('hidden', '');
nodes['live-announcer'].setAttribute('data-throttle-ms', '1000');
const latency = new FakeNode();
const scaleLabels = Array.from({ length: 5 }, () => new FakeNode());
const document = {
  addEventListener() {},
  createElement() { return new FakeNode(); },
  createTextNode(value) { const node = new FakeNode(); node.textContent = value; return node; },
  getElementById(id) { return nodes[id] || null; },
  querySelector(selector) { return selector === '.latency-strip' ? latency : null; },
  querySelectorAll(selector) { return selector === '[data-gauge-scale]' ? scaleLabels : []; }
};
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
  window, document, SpeedtestGauge, Promise, performance: { now: () => 0 }, Date, setTimeout, clearTimeout
});

const app = window.SpeedtestWeb;
app.render();
assert.equal(nodes['gauge-dial'].hidden, true, 'idle hides the full dial');
assert.equal(nodes['gauge-readout'].hidden, true, 'idle hides the live readout');
assert.equal(nodes['go-control'].hidden, false, 'idle shows GO');
assert.equal(nodes['cancel-test'].hidden, true, 'idle hides cancel');
assert.equal(nodes['primary-metrics'].hidden, true, 'idle hides throughput metrics');
assert.equal(latency.hidden, true, 'idle hides latency metrics');
assert.equal(nodes['phase-label'].textContent, 'Ready');

Object.assign(app.state, { status: 'preparing', phase: 'preparing' });
app.render();
assert.equal(nodes['gauge-dial'].hidden, true);
assert.equal(nodes['go-control'].hidden, true);
assert.equal(nodes['cancel-test'].hidden, true);
assert.equal(nodes['live-gauge'].attributes['aria-busy'], 'true');
assert.equal(nodes.status.textContent, 'Preparing…');

Object.assign(app.state, {
  status: 'running', phase: 'download', progress: 25, gaugeValue: 50, gaugeUnit: 'Mbps', gaugeScale: 200,
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
assert.equal(nodes['download-trace'].attributes.d, SpeedtestGauge.tracePath([10, 30, 50], 200));
assert.equal(nodes['upload-trace'].attributes.d, '');
assert.deepEqual(scaleLabels.map(node => node.textContent), ['0', '50', '100', '150', '200']);
assert.equal(nodes['gauge-needle'].style.transform, 'rotate(-67.5deg)');
assert.equal(nodes['live-gauge'].style.values['--gauge-progress'], '25');

Object.assign(app.state, { phase: 'upload', progress: 60, gaugeValue: 100, upload: 42.75, traces: { download: [10, 30, 50], upload: [20, 42.75] } });
app.render();
assert.equal(nodes['live-gauge'].attributes['data-phase'], 'upload');
assert.equal(nodes['phase-label'].textContent, 'Upload');
assert.equal(nodes['phase-announcer'].textContent, 'Upload phase');
assert.equal(nodes['metric-upload'].textContent, '42.75');
assert.equal(nodes['upload-trace'].attributes.d, SpeedtestGauge.tracePath([20, 42.75], 200));
assert.equal(nodes['gauge-needle'].style.transform, 'rotate(0deg)');

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
assert.equal(nodes['metric-download'].textContent, '50.25');
assert.equal(nodes['metric-upload'].textContent, '42.75');
assert.equal(nodes['download-trace'].attributes.d, SpeedtestGauge.tracePath([10, 30, 50], 200));
assert.equal(nodes['upload-trace'].attributes.d, SpeedtestGauge.tracePath([20, 42.75], 200));
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

console.log('frontend render ok');
