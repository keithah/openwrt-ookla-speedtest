'use strict';
/* GL.iNet SDK view: reuse authenticated LuCI session and shared dashboard. */
window.OoklaSpeedtestGL = {mount:function (el, remote) { var frame=document.createElement('iframe'); frame.src='/luci-static/resources/ookla-speedtest-web/index.html'; frame.title='Ookla Speedtest dashboard'; frame.dataset.remote=remote ? 'true' : 'false'; frame.style.cssText='width:100%;height:760px;border:0'; el.appendChild(frame); }};
