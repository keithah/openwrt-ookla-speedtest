(function(){'use strict';
var listeners=[];
var announcementTimer=null,lastAnnouncementAt=0,queuedAnnouncement='',lastAnnouncedPhase='';
var runGeneration=0,interactionEpoch=0;
var termsInvoker=null,serverInvoker=null;
var pollTimer=null,pollWake=null,pollTimerToken=null,cancelPromise=null,cancelPromiseToken=null,localCancelPromise=null,localCancelPromiseToken=null,localCancelOutcome=null,localCancelOutcomeToken=null;
var needleAnimator=null,renderedPhase=null,renderedLabelPhase=null,animatedSampleVersion=0,phaseResetFrame=null,pendingGaugeTarget=null;
var LIVE_POLL_MS=100;
var RETRY_DELAYS=[500,1000,2000];
var state={view:'home',mode:'router-internet',status:'idle',phase:'idle',progress:0,gaugeValue:0,gaugeUnit:'Mbps',gaugeSampleVersion:0,traces:{download:[],upload:[]},activeJob:null,localRunId:null,cancelRequested:false,pollFailures:0,errorPath:null,errorCode:null,failedPhase:null,failedMode:null,download:null,upload:null,ping:null,jitter:null,loss:null,server:{name:'Auto',sponsor:'',city:'',latency:'—'},settings:{default_mode:'router-internet',server_id:'',history_retention:100,motion:'system',terms_accepted:false},history:[],results:{internet:null,local:null},isp:'ISP',connection:'Connection',network:null,range:7,servers:[],pendingMode:null,transitionMessage:null,selectedHistory:null};
var initialized=false,initialization=null;
function el(id){return document.getElementById(id)}
function text(node,value){if(node)node.textContent=value}
function setHidden(node,hidden){if(!node)return;node.hidden=hidden;if(hidden)node.setAttribute('hidden','');else node.removeAttribute('hidden')}
function notify(){listeners.forEach(function(fn){fn(state)})}
function subscribe(fn){listeners.push(fn);return function(){listeners=listeners.filter(function(x){return x!==fn})}}
function navigate(view){state.view=view;render();notify()}
function focusNode(node){if(node&&typeof node.focus==='function')node.focus()}
var adapter={call:function(){return Promise.reject(new Error('Speedtest adapter not configured'))},subscribe:subscribe,navigate:navigate};
try{if(window.SpeedtestWebAdapter)adapter=window.SpeedtestWebAdapter;else if(window.parent&&window.parent!==window&&window.parent.SpeedtestWebAdapter)adapter=window.parent.SpeedtestWebAdapter}catch(_){ }
function checked(method,params){return Promise.resolve(adapter.call(method,params||{})).then(function(x){if(x&&x.ok===false){var e=new Error(x.error&&x.error.message||x.error&&x.error.code||'Request failed');e.code=x.error&&x.error.code;throw e}return x||{}})}
function applySettings(settings){settings={default_mode:settings.default_mode||'router-internet',server_id:settings.server_id||'',history_retention:settings.history_retention||100,motion:settings.motion||'system',terms_accepted:!!settings.terms_accepted};state.settings=settings;state.mode=settings.default_mode;state.server=settings.server_id?{id:String(settings.server_id),name:String(settings.server_id),sponsor:'',city:'',latency:'—'}:{name:'Auto',sponsor:'',city:'',latency:'—'};return settings}
function saveSettings(changes){if(!initialized)return Promise.resolve(state.settings);return checked('save_settings',changes).then(function(settings){applySettings(settings);render();notify();return settings})}
function browserReducedMotion(){return window.matchMedia('(prefers-reduced-motion: reduce)').matches}
function reducedMotion(){return browserReducedMotion()||state.settings.motion==='reduced'}
function mbps(bytes,elapsed){return Math.round((bytes*8/Math.max(elapsed,1)/1000)*100)/100}
function localConfig(){var supplied={};try{supplied=window.SpeedtestWebLocalConfig||{}}catch(_){ }return{measurementMs:typeof supplied.measurementMs==='number'&&supplied.measurementMs>=0?supplied.measurementMs:3000,maxBatches:typeof supplied.maxBatches==='number'&&supplied.maxBatches>0?Math.floor(supplied.maxBatches):Infinity}}
function requireLocalRun(runToken){if(!ownsRun(runToken))throw liveError('stale_local_test');if(state.cancelRequested||state.status==='cancelled'||state.status==='cancelling')throw liveError('cancelled')}
function applyLocalSample(phase,value){state.status='running';state.phase=phase;state.gaugeValue=value;state.gaugeUnit=phase==='ping'?'ms':'Mbps';state.gaugeSampleVersion+=1;if(phase==='ping')state.ping=value;else{state[phase]=value;state.traces[phase]=state.traces[phase].concat([value]).slice(-120)}render();notify()}
function localPing(runToken,runId){var samples=[];function probe(){requireLocalRun(runToken);var started=performance.now();return checked('local_download',{run_id:runId,bytes:1024}).then(function(){requireLocalRun(runToken);samples.push(Math.round((performance.now()-started)*100)/100);if(samples.length<3)return probe();samples.sort(function(a,b){return a-b});applyLocalSample('ping',samples[1]);return samples[1]})}return probe()}
function localTransfer(method,params,phase,runToken,options){var batchSize=8,totalBytes=0,totalElapsed=0,batches=0,windowStarted=performance.now();state.status='running';state.phase=phase;state.gaugeUnit='Mbps';render();notify();function batch(){requireLocalRun(runToken);var started=performance.now();return Promise.all(Array.from({length:batchSize},function(){return checked(method,params)})).then(function(rows){requireLocalRun(runToken);var elapsed=Math.max(performance.now()-started,1),bytes=rows.reduce(function(sum,row){return sum+(Number(row.bytes)||0)},0);totalBytes+=bytes;totalElapsed+=elapsed;batches+=1;applyLocalSample(phase,mbps(bytes,elapsed));if(batches>=options.maxBatches||performance.now()-windowStarted>=options.measurementMs)return mbps(totalBytes,totalElapsed);return batch()},function(error){requireLocalRun(runToken);throw error})}return batch()}
function localRunId(value){if(typeof value!=='string'||!/^[0-9a-f]{32}$/.test(value))throw liveError('malformed_local_run');return value}
function releaseFailedLocalRun(runId,error,runToken){var outcome;if(error.localCandidate&&localCancelPromise&&localCancelPromiseToken===runToken)outcome=localCancelPromise;else if(error.localCandidate&&localCancelOutcome&&localCancelOutcomeToken===runToken)outcome=Promise.resolve(localCancelOutcome);if(outcome)return outcome.then(function(result){if(result&&result.state==='committed')return error.localCandidate;throw result&&result.state==='cancelled'?liveError('cancelled'):error.localFailure||error});if(!runId||error.code==='cancelled')return Promise.reject(error);return checked('cancel_local',{run_id:runId}).then(function(){throw error},function(cleanupError){if(cleanupError.code==='too_late'&&error.localCandidate)return error.localCandidate;throw error})}
function localTest(runToken){if(runToken==null)runToken=startRun();var size=32768,payload=new Array(size+1).join('0'),options=localConfig(),ping,runId;state.status='running';state.phase='ping';render();notify();return checked('begin_local',{}).then(function(response){runId=localRunId(response.run_id);if(!ownsRun(runToken))return checked('cancel_local',{run_id:runId}).then(function(){throw liveError('stale_local_test')},function(){throw liveError('stale_local_test')});state.localRunId=runId;if(state.cancelRequested)return requestLocalCancel(runToken,runId).then(function(outcome){if(outcome&&outcome.state==='cancelled')throw liveError('cancelled');return runId});return runId}).then(function(){return localPing(runToken,runId)}).then(function(value){ping=value;return localTransfer('local_download',{run_id:runId,bytes:size},'download',runToken,options)}).then(function(down){return localTransfer('local_upload',{run_id:runId,data:payload},'upload',runToken,options).then(function(up){var candidate={kind:'device-router',download_mbps:down,upload_mbps:up,ping_ms:ping};requireLocalRun(runToken);return checked('record_local',{run_id:runId,download_mbps:String(down),upload_mbps:String(up),ping_ms:String(ping)}).then(function(response){if(response.state!=='committed')throw liveError('malformed_local_run');if(!ownsRun(runToken))throw liveError('stale_local_test');state.cancelRequested=false;state.status='running';return candidate},function(error){var runError;error.localCandidate=candidate;try{requireLocalRun(runToken)}catch(cancellationError){runError=cancellationError;runError.localCandidate=candidate;runError.localFailure=error;throw runError}throw error})})}).catch(function(error){return releaseFailedLocalRun(runId,error,runToken)})}
function liveError(code,message){var error=new Error(message||code);error.code=code;return error}
function ownsRun(runToken,jobId){return runToken===runGeneration&&(!jobId||state.activeJob===jobId)}
function clearPollWake(runToken){if(runToken!=null&&pollTimerToken!==runToken)return;if(pollTimer!=null)clearTimeout(pollTimer);var wake=pollWake;pollTimer=null;pollWake=null;pollTimerToken=null;if(wake)wake()}
function pollDelay(runToken,delay){return new Promise(function(resolve){pollTimerToken=runToken;pollWake=function(){pollTimer=null;pollWake=null;pollTimerToken=null;resolve()};pollTimer=setTimeout(pollWake,delay)})}
function nextPollDelay(failures){return failures?RETRY_DELAYS[Math.min(failures-1,RETRY_DELAYS.length-1)]:LIVE_POLL_MS}
function waitUntilVisible(runToken){
  if(document.visibilityState!=='hidden')return Promise.resolve();
  return new Promise(function(resolve){
    function visible(){if(document.visibilityState!=='hidden'){document.removeEventListener('visibilitychange',visible);if(pollWake===wake){pollWake=null;pollTimerToken=null}resolve()}}
    function wake(){document.removeEventListener('visibilitychange',visible);resolve()}
    pollTimerToken=runToken;pollWake=wake;document.addEventListener('visibilitychange',visible);
  })
}
function startRun(){var staleLocal=state.status==='running'&&state.localRunId?state.localRunId:null;clearPollWake();clearNumericAnnouncement();state.failedPhase=null;cancelPromise=null;cancelPromiseToken=null;localCancelPromise=null;localCancelPromiseToken=null;localCancelOutcome=null;localCancelOutcomeToken=null;var next=++runGeneration;if(staleLocal)Promise.resolve().then(function(){return checked('cancel_local',{run_id:staleLocal})}).catch(function(){});return next}
function resultMbps(result,key,fallback){var metric=result&&result[key];return metric&&metric.bandwidth!=null?Math.round(metric.bandwidth*8/10000)/100:fallback}
function liveResult(payload){var result=payload.result||{};return{kind:'router-internet',download_mbps:resultMbps(result,'download',payload.download_mbps),upload_mbps:resultMbps(result,'upload',payload.upload_mbps),ping_ms:result.ping&&result.ping.latency!=null?result.ping.latency:payload.ping_ms,jitter_ms:result.ping&&result.ping.jitter!=null?result.ping.jitter:payload.jitter_ms,loss_percent:result.packetLoss!=null?result.packetLoss:payload.packet_loss,server:result.server,isp:result.isp,interface:result.interface,network_context:result.network_context}}
function liveNumber(value,max){if(typeof value!=='number'||!isFinite(value)||value<0||value>max)throw liveError('malformed_live_status');return value}
function optionalLiveNumber(payload,key,max){return payload[key]==null?null:liveNumber(payload[key],max)}
function traceValues(rows){if(rows==null)return null;if(!Array.isArray(rows))throw liveError('malformed_live_status');return rows.slice(-120).map(function(row){if(!row||typeof row!=='object')throw liveError('malformed_live_status');return liveNumber(row.value,100000)})}
function meaningfulPhase(phase,fallback){return['starting','ping','download','upload'].indexOf(phase)>=0?phase:fallback||'starting'}
function setLiveError(error,jobId){if(jobId&&state.activeJob!==jobId)return;clearPollWake();state.errorPath='internet';state.errorCode=error.code||error.message||state.errorCode;state.failedPhase=meaningfulPhase(state.phase);state.status='error';state.phase='error';render();notify();return error}
function applyLiveStatus(payload,jobId){
  if(state.activeJob!==jobId||payload&&payload.job_id&&payload.job_id!==jobId)return false;
  if(!payload||typeof payload!=='object')throw liveError('malformed_live_status');
  var backendState=payload.state,phase=payload.phase;
  if(['starting','running','complete','cancelled','error'].indexOf(backendState)<0)throw liveError('malformed_live_status');
  if(backendState==='error'){clearPollWake();state.errorPath='internet';state.failedPhase=meaningfulPhase(phase,meaningfulPhase(state.phase));state.errorCode=payload.error&&payload.error.code||state.errorCode;state.status='error';state.phase='error';render();notify();return true}
  if(backendState==='cancelled'){clearPollWake();state.failedPhase=null;state.status='cancelled';state.phase='cancelled';render();notify();return true}
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
    if(payload.result.ping&&payload.result.ping.jitter!=null)liveNumber(payload.result.ping.jitter,100000);
    if(payload.result.packetLoss!=null)liveNumber(payload.result.packetLoss,100);
  }
  state.phase=phase;state.status=backendState==='complete'?'done':'running';
  if(backendState==='complete')clearPollWake();
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
  if((phase==='ping'&&ping!=null)||(phase==='download'&&download!=null)||(phase==='upload'&&upload!=null))state.gaugeSampleVersion+=1;
  state.transitionMessage=null;
  if(payload.result){state.isp=payload.result.isp||state.isp;state.connection=payload.result.interface&&payload.result.interface.name||state.connection;state.network=payload.result.network_context||state.network;if(payload.result.server)state.server=payload.result.server;if(payload.result.packetLoss!=null)state.loss=Number(payload.result.packetLoss)}
  render();notify();return true;
}
function pollLive(jobId,runToken){
  if(!ownsRun(runToken,jobId)) return Promise.reject(liveError('stale_live_job'));
  if(state.status==='cancelled') return Promise.reject(liveError('cancelled'));
  if(state.cancelRequested)return pollDelay(runToken,LIVE_POLL_MS).then(function(){return pollLive(jobId,runToken)});
  function handlePayload(payload){
    if(!ownsRun(runToken,jobId))throw liveError('stale_live_job');
    if(state.status==='cancelled')throw liveError('cancelled');
    if(state.cancelRequested)return pollDelay(runToken,LIVE_POLL_MS).then(function(){return pollLive(jobId,runToken)});
    state.pollFailures=0;
    if(!applyLiveStatus(payload,jobId))return waitUntilVisible(runToken).then(function(){return pollDelay(runToken,LIVE_POLL_MS)}).then(function(){return pollLive(jobId,runToken)});
    if(state.status==='done')return liveResult(payload);
    if(state.status==='cancelled')throw liveError('cancelled');
    if(state.status==='error')throw liveError(payload.error&&payload.error.code||'speedtest_failed');
    return waitUntilVisible(runToken).then(function(){return pollDelay(runToken,LIVE_POLL_MS)}).then(function(){return pollLive(jobId,runToken)});
  }
  function handleError(error){
    if(!ownsRun(runToken,jobId))throw liveError('stale_live_job');
    if(state.status==='cancelled')throw liveError('cancelled');
    if(state.cancelRequested)return pollDelay(runToken,LIVE_POLL_MS).then(function(){return pollLive(jobId,runToken)});
    if(error.code){setLiveError(error,jobId);throw error}
    state.pollFailures+=1;
    if(state.pollFailures>3){setLiveError(error,jobId);throw error}
    return waitUntilVisible(runToken).then(function(){return pollDelay(runToken,nextPollDelay(state.pollFailures))}).then(function(){return pollLive(jobId,runToken)});
  }
  return waitUntilVisible(runToken).then(function(){
    if(!ownsRun(runToken,jobId))throw liveError('stale_live_job');
    if(state.status==='cancelled')throw liveError('cancelled');
    if(state.cancelRequested||state.status==='cancelling')return pollDelay(runToken,LIVE_POLL_MS).then(function(){return pollLive(jobId,runToken)});
    return checked('live_status',{job_id:jobId}).then(handlePayload,handleError);
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
    state.failedPhase=null;state.status='cancelled';state.phase='cancelled';clearPollWake(runToken);render();notify();return response;
  },function(error){if(cancelPromiseToken===runToken){cancelPromise=null;cancelPromiseToken=null}return cancelFailed(error,runToken,jobId)});
  return cancelPromise;
}
function restoreLocalCancel(runToken){if(!ownsRun(runToken))return;state.cancelRequested=false;if(state.status==='cancelling')state.status='running';render();notify()}
function requestLocalCancel(runToken,runId){
  if(localCancelPromise&&localCancelPromiseToken===runToken)return localCancelPromise;
  if(localCancelOutcome&&localCancelOutcomeToken===runToken&&(localCancelOutcome.state==='committed'||localCancelOutcome.state==='cancelled')){if(localCancelOutcome.state==='committed')restoreLocalCancel(runToken);return Promise.resolve(localCancelOutcome)}
  if(localCancelOutcomeToken===runToken){localCancelOutcome=null;localCancelOutcomeToken=null;restoreLocalCancel(runToken)}
  state.cancelRequested=true;state.status='cancelling';render();notify();localCancelPromiseToken=runToken;localCancelOutcome=null;localCancelOutcomeToken=runToken;
  localCancelPromise=checked('cancel_local',{run_id:runId}).then(function(response){
    var terminal=response.state==='cancelled'||response.state==='committed';if(localCancelOutcomeToken===runToken){localCancelOutcome=terminal?response:null;if(!terminal)localCancelOutcomeToken=null}if(localCancelPromiseToken===runToken){localCancelPromise=null;localCancelPromiseToken=null}if(!ownsRun(runToken))return response;
    if(response.state==='committed'){restoreLocalCancel(runToken);return response}if(response.state!=='cancelled'){restoreLocalCancel(runToken);return{ok:false,error:{code:'cancel_not_acknowledged'}}}state.failedPhase=null;state.status='cancelled';state.phase='cancelled';render();notify();return response;
  },function(error){
    var outcome=error.code==='too_late'?{ok:false,state:'committed',error:{code:'too_late'}}:{ok:false,error:{code:error.code||'transport_error'}};
    if(localCancelOutcomeToken===runToken){localCancelOutcome=error.code==='too_late'?outcome:null;if(error.code!=='too_late')localCancelOutcomeToken=null}if(localCancelPromiseToken===runToken){localCancelPromise=null;localCancelPromiseToken=null}if(!ownsRun(runToken))return{ok:false,error:{code:'stale_local_test'}};
    restoreLocalCancel(runToken);return outcome;
  });return localCancelPromise;
}
function internetTest(runToken){if(runToken==null)runToken=startRun();var params={};if(state.server.id)params.server_id=state.server.id;state.pollFailures=0;return checked('start_live',params).then(function(started){if(!ownsRun(runToken))throw liveError('stale_live_job');if(!started.job_id)throw liveError('malformed_live_status');state.activeJob=started.job_id;if(state.cancelRequested)return requestCancel(runToken,started.job_id).then(function(outcome){if(outcome.ok)throw liveError('cancelled');return pollLive(started.job_id,runToken)});state.status='running';state.phase='ping';render();notify();return pollLive(started.job_id,runToken)})}
function cancelTest(){var jobId=state.activeJob,runId=state.localRunId;if(state.cancelRequested)return cancelPromise||localCancelPromise||Promise.resolve({ok:false,pending:!jobId&&!runId});if(state.status!=='running')return Promise.resolve({ok:false});state.cancelRequested=true;state.status='cancelling';clearPollWake(runGeneration);render();notify();if(jobId)return requestCancel(runGeneration,jobId);if(runId)return requestLocalCancel(runGeneration,runId);return Promise.resolve({ok:true,pending:true})}
function createNeedleAnimator(){if(needleAnimator)return;needleAnimator=SpeedtestGauge.createAnimator(function(angle){var needle=el('gauge-needle');if(needle)needle.style.transform='rotate('+angle+'deg)'},{now:function(){return performance.now()},requestFrame:function(callback){return window.requestAnimationFrame(callback)},cancelFrame:function(id){window.cancelAnimationFrame(id)},reducedMotion:reducedMotion});needleAnimator.jump(-135)}
function renderResults(){SpeedtestResults.render(el('results'),state.mode,state.results)}
function focusResultHeading(){var results=el('results'),card=results&&results.children&&results.children[0],heading=card&&card.children&&card.children[0];focusNode(heading)}
function focusCompletedResult(runToken,epoch){if(ownsRun(runToken)&&state.status==='done'&&state.phase==='complete'&&state.view==='home'&&interactionEpoch===epoch)focusResultHeading()}
function pathSpeech(){return state.mode==='device-router'?'Device to Router':state.mode==='both'?'Device to Router and Router to Internet':'Router to Internet'}
function metric(value){return value==null||value===''?'—':String(Math.round(Number(value)*100)/100)}
function announceGauge(message){
  var node=el('live-announcer');if(!node||!message||node.textContent===message)return;
  var wait=Number(node.getAttribute('data-throttle-ms'))||1000,remaining=wait-(Date.now()-lastAnnouncementAt);
  if(remaining<=0){text(node,message);lastAnnouncementAt=Date.now();return}
  queuedAnnouncement=message;if(announcementTimer)return;
  announcementTimer=setTimeout(function(){text(node,queuedAnnouncement);lastAnnouncementAt=Date.now();queuedAnnouncement='';announcementTimer=null},remaining);
}
function clearNumericAnnouncement(){if(announcementTimer!=null)clearTimeout(announcementTimer);announcementTimer=null;queuedAnnouncement='';text(el('live-announcer'),'')}
function failedPathLabel(){return state.errorPath==='settings'?'Settings':state.errorPath==='local'?'Device → Router':'Router → Internet'}
function failureMessage(){return state.errorPath==='settings'?'Settings startup failed'+(state.errorCode?' ('+state.errorCode+')':''):failedPathLabel()+' '+meaningfulPhase(state.failedPhase)+' failed'+(state.errorCode?' ('+state.errorCode+')':'')}
function announcePhase(phase){var key=phase==='error'?phase+':'+state.errorPath+':'+state.failedPhase+':'+state.errorCode:phase;if(key===lastAnnouncedPhase)return;lastAnnouncedPhase=key;var message=phase==='complete'?'Test complete':phase==='cancelled'?'Test cancelled':phase==='error'?failureMessage():phase==='idle'?'Ready':phase.charAt(0).toUpperCase()+phase.slice(1)+' phase';text(el('phase-announcer'),message)}
function gaugePhase(){return state.phase==='ping'?'ping':state.phase==='upload'?'upload':state.phase==='download'?'download':state.status==='done'?'complete':'idle'}
function buildGaugeLabels(phase){
  var box=el('gauge-labels');if(!box||renderedLabelPhase===phase)return;renderedLabelPhase=phase;while(box.firstChild)box.removeChild(box.firstChild);
  SpeedtestGauge.labelsFor(phase).forEach(function(value,index,labels){var angle=(-135+270*index/(labels.length-1))*Math.PI/180,node=document.createElementNS?document.createElementNS('http://www.w3.org/2000/svg','text'):document.createElement('text');node.textContent=metric(value);node.setAttribute('x',143+112*Math.sin(angle));node.setAttribute('y',143-112*Math.cos(angle));node.setAttribute('text-anchor','middle');node.setAttribute('dominant-baseline','middle');box.appendChild(node)})
}
function setCurrentMetric(phase){['download','upload','ping'].forEach(function(metricName){var node=el('metric-'+metricName);if(!node)return;if(metricName===phase)node.setAttribute('aria-current','true');else node.removeAttribute('aria-current')})}
function retargetGauge(phase){if(!needleAnimator||state.gaugeSampleVersion===animatedSampleVersion)return;animatedSampleVersion=state.gaugeSampleVersion;needleAnimator.track(SpeedtestGauge.angleFor(Number(state.gaugeValue)||0,phase))}
function waitForGaugeReset(){
  if(phaseResetFrame!=null)window.cancelAnimationFrame(phaseResetFrame);
  function frame(){if(Math.abs(needleAnimator.current()+135)<.001){phaseResetFrame=null;var target=pendingGaugeTarget;pendingGaugeTarget=null;if(target===renderedPhase)retargetGauge(target);return}phaseResetFrame=window.requestAnimationFrame(frame)}
  phaseResetFrame=window.requestAnimationFrame(frame)
}
function morphGaugePhase(phase){
  var previous=renderedPhase,active=['ping','download','upload'].indexOf(phase)>=0,previousActive=['ping','download','upload'].indexOf(previous)>=0;renderedPhase=phase;
  if(!needleAnimator)return;
  if(previousActive&&previous!==phase){
    if(phaseResetFrame!=null)window.cancelAnimationFrame(phaseResetFrame);needleAnimator.reset();pendingGaugeTarget=active?phase:null;
    if(reducedMotion()){phaseResetFrame=null;if(active)retargetGauge(phase);pendingGaugeTarget=null;return}
    waitForGaugeReset();return
  }
  if(phaseResetFrame!=null&&active){pendingGaugeTarget=phase;if(reducedMotion()){window.cancelAnimationFrame(phaseResetFrame);phaseResetFrame=null;retargetGauge(phase);pendingGaugeTarget=null}}
}
function renderGauge(){
  var gauge=el('live-gauge');if(!gauge||typeof SpeedtestGauge==='undefined')return;
  var phase=gaugePhase(),active=['ping','download','upload'].indexOf(phase)>=0,labels=SpeedtestGauge.labelsFor(phase),scale=labels[labels.length-1];
  var progress=Math.max(0,Math.min(100,Number(state.progress)||0));
  gauge.setAttribute('data-phase',phase);gauge.setAttribute('data-status',state.status);gauge.setAttribute('data-shape',state.status==='preparing'?'ring':active?'arc':'disc');gauge.setAttribute('aria-busy',state.status==='preparing'||state.status==='running'||state.status==='cancelling'?'true':'false');gauge.style.setProperty('--gauge-progress',String(progress));
  if(phase!==renderedPhase)morphGaugePhase(phase);if(active){buildGaugeLabels(phase);if(!pendingGaugeTarget)retargetGauge(phase)}setCurrentMetric(active?phase:null);
  text(el('phase-label'),phase==='ping'?'Ping':phase==='download'?'Download':phase==='upload'?'Upload':phase==='complete'?'Complete':'Ready');
  text(el('gauge-value'),metric(state.gaugeValue));text(el('gauge-unit'),state.gaugeUnit||'Mbps');
  text(el('metric-download'),metric(state.download));text(el('metric-upload'),metric(state.upload));text(el('metric-ping'),metric(state.ping));text(el('metric-jitter'),metric(state.jitter));text(el('metric-loss'),metric(state.loss));
  el('download-trace').setAttribute('d',SpeedtestGauge.tracePath(state.traces.download,scale));
  el('upload-trace').setAttribute('d',SpeedtestGauge.tracePath(state.traces.upload,scale));
  var compact=state.status==='idle'||state.status==='preparing'||state.status==='done'||state.status==='cancelled'||state.status==='error';setHidden(el('gauge-dial'),compact);setHidden(el('gauge-readout'),compact);
  el('primary-metrics').hidden=state.status==='idle'||state.status==='preparing';document.querySelector('.latency-strip').hidden=state.status==='idle'||state.status==='preparing';
  var terminal=state.status==='done'||state.status==='cancelled'||state.status==='error',go=el('go-control'),serverPicker=el('server-picker');go.hidden=state.status==='preparing'||state.status==='running'||state.status==='cancelling';text(go,terminal?'RETEST':'GO');go.setAttribute('aria-label',terminal?'Run '+pathSpeech()+' test again':'Start '+pathSpeech()+' test');serverPicker.setAttribute('aria-label','Change server');el('cancel-test').hidden=state.status!=='running';el('cancel-test').disabled=state.status!=='running';
  if(state.status!=='running')clearNumericAnnouncement();announcePhase(state.phase);if(state.status==='running')announceGauge(phase+' '+metric(state.gaugeValue)+' '+(state.gaugeUnit||'Mbps'));
}
function render(){var modeLocked=!initialized||state.status==='preparing'||state.status==='running'||state.status==='cancelling';document.querySelectorAll('[data-mode]').forEach(function(b){var selected=b.getAttribute('data-mode')===state.mode;b.classList.toggle('active',selected);b.setAttribute('aria-pressed',selected?'true':'false');b.disabled=modeLocked});document.querySelectorAll('[data-view]').forEach(function(b){if(b.getAttribute('data-view')===state.view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});el('go-control').disabled=!initialized;el('server-picker').disabled=!initialized;text(el('route-label'),state.mode==='device-router'?'Device → Router':state.mode==='both'?'Device → Router + Router → Internet':'Router → Internet');text(el('scope-note'),state.mode==='device-router'?'Tests this device’s Wi‑Fi or Ethernet path to the router—not the internet.':state.mode==='both'?'Runs both paths from one action and reports them separately.':'Tests the router’s connection to the internet—not this device.');text(el('status'),state.transitionMessage|| (state.status==='preparing'?'Preparing…':state.status==='running'?'Testing…':state.status==='cancelling'?'Cancelling…':state.status==='error'?'Test failed':state.status==='cancelled'?'Test cancelled':state.status==='done'?'Test complete':'Ready to test your connection'));var errorMessage=el('error-message'),retry=el('retry-test');if(errorMessage){errorMessage.hidden=state.status!=='error';text(errorMessage,state.status==='error'?failureMessage()+'. Last valid measurements are retained.':'')}if(retry)retry.hidden=state.status!=='error';text(el('isp-badge'),state.isp||'ISP');text(el('network-badge'),state.connection||'Connection');text(el('vpn-callout'),state.network&&state.network.note||'');text(el('server-name'),state.server.name||'Auto');text(el('server-detail'),[state.server.sponsor,state.server.location||state.server.city].filter(Boolean).join(' · ')||'Select a server');renderGauge();renderResults();SpeedtestViews.render(el('view'),state.view,state,{deleteHistory:function(id){return checked('delete_history',{id:id}).then(function(){return loadHistory()})},clearHistory:function(){return checked('clear_history',{}).then(function(){return loadHistory()})},saveSettings:saveSettings,openResult:function(row){state.selectedHistory=row;state.view='result';render()}})}
function resetMeasurement(phase){clearNumericAnnouncement();state.status='running';state.phase=phase;state.failedPhase=null;state.progress=0;state.gaugeValue=0;state.gaugeUnit='Mbps';state.traces={download:[],upload:[]};state.activeJob=null;state.localRunId=null;state.pollFailures=0;state.download=null;state.upload=null;state.ping=null;state.jitter=null;state.loss=null;render();notify()}
function actionableRunInvoker(node){return node===el('go-control')||node===el('retry-test')?node:state.status==='error'?el('retry-test'):el('go-control')}
function openTermsDialog(mode,invoker){var dialog=el('terms-dialog'),heading=el('terms-title');state.pendingMode=mode;termsInvoker=actionableRunInvoker(invoker);if(heading)heading.setAttribute('tabindex','-1');dialog.showModal();focusNode(heading)}
function executeMode(mode,runToken,invoker){if(runToken==null)runToken=startRun();state.failedMode=mode;state.cancelRequested=false;state.errorPath=null;state.errorCode=null;state.transitionMessage=null;state.results={internet:null,local:null};resetMeasurement(mode==='router-internet'?'idle':'ping');var currentPath=mode==='router-internet'?'internet':'local',work;if(mode==='device-router'){work=localTest(runToken).then(function(local){if(ownsRun(runToken))state.results.local=local;return local})}else if(mode==='router-internet'){work=internetTest(runToken).then(function(internet){if(ownsRun(runToken))state.results.internet=internet;return internet})}else{work=localTest(runToken).then(function(local){if(!ownsRun(runToken))throw liveError('stale_local_test');state.results.local=local;currentPath='internet';state.transitionMessage='Device → Router complete. Starting Router → Internet…';resetMeasurement('idle');return internetTest(runToken)}).then(function(internet){if(ownsRun(runToken))state.results.internet=internet;return internet})}return work.then(function(){if(!ownsRun(runToken))return;var summary=state.results.internet||state.results.local;if(summary){state.download=summary.download_mbps;state.upload=summary.upload_mbps;state.ping=summary.ping_ms;state.jitter=summary.jitter_ms;state.loss=summary.loss_percent;state.gaugeValue=summary.download_mbps||0;state.progress=100}if(state.results.internet){var internet=state.results.internet;state.isp=internet.isp||state.isp;state.connection=internet.interface&&internet.interface.name||state.connection;state.network=internet.network_context;if(internet.server)state.server=internet.server}state.transitionMessage=null;state.status='done';state.phase='complete';state.failedPhase=null;state.failedMode=null;clearPollWake(runToken);render();notify();var focusEpoch=interactionEpoch;return loadHistory(runToken).catch(function(){}).then(function(){focusCompletedResult(runToken,focusEpoch)})}).catch(function(err){if(!ownsRun(runToken))return;state.transitionMessage=null;if(err.code==='terms_required'){state.failedPhase=null;state.status='idle';state.phase='idle';render();notify();openTermsDialog(mode,invoker)}else if(err.code==='cancelled'){state.failedPhase=null;state.status='cancelled';state.phase='cancelled'}else{state.failedPhase=meaningfulPhase(state.failedPhase,meaningfulPhase(state.phase,currentPath==='internet'?'starting':'ping'));state.errorPath=currentPath;state.errorCode=err.code||err.message||'unknown_error';state.status='error';state.phase='error'}clearPollWake(runToken);render();notify()})}
function runMode(mode,invoker){invoker=actionableRunInvoker(invoker);var runToken=startRun();state.mode=mode;state.failedMode=mode;state.failedPhase=null;state.status='preparing';state.phase='preparing';render();notify();if(mode==='device-router')return executeMode(mode,runToken,invoker);return checked('settings',{}).then(function(settings){if(!ownsRun(runToken))return;if(!settings.terms_accepted){state.status='idle';state.phase='idle';render();notify();openTermsDialog(mode,invoker);return}return executeMode(mode,runToken,invoker)}).catch(function(err){if(!ownsRun(runToken))return;state.errorPath='internet';state.errorCode=err.code||err.message||'settings_failed';state.failedPhase='starting';state.status='error';state.phase='error';clearPollWake(runToken);render();notify();throw err})}
function loadHistory(runToken){return checked('history',{}).then(function(x){if(runToken!=null&&!ownsRun(runToken))return;state.history=x.items||[];render();notify()})}
function closeServerPanel(){el('server-panel').hidden=true;focusNode(serverInvoker);serverInvoker=null}
function renderServerChoices(){var q=el('server-search').value.toLowerCase(),box=el('server-results');while(box.firstChild)box.removeChild(box.firstChild);var automatic=document.createElement('button');automatic.textContent='Automatic';automatic.onclick=function(){return saveSettings({server_id:''}).then(function(){closeServerPanel()})};box.appendChild(automatic);state.servers.filter(function(s){return(s.name||'').toLowerCase().indexOf(q)>=0}).forEach(function(s){var b=document.createElement('button');b.textContent=(s.name||'Server')+' '+(s.location||'');b.onclick=function(){return saveSettings({server_id:String(s.id)}).then(function(){state.server=s;render();closeServerPanel()})};box.appendChild(b)})}
function initialize(){if(initialized)return Promise.resolve(state.settings);if(initialization)return initialization;initialization=checked('settings',{}).then(function(settings){applySettings(settings);initialized=true;initialization=null;state.status='idle';state.phase='idle';state.errorPath=null;state.errorCode=null;state.failedPhase=null;state.transitionMessage=null;render();notify();return loadHistory().catch(function(){})},function(error){initialization=null;state.status='error';state.phase='error';state.errorPath='settings';state.errorCode=error.code||error.message||'settings_failed';state.failedPhase='startup';state.transitionMessage=null;render();notify();return null});return initialization}
document.addEventListener('focusin',function(){interactionEpoch+=1});
document.addEventListener('DOMContentLoaded',function(){createNeedleAnimator();el('go-control').disabled=true;el('server-picker').disabled=true;document.querySelectorAll('[data-mode]').forEach(function(b){b.disabled=true;b.addEventListener('click',function(){if(!initialized||state.status==='running'||state.status==='cancelling')return;state.mode=b.getAttribute('data-mode');render()})});document.querySelectorAll('[data-view]').forEach(function(b){b.addEventListener('click',function(){if(!initialized)return;state.view=b.getAttribute('data-view');render()})});el('go-control').addEventListener('click',function(){if(!initialized)return;return runMode(state.mode,this).catch(function(){})});el('retry-test').addEventListener('click',function(){if(!initialized)return initialize();return runMode(state.failedMode||state.mode,this).catch(function(){})});el('cancel-test').addEventListener('click',function(){if(!initialized)return;return Promise.resolve().then(cancelTest).catch(function(){})});el('terms-dialog').addEventListener('close',function(){state.pendingMode=null;if(state.status==='preparing'){state.status='idle';state.phase='idle'}render();notify();focusNode(termsInvoker);termsInvoker=null});el('accept-terms').addEventListener('click',function(){if(!initialized)return;var mode=state.pendingMode||state.mode,invoker=termsInvoker;return checked('accept_terms',{}).then(function(){if(el('terms-dialog').open)el('terms-dialog').close('accept');return runMode(mode,invoker)}).catch(function(err){state.pendingMode=null;state.failedMode=mode;state.errorPath=mode==='device-router'?'local':'internet';state.errorCode=err.code||err.message||'terms_acceptance_failed';state.failedPhase='starting';state.status='error';state.phase='error';render();notify()})});el('server-picker').addEventListener('click',function(){if(!initialized)return;serverInvoker=document.activeElement||el('server-picker');el('server-panel').hidden=false;focusNode(el('server-search'));return checked('servers',{}).then(function(x){state.servers=x.servers||x||[];renderServerChoices()}).catch(function(){})});el('server-search').addEventListener('input',function(){if(initialized)renderServerChoices()});document.addEventListener('keydown',function(event){if(event.key==='Escape'&&!el('server-panel').hidden)closeServerPanel()});initialize()});
if(typeof window!=='undefined')window.SpeedtestWeb={adapter:adapter,state:state,render:render,runMode:runMode,localTest:localTest,internetTest:internetTest,applyLiveStatus:applyLiveStatus,applyLocalSample:applyLocalSample,cancelTest:cancelTest};
})();
