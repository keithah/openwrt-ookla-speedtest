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
  click() { if (!this.disabled && this.listeners.click) return this.listeners.click.call(this); }
  appendChild(node) { this.children.push(node); return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
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

async function flushUntil(predicate) {
  for (let i = 0; i < 20 && !predicate(); i++) await flush();
}

function harness(handler, options) {
  const ids = ['live-gauge', 'gauge-dial', 'gauge-readout', 'gauge-needle', 'gauge-value', 'gauge-unit',
    'phase-label', 'primary-metrics', 'metric-download', 'metric-upload', 'metric-ping', 'metric-jitter',
    'metric-loss', 'download-trace', 'upload-trace', 'go-control', 'cancel-test', 'live-announcer',
    'route-label', 'scope-note', 'status', 'isp-badge', 'network-badge', 'vpn-callout', 'server-name',
    'server-detail', 'results', 'view', 'terms-dialog', 'accept-terms', 'server-picker', 'server-panel',
    'server-search', 'server-results', 'phase-announcer', 'error-message', 'retry-test'];
  const nodes = Object.fromEntries(ids.map(id => [id, new FakeNode()]));
  const modeButtons = ['router-internet', 'device-router', 'both'].map(mode => { const node = new FakeNode(); node.setAttribute('data-mode', mode); return node; });
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
    querySelectorAll(selector) { return selector === '[data-gauge-scale]' ? scaleLabels : selector === '[data-mode]' ? modeButtons : []; }
  };
  const timers = new FakeTimers();
  const calls = [];
  const adapter = { call(method, params) { calls.push({ method, params, at: timers.now }); return handler(method, params, calls, timers); } };
  const window = { SpeedtestWebAdapter: adapter, SpeedtestWebLocalConfig: options && options.local };
  const FakeDate = { now: () => timers.now };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
    window, document, SpeedtestGauge, Promise, performance: { now: () => timers.now }, Date: FakeDate,
    setTimeout: timers.setTimeout.bind(timers), clearTimeout: timers.clearTimeout.bind(timers)
  });
  return { app: window.SpeedtestWeb, calls, document, nodes, modeButtons, ready, timers };
}

function status(job, fields) {
  return Object.assign({ ok: true, job_id: job, state: 'running' }, fields);
}

function complete(job, download) {
  return status(job, { state: 'complete', phase: 'complete', progress: 1, ping_ms: 8, download_mbps: download, upload_mbps: 20,
    download_trace: [{ timestamp: 1, value: download }], upload_trace: [{ timestamp: 2, value: 20 }],
    result: { download: { bandwidth: download * 125000 }, upload: { bandwidth: 2500000 }, ping: { latency: 8 }, packetLoss: 0,
      isp: 'ISP ' + job, interface: { name: 'wan' }, server: { id: 42, name: job }, network_context: { note: job } } });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function nodeText(node) {
  return [node.textContent].concat(node.children.map(nodeText)).filter(Boolean).join(' ');
}

function nodesWithClass(node, className) {
  return [node].concat(node.children.flatMap(child => nodesWithClass(child, className))).filter(child => (child.className || '').split(/\s+/).includes(className));
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
  assert.equal(h.nodes['gauge-needle'].style.transform, 'rotate(-110.025deg)');
  await h.timers.tick(500);
  assert.equal(h.app.state.phase, 'download');
  assert.deepEqual(Array.from(h.app.state.traces.download), [80, 120]);
  assert.notEqual(h.nodes['download-trace'].attributes.d, '');
  const downloadNeedle = h.nodes['gauge-needle'].style.transform;
  await h.timers.tick(500);
  assert.equal(h.app.state.phase, 'upload');
  assert.deepEqual(Array.from(h.app.state.traces.upload), [31]);
  assert.notEqual(h.nodes['gauge-needle'].style.transform, downloadNeedle);
  await h.timers.tick(500);
  const result = await promise;
  assert.equal(h.app.state.phase, 'complete');
  assert.equal(h.app.state.status, 'done');
  assert.equal(h.app.state.failedPhase, null);
  assert.equal(result.download_mbps, 296.73);
  assert.equal(result.upload_mbps, 31);
  assert.equal(h.app.state.download, 296.73);
  assert.deepEqual(Array.from(h.app.state.traces.download), [80, 120, 296.73]);
}

async function testResultEventWaitsForEnrichedTerminalState() {
  const early = complete('result-race', 250);
  early.state = 'running';
  delete early.result.network_context;
  const terminal = complete('result-race', 250);
  terminal.result.network_context = { note: 'Tailscale exit node', vpn: true };
  const responses = [{ ok: true, job_id: 'result-race' }, early, terminal];
  const h = harness(() => Promise.resolve(responses.shift()));
  const pending = h.app.internetTest();
  await flush();
  assert.equal(h.app.state.phase, 'complete');
  assert.equal(h.app.state.status, 'running', 'a JSONL result event is not the worker terminal state');
  await h.timers.tick(500);
  const result = await pending;
  assert.equal(result.network_context.note, 'Tailscale exit node');
  assert.equal(h.calls.filter(call => call.method === 'live_status').length, 2);
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
  assert.equal(h.app.state.failedPhase, 'download');
  assert.match(h.nodes['error-message'].textContent, /Router → Internet download failed/);
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
  h.app.state.failedPhase = 'download';
  h.app.render();
  h.nodes['cancel-test'].click();
  h.nodes['cancel-test'].click();
  await flush();
  assert.equal(h.app.state.cancelRequested, true);
  assert.equal(h.app.state.phase, 'cancelled');
  assert.equal(h.app.state.status, 'cancelled');
  assert.equal(h.app.state.failedPhase, null);
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

async function testRunningStartingPhaseNormalizesBeforeProgress() {
  const responses = [
    { ok: true, job_id: 'starting-job' },
    status('starting-job', { phase: 'starting', progress: 0 }),
    status('starting-job', { phase: 'download', progress: 0.25, download_mbps: 40, download_trace: [{ timestamp: 1, value: 40 }] }),
    complete('starting-job', 80)
  ];
  const h = harness(() => Promise.resolve(responses.shift()));
  const run = h.app.internetTest();
  await flush();
  assert.equal(h.app.state.status, 'running');
  assert.equal(h.app.state.phase, 'ping');
  assert.equal(h.nodes['live-gauge'].attributes['data-phase'], 'ping');
  await h.timers.tick(500);
  assert.equal(h.app.state.phase, 'download');
  await h.timers.tick(500);
  await run;
  assert.equal(h.app.state.status, 'done');
}

async function testRunModeUsesTermsServerLiveAndHistory() {
  const h = harness((method, params) => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: 'integrated-job' });
    if (method === 'live_status') return Promise.resolve(complete('integrated-job', 80));
    if (method === 'history') return Promise.resolve({ ok: true, items: [{ id: 'history-row' }] });
    return Promise.reject(new Error('unexpected method ' + method));
  });
  h.app.state.server = { id: 42, name: 'Chosen' };
  await h.app.runMode('router-internet');
  assert.deepEqual(h.calls.map(call => call.method), ['settings', 'start_live', 'live_status', 'history']);
  assert.equal(h.calls[1].params.server_id, 42);
  assert.equal(h.app.state.status, 'done');
  assert.equal(h.app.state.results.internet.download_mbps, 80);
  assert.equal(h.app.state.history[0].id, 'history-row');
  assert.equal(h.calls.some(call => call.method === 'runTest'), false, 'router tests never use the legacy synchronous bridge');
}

