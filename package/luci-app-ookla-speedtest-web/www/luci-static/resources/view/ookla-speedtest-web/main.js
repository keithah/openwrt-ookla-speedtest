'use strict';
'require view';
'require rpc';
var specs={status:[],servers:[],start:['server_id'],start_live:['server_id'],live_status:['job_id'],cancel_live:['job_id'],history:[],delete_history:['id'],clear_history:[],settings:[],accept_terms:[],begin_local:[],cancel_local:['run_id'],local_download:['run_id','bytes'],local_upload:['run_id','data'],record_local:['run_id','download_mbps','upload_mbps','ping_ms']};
var call={};
Object.keys(specs).forEach(function(method){call[method]=rpc.declare({object:'ookla-speedtest-web',method:method,params:specs[method]})});
call.runTest=function(params){return call.start(params&&params.server_id)};
return view.extend({
 load:function(){return Promise.all([call.status(),call.history(),call.settings()])},
 render:function(){
  var root=E('div',{'class':'ookla-speedtest-web'});
  root.appendChild(E('link',{rel:'stylesheet',href:L.resource('ookla-speedtest-web/styles.css')}));
  var frame=E('iframe',{title:'Unofficial Ookla Speedtest dashboard',style:'width:100%;min-height:900px;border:0'});
  var bridge={call:function(method,params){if(method==='runTest')method='start';params=params||{};var values=(specs[method]||[]).map(function(name){return params[name]});return call[method].apply(null,values)},subscribe:function(){},navigate:function(){}};
  window.SpeedtestWebAdapter=bridge;
  frame.contentWindow.SpeedtestWebAdapter=bridge;
  frame.src=L.resource('ookla-speedtest-web/index.html');
  root.appendChild(frame);
  return root;
 },
 handleSaveApply:null,
 call:call,
 csrf:function(){return document.cookie||''}
});
