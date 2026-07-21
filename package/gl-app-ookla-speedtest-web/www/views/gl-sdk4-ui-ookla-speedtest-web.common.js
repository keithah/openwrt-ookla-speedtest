'use strict';

module.exports = {
  name: 'ookla-speedtest-web',
  data: function () {
    return { frame: null, bridge: null };
  },
  mounted: function () {
    var self = this;
    this.bridge = {
      call: function (method, params) {
        if (method === 'runTest') method = 'start';
        if (typeof window.$request !== 'function') {
          return Promise.reject(new Error('GL.iNet authenticated request service unavailable'));
        }
        return window.$request(
          'call',
          ['sid', 'ookla-speedtest-web', method, params || {}],
          { timeout: method === 'start' ? 130000 : 30000 }
        );
      },
      subscribe: function () {},
      navigate: function () {}
    };
    window.SpeedtestWebAdapter = this.bridge;
    this.frame = document.createElement('iframe');
    this.frame.title = 'Unofficial Ookla Speedtest dashboard';
    this.frame.style.cssText = 'display:block;width:100%;min-height:900px;border:0';
    this.frame.onload = function () {
      try { self.frame.contentWindow.SpeedtestWebAdapter = self.bridge; } catch (_) {}
    };
    this.$refs.host.appendChild(this.frame);
    fetch('/luci-static/resources/ookla-speedtest-web/index.html', {
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (response) {
      if (!response.ok) throw new Error('Dashboard request failed: ' + response.status);
      return response.text();
    }).then(function (html) {
      self.frame.srcdoc = html.replace(
        '<head>',
        '<head><base href="/luci-static/resources/ookla-speedtest-web/">'
      );
    }).catch(function (error) {
      self.$refs.host.textContent = 'Unable to load Ookla Speedtest: ' + error.message;
    });
  },
  beforeDestroy: function () {
    if (this.frame) this.frame.remove();
    if (window.SpeedtestWebAdapter === this.bridge) delete window.SpeedtestWebAdapter;
  },
  render: function (createElement) {
    return createElement('div', {
      ref: 'host',
      attrs: { 'data-app': 'ookla-speedtest-web' },
      style: { width: '100%', minHeight: '900px' }
    });
  }
};
