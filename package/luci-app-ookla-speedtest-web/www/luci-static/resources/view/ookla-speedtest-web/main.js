'use strict';
'require view';
'require rpc';
'require ui';
var call = {};
['status','servers','start','history','delete_history','clear_history','settings'].forEach(function (method) {
 call[method] = rpc.declare({ object: 'ookla-speedtest-web', method: method, params: method === 'start' ? ['server_id'] : (method === 'delete_history' ? ['id'] : []) });
});
call.runTest = function (params) { return call.start(params || {}); };
return view.extend({
 load: function () { return Promise.all([call.status(), call.history(), call.settings()]); },
 render: function (data) {
  var root = E('div', {'class':'ookla-speedtest-web'});
  root.appendChild(E('link', {rel:'stylesheet', href:L.resource('ookla-speedtest-web/styles.css')}));
  var frame=E('iframe', {title:'Ookla Speedtest dashboard', style:'width:100%;min-height:760px;border:0'});
  var bridge={call:function(m,p){if(m==='runTest')m='start';return call[m](p||{});},subscribe:function(){},navigate:function(){}};
  window.SpeedtestWebAdapter=bridge;
  frame.contentWindow.SpeedtestWebAdapter=bridge;
  frame.src=L.resource('ookla-speedtest-web/index.html'); root.appendChild(frame); return root;
 },
 handleSaveApply: null,
 call: call,
 csrf: function () { return document.cookie || ''; }
});
