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

  function finite(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  function labelsFor(phase) {
    return (phase === 'ping' ? PING_LABELS : SPEED_LABELS).slice();
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
    pushTrace: pushTrace,
    tracePath: tracePath
  };
});