async function testHistoryRefreshFailureDoesNotRewriteCompletedMeasurement() {
  const h = harness(method => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: 'history-failure-job' });
    if (method === 'live_status') return Promise.resolve(complete('history-failure-job', 144));
    if (method === 'history') return Promise.reject(Object.assign(new Error('history unavailable'), { code: 'storage_error' }));
    throw new Error('unexpected ' + method);
  });
  await h.app.runMode('router-internet');
  assert.equal(h.app.state.status, 'done');
  assert.equal(h.app.state.phase, 'complete');
  assert.equal(h.app.state.results.internet.download_mbps, 144);
  assert.equal(h.app.state.errorCode, null, 'best-effort history refresh is not a measurement error');
}

async function testTermsAcceptanceResumesLiveRun() {
  let accepted = false;
  const h = harness(method => {
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: accepted });
    if (method === 'accept_terms') { accepted = true; return Promise.resolve({ ok: true }); }
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: 'terms-job' });
    if (method === 'live_status') return Promise.resolve(complete('terms-job', 90));
    throw new Error('unexpected ' + method);
  });
  h.ready();
  await flush();
  await h.app.runMode('router-internet');
  assert.equal(h.nodes['terms-dialog'].open, true);
  assert.equal(h.calls.some(call => call.method === 'start_live'), false);
  h.nodes['accept-terms'].click();
  await flush();
  assert.equal(h.calls.filter(call => call.method === 'accept_terms').length, 1);
  assert.equal(h.calls.filter(call => call.method === 'start_live').length, 1);
  assert.equal(h.app.state.status, 'done');
}

async function testDeviceRouterKeepsLocalBridge() {
  const pingDelays = [7, 3, 5];
  const h = harness((method, params, calls, timers) => {
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: '11111111111111111111111111111111', state: 'active' });
    if (method === 'local_download' && params.bytes === 1024) return new Promise(resolve => {
      const delay = pingDelays.shift();
      timers.setTimeout(() => resolve({ ok: true, bytes: params.bytes }), delay);
    });
    if (method === 'local_download') return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
    if (method === 'record_local') {
      assert.equal(params.run_id, '11111111111111111111111111111111');
      return Promise.resolve({ ok: true, run_id: params.run_id, state: 'committed', item: { id: params.run_id } });
    }
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 2 } });
  const run = h.app.runMode('device-router');
  await flush();
  await h.timers.tick(7);
  await h.timers.tick(3);
  await h.timers.tick(5);
  await run;
  const latency = h.calls.filter(call => call.method === 'local_download').slice(0, 3);
  assert.equal(h.calls[0].method, 'begin_local', 'local run is reserved before probes begin');
  assert.deepEqual(latency.map(call => [call.method, call.params.bytes]), [
    ['local_download', 1024], ['local_download', 1024], ['local_download', 1024]
  ]);
  assert.equal(h.calls.filter(call => call.method === 'local_download').length, 19);
  assert.equal(h.calls.filter(call => call.method === 'local_upload').length, 16);
  assert.equal(h.calls.filter(call => call.method === 'record_local').length, 1);
  assert.equal(h.calls.filter(call => call.method === 'begin_local').length, 1);
  assert.equal(h.app.state.results.local.ping_ms, 5, 'three latency probes use their median');
  assert.equal(h.app.state.traces.download.length, 2, 'each completed download batch emits a gauge sample');
  assert.equal(h.app.state.traces.upload.length, 2, 'each completed upload batch emits a gauge sample');
  assert.ok(h.calls.filter(call => call.method === 'local_download' && call.params.bytes !== 1024)
    .every(call => call.params.bytes === 32768));
  assert.ok(h.calls.filter(call => call.method === 'local_download')
    .every(call => call.params.run_id === '11111111111111111111111111111111'));
  assert.ok(h.calls.filter(call => call.method === 'local_upload')
    .every(call => call.params.data.length === 32768 && call.params.run_id === '11111111111111111111111111111111'));
  assert.equal(h.calls.some(call => ['settings', 'start_live', 'live_status', 'runTest'].includes(call.method)), false);
  assert.equal(h.app.state.status, 'done');
  assert.ok(h.app.state.results.local);
}

async function testCancelDuringLocalStopsAfterInflightBatch() {
  const batch = deferred();
  const h = harness((method, params) => {
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: '22222222222222222222222222222222', state: 'active' });
    if (method === 'cancel_local') return Promise.resolve({ ok: true, run_id: params.run_id, state: 'cancelled' });
    if (method === 'local_download' && params.bytes === 1024) return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_download') return batch.promise;
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 3 } });
  const run = h.app.runMode('device-router');
  await flushUntil(() => h.calls.filter(call => call.method === 'local_download' && call.params.bytes === 32768).length === 8);
  assert.equal(h.calls.filter(call => call.method === 'local_download' && call.params.bytes === 32768).length, 8);
  await h.app.cancelTest();
  assert.equal(h.app.state.status, 'cancelled');
  batch.resolve({ ok: true, bytes: 32768 });
  await run;
  assert.equal(h.calls.filter(call => call.method === 'local_download' && call.params.bytes === 32768).length, 8);
  assert.equal(h.calls.some(call => call.method === 'local_upload'), false);
  assert.equal(h.calls.some(call => call.method === 'record_local'), false);
  assert.equal(h.app.state.status, 'cancelled');
  assert.equal(h.app.state.results.local, null);
  assert.equal(h.calls.filter(call => call.method === 'cancel_local').length, 1);
  assert.equal(h.calls.find(call => call.method === 'cancel_local').params.run_id, '22222222222222222222222222222222');
}

async function testTransientLocalCancelFailureCanBeRetried() {
  const batch = deferred();
  let cancelAttempts = 0;
  const h = harness((method, params) => {
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: '12121212121212121212121212121212', state: 'active' });
    if (method === 'local_download' && params.bytes === 1024) return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_download') return batch.promise;
    if (method === 'cancel_local') {
      cancelAttempts += 1;
      if (cancelAttempts === 1) {
        const error = new Error('service busy');
        error.code = 'busy';
        return Promise.reject(error);
      }
      return Promise.resolve({ ok: true, run_id: params.run_id, state: 'cancelled' });
    }
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 2 } });
  const run = h.app.runMode('device-router');
  await flushUntil(() => h.calls.filter(call => call.method === 'local_download' && call.params.bytes === 32768).length === 8);

  const first = await h.app.cancelTest();
  assert.equal(first.error.code, 'busy');
  assert.equal(h.app.state.cancelRequested, false);
  assert.equal(h.app.state.status, 'running');

  const second = await h.app.cancelTest();
  assert.equal(second.state, 'cancelled');
  assert.equal(h.calls.filter(call => call.method === 'cancel_local').length, 2);
  assert.equal(h.app.state.status, 'cancelled');
  batch.resolve({ ok: true, bytes: 32768 });
  await run;
  assert.equal(h.app.state.status, 'cancelled');
}

