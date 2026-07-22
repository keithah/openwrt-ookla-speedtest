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
    this.listeners = {};
    this.classList = { toggle() {} };
    this.hidden = false;
    this.style = { values: {}, setProperty: (name, value) => { this.style.values[name] = value; } };
    this.textContent = '';
    this.value = '';
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { if (this.listeners.click) this.listeners.click.call(this); }
  appendChild(node) { this.children.push(node); return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  showModal() { this.open = true; }
}

class FakeTimers {
  constructor() { this.now = 0; this.nextId = 1; this.tasks = []; }
  setTimeout(fn, delay) {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.now + Number(delay || 0), fn });
    this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
    return id;
  }
  clearTimeout(id) { this.tasks = this.tasks.filter(task => task.id !== id); }
  async tick(ms) {
    const end = this.now + ms;
    while (this.tasks.length && this.tasks[0].at <= end) {
      const task = this.tasks.shift();
      this.now = task.at;
      task.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function harness(handler) {
  const ids = ['live-gauge', 'gauge-dial', 'gauge-readout', 'gauge-needle', 'gauge-value', 'gauge-unit',
    'phase-label', 'primary-metrics', 'metric-download', 'metric-upload', 'metric-ping', 'metric-jitter',
    'metric-loss', 'download-trace', 'upload-trace', 'go-control', 'cancel-test', 'live-announcer',
    'route-label', 'scope-note', 'status', 'isp-badge', 'network-badge', 'vpn-callout', 'server-name',
    'server-detail', 'results', 'view', 'terms-dialog', 'accept-terms', 'server-picker', 'server-panel',
    'server-search', 'server-results'];
  const nodes = Object.fromEntries(ids.map(id => [id, new FakeNode()]));
  nodes['live-announcer'].setAttribute('data-throttle-ms', '1000');
  const latency = new FakeNode();
  const scaleLabels = Array.from({ length: 5 }, () => new FakeNode());
  let ready;
  const document = {
    addEventListener(name, fn) { if (name === 'DOMContentLoaded') ready = fn; },
    createElement() { return new FakeNode(); },
    createTextNode(value) { const node = new FakeNode(); node.textContent = value; return node; },
    getElementById(id) { return nodes[id] || null; },
    querySelector(selector) { return selector === '.latency-strip' ? latency : null; },
    querySelectorAll(selector) { return selector === '[data-gauge-scale]' ? scaleLabels : []; }
  };
  const timers = new FakeTimers();
  const calls = [];
  const adapter = { call(method, params) { calls.push({ method, params, at: timers.now }); return handler(method, params, calls); } };
  const window = { SpeedtestWebAdapter: adapter };
  const FakeDate = { now: () => timers.now };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
    window, document, SpeedtestGauge, Promise, performance: { now: () => timers.now }, Date: FakeDate,
    setTimeout: timers.setTimeout.bind(timers), clearTimeout: timers.clearTimeout.bind(timers)
  });
  return { app: window.SpeedtestWeb, calls, document, nodes, ready, timers };
}

function status(job, fields) {
  return Object.assign({ ok: true, job_id: job, state: 'running' }, fields);
}

