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

  function networkSummary(result) {
    var context = result && result.network_context || {};
    if (context.vpn_kind === 'tailscale-exit') return 'Router → Internet via Tailscale exit node';
    if (context.vpn_kind === 'speedify') return 'Router → Internet via Speedify';
    if (context.vpn === true) return 'Router → Internet via ' + (context.vpn_name || 'VPN tunnel');
    if (context.possible_vpn === true) return 'Router → Internet via possible VPN/proxy path';
    return 'Router → Internet via direct WAN path';
  }

  // Every number and every Provider/Connection/Server/Location field this result
  // could show is already live on the dashboard above (metrics strip, ping/jitter/
  // loss row, network-context, and server rows). This card exists only for the
  // handful of things that live nowhere else, so completing a test never grows
  // the page or requires scrolling.
  function card(doc, result, kind) {
    var section = doc.createElement('article');
    section.className = 'result-card ' + kind;
    if (kind === 'local') {
      var warning = doc.createElement('p');
      warning.className = 'scope-note';
      warning.textContent = "Device → Router measures this browser's path to the router; it is not a public internet speed.";
      section.appendChild(warning);
      return section;
    }
    if (result.share_url) {
      var share = doc.createElement('button');
      share.type = 'button';
      share.className = 'share-result';
      share.textContent = 'Share result';
      share.setAttribute('data-share-url', result.share_url);
      section.appendChild(share);
      return section;
    }
    return null;
  }

  function render(container, mode, results) {
    if (!container) return;
    var doc = documentFor(container), values = results || {};
    clear(container);
    if ((' ' + (container.className || '') + ' ').indexOf(' final-result ') < 0) {
      container.className = ((container.className || '') + ' final-result').replace(/^\s+/, '');
    }
    if ((mode === 'device-router' || mode === 'both') && values.local) {
      var localCard = card(doc, values.local, 'local');
      if (localCard) container.appendChild(localCard);
    }
    if ((mode === 'router-internet' || mode === 'both') && values.internet) {
      var internetCard = card(doc, values.internet, 'internet');
      if (internetCard) container.appendChild(internetCard);
    }
  }

  return { networkSummary: networkSummary, render: render };
});