async function testAcknowledgedLocalCancelWinsLateBatchRejection() {
  const requests = Array.from({ length: 8 }, () => deferred());
  let requestIndex = 0;
  const lateError = new Error('local run is no longer active');
  lateError.code = 'local_run_not_active';
  const h = harness((method, params) => {
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', state: 'active' });
    if (method === 'cancel_local') return Promise.resolve({ ok: true, run_id: params.run_id, state: 'cancelled' });
    if (method === 'local_download' && params.bytes === 1024) return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_download') return requests[requestIndex++].promise;
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 2 } });
  const run = h.app.runMode('device-router');
  await flushUntil(() => requestIndex === 8);
  await h.app.cancelTest();
  requests.slice(0, 7).forEach(request => request.resolve({ ok: true, bytes: 32768 }));
  requests[7].reject(lateError);
  await run;
  assert.equal(h.app.state.status, 'cancelled');
  assert.equal(h.app.state.phase, 'cancelled');
  assert.equal(h.app.state.errorCode, null);
  assert.equal(h.app.state.results.local, null);
  assert.equal(h.calls.filter(call => call.method === 'cancel_local').length, 1);
}

async function testCancelDuringPendingLocalBeginCancelsBeforeProbes() {
  const begin = deferred();
  const h = harness((method, params) => {
    if (method === 'begin_local') return begin.promise;
    if (method === 'cancel_local') return Promise.resolve({ ok: true, run_id: params.run_id, state: 'cancelled' });
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 1 } });
  const run = h.app.runMode('device-router');
  await flush();
  const pending = await h.app.cancelTest();
  assert.equal(pending.pending, true);
  begin.resolve({ ok: true, run_id: '99999999999999999999999999999999', state: 'active' });
  await run;
  assert.equal(h.calls.filter(call => call.method === 'cancel_local').length, 1);
  assert.equal(h.calls.find(call => call.method === 'cancel_local').params.run_id, '99999999999999999999999999999999');
  assert.equal(h.calls.some(call => call.method === 'local_download'), false);
  assert.equal(h.app.state.status, 'cancelled');
}

async function testCancelWinsAgainstInflightLocalRecord() {
  const record = deferred();
  const h = harness((method, params) => {
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: '33333333333333333333333333333333', state: 'active' });
    if (method === 'local_download') return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
    if (method === 'record_local') return record.promise;
    if (method === 'cancel_local') return Promise.resolve({ ok: true, run_id: params.run_id, state: 'cancelled' });
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 1 } });
  const run = h.app.runMode('device-router');
  await flushUntil(() => h.calls.some(call => call.method === 'record_local'));
  assert.equal(h.calls.filter(call => call.method === 'record_local').length, 1);
  await h.app.cancelTest();
  record.resolve({ ok: false, state: 'cancelled', error: { code: 'local_cancelled' } });
  await run;
  assert.equal(h.calls.filter(call => call.method === 'cancel_local').length, 1);
  assert.equal(h.calls.some(call => call.method === 'delete_history'), false);
  assert.equal(h.app.state.status, 'cancelled');
  assert.equal(h.app.state.results.local, null);
  assert.equal(h.calls.some(call => call.method === 'history'), false);
}

async function testLocalRecordWinnerIsAuthoritativeOverCancellation() {
  const record = deferred(), cancellation = deferred();
  const h = harness((method, params) => {
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: '44444444444444444444444444444444', state: 'active' });
    if (method === 'local_download') return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
    if (method === 'record_local') return record.promise;
    if (method === 'cancel_local') return cancellation.promise;
    if (method === 'history') return Promise.resolve({ ok: true, items: [{ id: '44444444444444444444444444444444' }] });
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 1 } });
  const run = h.app.runMode('device-router');
  await flushUntil(() => h.calls.some(call => call.method === 'record_local'));
  const cancel = h.app.cancelTest();
  await flushUntil(() => h.calls.some(call => call.method === 'cancel_local'));
  record.resolve({ ok: true, run_id: '44444444444444444444444444444444', state: 'committed', item: { id: '44444444444444444444444444444444' } });
  await flush();
  cancellation.resolve({ ok: false, state: 'committed', error: { code: 'too_late' } });
  await cancel;
  await run;
  assert.equal(h.app.state.status, 'done');
  assert.equal(h.app.state.results.local.kind, 'device-router');
  assert.equal(h.calls.some(call => call.method === 'delete_history'), false);
  assert.equal(h.app.state.history[0].id, '44444444444444444444444444444444');
}

async function testLostCommittedRecordResponseRecoversAuthoritativeResult() {
  const record = deferred();
  const runId = 'ffffffffffffffffffffffffffffffff';
  const h = harness((method, params) => {
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: runId, state: 'active' });
    if (method === 'local_download') return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
    if (method === 'record_local') return record.promise;
    if (method === 'cancel_local') return Promise.resolve({ ok: false, state: 'committed', error: { code: 'too_late' } });
    if (method === 'history') return Promise.resolve({ ok: true, items: [{ id: runId, run_id: runId, kind: 'device-router', outcome: 'success' }] });
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 1 } });
  const run = h.app.runMode('device-router');
  await flushUntil(() => h.calls.some(call => call.method === 'record_local'));
  record.reject(new Error('response lost after commit'));
  await run;
  assert.equal(h.calls.filter(call => call.method === 'record_local').length, 1);
  assert.equal(h.calls.filter(call => call.method === 'cancel_local').length, 1);
  assert.equal(h.app.state.status, 'done');
  assert.equal(h.app.state.results.local.kind, 'device-router');
  assert.equal(h.app.state.history.length, 1);
  assert.equal(h.app.state.history[0].id, runId);
}

