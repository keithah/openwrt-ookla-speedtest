(function(root, factory) {
  'use strict';
  var gauge = factory();
  if (typeof module === 'object' && module.exports) module.exports = gauge;
  else root.SpeedtestGauge = gauge;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var VIEWBOX_WIDTH = 100;
  var VIEWBOX_HEIGHT = 30;
  var SPEED_LABELS = [0, 5, 10, 50, 100, 250, 500, 750, 1000];
  var PING_LABELS = [0, 5, 10, 20, 50, 100, 250, 500];
  var START_ANGLE = -135;
  var SWEEP = 270;

  function finite(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

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

  function pushTrace(samples, value, limit) {
    var trace = Array.isArray(samples) ? samples.slice() : [];
    var size = Math.max(0, Math.floor(finite(limit, 0)));
    if (!size) return [];
    trace.push(value);
    return trace.slice(-size);
  }

  function point(value, max) {
    var bounded = Math.max(0, Math.min(max, finite(value, 0)));
    return VIEWBOX_HEIGHT - bounded / max * VIEWBOX_HEIGHT;
  }

  function coordinate(value) {
    return String(Math.round(value * 1000) / 1000);
  }

  function tracePath(samples, max) {
    if (!Array.isArray(samples) || !samples.length) return '';
    var values = samples.map(function(value) { return finite(value, 0); });
    var limit = finite(max, 0);
    if (limit <= 0) {
      limit = Math.max.apply(Math, values.concat([1]));
      if (limit <= 0) limit = 1;
    }
    return values.map(function(value, index) {
      var x = values.length === 1 ? 0 : index / (values.length - 1) * VIEWBOX_WIDTH;
      return (index ? 'L' : 'M') + coordinate(x) + ' ' + coordinate(point(value, limit));
    }).join(' ');
  }

  return {
    labelsFor: labelsFor,
    angleFor: angleFor,
    createAnimator: createAnimator,
    pushTrace: pushTrace,
    tracePath: tracePath
  };
});
