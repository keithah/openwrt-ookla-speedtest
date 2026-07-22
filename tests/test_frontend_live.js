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
  const h = harness((method, params) => {
    if (method === 'local_download') return Promise.resolve({ ok: true, bytes: params.bytes });
    if (method === 'local_upload') return Promise.resolve({ ok: true, bytes: params.data.length });
    if (method === 'record_local') return Promise.resolve({ ok: true });
    if (method === 'history') return Promise.resolve({ ok: true, items: [] });
    throw new Error('unexpected ' + method);
  });
  await h.app.runMode('device-router');
  assert.equal(h.calls.filter(call => call.method === 'local_download').length, 17);
  assert.equal(h.calls.filter(call => call.method === 'local_upload').length, 16);
  assert.equal(h.calls.filter(call => call.method === 'record_local').length, 1);
  assert.equal(h.calls.some(call => ['settings', 'start_live', 'live_status', 'runTest'].includes(call.method)), false);
  assert.equal(h.app.state.status, 'done');
  assert.ok(h.app.state.results.local);
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
  await testCadenceAndRetries();
  await testStaleResponsesAreIgnored();
  await testCancelIsImmediateAndSingleShot();
  await testMalformedBackendStateIsStableError();
  await testRunningStartingPhaseNormalizesBeforeProgress();
  await testRunModeUsesTermsServerLiveAndHistory();
  await testTermsAcceptanceResumesLiveRun();
  await testDeviceRouterKeepsLocalBridge();
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