async function testLiveSamplesReachComplete() {
  const responses = [
    { ok: true, job_id: 'job-a' },
    status('job-a', { phase: 'ping', progress: 1, ping_ms: 9.25, jitter_ms: 0.75 }),
    status('job-a', { phase: 'download', progress: 0.4, download_mbps: 120, download_trace: [{ timestamp: 1, value: 80 }, { timestamp: 2, value: 120 }] }),
    status('job-a', { phase: 'upload', progress: 0.6, download_mbps: 120, upload_mbps: 31, download_trace: [{ timestamp: 1, value: 80 }, { timestamp: 2, value: 120 }], upload_trace: [{ timestamp: 3, value: 31 }] }),
    status('job-a', { state: 'complete', phase: 'complete', progress: 1, ping_ms: 9.25, download_mbps: 296.73, upload_mbps: 31,
      download_trace: [{ timestamp: 1, value: 80 }, { timestamp: 2, value: 120 }, { timestamp: 4, value: 296.73 }], upload_trace: [{ timestamp: 3, value: 31 }],
      result: { download: { bandwidth: 37091386 }, upload: { bandwidth: 3875000 }, ping: { latency: 9.25 }, packetLoss: 0,
        isp: 'Example ISP', interface: { name: 'wan' }, server: { id: 42, name: 'Example Server' }, network_context: { note: 'Direct' } } })
  ];
  const h = harness(() => Promise.resolve(responses.shift()));
  const promise = h.app.internetTest();
  await flush();
  assert.deepEqual(h.calls.slice(0, 2).map(call => call.method), ['start_live', 'live_status']);
  assert.equal(h.app.state.phase, 'ping');
  assert.equal(h.nodes['live-gauge'].attributes['data-phase'], 'ping');
  assert.equal(h.nodes['phase-label'].textContent, 'Ping');
  assert.equal(h.nodes['gauge-needle'].attributes.transform, 'rotate(-110.025 230 230)');
  await h.timers.tick(500);
  assert.equal(h.app.state.phase, 'download');
  assert.deepEqual(Array.from(h.app.state.traces.download), [80, 120]);
  assert.notEqual(h.nodes['download-trace'].attributes.d, '');
  const downloadNeedle = h.nodes['gauge-needle'].attributes.transform;
  await h.timers.tick(500);
  assert.equal(h.app.state.phase, 'upload');
  assert.deepEqual(Array.from(h.app.state.traces.upload), [31]);
  assert.notEqual(h.nodes['gauge-needle'].attributes.transform, downloadNeedle);
  await h.timers.tick(500);
  const result = await promise;
  assert.equal(h.app.state.phase, 'complete');
  assert.equal(h.app.state.status, 'done');
  assert.equal(result.download_mbps, 296.73);
  assert.equal(result.upload_mbps, 31);
  assert.equal(h.app.state.download, 296.73);
  assert.deepEqual(Array.from(h.app.state.traces.download), [80, 120, 296.73]);
}

async function testCadenceAndRetries() {
  let polls = 0;
  const h = harness(method => {
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: 'retry-job' });
    polls++;
    if (polls === 1) return Promise.resolve(status('retry-job', { phase: 'download', progress: 0.2, download_mbps: 55, download_trace: [{ timestamp: 1, value: 55 }] }));
    return Promise.reject(new Error('transport'));
  });
  const rejected = h.app.internetTest().then(() => null, error => error);
  await flush();
  assert.equal(h.calls.filter(call => call.method === 'live_status')[0].at, 0);
  await h.timers.tick(500);
  await h.timers.tick(500);
  await h.timers.tick(1000);
  await h.timers.tick(2000);
  const error = await rejected;
  assert.equal(error.message, 'transport');
  assert.deepEqual(h.calls.filter(call => call.method === 'live_status').map(call => call.at), [0, 500, 1000, 2000, 4000]);
  assert.equal(h.app.state.download, 55, 'transport failures preserve the last real sample');
  assert.deepEqual(Array.from(h.app.state.traces.download), [55]);
  assert.equal(h.app.state.pollFailures, 4);
  assert.equal(h.app.state.status, 'error');
}

async function testStaleResponsesAreIgnored() {
  const h = harness(() => Promise.resolve({}));
  h.app.state.activeJob = 'new-job';
  h.app.state.download = 77;
  const applied = h.app.applyLiveStatus(status('old-job', { phase: 'download', download_mbps: 999 }), 'old-job');
  assert.equal(applied, false);
  assert.equal(h.app.state.download, 77);
}

async function testCancelIsImmediateAndSingleShot() {
  const h = harness((method, params) => {
    if (method === 'cancel_live') return Promise.resolve({ ok: true, job_id: params.job_id, state: 'cancelled' });
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    return Promise.resolve({ ok: true });
  });
  h.ready();
  await flush();
  h.app.state.activeJob = 'cancel-job';
  h.app.state.status = 'running';
  h.nodes['cancel-test'].click();
  h.nodes['cancel-test'].click();
  await flush();
  assert.equal(h.app.state.cancelRequested, true);
  assert.equal(h.app.state.phase, 'cancelled');
  assert.equal(h.app.state.status, 'cancelled');
  const cancels = h.calls.filter(call => call.method === 'cancel_live');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].params.job_id, 'cancel-job');
}

async function testMalformedBackendStateIsStableError() {
  const responses = [{ ok: true, job_id: 'bad-job' }, status('bad-job', { phase: 'teleporting' })];
  const h = harness(() => Promise.resolve(responses.shift()));
  const error = await h.app.internetTest().then(() => null, reason => reason);
  assert.equal(error.code, 'malformed_live_status');
  assert.equal(h.app.state.status, 'error');
  assert.equal(h.app.state.phase, 'error');
}

(async function main() {
  await testLiveSamplesReachComplete();
  await testCadenceAndRetries();
  await testStaleResponsesAreIgnored();
  await testCancelIsImmediateAndSingleShot();
  await testMalformedBackendStateIsStableError();
  console.log('frontend live polling ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
