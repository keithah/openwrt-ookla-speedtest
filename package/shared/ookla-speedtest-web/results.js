(function(root, factory) {
  'use strict';
  var results = factory();
  if (typeof module === 'object' && module.exports) module.exports = results;
  else root.SpeedtestResults = results;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  function documentFor(container) {
    if (container && container.ownerDocument) return container.ownerDocument;
    if (typeof document !== 'undefined') return document;
    throw new Error('A DOM document is required');
  }

  function clear(container) {
    while (container && container.firstChild) container.removeChild(container.firstChild);
  }

  function value(input) {
    return input == null || input === '' ? '—' : String(input);
  }

  function line(doc, container, label, input, unit, optional) {
    if (optional && input == null) return;
    var node = doc.createElement('p');
    node.textContent = label + ' ' + value(input) + (unit ? ' ' + unit : '');
    container.appendChild(node);
  }

  function detail(doc, container, label, parts) {
    var content = parts.filter(function(part) { return part != null && part !== ''; });
    if (!content.length) return;
    var node = doc.createElement('small');
    node.textContent = label + ': ' + content.join(' · ');
    container.appendChild(node);
  }

  function networkSummary(result) {
    var context = result && result.network_context || {};
    if (context.vpn_kind === 'tailscale-exit') return 'Router → Internet via Tailscale exit node';
    if (context.vpn_kind === 'speedify') return 'Router → Internet via Speedify';
    if (context.vpn === true) return 'Router → Internet via ' + (context.vpn_name || 'VPN tunnel');
    if (context.possible_vpn === true) return 'Router → Internet via possible VPN/proxy path';
    return 'Router → Internet via direct WAN path';
  }

  function card(doc, title, result, kind) {
    var section = doc.createElement('article');
    section.className = 'result-card ' + kind;
    var heading = doc.createElement('h2');
    heading.textContent = title;
    section.appendChild(heading);
    line(doc, section, 'Download', result.download_mbps, 'Mbps');
    line(doc, section, 'Upload', result.upload_mbps, 'Mbps');
    line(doc, section, 'Ping', result.ping_ms, 'ms');
    if (kind === 'local') {
      var warning = doc.createElement('p');
      warning.className = 'scope-note';
      warning.textContent = "Device → Router measures this browser's path to the router; it is not a public internet speed.";
      section.appendChild(warning);
      return section;
    }
    var ping = result.ping || {}, download = result.download || {}, upload = result.upload || {};
    line(doc, section, 'Idle latency', result.idle_latency_ms != null ? result.idle_latency_ms : ping.latency, 'ms', true);
    line(doc, section, 'Download latency', result.download_latency_ms != null ? result.download_latency_ms : download.latency, 'ms', true);
    line(doc, section, 'Upload latency', result.upload_latency_ms != null ? result.upload_latency_ms : upload.latency, 'ms', true);
    line(doc, section, 'Jitter', result.jitter_ms != null ? result.jitter_ms : ping.jitter, 'ms', true);
    line(doc, section, 'Loss', result.loss_percent != null ? result.loss_percent : result.packetLoss, '%', true);
    detail(doc, section, 'ISP', [result.isp]);
    var connection = result.interface || {};
    if (typeof connection === 'string') detail(doc, section, 'WAN interface/type', [connection]);
    else detail(doc, section, 'WAN interface/type', [connection.name, connection.type || connection.connectionType]);
    var server = result.server || {};
    detail(doc, section, 'Server', [server.name, server.sponsor, server.location || server.city || server.country]);
    var summary = doc.createElement('p');
    summary.className = 'network-summary';
    summary.textContent = networkSummary(result);
    section.appendChild(summary);
    return section;
  }

  function render(container, mode, results) {
    if (!container) return;
    var doc = documentFor(container), values = results || {};
    clear(container);
    if ((' ' + (container.className || '') + ' ').indexOf(' final-result ') < 0) {
      container.className = ((container.className || '') + ' final-result').replace(/^\s+/, '');
    }
    if ((mode === 'device-router' || mode === 'both') && values.local) {
      container.appendChild(card(doc, 'Device → Router', values.local, 'local'));
    }
    if ((mode === 'router-internet' || mode === 'both') && values.internet) {
      container.appendChild(card(doc, 'Router → Internet', values.internet, 'internet'));
    }
  }

  return { networkSummary: networkSummary, render: render };
});
