(function(){'use strict';
var listeners=[];
var announcementTimer=null,lastAnnouncementAt=0,queuedAnnouncement='';
var state={view:'home',mode:'router-internet',status:'idle',phase:'idle',progress:0,gaugeValue:0,gaugeUnit:'Mbps',gaugeScale:100,traces:{download:[],upload:[]},activeJob:null,cancelRequested:false,pollFailures:0,download:null,upload:null,ping:null,jitter:null,loss:null,server:{name:'Auto',sponsor:'',city:'',latency:'—'},history:[],results:{internet:null,local:null},isp:'ISP',connection:'Connection',network:null,range:7,servers:[],pendingMode:null};
function el(id){return document.getElementById(id)}
function text(node,value){if(node)node.textContent=value}
function notify(){listeners.forEach(function(fn){fn(state)})}
function subscribe(fn){listeners.push(fn);return function(){listeners=listeners.filter(function(x){return x!==fn})}}
function navigate(view){state.view=view;render();notify()}
var adapter={call:function(){return Promise.reject(new Error('Speedtest adapter not configured'))},subscribe:subscribe,navigate:navigate};
try{if(window.SpeedtestWebAdapter)adapter=window.SpeedtestWebAdapter;else if(window.parent&&window.parent!==window&&window.parent.SpeedtestWebAdapter)adapter=window.parent.SpeedtestWebAdapter}catch(_){ }
function checked(method,params){return Promise.resolve(adapter.call(method,params||{})).then(function(x){if(x&&x.ok===false){var e=new Error(x.error&&x.error.message||x.error&&x.error.code||'Request failed');e.code=x.error&&x.error.code;throw e}return x||{}})}
function mbps(bytes,elapsed){return Math.round((bytes*8/Math.max(elapsed,1)/1000)*100)/100}
function localTest(){var size=32768,count=16,payload=new Array(size+1).join('0'),started=performance.now();return Promise.all(Array.from({length:count},function(){return checked('local_download',{bytes:size})})).then(function(rows){var down=mbps(rows.reduce(function(n,r){return n+(r.bytes||0)},0),performance.now()-started);var pingStart=performance.now();return checked('local_download',{bytes:1024}).then(function(){var ping=Math.round((performance.now()-pingStart)*100)/100;var uploadStart=performance.now();return Promise.all(Array.from({length:count},function(){return checked('local_upload',{data:payload})})).then(function(ups){var up=mbps(ups.reduce(function(n,r){return n+(r.bytes||0)},0),performance.now()-uploadStart);return checked('record_local',{download_mbps:String(down),upload_mbps:String(up),ping_ms:String(ping)}).then(function(){return{kind:'device-router',download_mbps:down,upload_mbps:up,ping_ms:ping}})})})})}
function liveError(code,message){var error=new Error(message||code);error.code=code;return error}
function resultMbps(result,key,fallback){var metric=result&&result[key];return metric&&metric.bandwidth!=null?Math.round(metric.bandwidth*8/10000)/100:fallback}
function liveResult(payload){var result=payload.result||{};return{kind:'router-internet',download_mbps:resultMbps(result,'download',payload.download_mbps),upload_mbps:resultMbps(result,'upload',payload.upload_mbps),ping_ms:result.ping&&result.ping.latency!=null?result.ping.latency:payload.ping_ms,server:result.server,isp:result.isp,interface:result.interface,network_context:result.network_context}}
function traceValues(rows){if(!Array.isArray(rows))return null;return rows.map(function(row){return row&&typeof row==='object'?Number(row.value):Number(row)}).filter(function(value){return isFinite(value)&&value>=0}).slice(-120)}
function setLiveError(error,jobId){if(jobId&&state.activeJob!==jobId)return;state.status='error';state.phase='error';render();notify();return error}
function applyLiveStatus(payload,jobId){
  if(state.activeJob!==jobId||payload&&payload.job_id&&payload.job_id!==jobId)return false;
  if(!payload||typeof payload!=='object')throw liveError('malformed_live_status');
  var backendState=payload.state,phase=payload.phase;
  if(['starting','running','complete','cancelled','error'].indexOf(backendState)<0)throw liveError('malformed_live_status');
  if(backendState==='error'){state.status='error';state.phase='error';render();notify();return true}
  if(backendState==='cancelled'){state.status='cancelled';state.phase='cancelled';render();notify();return true}
  if(backendState==='starting')phase='ping';
  if(backendState==='complete')phase='complete';
  var phases=['idle','ping','download','upload','complete'];
  var current=phases.indexOf(state.phase),next=phases.indexOf(phase);
  if(next<0||current<0||next<current)throw liveError('malformed_live_status');
  state.phase=phase;state.status=phase==='complete'?'done':'running';
  if(payload.progress!=null){var progress=Number(payload.progress);if(!isFinite(progress))throw liveError('malformed_live_status');state.progress=Math.max(0,Math.min(100,progress*100))}
  if(payload.ping_ms!=null)state.ping=Number(payload.ping_ms);
  if(payload.jitter_ms!=null)state.jitter=Number(payload.jitter_ms);
  if(payload.packet_loss!=null)state.loss=Number(payload.packet_loss);
  if(payload.download_mbps!=null)state.download=Number(payload.download_mbps);
  if(payload.upload_mbps!=null)state.upload=Number(payload.upload_mbps);
  var downloadTrace=traceValues(payload.download_trace),uploadTrace=traceValues(payload.upload_trace);
  if(downloadTrace)state.traces.download=downloadTrace;
  if(uploadTrace)state.traces.upload=uploadTrace;
  if(phase==='ping'){state.gaugeValue=state.ping||0;state.gaugeUnit='ms'}
  else if(phase==='upload'){state.gaugeValue=state.upload||0;state.gaugeUnit='Mbps'}
  else{state.gaugeValue=state.download||0;state.gaugeUnit='Mbps'}
  state.gaugeScale=SpeedtestGauge.scaleFor(state.gaugeValue,state.gaugeScale);
  if(payload.result){state.isp=payload.result.isp||state.isp;state.connection=payload.result.interface&&payload.result.interface.name||state.connection;state.network=payload.result.network_context||state.network;if(payload.result.server)state.server=payload.result.server;if(payload.result.packetLoss!=null)state.loss=Number(payload.result.packetLoss)}
  render();notify();return true;
}
function pollLive(jobId){
  if(state.activeJob!==jobId) return Promise.reject(liveError('stale_live_job'));
  if(state.cancelRequested) return Promise.reject(liveError('cancelled'));
  return checked('live_status',{job_id:jobId}).then(function(payload){
    state.pollFailures=0;applyLiveStatus(payload,jobId);
    if(state.status==='done')return liveResult(payload);
    if(state.status==='cancelled')throw liveError('cancelled');
    if(state.status==='error')throw liveError(payload.error&&payload.error.code||'speedtest_failed');
    return new Promise(function(resolve){setTimeout(resolve,500)}).then(function(){return pollLive(jobId)});
  },function(error){
    if(error.code){setLiveError(error,jobId);throw error}
    state.pollFailures+=1;
    if(state.pollFailures>3){setLiveError(error,jobId);throw error}
    var wait=[500,1000,2000][state.pollFailures-1];
    return new Promise(function(resolve){setTimeout(resolve,wait)}).then(function(){return pollLive(jobId)});
  }).catch(function(error){if(error.code==='malformed_live_status')setLiveError(error,jobId);throw error});
}
function internetTest(){var params={};if(state.server.id)params.server_id=state.server.id;state.cancelRequested=false;state.pollFailures=0;return checked('start_live',params).then(function(started){if(!started.job_id)throw liveError('malformed_live_status');state.activeJob=started.job_id;state.status='running';state.phase='ping';render();notify();return pollLive(started.job_id)})}
function cancelTest(){var jobId=state.activeJob;if(!jobId||state.cancelRequested)return Promise.resolve({ok:false});state.cancelRequested=true;state.status='cancelled';state.phase='cancelled';render();notify();return checked('cancel_live',{job_id:jobId})}
function resultCard(title,r){var card=document.createElement('article');card.className='result-card';var h=document.createElement('h2');h.textContent=title;card.appendChild(h);[['Download',r.download_mbps,'Mbps'],['Upload',r.upload_mbps,'Mbps'],['Ping',r.ping_ms,'ms']].forEach(function(row){var p=document.createElement('p');p.textContent=row[0]+' '+(row[1]==null?'—':row[1])+' '+row[2];card.appendChild(p)});if(r.isp){var isp=document.createElement('small');isp.textContent='ISP: '+r.isp;card.appendChild(isp)}return card}
function renderResults(){var box=el('results');while(box&&box.firstChild)box.removeChild(box.firstChild);if(!box)return;if(state.results.internet)box.appendChild(resultCard('Router → Internet',state.results.internet));if(state.results.local)box.appendChild(resultCard('Device → Router',state.results.local))}
function metric(value){return value==null||value===''?'—':String(Math.round(Number(value)*100)/100)}
function announceGauge(message){
  var node=el('live-announcer');if(!node||!message||node.textContent===message)return;
  var wait=Number(node.getAttribute('data-throttle-ms'))||1000,remaining=wait-(Date.now()-lastAnnouncementAt);
  if(remaining<=0){text(node,message);lastAnnouncementAt=Date.now();return}
  queuedAnnouncement=message;if(announcementTimer)return;
  announcementTimer=setTimeout(function(){text(node,queuedAnnouncement);lastAnnouncementAt=Date.now();queuedAnnouncement='';announcementTimer=null},remaining);
}
function renderGauge(){
  var gauge=el('live-gauge');if(!gauge||typeof SpeedtestGauge==='undefined')return;
  var phase=state.phase==='ping'?'ping':state.phase==='upload'?'upload':state.phase==='download'?'download':state.status==='done'?'complete':'idle';
  var scale=Number(state.gaugeScale)||SpeedtestGauge.scaleFor(Number(state.gaugeValue)||0,0);
  var angle=SpeedtestGauge.angleFor(Number(state.gaugeValue)||0,scale);
  var progress=Math.max(0,Math.min(100,Number(state.progress)||0));
  gauge.setAttribute('data-phase',phase);gauge.setAttribute('data-status',state.status);gauge.style.setProperty('--gauge-progress',String(progress));
  el('gauge-needle').setAttribute('transform','rotate('+angle+' 230 230)');
  text(el('phase-label'),phase==='ping'?'Ping':phase==='download'?'Download':phase==='upload'?'Upload':phase==='complete'?'Complete':'Ready');
  text(el('gauge-value'),metric(state.gaugeValue));text(el('gauge-unit'),state.gaugeUnit||'Mbps');
  document.querySelectorAll('[data-gauge-scale]').forEach(function(label,index){label.textContent=metric(scale*index/4)});
  text(el('metric-download'),metric(state.download));text(el('metric-upload'),metric(state.upload));text(el('metric-ping'),metric(state.ping));text(el('metric-jitter'),metric(state.jitter));text(el('metric-loss'),metric(state.loss));
  el('download-trace').setAttribute('d',SpeedtestGauge.tracePath(state.traces.download,scale));
  el('upload-trace').setAttribute('d',SpeedtestGauge.tracePath(state.traces.upload,scale));
  var compact=state.status==='idle'||state.status==='done'||state.status==='cancelled'||state.status==='error';el('gauge-dial').hidden=compact;el('gauge-readout').hidden=compact;
  el('primary-metrics').hidden=state.status==='idle';document.querySelector('.latency-strip').hidden=state.status==='idle';
  el('go-control').hidden=state.status==='running';el('cancel-test').hidden=state.status!=='running';
  if(state.status==='running'||state.status==='done')announceGauge(phase==='complete'?'Test complete':phase+' '+metric(state.gaugeValue)+' '+(state.gaugeUnit||'Mbps'));
}
function renderHistory(v){var h=document.createElement('h2');h.textContent='History';v.appendChild(h);var table=document.createElement('table');var head=document.createElement('tr');['Path','Date','Download','Upload','Ping','Actions'].forEach(function(x){var th=document.createElement('th');th.textContent=x;head.appendChild(th)});table.appendChild(head);state.history.forEach(function(r){var tr=document.createElement('tr'),vals=[r.kind==='device-router'?'Device → Router':'Router → Internet',r.date||new Date((r.timestamp||0)*1000).toLocaleString(),r.download_mbps||r.download&&r.download.bandwidth||'—',r.upload_mbps||r.upload&&r.upload.bandwidth||'—',r.ping_ms||r.latency||'—'];vals.forEach(function(x){var td=document.createElement('td');td.textContent=x;tr.appendChild(td)});var td=document.createElement('td'),b=document.createElement('button');b.textContent='Delete';b.onclick=function(){checked('delete_history',{id:r.id}).then(loadHistory)};td.appendChild(b);tr.appendChild(td);table.appendChild(tr)});v.appendChild(table)}
function renderAnalytics(v){var h=document.createElement('h2');h.textContent='Analytics';v.appendChild(h);['router-internet','device-router'].forEach(function(kind){var rows=state.history.filter(function(r){return r.kind===kind});var p=document.createElement('p');p.textContent=(kind==='device-router'?'Device → Router':'Router → Internet')+': '+rows.length+' recorded test'+(rows.length===1?'':'s');v.appendChild(p)})}
function render(){document.querySelectorAll('[data-mode]').forEach(function(b){b.classList.toggle('active',b.getAttribute('data-mode')===state.mode)});text(el('route-label'),state.mode==='device-router'?'Device → Router':state.mode==='both'?'Device → Router + Router → Internet':'Router → Internet');text(el('scope-note'),state.mode==='device-router'?'Tests this device’s Wi‑Fi or Ethernet path to the router—not the internet.':state.mode==='both'?'Runs both paths from one action and reports them separately.':'Tests the router’s connection to the internet—not this device.');text(el('status'),state.status==='running'?'Testing…':state.status==='error'?'Test failed':state.status==='cancelled'?'Test cancelled':state.status==='done'?'Test complete':'Ready to test your connection');text(el('isp-badge'),state.isp||'ISP');text(el('network-badge'),state.connection||'Connection');text(el('vpn-callout'),state.network&&state.network.note||'');text(el('server-name'),state.server.name||'Auto');text(el('server-detail'),[state.server.sponsor,state.server.location||state.server.city].filter(Boolean).join(' · ')||'Select a server');renderGauge();renderResults();var v=el('view');while(v&&v.firstChild)v.removeChild(v.firstChild);if(!v||state.view==='home')return;if(state.view==='history')renderHistory(v);else if(state.view==='analytics')renderAnalytics(v);else if(state.view==='settings')v.appendChild(document.createTextNode('History and acceptance are stored locally on this router.'));else if(state.view==='about')v.appendChild(document.createTextNode('Unofficial OpenWrt frontend. Device → Router measures this browser’s authenticated RPC path to the router. Router → Internet runs the separate Ookla CLI on the router. Both results are stored and displayed separately.'))}
function executeMode(mode){state.status='running';state.phase=mode==='device-router'?'download':'idle';state.progress=0;state.gaugeValue=0;state.gaugeUnit='Mbps';state.gaugeScale=100;state.traces={download:[],upload:[]};state.activeJob=null;state.cancelRequested=false;state.pollFailures=0;state.download=null;state.upload=null;state.ping=null;state.jitter=null;state.loss=null;state.results={internet:null,local:null};render();var internet=mode!=='device-router'?internetTest():Promise.resolve(null),local=mode!=='router-internet'?localTest():Promise.resolve(null);return Promise.all([internet,local]).then(function(results){state.results.internet=results[0];state.results.local=results[1];var summary=results[0]||results[1];if(summary){state.download=summary.download_mbps;state.upload=summary.upload_mbps;state.ping=summary.ping_ms;state.gaugeValue=summary.download_mbps||0;state.gaugeScale=SpeedtestGauge.scaleFor(state.gaugeValue,state.gaugeScale);state.progress=100}if(results[0]){state.isp=results[0].isp||state.isp;state.connection=results[0].interface&&results[0].interface.name||state.connection;state.network=results[0].network_context;if(results[0].server)state.server=results[0].server}state.status='done';state.phase='complete';return loadHistory()}).catch(function(err){if(err.code==='terms_required'){state.status='idle';state.phase='idle';state.pendingMode=mode;el('terms-dialog').showModal()}else if(err.code==='cancelled'){state.status='cancelled';state.phase='cancelled'}else{state.status='error';state.phase='error'}render();notify()})}
function runMode(mode){if(mode==='device-router')return executeMode(mode);return checked('settings',{}).then(function(settings){if(!settings.terms_accepted){state.pendingMode=mode;el('terms-dialog').showModal();return}return executeMode(mode)}).catch(function(err){state.status='error';render();notify();throw err})}
function loadHistory(){return checked('history',{}).then(function(x){state.history=x.items||[];render();notify()})}
document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-mode]').forEach(function(b){b.addEventListener('click',function(){state.mode=b.getAttribute('data-mode');render()})});document.querySelectorAll('[data-view]').forEach(function(b){b.addEventListener('click',function(){state.view=b.getAttribute('data-view');render()})});el('go-control').addEventListener('click',function(){runMode(state.mode)});el('cancel-test').addEventListener('click',cancelTest);el('accept-terms').addEventListener('click',function(){checked('accept_terms',{}).then(function(){var mode=state.pendingMode||state.mode;state.pendingMode=null;runMode(mode)})});el('server-picker').addEventListener('click',function(){el('server-panel').hidden=false;checked('servers',{}).then(function(x){state.servers=x.servers||x||[]})});el('server-search').addEventListener('input',function(){var q=this.value.toLowerCase(),box=el('server-results');while(box.firstChild)box.removeChild(box.firstChild);state.servers.filter(function(s){return(s.name||'').toLowerCase().indexOf(q)>=0}).forEach(function(s){var b=document.createElement('button');b.textContent=(s.name||'Server')+' '+(s.location||'');b.onclick=function(){state.server=s;el('server-panel').hidden=true;render()};box.appendChild(b)})});loadHistory().catch(function(){render()})});
if(typeof window!=='undefined')window.SpeedtestWeb={adapter:adapter,state:state,render:render,runMode:runMode,localTest:localTest,internetTest:internetTest,applyLiveStatus:applyLiveStatus,cancelTest:cancelTest};
})();
