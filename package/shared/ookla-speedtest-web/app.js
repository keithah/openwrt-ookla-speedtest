(function(){'use strict';
var listeners=[];
var announcementTimer=null,lastAnnouncementAt=0,queuedAnnouncement='';
var runGeneration=0;
var pollTimer=null,pollWake=null,pollTimerToken=null,cancelPromise=null,cancelPromiseToken=null,localCancelPromise=null,localCancelPromiseToken=null;
var state={view:'home',mode:'router-internet',status:'idle',phase:'idle',progress:0,gaugeValue:0,gaugeUnit:'Mbps',gaugeScale:100,traces:{download:[],upload:[]},activeJob:null,localRunId:null,cancelRequested:false,pollFailures:0,errorPath:null,errorCode:null,download:null,upload:null,ping:null,jitter:null,loss:null,server:{name:'Auto',sponsor:'',city:'',latency:'—'},history:[],results:{internet:null,local:null},isp:'ISP',connection:'Connection',network:null,range:7,servers:[],pendingMode:null};
function el(id){return document.getElementById(id)}
function text(node,value){if(node)node.textContent=value}
function notify(){listeners.forEach(function(fn){fn(state)})}
function subscribe(fn){listeners.push(fn);return function(){listeners=listeners.filter(function(x){return x!==fn})}}
function navigate(view){state.view=view;render();notify()}
var adapter={call:function(){return Promise.reject(new Error('Speedtest adapter not configured'))},subscribe:subscribe,navigate:navigate};
try{if(window.SpeedtestWebAdapter)adapter=window.SpeedtestWebAdapter;else if(window.parent&&window.parent!==window&&window.parent.SpeedtestWebAdapter)adapter=window.parent.SpeedtestWebAdapter}catch(_){ }
function checked(method,params){return Promise.resolve(adapter.call(method,params||{})).then(function(x){if(x&&x.ok===false){var e=new Error(x.error&&x.error.message||x.error&&x.error.code||'Request failed');e.code=x.error&&x.error.code;throw e}return x||{}})}
function mbps(bytes,elapsed){return Math.round((bytes*8/Math.max(elapsed,1)/1000)*100)/100}
function localConfig(){var supplied={};try{supplied=window.SpeedtestWebLocalConfig||{}}catch(_){ }return{measurementMs:typeof supplied.measurementMs==='number'&&supplied.measurementMs>=0?supplied.measurementMs:3000,maxBatches:typeof supplied.maxBatches==='number'&&supplied.maxBatches>0?Math.floor(supplied.maxBatches):Infinity}}
function requireLocalRun(runToken){if(!ownsRun(runToken))throw liveError('stale_local_test');if(state.cancelRequested||state.status==='cancelled'||state.status==='cancelling')throw liveError('cancelled')}
function applyLocalSample(phase,value){state.status='running';state.phase=phase;state.gaugeValue=value;state.gaugeUnit=phase==='ping'?'ms':'Mbps';if(phase==='ping')state.ping=value;else{state[phase]=value;state.traces[phase]=state.traces[phase].concat([value]).slice(-120)}state.gaugeScale=SpeedtestGauge.scaleFor(value,state.gaugeScale);render();notify()}
function localPing(runToken){var samples=[];function probe(){requireLocalRun(runToken);var started=performance.now();return checked('local_download',{bytes:1024}).then(function(){requireLocalRun(runToken);samples.push(Math.round((performance.now()-started)*100)/100);if(samples.length<3)return probe();samples.sort(function(a,b){return a-b});applyLocalSample('ping',samples[1]);return samples[1]})}return probe()}
function localTransfer(method,params,phase,runToken,options){var batchSize=8,totalBytes=0,totalElapsed=0,batches=0,windowStarted=performance.now();function batch(){requireLocalRun(runToken);var started=performance.now();return Promise.all(Array.from({length:batchSize},function(){return checked(method,params)})).then(function(rows){requireLocalRun(runToken);var elapsed=Math.max(performance.now()-started,1),bytes=rows.reduce(function(sum,row){return sum+(Number(row.bytes)||0)},0);totalBytes+=bytes;totalElapsed+=elapsed;batches+=1;applyLocalSample(phase,mbps(bytes,elapsed));if(batches>=options.maxBatches||performance.now()-windowStarted>=options.measurementMs)return mbps(totalBytes,totalElapsed);return batch()})}return batch()}
function localRunId(value){if(typeof value!=='string'||!/^[0-9a-f]{32}$/.test(value))throw liveError('malformed_local_run');return value}
function localTest(runToken){if(runToken==null)runToken=startRun();var size=32768,payload=new Array(size+1).join('0'),options=localConfig(),ping,runId;state.status='running';state.phase='ping';render();notify();return checked('begin_local',{}).then(function(response){runId=localRunId(response.run_id);if(!ownsRun(runToken))return checked('cancel_local',{run_id:runId}).then(function(){throw liveError('stale_local_test')},function(){throw liveError('stale_local_test')});state.localRunId=runId;if(state.cancelRequested)return requestLocalCancel(runToken,runId).then(function(outcome){if(outcome&&outcome.state==='cancelled')throw liveError('cancelled');return runId});return runId}).then(function(){return localPing(runToken)}).then(function(value){ping=value;return localTransfer('local_download',{bytes:size},'download',runToken,options)}).then(function(down){return localTransfer('local_upload',{data:payload},'upload',runToken,options).then(function(up){requireLocalRun(runToken);return checked('record_local',{run_id:runId,download_mbps:String(down),upload_mbps:String(up),ping_ms:String(ping)}).then(function(response){if(response.state!=='committed')throw liveError('malformed_local_run');if(!ownsRun(runToken))throw liveError('stale_local_test');state.cancelRequested=false;state.status='running';return{kind:'device-router',download_mbps:down,upload_mbps:up,ping_ms:ping}},function(error){requireLocalRun(runToken);throw error})})})}
function liveError(code,message){var error=new Error(message||code);error.code=code;return error}
function ownsRun(runToken,jobId){return runToken===runGeneration&&(!jobId||state.activeJob===jobId)}
function clearPollWake(runToken){if(runToken!=null&&pollTimerToken!==runToken)return;if(pollTimer!=null)clearTimeout(pollTimer);var wake=pollWake;pollTimer=null;pollWake=null;pollTimerToken=null;if(wake)wake()}
function pollDelay(runToken,delay){return new Promise(function(resolve){pollTimerToken=runToken;pollWake=function(){pollTimer=null;pollWake=null;pollTimerToken=null;resolve()};pollTimer=setTimeout(pollWake,delay)})}
function startRun(){var staleLocal=state.status==='running'&&state.localRunId?state.localRunId:null;clearPollWake();cancelPromise=null;cancelPromiseToken=null;localCancelPromise=null;localCancelPromiseToken=null;var next=++runGeneration;if(staleLocal)Promise.resolve().then(function(){return checked('cancel_local',{run_id:staleLocal})}).catch(function(){});return next}
function resultMbps(result,key,fallback){var metric=result&&result[key];return metric&&metric.bandwidth!=null?Math.round(metric.bandwidth*8/10000)/100:fallback}
function liveResult(payload){var result=payload.result||{};return{kind:'router-internet',download_mbps:resultMbps(result,'download',payload.download_mbps),upload_mbps:resultMbps(result,'upload',payload.upload_mbps),ping_ms:result.ping&&result.ping.latency!=null?result.ping.latency:payload.ping_ms,server:result.server,isp:result.isp,interface:result.interface,network_context:result.network_context}}
function liveNumber(value,max){if(typeof value!=='number'||!isFinite(value)||value<0||value>max)throw liveError('malformed_live_status');return value}
function optionalLiveNumber(payload,key,max){return payload[key]==null?null:liveNumber(payload[key],max)}
function traceValues(rows){if(rows==null)return null;if(!Array.isArray(rows))throw liveError('malformed_live_status');return rows.slice(-120).map(function(row){if(!row||typeof row!=='object')throw liveError('malformed_live_status');return liveNumber(row.value,100000)})}
function setLiveError(error,jobId){if(jobId&&state.activeJob!==jobId)return;clearPollWake();state.status='error';state.phase='error';render();notify();return error}
function applyLiveStatus(payload,jobId){
  if(state.activeJob!==jobId||payload&&payload.job_id&&payload.job_id!==jobId)return false;
  if(!payload||typeof payload!=='object')throw liveError('malformed_live_status');
  var backendState=payload.state,phase=payload.phase;
  if(['starting','running','complete','cancelled','error'].indexOf(backendState)<0)throw liveError('malformed_live_status');
  if(backendState==='error'){clearPollWake();state.status='error';state.phase='error';render();notify();return true}
  if(backendState==='cancelled'){clearPollWake();state.status='cancelled';state.phase='cancelled';render();notify();return true}
  if(backendState==='starting'||phase==='starting')phase='ping';
  if(backendState==='complete')phase='complete';
  var phases=['idle','ping','download','upload','complete'];
  var current=phases.indexOf(state.phase),next=phases.indexOf(phase);
  if(next<0||current<0||next<current)throw liveError('malformed_live_status');
  var progress=payload.progress==null?null:liveNumber(payload.progress,1);
  var ping=optionalLiveNumber(payload,'ping_ms',100000),jitter=optionalLiveNumber(payload,'jitter_ms',100000),loss=optionalLiveNumber(payload,'packet_loss',100);
  var download=optionalLiveNumber(payload,'download_mbps',100000),upload=optionalLiveNumber(payload,'upload_mbps',100000);
  var downloadTrace=traceValues(payload.download_trace),uploadTrace=traceValues(payload.upload_trace);
  if(payload.result){
    if(typeof payload.result!=='object')throw liveError('malformed_live_status');
    if(payload.result.download&&payload.result.download.bandwidth!=null)liveNumber(payload.result.download.bandwidth,1000000000000);
    if(payload.result.upload&&payload.result.upload.bandwidth!=null)liveNumber(payload.result.upload.bandwidth,1000000000000);
    if(payload.result.ping&&payload.result.ping.latency!=null)liveNumber(payload.result.ping.latency,100000);
    if(payload.result.packetLoss!=null)liveNumber(payload.result.packetLoss,100);
  }
  state.phase=phase;state.status=phase==='complete'?'done':'running';
  if(phase==='complete')clearPollWake();
  if(progress!=null)state.progress=progress*100;
  if(ping!=null)state.ping=ping;
  if(jitter!=null)state.jitter=jitter;
  if(loss!=null)state.loss=loss;
  if(download!=null)state.download=download;
  if(upload!=null)state.upload=upload;
  if(downloadTrace)state.traces.download=downloadTrace;
  if(uploadTrace)state.traces.upload=uploadTrace;
  if(phase==='ping'){state.gaugeValue=state.ping||0;state.gaugeUnit='ms'}
  else if(phase==='upload'){state.gaugeValue=state.upload||0;state.gaugeUnit='Mbps'}
  else{state.gaugeValue=state.download||0;state.gaugeUnit='Mbps'}
  state.gaugeScale=SpeedtestGauge.scaleFor(state.gaugeValue,state.gaugeScale);
  if(payload.result){state.isp=payload.result.isp||state.isp;state.connection=payload.result.interface&&payload.result.interface.name||state.connection;state.network=payload.result.network_context||state.network;if(payload.result.server)state.server=payload.result.server;if(payload.result.packetLoss!=null)state.loss=Number(payload.result.packetLoss)}
  render();notify();return true;
}
function pollLive(jobId,runToken){
  if(!ownsRun(runToken,jobId)) return Promise.reject(liveError('stale_live_job'));
  if(state.status==='cancelled') return Promise.reject(liveError('cancelled'));
  if(state.cancelRequested)return pollDelay(runToken,500).then(function(){return pollLive(jobId,runToken)});
  return checked('live_status',{job_id:jobId}).then(function(payload){
    if(!ownsRun(runToken,jobId))throw liveError('stale_live_job');
    if(state.status==='cancelled')throw liveError('cancelled');
    if(state.cancelRequested)return pollDelay(runToken,500).then(function(){return pollLive(jobId,runToken)});
    state.pollFailures=0;
    if(!applyLiveStatus(payload,jobId))return pollDelay(runToken,500).then(function(){return pollLive(jobId,runToken)});
    if(state.status==='done')return liveResult(payload);
    if(state.status==='cancelled')throw liveError('cancelled');
    if(state.status==='error')throw liveError(payload.error&&payload.error.code||'speedtest_failed');
    return pollDelay(runToken,500).then(function(){return pollLive(jobId,runToken)});
  },function(error){
    if(!ownsRun(runToken,jobId))throw liveError('stale_live_job');
    if(state.status==='cancelled')throw liveError('cancelled');
    if(state.cancelRequested)return pollDelay(runToken,500).then(function(){return pollLive(jobId,runToken)});
    if(error.code){setLiveError(error,jobId);throw error}
    state.pollFailures+=1;
    if(state.pollFailures>3){setLiveError(error,jobId);throw error}
    var wait=[500,1000,2000][state.pollFailures-1];
    return pollDelay(runToken,wait).then(function(){return pollLive(jobId,runToken)});
  }).catch(function(error){if(error.code==='malformed_live_status'&&ownsRun(runToken,jobId))setLiveError(error,jobId);throw error});
}
function cancelFailed(error,runToken,jobId){if(ownsRun(runToken,jobId)){state.cancelRequested=false;state.status='running';render();notify()}return{ok:false,error:{code:error.code||'transport_error',message:error.message||String(error)}}}
function requestCancel(runToken,jobId){
  if(cancelPromise&&cancelPromiseToken===runToken)return cancelPromise;
  state.cancelRequested=true;state.status='cancelling';clearPollWake(runToken);render();notify();
  cancelPromiseToken=runToken;
  cancelPromise=Promise.resolve().then(function(){return checked('cancel_live',{job_id:jobId})}).then(function(response){
    if(cancelPromiseToken===runToken){cancelPromise=null;cancelPromiseToken=null}if(!ownsRun(runToken,jobId))return{ok:false,error:{code:'stale_live_job'}};
    if(response.state!=='cancelled')return cancelFailed(liveError('cancel_not_acknowledged'),runToken,jobId);
    state.status='cancelled';state.phase='cancelled';clearPollWake(runToken);render();notify();return response;
  },function(error){if(cancelPromiseToken===runToken){cancelPromise=null;cancelPromiseToken=null}return cancelFailed(error,runToken,jobId)});
  return cancelPromise;
}
function requestLocalCancel(runToken,runId){
  if(localCancelPromise&&localCancelPromiseToken===runToken)return localCancelPromise;
  state.cancelRequested=true;state.status='cancelling';render();notify();localCancelPromiseToken=runToken;
  localCancelPromise=checked('cancel_local',{run_id:runId}).then(function(response){
    if(localCancelPromiseToken===runToken){localCancelPromise=null;localCancelPromiseToken=null}if(!ownsRun(runToken))return response;
    if(response.state!=='cancelled')throw liveError('cancel_not_acknowledged');state.status='cancelled';state.phase='cancelled';render();notify();return response;
  },function(error){
    if(localCancelPromiseToken===runToken){localCancelPromise=null;localCancelPromiseToken=null}if(!ownsRun(runToken))return{ok:false,error:{code:'stale_local_test'}};
    if(error.code==='too_late'){state.cancelRequested=false;if(state.status==='cancelling')state.status='running';render();notify();return{ok:false,state:'committed',error:{code:'too_late'}}}
    state.cancelRequested=false;state.status='running';render();notify();return{ok:false,error:{code:error.code||'transport_error'}};
  });return localCancelPromise;
}
function internetTest(runToken){if(runToken==null)runToken=startRun();var params={};if(state.server.id)params.server_id=state.server.id;state.pollFailures=0;return checked('start_live',params).then(function(started){if(!ownsRun(runToken))throw liveError('stale_live_job');if(!started.job_id)throw liveError('malformed_live_status');state.activeJob=started.job_id;if(state.cancelRequested)return requestCancel(runToken,started.job_id).then(function(outcome){if(outcome.ok)throw liveError('cancelled');return pollLive(started.job_id,runToken)});state.status='running';state.phase='ping';render();notify();return pollLive(started.job_id,runToken)})}
function cancelTest(){var jobId=state.activeJob,runId=state.localRunId;if(state.cancelRequested)return cancelPromise||localCancelPromise||Promise.resolve({ok:false,pending:!jobId&&!runId});if(state.status!=='running')return Promise.resolve({ok:false});state.cancelRequested=true;state.status='cancelling';clearPollWake(runGeneration);render();notify();if(jobId)return requestCancel(runGeneration,jobId);if(runId)return requestLocalCancel(runGeneration,runId);return Promise.resolve({ok:true,pending:true})}
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
  el('go-control').hidden=state.status==='running'||state.status==='cancelling';el('cancel-test').hidden=state.status!=='running';
  if(state.status==='running'||state.status==='done')announceGauge(phase==='complete'?'Test complete':phase+' '+metric(state.gaugeValue)+' '+(state.gaugeUnit||'Mbps'));
}
function renderHistory(v){var h=document.createElement('h2');h.textContent='History';v.appendChild(h);var table=document.createElement('table');var head=document.createElement('tr');['Path','Date','Download','Upload','Ping','Actions'].forEach(function(x){var th=document.createElement('th');th.textContent=x;head.appendChild(th)});table.appendChild(head);state.history.forEach(function(r){var tr=document.createElement('tr'),vals=[r.kind==='device-router'?'Device → Router':'Router → Internet',r.date||new Date((r.timestamp||0)*1000).toLocaleString(),r.download_mbps||r.download&&r.download.bandwidth||'—',r.upload_mbps||r.upload&&r.upload.bandwidth||'—',r.ping_ms||r.latency||'—'];vals.forEach(function(x){var td=document.createElement('td');td.textContent=x;tr.appendChild(td)});var td=document.createElement('td'),b=document.createElement('button');b.textContent='Delete';b.onclick=function(){checked('delete_history',{id:r.id}).then(loadHistory)};td.appendChild(b);tr.appendChild(td);table.appendChild(tr)});v.appendChild(table)}
function renderAnalytics(v){var h=document.createElement('h2');h.textContent='Analytics';v.appendChild(h);['router-internet','device-router'].forEach(function(kind){var rows=state.history.filter(function(r){return r.kind===kind});var p=document.createElement('p');p.textContent=(kind==='device-router'?'Device → Router':'Router → Internet')+': '+rows.length+' recorded test'+(rows.length===1?'':'s');v.appendChild(p)})}
function render(){document.querySelectorAll('[data-mode]').forEach(function(b){b.classList.toggle('active',b.getAttribute('data-mode')===state.mode)});text(el('route-label'),state.mode==='device-router'?'Device → Router':state.mode==='both'?'Device → Router + Router → Internet':'Router → Internet');text(el('scope-note'),state.mode==='device-router'?'Tests this device’s Wi‑Fi or Ethernet path to the router—not the internet.':state.mode==='both'?'Runs both paths from one action and reports them separately.':'Tests the router’s connection to the internet—not this device.');text(el('status'),state.status==='running'?'Testing…':state.status==='cancelling'?'Cancelling…':state.status==='error'?'Test failed':state.status==='cancelled'?'Test cancelled':state.status==='done'?'Test complete':'Ready to test your connection');text(el('isp-badge'),state.isp||'ISP');text(el('network-badge'),state.connection||'Connection');text(el('vpn-callout'),state.network&&state.network.note||'');text(el('server-name'),state.server.name||'Auto');text(el('server-detail'),[state.server.sponsor,state.server.location||state.server.city].filter(Boolean).join(' · ')||'Select a server');renderGauge();renderResults();var v=el('view');while(v&&v.firstChild)v.removeChild(v.firstChild);if(!v||state.view==='home')return;if(state.view==='history')renderHistory(v);else if(state.view==='analytics')renderAnalytics(v);else if(state.view==='settings')v.appendChild(document.createTextNode('History and acceptance are stored locally on this router.'));else if(state.view==='about')v.appendChild(document.createTextNode('Unofficial OpenWrt frontend. Device → Router measures this browser’s authenticated RPC path to the router. Router → Internet runs the separate Ookla CLI on the router. Both results are stored and displayed separately.'))}
function resetMeasurement(phase){state.status='running';state.phase=phase;state.progress=0;state.gaugeValue=0;state.gaugeUnit='Mbps';state.gaugeScale=100;state.traces={download:[],upload:[]};state.activeJob=null;state.localRunId=null;state.pollFailures=0;state.download=null;state.upload=null;state.ping=null;state.jitter=null;state.loss=null;render();notify()}
function executeMode(mode,runToken){if(runToken==null)runToken=startRun();state.cancelRequested=false;state.errorPath=null;state.errorCode=null;state.results={internet:null,local:null};resetMeasurement(mode==='router-internet'?'idle':'ping');var currentPath=mode==='router-internet'?'internet':'local',work;if(mode==='device-router'){work=localTest(runToken).then(function(local){if(ownsRun(runToken))state.results.local=local;return local})}else if(mode==='router-internet'){work=internetTest(runToken).then(function(internet){if(ownsRun(runToken))state.results.internet=internet;return internet})}else{work=localTest(runToken).then(function(local){if(!ownsRun(runToken))throw liveError('stale_local_test');state.results.local=local;currentPath='internet';resetMeasurement('idle');return internetTest(runToken)}).then(function(internet){if(ownsRun(runToken))state.results.internet=internet;return internet})}return work.then(function(){if(!ownsRun(runToken))return;var summary=state.results.internet||state.results.local;if(summary){state.download=summary.download_mbps;state.upload=summary.upload_mbps;state.ping=summary.ping_ms;state.gaugeValue=summary.download_mbps||0;state.gaugeScale=SpeedtestGauge.scaleFor(state.gaugeValue,state.gaugeScale);state.progress=100}if(state.results.internet){var internet=state.results.internet;state.isp=internet.isp||state.isp;state.connection=internet.interface&&internet.interface.name||state.connection;state.network=internet.network_context;if(internet.server)state.server=internet.server}state.status='done';state.phase='complete';clearPollWake(runToken);return loadHistory(runToken)}).catch(function(err){if(!ownsRun(runToken))return;if(err.code==='terms_required'){state.status='idle';state.phase='idle';state.pendingMode=mode;el('terms-dialog').showModal()}else if(err.code==='cancelled'){state.status='cancelled';state.phase='cancelled'}else{state.errorPath=currentPath;state.errorCode=err.code||null;state.status='error';state.phase='error'}clearPollWake(runToken);render();notify()})}
function runMode(mode){var runToken=startRun();if(mode==='device-router')return executeMode(mode,runToken);return checked('settings',{}).then(function(settings){if(!ownsRun(runToken))return;if(!settings.terms_accepted){state.pendingMode=mode;el('terms-dialog').showModal();return}return executeMode(mode,runToken)}).catch(function(err){if(!ownsRun(runToken))return;state.status='error';clearPollWake(runToken);render();notify();throw err})}
function loadHistory(runToken){return checked('history',{}).then(function(x){if(runToken!=null&&!ownsRun(runToken))return;state.history=x.items||[];render();notify()})}
document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-mode]').forEach(function(b){b.addEventListener('click',function(){state.mode=b.getAttribute('data-mode');render()})});document.querySelectorAll('[data-view]').forEach(function(b){b.addEventListener('click',function(){state.view=b.getAttribute('data-view');render()})});el('go-control').addEventListener('click',function(){runMode(state.mode)});el('cancel-test').addEventListener('click',function(){Promise.resolve().then(cancelTest).catch(function(){})});el('accept-terms').addEventListener('click',function(){checked('accept_terms',{}).then(function(){var mode=state.pendingMode||state.mode;state.pendingMode=null;runMode(mode)})});el('server-picker').addEventListener('click',function(){el('server-panel').hidden=false;checked('servers',{}).then(function(x){state.servers=x.servers||x||[]})});el('server-search').addEventListener('input',function(){var q=this.value.toLowerCase(),box=el('server-results');while(box.firstChild)box.removeChild(box.firstChild);state.servers.filter(function(s){return(s.name||'').toLowerCase().indexOf(q)>=0}).forEach(function(s){var b=document.createElement('button');b.textContent=(s.name||'Server')+' '+(s.location||'');b.onclick=function(){state.server=s;el('server-panel').hidden=true;render()};box.appendChild(b)})});loadHistory().catch(function(){render()})});
if(typeof window!=='undefined')window.SpeedtestWeb={adapter:adapter,state:state,render:render,runMode:runMode,localTest:localTest,internetTest:internetTest,applyLiveStatus:applyLiveStatus,applyLocalSample:applyLocalSample,cancelTest:cancelTest};
})();