async function testLostRecordResponseReusesOverlappingCommittedCancellation() {
  for (const recordRejectsFirst of [true, false]) {
    const record = deferred(), cancellation = deferred();
    const runId = recordRejectsFirst
      ? 'abababababababababababababababab'
      : 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
    const h = harness((method, params) => {
      if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: runId, state: 'active' });
      if (method === 'local_download') return Promise.resolve({ ok: true, bytes: params.bytes });
      if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
      if (method === 'record_local') return record.promise;
      if (method === 'cancel_local') return cancellation.promise;
      if (method === 'history') return Promise.resolve({ ok: true, items: [{ id: runId, run_id: runId, kind: 'device-router', outcome: 'success' }] });
      throw new Error('unexpected ' + method);
    }, { local: { measurementMs: 3000, maxBatches: 1 } });
    const run = h.app.runMode('device-router');
    await flushUntil(() => h.calls.some(call => call.method === 'record_local'));
    const cancel = h.app.cancelTest();
    await flushUntil(() => h.calls.some(call => call.method === 'cancel_local'));

    if (recordRejectsFirst) {
      record.reject(new Error('response lost after commit'));
      await flush();
      cancellation.resolve({ ok: false, state: 'committed', error: { code: 'too_late' } });
    } else {
      cancellation.resolve({ ok: false, state: 'committed', error: { code: 'too_late' } });
      await cancel;
      record.reject(new Error('response lost after commit'));
    }

    await cancel;
    await run;
    assert.equal(h.calls.filter(call => call.method === 'record_local').length, 1);
    assert.equal(h.calls.filter(call => call.method === 'cancel_local').length, 1, 'record recovery reuses the user cancellation');
    assert.equal(h.calls.filter(call => call.method === 'history').length, 1);
    assert.equal(h.app.state.status, 'done');
    assert.equal(h.app.state.results.local.kind, 'device-router');
    assert.equal(h.app.state.history[0].id, runId);
  }
}

async function testSupersedingRunCancelsInflightLocalRecord() {
  const record = deferred();
  const h = harness((method, params) => {
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', state: 'active' });
    if (method === 'local_download') return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
    if (method === 'record_local') return record.promise;
    if (method === 'cancel_local') return Promise.reject(new Error('stale cleanup failed'));
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: 'new-after-local' });
    if (method === 'live_status') return Promise.resolve(complete('new-after-local', 240));
    if (method === 'history') return Promise.resolve({ ok: true, items: [{ id: 'new-only' }] });
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 1 } });
  const oldRun = h.app.runMode('device-router');
  await flushUntil(() => h.calls.some(call => call.method === 'record_local'));
  const newRun = h.app.runMode('router-internet');
  await flushUntil(() => h.calls.some(call => call.method === 'cancel_local'));
  record.reject(new Error('old record failed'));
  await oldRun;
  await newRun;
  const cancellation = h.calls.find(call => call.method === 'cancel_local');
  assert.equal(cancellation.params.run_id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(h.app.state.status, 'done');
  assert.equal(h.app.state.results.local, null);
  assert.equal(h.app.state.results.internet.download_mbps, 240);
  assert.equal(h.app.state.history[0].id, 'new-only');
}

async function testLocalFailuresReleaseReservationAndKeepOriginalError() {
  const cases = [
    { point: 'ping', code: 'local_ping_failed', phase: 'ping' },
    { point: 'transfer', code: 'local_transfer_failed', phase: 'download' },
    { point: 'record', code: 'local_record_failed', phase: 'upload' }
  ];
  for (const testCase of cases) {
    const runId = testCase.point === 'ping' ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      : testCase.point === 'transfer' ? 'cccccccccccccccccccccccccccccccc'
        : 'dddddddddddddddddddddddddddddddd';
    const h = harness((method, params) => {
      if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: runId, state: 'active' });
      if (method === 'local_download') {
        if ((testCase.point === 'ping' && params.bytes === 1024)
          || (testCase.point === 'transfer' && params.bytes === 32768)) {
          return Promise.resolve({ ok: false, error: { code: testCase.code } });
        }
        return Promise.resolve({ ok: true, bytes: params.bytes });
      }
      if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
      if (method === 'record_local') return testCase.point === 'record'
        ? Promise.resolve({ ok: false, error: { code: testCase.code } })
        : Promise.resolve({ ok: true, run_id: runId, state: 'committed', item: { id: runId } });
      if (method === 'cancel_local') return Promise.reject(new Error('cleanup transport failed'));
      throw new Error('unexpected ' + method);
    }, { local: { measurementMs: 3000, maxBatches: 1 } });

    await h.app.runMode('device-router');

    const cancellations = h.calls.filter(call => call.method === 'cancel_local');
    assert.equal(cancellations.length, 1, testCase.point + ' failure releases its reservation');
    assert.equal(cancellations[0].params.run_id, runId);
    assert.equal(h.app.state.status, 'error');
    assert.equal(h.app.state.errorPath, 'local');
    assert.equal(h.app.state.errorCode, testCase.code, 'cleanup failure must not replace the original error');
    assert.equal(h.app.state.failedPhase, testCase.phase);
    assert.match(h.nodes['error-message'].textContent, new RegExp('Device → Router '+testCase.phase+' failed'));
    assert.match(h.nodes['phase-announcer'].textContent, new RegExp('Device → Router '+testCase.phase+' failed'));
    assert.equal(h.app.state.results.local, null);
  }
}

async function testLocalMeasurementUsesFullWindowAndCumulativeElapsed() {
  let downloadRequest = 0, uploadRequest = 0;
  const h = harness((method, params, calls, timers) => {
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: '55555555555555555555555555555555', state: 'active' });
    if (method === 'local_download' && params.bytes === 1024) return new Promise(resolve => timers.setTimeout(() => resolve({ ok: true, bytes: 1024 }), 10));
    if (method === 'local_download') {
      const delay = [1000, 2000][Math.floor(downloadRequest++ / 8)];
      return new Promise(resolve => timers.setTimeout(() => resolve({ ok: true, bytes: params.bytes }), delay));
    }
    if (method === 'local_upload') {
      const delay = [2000, 1000][Math.floor(uploadRequest++ / 8)];
      return new Promise(resolve => timers.setTimeout(() => resolve({ ok: true, bytes: params.data.length }), delay));
    }
    if (method === 'record_local') return Promise.resolve({ ok: true, run_id: params.run_id, state: 'committed', item: { id: params.run_id } });
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000 } });
  const run = h.app.runMode('device-router');
  await flush();
  await h.timers.tick(10);
  await h.timers.tick(10);
  await h.timers.tick(10);
  await h.timers.tick(1000);
  await h.timers.tick(2000);
  await h.timers.tick(2000);
  await h.timers.tick(1000);
  assert.equal(h.calls.filter(call => call.method === 'record_local').length, 1, 'uncapped measurement completes after both three-second windows');
  await run;
  assert.equal(h.calls.filter(call => call.method === 'local_download' && call.params.bytes === 32768).length, 16);
  assert.equal(h.calls.filter(call => call.method === 'local_upload').length, 16);
  assert.deepEqual(Array.from(h.app.state.traces.download), [2.1, 1.05]);
  assert.deepEqual(Array.from(h.app.state.traces.upload), [1.05, 2.1]);
  assert.equal(h.app.state.results.local.download_mbps, 1.4);
  assert.equal(h.app.state.results.local.upload_mbps, 1.4);
  assert.ok(h.calls.find(call => call.method === 'record_local').at >= 6030);
}

