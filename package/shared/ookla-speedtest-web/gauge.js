(function(root, factory) {
  'use strict';
  var gauge = factory();
  if (typeof module === 'object' && module.exports) module.exports = gauge;
  else root.SpeedtestGauge = gauge;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var VIEWBOX_WIDTH = 100;
  var VIEWBOX_HEIGHT = 30;

  function finite(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  function niceCeiling(value) {
    if (value <= 10) return 10;
    var power = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
    var normalized = value / power;
    if (normalized <= 1) return power;
    if (normalized <= 2) return 2 * power;
    if (normalized <= 5) return 5 * power;
    return 10 * power;
  }

  function scaleFor(value, current) {
    var sample = Math.max(0, finite(value, 0));
    var activeScale = Math.max(0, finite(current, 0));
    // Five percent tolerance keeps borderline samples on the lower nice scale.
    var nextScale = niceCeiling(sample * 1.2 * 0.95);
    return Math.max(activeScale, nextScale);
  }

  function angleFor(value, max) {
    var limit = finite(max, 0);
    if (limit <= 0) return -135;
    var ratio = finite(value, 0) / limit;
    ratio = Math.max(0, Math.min(1, ratio));
    return -135 + ratio * 270;
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
    scaleFor: scaleFor,
    angleFor: angleFor,
    pushTrace: pushTrace,
    tracePath: tracePath
  };
});
