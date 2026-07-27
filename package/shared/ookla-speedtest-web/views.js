(function(root, factory) {
  'use strict';
  var views = factory();
  if (typeof module === 'object' && module.exports) module.exports = views;
  else root.SpeedtestViews = views;
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var ABOUT_COPY = "OpenWrt Ookla Speedtest (Unofficial) runs Router → Internet tests on the router through the separately installed Ookla CLI. The web packages do not contain the Ookla binary. Device → Router measures this browser's authenticated path to the router, not the public internet. GoodCloud opens this same authenticated router interface; the package does not expose another public service.";

  function documentFor(container) {
    if (container && container.ownerDocument) return container.ownerDocument;
    if (typeof document !== 'undefined') return document;
    throw new Error('A DOM document is required');
  }

  function clear(container) {
    while (container && container.firstChild) container.removeChild(container.firstChild);
  }

  function add(doc, parent, tag, text, className) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function metric(value) {
    if (value == null || value === '') return '—';
    return String(Math.round(Number(value) * 100) / 100);
  }

  function historyMbps(row, key) {
    if (row[key + '_mbps'] != null) return metric(row[key + '_mbps']) + ' Mbps';
    var bandwidth = row[key] && row[key].bandwidth;
    if (bandwidth == null) return '—';
    return metric(row.kind === 'router-internet' ? bandwidth * 8 / 1000000 : bandwidth) + ' Mbps';
  }

  function outcome(row) {
    if (row.outcome === 'cancelled') return 'Cancelled';
    if (row.outcome && row.outcome !== 'success') {
      var code = row.error_code || row.error && row.error.code;
      return 'Failed' + (code ? ' (' + code + ')' : '');
    }
    return '';
  }

  function pathLabel(kind) {
    return kind === 'device-router' ? 'Device → Router' : 'Router → Internet';
  }

  function renderHistory(doc, container, state, actions) {
    add(doc, container, 'h2', 'History');
    var region = doc.createElement('div');
    region.className = 'history-scroll';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Speedtest history table');
    region.setAttribute('tabindex', '0');
    var table = doc.createElement('table'), head = doc.createElement('tr');
    ['Path', 'Date', 'Location', 'Outcome', 'Download', 'Upload', 'Ping', 'Actions'].forEach(function(label) {
      add(doc, head, 'th', label);
    });
    table.appendChild(head);
    (state.history || []).forEach(function(row) {
      var tr = doc.createElement('tr');
      var values = [pathLabel(row.kind), row.date || new Date((row.timestamp || 0) * 1000).toLocaleString(),
        row.location || '—', outcome(row), historyMbps(row, 'download'), historyMbps(row, 'upload'),
        row.ping_ms != null ? metric(row.ping_ms) + ' ms' : row.latency != null ? metric(row.latency) + ' ms' : '—'];
      values.forEach(function(value, index) {
        var className = index === 0 ? 'mode-badge ' + row.kind : index === 3 ? 'outcome ' + (row.outcome === 'error' || row.outcome === 'failed' ? 'failed' : row.outcome || 'success') : '';
        add(doc, tr, 'td', value, className);
      });
      var actionCell = doc.createElement('td');
      var open = add(doc, actionCell, 'button', 'View result');
      open.onclick = function() { if (actions.openResult) return actions.openResult(row); };
      if (actions.deleteHistory) {
        var remove = add(doc, actionCell, 'button', 'Delete');
        remove.onclick = function() { return actions.deleteHistory(row.id); };
      }
      tr.appendChild(actionCell);
      table.appendChild(tr);
    });
    region.appendChild(table);
    container.appendChild(region);
    if (actions.clearHistory) {
      var clearButton = add(doc, container, 'button', 'Clear history');
      clearButton.onclick = actions.clearHistory;
    }
  }

  function valueFor(row, key) {
    if (row[key] != null) return Number(row[key]);
    if ((key === 'download_mbps' || key === 'upload_mbps') && row[key.replace('_mbps', '')] && row[key.replace('_mbps', '')].bandwidth != null) {
      var bandwidth = Number(row[key.replace('_mbps', '')].bandwidth);
      return row.kind === 'router-internet' ? bandwidth * 8 / 1000000 : bandwidth;
    }
    if (key === 'ping_ms' && row.latency != null) return Number(row.latency);
    return null;
  }

  function renderSeries(doc, section, rows, label, key, unit) {
    var values = rows.map(function(row) { return valueFor(row, key); }).filter(function(number) { return number != null && isFinite(number); });
    if (!values.length) return;
    var average = values.reduce(function(sum, number) { return sum + number; }, 0) / values.length;
    add(doc, section, 'p', label + ' average ' + metric(average) + ' ' + unit + ' · min ' + metric(Math.min.apply(Math, values)) + ' · max ' + metric(Math.max.apply(Math, values)));
  }

  function renderAnalytics(doc, container, state) {
    add(doc, container, 'h2', 'Analytics');
    ['router-internet', 'device-router'].forEach(function(kind) {
      var rows = (state.history || []).filter(function(row) { return row.kind === kind && row.outcome === 'success'; });
      var section = doc.createElement('section');
      section.className = 'analytics-series ' + kind;
      add(doc, section, 'h3', pathLabel(kind) + ': ' + rows.length + ' recorded test' + (rows.length === 1 ? '' : 's'));
      renderSeries(doc, section, rows, 'Download', 'download_mbps', 'Mbps');
      renderSeries(doc, section, rows, 'Upload', 'upload_mbps', 'Mbps');
      renderSeries(doc, section, rows, 'Ping', 'ping_ms', 'ms');
      container.appendChild(section);
    });
  }

  function setting(doc, container, label, value) {
    add(doc, container, 'p', label + ': ' + (value == null || value === '' ? 'Automatic' : String(value)), 'setting-row');
  }

  function selectSetting(doc, container, label, name, value, choices, actions) {
    var row = doc.createElement('label');
    row.className = 'setting-row';
    add(doc, row, 'span', label);
    var select = doc.createElement('select');
    select.setAttribute('data-setting', name);
    choices.forEach(function(choice) {
      var option = doc.createElement('option');
      option.value = String(choice[0]);
      option.textContent = choice[1];
      if (String(choice[0]) === String(value)) option.selected = true;
      select.appendChild(option);
    });
    select.value = String(value);
    select.onchange = function() { return actions.saveSettings ? actions.saveSettings((function(){var change={};change[name]=select.value;return change})()) : undefined; };
    row.appendChild(select);
    container.appendChild(row);
  }

  function renderSettings(doc, container, state, actions) {
    var settings = state.settings || {};
    add(doc, container, 'h2', 'Settings');
    setting(doc, container, 'Server preference', settings.server_name || settings.server_id || state.server && (state.server.name || state.server.id));
    selectSetting(doc, container, 'Default mode', 'default_mode', settings.default_mode || 'router-internet', [['router-internet','Router → Internet'],['device-router','Device → Router'],['both','Both']], actions);
    selectSetting(doc, container, 'Retention', 'history_retention', settings.history_retention || 100, [[25,'25'],[50,'50'],[100,'100'],[250,'250']], actions);
    selectSetting(doc, container, 'Display options', 'motion', settings.motion || 'system', [['system','System'],['full','Full'],['reduced','Reduced']], actions);
    setting(doc, container, 'Terms status', settings.terms_accepted ? 'Accepted' : 'Not accepted');
  }

  function renderAbout(doc, container) {
    add(doc, container, 'h2', 'About');
    add(doc, container, 'p', ABOUT_COPY);
  }

  function render(container, view, state, actions) {
    if (!container) return;
    var doc = documentFor(container);
    clear(container);
    state = state || {};
    actions = actions || {};
    if (view === 'history') renderHistory(doc, container, state, actions);
    else if (view === 'analytics') renderAnalytics(doc, container, state);
    else if (view === 'settings') renderSettings(doc, container, state, actions);
    else if (view === 'about') renderAbout(doc, container);
  }

  return { render: render };
});