async function testBothRunsLocalThenInternetAndKeepsSeparateResults() {
  const h = harness((method, params, calls) => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: '66666666666666666666666666666666', state: 'active' });
    if (method === 'local_download') return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
    if (method === 'record_local') return Promise.resolve({ ok: true, run_id: params.run_id, state: 'committed', item: { id: params.run_id } });
    if (method === 'start_live') {
      assert.equal(calls.filter(call => call.method === 'record_local').length, 1, 'internet starts only after local recording completes');
      return Promise.resolve({ ok: true, job_id: 'both-job' });
    }
    if (method === 'live_status') return Promise.resolve(complete('both-job', 180));
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 2 } });
  await h.app.runMode('both');
  const recordIndex = h.calls.findIndex(call => call.method === 'record_local');
  const startIndex = h.calls.findIndex(call => call.method === 'start_live');
  assert.ok(recordIndex >= 0 && startIndex > recordIndex);
  assert.equal(h.app.state.results.local.kind, 'device-router');
  assert.equal(h.app.state.results.internet.kind, 'router-internet');
  assert.equal(h.app.state.results.internet.download_mbps, 180);
  assert.deepEqual(Array.from(h.app.state.traces.download), [180], 'internet path starts with fresh traces');
}

async function testBothFailureKeepsCompletedLocalAndIdentifiesInternet() {
  const h = harness((method, params) => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: '77777777777777777777777777777777', state: 'active' });
    if (method === 'local_download') return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
    if (method === 'record_local') return Promise.resolve({ ok: true, run_id: params.run_id, state: 'committed', item: { id: params.run_id } });
    if (method === 'start_live') return Promise.reject(new Error('internet unavailable'));
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 1 } });
  await h.app.runMode('both');
  assert.equal(h.app.state.status, 'error');
  assert.equal(h.app.state.errorPath, 'internet');
  assert.equal(h.app.state.results.local.kind, 'device-router');
  assert.equal(h.app.state.results.internet, null);
  assert.equal(h.nodes.results.children.length, 1, 'completed local result remains visible');
  assert.match(nodeText(h.nodes.results.children[0]), /Device → Router/);
}

async function testCompletedResultsRenderPathMetadataAndModeScope() {
  const h = harness(() => Promise.resolve({ ok: true }));
  h.app.state.results = {
    local: { kind: 'device-router', download_mbps: 810, upload_mbps: 700, ping_ms: 2 },
    internet: { kind: 'router-internet', download_mbps: 320, upload_mbps: 42, ping_ms: 9, jitter_ms: 1.4, loss_percent: 0,
      server: { name: 'West Coast', sponsor: 'Example Host', location: 'Portland' }, isp: 'Example ISP',
      interface: { name: 'wan', isVpn: false }, network_context: { note: 'Direct connection', vpn: false } }
  };
  h.app.state.mode = 'both';
  h.app.state.status = 'done';
  h.app.state.phase = 'complete';
  h.app.render();
  assert.equal(h.nodes.results.children.length, 2);
  assert.match(nodeText(h.nodes.results.children[0]), /Device → Router/);
  const internet = nodeText(h.nodes.results.children[1]);
  for (const expected of ['Router → Internet', 'Jitter 1.4 ms', 'Loss 0 %', 'West Coast', 'Example ISP', 'wan', 'Direct connection']) assert.match(internet, new RegExp(expected));
  h.app.state.mode = 'device-router';
  h.app.render();
  assert.equal(h.nodes.results.children.length, 1);
  assert.match(nodeText(h.nodes.results.children[0]), /Device → Router/);
}

async function testTerminalInternetErrorsPreservePhaseAndLastSample() {
  const cases = [
    { phase: 'ping', samples: [status('phase-job', { phase: 'ping', ping_ms: 7.5 })], retained: 'ping', value: 7.5 },
    { phase: 'download', samples: [status('phase-job', { phase: 'ping', ping_ms: 8 }), status('phase-job', { phase: 'download', download_mbps: 123, download_trace: [{ value: 123 }] })], retained: 'download', value: 123 },
    { phase: 'upload', samples: [status('phase-job', { phase: 'ping', ping_ms: 8 }), status('phase-job', { phase: 'download', download_mbps: 123 }), status('phase-job', { phase: 'upload', upload_mbps: 34, upload_trace: [{ value: 34 }] })], retained: 'upload', value: 34 }
  ];
  for (const testCase of cases) {
    const responses = [{ ok: true, terms_accepted: true }, { ok: true, job_id: 'phase-job' }]
      .concat(testCase.samples)
      .concat([status('phase-job', { state: 'error', phase: 'error', error: { code: 'speedtest_failed' } })]);
    const h = harness(() => Promise.resolve(responses.shift()));
    const run = h.app.runMode('router-internet');
    await flush();
    for (let i = 0; i < testCase.samples.length; i++) await h.timers.tick(500);
    await run;
    assert.equal(h.app.state.status, 'error');
    assert.equal(h.app.state.failedPhase, testCase.phase);
    assert.equal(h.app.state[testCase.retained], testCase.value, testCase.phase+' keeps its last valid sample');
    assert.match(h.nodes['error-message'].textContent, new RegExp('Router → Internet '+testCase.phase+' failed \\(speedtest_failed\\)'));
    assert.match(h.nodes['phase-announcer'].textContent, new RegExp('Router → Internet '+testCase.phase+' failed'));
  }
}

async function testHistoryOutcomesConversionAndAnalytics() {
  const h = harness(() => Promise.resolve({ ok: true }));
  h.app.state.history = [
    { id: 'ok', date: 'Today', kind: 'router-internet', outcome: 'success', download: { bandwidth: 12500000 }, upload: { bandwidth: 2500000 }, latency: 8 },
    { id: 'cancel', date: 'Today', kind: 'router-internet', outcome: 'cancelled' },
    { id: 'failed', date: 'Today', kind: 'device-router', outcome: 'error', error_code: 'local_io', download_mbps: 900 }
  ];
  h.app.state.view = 'history'; h.app.render();
  const history = nodeText(h.nodes.view);
  assert.match(history, /100 Mbps/);
  assert.match(history, /20 Mbps/);
  assert.match(history, /Cancelled/);
  assert.match(history, /Failed \(local_io\)/);
  assert.match(history, /900 Mbps/);
  assert.equal(h.nodes.view.children[1].className, 'history-scroll');
  assert.equal(h.nodes.view.children[1].attributes.role, 'region');
  assert.equal(h.nodes.view.children[1].attributes.tabindex, '0');
  assert.equal(nodesWithClass(h.nodes.view, 'failed').length, 1, 'backend error outcome uses failed styling');
  h.app.state.view = 'analytics'; h.app.render();
  const analytics = nodeText(h.nodes.view);
  assert.match(analytics, /Router → Internet: 1 recorded test/);
  assert.match(analytics, /Device → Router: 0 recorded tests/);
}

