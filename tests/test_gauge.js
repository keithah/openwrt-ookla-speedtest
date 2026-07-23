const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gaugePath = path.join(__dirname, '..', 'package', 'shared', 'ookla-speedtest-web', 'gauge.js');
const gauge = require(gaugePath);

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

const shortTrace = [1, 2];
assert.deepEqual(gauge.pushTrace(shortTrace, 3, 3), [1, 2, 3]);
assert.deepEqual(shortTrace, [1, 2]);
const fullTrace = [1, 2, 3];
assert.deepEqual(gauge.pushTrace(fullTrace, 4, 3), [2, 3, 4]);
assert.deepEqual(fullTrace, [1, 2, 3]);
assert.deepEqual(gauge.pushTrace([1, 2], 3, 0), []);
assert.deepEqual(gauge.pushTrace([1, 2], 3, -1), []);
assert.deepEqual(gauge.pushTrace([1, 2], 3, 2.9), [2, 3]);

for (const samples of [[], [5], [5, 5, 5], [-5, 10, 100], [NaN, Infinity, -Infinity]]) {
  const pathData = gauge.tracePath(samples, 10);
  assert.equal(typeof pathData, 'string');
  assert.doesNotMatch(pathData, /NaN|Infinity/);
  assert.match(pathData, /^(?:|M\d+(?:\.\d+)? \d+(?:\.\d+)?(?: L\d+(?:\.\d+)? \d+(?:\.\d+)?)*)$/);
}
assert.equal(gauge.tracePath([], 10), '');
assert.equal(gauge.tracePath([5], 10), 'M0 15');
assert.equal(gauge.tracePath([5, 5], 10), 'M0 15 L100 15');
assert.equal(gauge.tracePath([-5, 20], 10), 'M0 30 L100 0');
for (const invalidMax of [0, -1, NaN, Infinity, -Infinity]) {
  const pathData = gauge.tracePath([0, 5, 10], invalidMax);
  assert.doesNotMatch(pathData, /NaN|Infinity/);
  assert.match(pathData, /^M0 30 L50 15 L100 0$/);
}

const browser = {};
vm.runInNewContext(fs.readFileSync(gaugePath, 'utf8'), browser);
assert.equal(typeof browser.SpeedtestGauge.labelsFor, 'function');
assert.equal(typeof browser.SpeedtestGauge.createAnimator, 'function');

console.log('gauge model ok');
