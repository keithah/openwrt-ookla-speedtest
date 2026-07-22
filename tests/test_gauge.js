const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gaugePath = path.join(__dirname, '..', 'package', 'shared', 'ookla-speedtest-web', 'gauge.js');
const gauge = require(gaugePath);

assert.equal(gauge.scaleFor(0, 0), 10);
assert.equal(gauge.scaleFor(87, 50), 100);
assert.equal(gauge.scaleFor(624, 500), 1000);
assert.equal(gauge.scaleFor(20, 100), 100);
for (const [sample, expected] of [
  [8, 10], [9, 20],
  [17, 20], [18, 50],
  [43, 50], [44, 100],
  [87, 100], [88, 200],
  [175, 200], [176, 500],
  [438, 500], [439, 1000]
]) assert.equal(gauge.scaleFor(sample, 0), expected);
assert.equal(gauge.scaleFor(NaN, NaN), 10);
assert.equal(gauge.scaleFor(Infinity, 100), 100);
assert.equal(gauge.scaleFor(20, Infinity), 50);
assert.equal(gauge.scaleFor(-Infinity, -Infinity), 10);
const extremeScale = gauge.scaleFor(Number.MAX_VALUE, 0);
assert.ok(Number.isFinite(extremeScale));
assert.ok(extremeScale > 0);

assert.equal(gauge.angleFor(0, 500), -135);
assert.equal(gauge.angleFor(500, 500), 135);
assert.equal(gauge.angleFor(-1, 500), -135);
assert.equal(gauge.angleFor(501, 500), 135);

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
assert.equal(typeof browser.SpeedtestGauge.scaleFor, 'function');

console.log('gauge model ok');