async function testErrorRetryUsesFailedModeAndConsumesUiRejections() {
  let settingsCalls = 0;
  const h = harness(method => {
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    if (method === 'settings') { settingsCalls++; return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' })); }
    throw new Error('unexpected ' + method);
  });
  h.ready();
  await flush();
  await h.nodes['go-control'].click();
  await flush();
  assert.equal(h.app.state.status, 'error');
  assert.equal(h.app.state.failedMode, 'router-internet');
  h.app.state.mode = 'device-router';
  await h.nodes['retry-test'].click();
  await flush();
  assert.equal(settingsCalls, 2, 'Retry restarts the exact failed mode');
  assert.equal(h.app.state.failedMode, 'router-internet');
}

async function testTermsAcceptanceRejectionBecomesRecoverableError() {
  const h = harness(method => {
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: false });
    if (method === 'accept_terms') return Promise.reject(Object.assign(new Error('write failed'), { code: 'storage_error' }));
    throw new Error('unexpected ' + method);
  });
  h.ready(); await flush();
  await h.app.runMode('both');
  assert.equal(h.nodes['terms-dialog'].open, true);
  await h.nodes['accept-terms'].click();
  assert.equal(h.app.state.status, 'error');
  assert.equal(h.app.state.errorCode, 'storage_error');
  assert.equal(h.app.state.failedMode, 'both');
  assert.equal(h.nodes['retry-test'].hidden, false);
}

async function testPhaseAnnouncementsAreDistinctFromThrottledNumbers() {
  const h = harness(() => Promise.resolve({ ok: true }));
  Object.assign(h.app.state, { status: 'running', phase: 'download', gaugeValue: 10, gaugeUnit: 'Mbps', download: 10 });
  h.app.render();
  assert.equal(h.nodes['phase-announcer'].textContent, 'Download phase');
  const firstNumeric = h.nodes['live-announcer'].textContent;
  h.app.state.gaugeValue = 11; h.app.state.download = 11; h.app.render();
  assert.equal(h.nodes['metric-download'].textContent, '11', 'visible value updates immediately');
  assert.equal(h.nodes['live-announcer'].textContent, firstNumeric, 'numeric announcement remains throttled');
  h.app.state.phase = 'upload'; h.app.state.upload = 5; h.app.state.gaugeValue = 5; h.app.render();
  assert.equal(h.nodes['phase-announcer'].textContent, 'Upload phase', 'phase change is announced immediately');
  h.app.render();
  assert.equal(h.nodes['phase-announcer'].textContent, 'Upload phase', 'same phase is not re-announced');
  await h.timers.tick(1000);
  assert.equal(h.nodes['live-announcer'].textContent, 'upload 5 Mbps', 'throttle publishes the latest exact sample');
  h.app.state.gaugeValue = 6; h.app.render();
  await h.timers.tick(999);
  assert.equal(h.nodes['live-announcer'].textContent, 'upload 5 Mbps');
  await h.timers.tick(1);
  assert.equal(h.nodes['live-announcer'].textContent, 'upload 6 Mbps');
}

async function testTerminalStatesDiscardQueuedNumericAnnouncements() {
  for (const terminal of ['done', 'error', 'cancelled']) {
    const h = harness(() => Promise.resolve({ ok: true }));
    Object.assign(h.app.state, { status: 'running', phase: 'download', gaugeValue: 88, gaugeUnit: 'Mbps', download: 88 });
    h.app.render();
    assert.ok(h.timers.tasks.length, 'running sample queues an announcement');
    Object.assign(h.app.state, { status: terminal, phase: terminal === 'done' ? 'complete' : terminal,
      errorPath: 'internet', errorCode: terminal === 'error' ? 'offline' : null, failedPhase: terminal === 'error' ? 'download' : null });
    h.app.render();
    const terminalAnnouncement = h.nodes['phase-announcer'].textContent;
    await h.timers.tick(1500);
    assert.equal(h.nodes['live-announcer'].textContent, '', terminal+' does not announce stale speed later');
    assert.equal(h.nodes['phase-announcer'].textContent, terminalAnnouncement);
  }
}

async function testModeSelectionIsLockedAndSemanticDuringActiveRun() {
  const h = harness(() => Promise.resolve({ ok: true }));
  h.ready(); await flush();
  Object.assign(h.app.state, { mode: 'both', status: 'running', phase: 'download', results: {
    local: { kind: 'device-router', download_mbps: 500, upload_mbps: 400, ping_ms: 2 }, internet: null
  }});
  h.app.render();
  const internetButton = h.modeButtons[0], bothButton = h.modeButtons[2];
  assert.equal(internetButton.disabled, true);
  assert.equal(bothButton.disabled, true);
  assert.equal(bothButton.attributes['aria-pressed'], 'true');
  assert.equal(internetButton.attributes['aria-pressed'], 'false');
  internetButton.click();
  assert.equal(h.app.state.mode, 'both');
  assert.match(h.nodes['route-label'].textContent, /Device → Router \+ Router → Internet/);
  assert.equal(h.nodes.results.children.length, 1);
  assert.match(nodeText(h.nodes.results.children[0]), /Device → Router/);
  h.app.state.status = 'done'; h.app.state.phase = 'complete'; h.app.render();
  assert.equal(internetButton.disabled, false);
}

async function testModeLocksWhileTermsSettingsArePending() {
  const settings = deferred();
  let starts = 0;
  const h = harness(method => {
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    if (method === 'settings') return settings.promise;
    if (method === 'start_live') { starts++; return Promise.resolve({ ok: true, job_id: 'prepared-job' }); }
    if (method === 'live_status') return Promise.resolve(complete('prepared-job', 90));
    throw new Error('unexpected '+method);
  });
  h.ready(); await flush();
  const run = h.app.runMode('router-internet');
  assert.equal(h.app.state.status, 'preparing');
  assert.equal(h.nodes.status.textContent, 'Preparing…');
  assert.equal(h.modeButtons[0].disabled, true, 'mode locks before settings RPC resolves');
  assert.equal(h.nodes['cancel-test'].hidden, true);
  assert.equal(h.nodes['cancel-test'].disabled, true);
  assert.equal(h.nodes['live-announcer'].textContent, '', 'preflight has no numeric speed announcement');
  h.modeButtons[1].click();
  assert.equal(h.app.state.mode, 'router-internet');
  settings.resolve({ ok: true, terms_accepted: true });
  await run;
  assert.equal(starts, 1);
  assert.equal(h.app.state.status, 'done');

  const rejectedSettings = deferred();
  const rejected = harness(method => {
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    if (method === 'settings') return rejectedSettings.promise;
    throw new Error('unexpected '+method);
  });
  rejected.ready(); await flush();
  const failedRun = rejected.app.runMode('router-internet').then(() => null, error => error);
  assert.equal(rejected.app.state.status, 'preparing');
  rejectedSettings.reject(Object.assign(new Error('offline'), { code: 'offline' }));
  const error = await failedRun;
  assert.equal(error.code, 'offline');
  assert.equal(rejected.app.state.status, 'error');
  assert.equal(rejected.modeButtons[0].disabled, false, 'settings failure unlocks modes');
  assert.equal(rejected.nodes['cancel-test'].hidden, true);
  assert.equal(rejected.nodes['cancel-test'].disabled, true);
}

async function testBothLocalFailureNeverStartsInternet() {
  const h = harness((method, params) => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'begin_local') return Promise.resolve({ ok: true, run_id: '88888888888888888888888888888888', state: 'active' });
    if (method === 'local_download' && params.bytes === 1024) return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_download') return Promise.reject(new Error('local unavailable'));
    throw new Error('unexpected ' + method);
  }, { local: { measurementMs: 3000, maxBatches: 1 } });
  await h.app.runMode('both');
  assert.equal(h.app.state.status, 'error');
  assert.equal(h.app.state.errorPath, 'local');
  assert.equal(h.calls.some(call => call.method === 'start_live'), false);
  assert.equal(h.calls.some(call => call.method === 'record_local'), false);
}

async function testRunModeHandlesBackendTerminalStates() {
  for (const terminal of ['error', 'cancelled']) {
    const h = harness(method => {
      if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
      if (method === 'start_live') return Promise.resolve({ ok: true, job_id: terminal + '-job' });
      if (method === 'live_status') return Promise.resolve(status(terminal + '-job', {
        ok: terminal !== 'error', state: terminal, phase: terminal, error: terminal === 'error' ? { code: 'speedtest_failed' } : undefined
      }));
      return Promise.resolve({ ok: true, items: [] });
    });
    await h.app.runMode('router-internet');
    assert.equal(h.app.state.status, terminal);
    assert.equal(h.app.state.phase, terminal);
    assert.equal(h.calls.some(call => call.method === 'history'), false);
  }
}

async function testCancelWinsAgainstInflightStatus() {
  const live = deferred();
  const h = harness(method => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: 'cancel-race' });
    if (method === 'live_status') return live.promise;
    if (method === 'cancel_live') return Promise.resolve({ ok: true, job_id: 'cancel-race', state: 'cancelled' });
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    throw new Error('unexpected ' + method);
  });
  const run = h.app.runMode('router-internet');
  await flush();
  await h.app.cancelTest();
  live.resolve(complete('cancel-race', 999));
  await run;
  assert.equal(h.app.state.status, 'cancelled');
  assert.equal(h.app.state.phase, 'cancelled');
  assert.equal(h.app.state.download, null);
  assert.equal(h.app.state.results.internet, null);
  assert.equal(h.calls.filter(call => call.method === 'cancel_live').length, 1);
  assert.equal(h.calls.some(call => call.method === 'history'), false);
}

async function testCancelWinsAgainstInflightFailure() {
  const live = deferred();
  const h = harness(method => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: 'cancel-failure' });
    if (method === 'live_status') return live.promise;
    if (method === 'cancel_live') return Promise.resolve({ ok: true, job_id: 'cancel-failure', state: 'cancelled' });
    throw new Error('unexpected ' + method);
  });
  const run = h.app.runMode('router-internet');
  await flush();
  await h.app.cancelTest();
  live.reject(new Error('late transport failure'));
  await flush();
  assert.equal(h.app.state.pollFailures, 0, 'cancelled in-flight failure does not enter retry backoff');
  await run;
  assert.equal(h.app.state.status, 'cancelled');
}

async function testCancelDuringPendingStartCancelsBeforePolling() {
  const start = deferred();
  const h = harness(method => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return start.promise;
    if (method === 'cancel_live') return Promise.resolve({ ok: true, job_id: 'pending-job', state: 'cancelled' });
    throw new Error('unexpected ' + method);
  });
  const run = h.app.runMode('router-internet');
  await flush();
  const cancellation = await h.app.cancelTest();
  assert.equal(cancellation.pending, true);
  assert.equal(h.app.state.cancelRequested, true);
  assert.equal(h.app.state.status, 'cancelling');
  start.resolve({ ok: true, job_id: 'pending-job' });
  await run;
  assert.equal(h.calls.filter(call => call.method === 'cancel_live').length, 1);
  assert.equal(h.calls.some(call => call.method === 'live_status'), false);
  assert.equal(h.app.state.status, 'cancelled');
}

async function testFailedCancelResumesPollingWithoutUnhandledRejection() {
  for (const failure of ['transport', 'job_not_running']) {
    let polls = 0;
    const h = harness(method => {
      if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
      if (method === 'start_live') return Promise.resolve({ ok: true, job_id: failure + '-job' });
      if (method === 'live_status') {
        polls++;
        return Promise.resolve(polls === 1 ? status(failure + '-job', { phase: 'download', progress: 0.2, download_mbps: 25 }) : complete(failure + '-job', 125));
      }
      if (method === 'cancel_live') return failure === 'transport'
        ? Promise.reject(new Error('cancel transport failed'))
        : Promise.resolve({ ok: false, error: { code: 'job_not_running' } });
      if (method === 'history') return Promise.resolve({ ok: true, items: [] });
      throw new Error('unexpected ' + method);
    });
    const run = h.app.runMode('router-internet');
    await flush();
    const outcome = await h.app.cancelTest();
    assert.equal(outcome.ok, false);
    assert.equal(h.app.state.cancelRequested, false);
    assert.equal(h.app.state.status, 'running');
    await h.timers.tick(500);
    await run;
    assert.equal(h.app.state.status, 'done');
    assert.equal(h.app.state.download, 125);
    assert.equal(polls, 2);
  }
}

async function testTerminalCancelClearsScheduledPollWakeup() {
  let polls = 0;
  const h = harness(method => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: 'timer-job' });
    if (method === 'live_status') { polls++; return Promise.resolve(status('timer-job', { phase: 'download', progress: 0.2, download_mbps: 20 })); }
    if (method === 'cancel_live') return Promise.resolve({ ok: true, job_id: 'timer-job', state: 'cancelled' });
    throw new Error('unexpected ' + method);
  });
  const run = h.app.runMode('router-internet');
  await flush();
  await h.app.cancelTest();
  await run;
  await h.timers.tick(500);
  assert.equal(polls, 1, 'acknowledged cancellation clears the scheduled polling wakeup');
  assert.equal(h.app.state.status, 'cancelled');
}

async function testSupersedingRunClearsScheduledPollWakeup() {
  let starts = 0, oldPolls = 0;
  const h = harness((method, params) => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: ++starts === 1 ? 'scheduled-old' : 'scheduled-new' });
    if (method === 'live_status') {
      if (params.job_id === 'scheduled-old') { oldPolls++; return Promise.resolve(status('scheduled-old', { phase: 'download', progress: 0.2, download_mbps: 10 })); }
      return Promise.resolve(complete('scheduled-new', 210));
    }
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    throw new Error('unexpected ' + method);
  });
  const oldRun = h.app.runMode('router-internet');
  await flush();
  await h.app.runMode('router-internet');
  await oldRun;
  await h.timers.tick(500);
  assert.equal(oldPolls, 1, 'supersession clears the old scheduled polling wakeup');
  assert.equal(h.app.state.download, 210);
}

async function testTraceBoundsWorkBeforeValidation() {
  const oldMalformed = { timestamp: 0, value: Infinity };
  const retained = Array.from({ length: 120 }, (_, index) => ({ timestamp: index + 1, value: index + 1 }));
  const responses = [
    { ok: true, job_id: 'trace-job' },
    status('trace-job', { phase: 'download', progress: 0.5, download_mbps: 120, download_trace: [oldMalformed].concat(retained) }),
    complete('trace-job', 120)
  ];
  const h = harness(() => Promise.resolve(responses.shift()));
  const run = h.app.internetTest();
  await flush();
  assert.equal(h.app.state.status, 'running');
  assert.equal(h.app.state.traces.download.length, 120);
  assert.equal(h.app.state.traces.download[0], 1);
  await h.timers.tick(500);
  await run;
}

async function testStaleSuccessCannotOverwriteNewRun() {
  const oldLive = deferred();
  let starts = 0;
  const h = harness(method => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: ++starts === 1 ? 'old-job' : 'new-job' });
    if (method === 'live_status') return starts === 1 ? oldLive.promise : Promise.resolve(complete('new-job', 200));
    if (method === 'history') return Promise.resolve({ ok: true, items: [{ id: 'new-history' }] });
    throw new Error('unexpected ' + method);
  });
  const oldRun = h.app.runMode('router-internet');
  await flush();
  const newRun = h.app.runMode('router-internet');
  await newRun;
  oldLive.resolve(complete('old-job', 999));
  await oldRun;
  assert.equal(h.app.state.status, 'done');
  assert.equal(h.app.state.activeJob, 'new-job');
  assert.equal(h.app.state.download, 200);
  assert.equal(h.app.state.results.internet.download_mbps, 200);
  assert.equal(h.app.state.history[0].id, 'new-history');
}

async function testStaleFailureCannotErrorNewRunOrRetry() {
  const oldLive = deferred();
  let starts = 0;
  const h = harness(method => {
    if (method === 'settings') return Promise.resolve({ ok: true, terms_accepted: true });
    if (method === 'start_live') return Promise.resolve({ ok: true, job_id: ++starts === 1 ? 'old-failure' : 'new-success' });
    if (method === 'live_status') return starts === 1 ? oldLive.promise : Promise.resolve(complete('new-success', 300));
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    throw new Error('unexpected ' + method);
  });
  const oldRun = h.app.runMode('router-internet');
  await flush();
  await h.app.runMode('router-internet');
  const pollsBefore = h.calls.filter(call => call.method === 'live_status').length;
  oldLive.reject(new Error('old transport failure'));
  await h.timers.tick(500);
  await oldRun;
  assert.equal(h.calls.filter(call => call.method === 'live_status').length, pollsBefore, 'stale failure does not retry');
  assert.equal(h.app.state.status, 'done');
  assert.equal(h.app.state.download, 300);
  assert.equal(h.app.state.pollFailures, 0);
}

async function testMalformedNumericSamplesBecomeStableErrors() {
  const malformed = [
    status('numeric-job', { phase: 'download', progress: 0.5, download_mbps: 'fast' }),
    status('numeric-job', { phase: 'ping', progress: 0.5, ping_ms: NaN }),
    status('numeric-job', { phase: 'upload', progress: 0.5, upload_mbps: 2, upload_trace: [{ timestamp: 1, value: Infinity }] })
  ];
  for (const jitter of ['1.2', -1, Infinity]) { const payload = complete('numeric-job', 10); payload.result.ping.jitter = jitter; malformed.push(payload); }
  for (const payload of malformed) {
    const responses = [{ ok: true, job_id: 'numeric-job' }, payload];
    const h = harness(() => Promise.resolve(responses.shift()));
    const pending = h.app.internetTest().then(() => null, reason => reason);
    await flush();
    assert.equal(h.app.state.status, 'error', 'malformed numeric input must fail without another poll');
    const error = await pending;
    assert.equal(error.code, 'malformed_live_status');
    assert.equal(h.app.state.status, 'error');
    assert.equal(Number.isFinite(h.app.state.gaugeValue), true);
  }
}

(async function main() {
  await testLiveSamplesReachComplete();
  await testResultEventWaitsForEnrichedTerminalState();
  await testCadenceAndRetries();
  await testStaleResponsesAreIgnored();
  await testCancelIsImmediateAndSingleShot();
  await testMalformedBackendStateIsStableError();
  await testRunningStartingPhaseNormalizesBeforeProgress();
  await testRunModeUsesTermsServerLiveAndHistory();
  await testHistoryRefreshFailureDoesNotRewriteCompletedMeasurement();
  await testTermsAcceptanceResumesLiveRun();
  await testDeviceRouterKeepsLocalBridge();
  await testCancelDuringLocalStopsAfterInflightBatch();
  await testTransientLocalCancelFailureCanBeRetried();
  await testAcknowledgedLocalCancelWinsLateBatchRejection();
  await testCancelDuringPendingLocalBeginCancelsBeforeProbes();
  await testCancelWinsAgainstInflightLocalRecord();
  await testLocalRecordWinnerIsAuthoritativeOverCancellation();
  await testLostCommittedRecordResponseRecoversAuthoritativeResult();
  await testLostRecordResponseReusesOverlappingCommittedCancellation();
  await testSupersedingRunCancelsInflightLocalRecord();
  await testLocalFailuresReleaseReservationAndKeepOriginalError();
  await testLocalMeasurementUsesFullWindowAndCumulativeElapsed();
  await testBothRunsLocalThenInternetAndKeepsSeparateResults();
  await testBothFailureKeepsCompletedLocalAndIdentifiesInternet();
  await testCompletedResultsRenderPathMetadataAndModeScope();
  await testTerminalInternetErrorsPreservePhaseAndLastSample();
  await testHistoryOutcomesConversionAndAnalytics();
  await testErrorRetryUsesFailedModeAndConsumesUiRejections();
  await testTermsAcceptanceRejectionBecomesRecoverableError();
  await testPhaseAnnouncementsAreDistinctFromThrottledNumbers();
  await testTerminalStatesDiscardQueuedNumericAnnouncements();
  await testModeSelectionIsLockedAndSemanticDuringActiveRun();
  await testModeLocksWhileTermsSettingsArePending();
  await testBothLocalFailureNeverStartsInternet();
  await testRunModeHandlesBackendTerminalStates();
  await testCancelWinsAgainstInflightStatus();
  await testCancelWinsAgainstInflightFailure();
  await testCancelDuringPendingStartCancelsBeforePolling();
  await testFailedCancelResumesPollingWithoutUnhandledRejection();
  await testTerminalCancelClearsScheduledPollWakeup();
  await testSupersedingRunClearsScheduledPollWakeup();
  await testStaleSuccessCannotOverwriteNewRun();
  await testStaleFailureCannotErrorNewRunOrRetry();
  await testMalformedNumericSamplesBecomeStableErrors();
  await testTraceBoundsWorkBeforeValidation();
  console.log('frontend live polling ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
