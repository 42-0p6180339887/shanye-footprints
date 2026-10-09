import {validateActivities, validateDocuments, dateInfo, selectActivities, pointAtProgress} from './lib.mjs';
import {parseGPX, drawProfile} from './gpx.mjs';
import {Route3D} from './route-3d.mjs';
import {getTrackPreview, trackRequest, prepareSavedTrack} from './track-client.mjs';
import {ROUTE_MANAGER_URL} from './site-config.mjs';
import {renderJourneyMap} from './journey-map.mjs';

const $ = id => document.getElementById(id);
const text = (tag, value, cls) => { const el = document.createElement(tag); el.textContent = value; if (cls) el.className = cls; return el; };
let activities = [], documents = {}, activeActivity = null, visibleLimit = 30;
let routeState = null, currentTrack = null, routeView = '3d', scene = null;
let map, trackLayer, movingMarker, generation = 0, busy = false, displayedTrackId = null, acceptedRevision = -1, leafletStyleRequest, leafletScriptRequest;
let animation = null, lastFrame = null, playbackPosition = 0;
let documentObserver = null;

function displayName(activity) {
  return activity.name.replace(/^【(?:总文件|总文档|活动\s*Event|野营|准备会|拉练)】\s*/u, '')
    .replace(/^(?:技术|十险)[｜|]\s*/u, '')
    .replace(/^(?:20\d{2}[.\/-]\d{1,2}[.\/-]\d{1,2}|20\d{6})(?:[-—]\d{2,4})?[\s\-]*/u, '')
    .replace(/\s*(?:总文件|总文档|准备会文档)$/u, '').trim() || activity.name;
}
function statusLabel(row) { return row.status === '仅有计划证据' ? '仅有活动计划' : row.status === '待核对' ? '是否成行不详' : ''; }
function formatDate(activity) { const d = dateInfo(activity.date); return d.complete ? `${d.year}.${d.month}.${d.day}` : activity.date || '日期未注明'; }
function renderActivities(reset = false) {
  if (reset) visibleLimit = 30;
  const rows = selectActivities(activities, {query:$('search-input').value,year:$('year-filter').value,type:$('type-filter').value});
  $('result-count').textContent = `${rows.length} 个活动`;
  $('empty-state').hidden = rows.length > 0;
  $('load-more').hidden = rows.length <= visibleLimit;
  const fragment = document.createDocumentFragment();
  let lastYear, yearRows;
  for (const activity of rows.slice(0, visibleLimit)) {
    const date = dateInfo(activity.date), year = date.year || '更早的旅程';
    if (year !== lastYear) {
      const group = text('section','', 'year-group');
      group.append(text('h3',year,'timeline-year')); yearRows = text('div','','year-rows'); group.append(yearRows); fragment.append(group); lastYear = year;
    }
    const button = text('button','','activity-row'); button.type = 'button'; button.dataset.status = activity.status;
    button.setAttribute('aria-label', `查看活动：${activity.name}`);
    const dateCell = text('span','','activity-date'); dateCell.append(text('strong',date.complete ? date.day : '—'),text('small',date.complete ? `${date.month} 月` : '日期未注明'));
    const body = text('span','','activity-body'); body.append(text('span',displayName(activity),'activity-title'));
    const meta = text('span',[activity.location, !date.complete ? activity.date : ''].filter(Boolean).join(' · '),'activity-meta');
    if (statusLabel(activity)) meta.append(text('span',statusLabel(activity),'status-note'));
    body.append(meta);
    button.append(dateCell,body,text('span',activity.type === '未分类' ? '山野活动' : activity.type,'activity-type'),text('span','↗','activity-arrow'));
    button.addEventListener('click',()=>openActivity(activity)); yearRows.append(button);
  }
  $('activity-list').replaceChildren(fragment);
}

async function openActivity(activity, updateHash = true) {
  const token = ++generation; pausePlayback(); activeActivity = activity; routeState = null; acceptedRevision = -1;
  documentObserver?.disconnect(); documentObserver = null;
  $('detail-year').textContent = dateInfo(activity.date).year || '往期活动';
  $('detail-kicker').textContent = activity.type === '未分类' ? '山野活动' : activity.type;
  $('detail-title').textContent = displayName(activity);
  $('detail-meta').textContent = [formatDate(activity),activity.location,statusLabel(activity)].filter(Boolean).join('　·　');
  $('route-activity-name').textContent = displayName(activity);
  const doc = documents[activity.id];
  $('document-link').hidden = !doc;
  $('document-viewer').hidden = !doc; $('document-missing').hidden = Boolean(doc);
  $('document-heading').textContent = doc?.kind || '活动文档';
  $('document-frame').removeAttribute('src');
  const startDocument = ()=>{
    if(!doc || token!==generation || documentObserver || $('document-frame').hasAttribute('src'))return;
    if(!('IntersectionObserver' in window)){$('document-frame').src=doc.url;return;}
    documentObserver=new IntersectionObserver(entries=>{
      if(token!==generation)return;
      if(entries.some(entry=>entry.isIntersecting)){
        $('document-frame').src=doc.url;
        documentObserver.disconnect();documentObserver=null;
      }
    },{root:$('activity-dialog'),rootMargin:'0px 0px -25% 0px',threshold:0});
    documentObserver.observe($('document-viewer'));
  };
  if (doc) {
    $('document-link').href = doc.url; $('document-link').title = doc.title;
    $('document-frame').title = `${displayName(activity)} · 飞书${doc.kind}`;
  } else { $('document-link').removeAttribute('href'); $('document-frame').removeAttribute('src'); }
  $('document-note').textContent = doc ? '无法显示时，可在飞书打开。' : '';
  clearScene();
  if (!$('activity-dialog').open) $('activity-dialog').showModal();
  $('activity-dialog').scrollTop = 0;
  if (updateHash) history.replaceState(null,'',`#activity=${encodeURIComponent(activity.id)}`);
  $('route-status').textContent = '正在加载路线…'; setBusy(true);
  let cloudPhase = 'pending';
  const previewRequest=getTrackPreview(activity.id).then(preview=>{
    if(!preview || token!==generation || cloudPhase==='resolved' || acceptedRevision>=0) return;
    routeState=preview.state; showSavedTrack(preview.track); renderVersions(); setBusy(false);
    if(cloudPhase==='failed') $('route-status').textContent += ' · 更新暂不可用';
  }).catch(()=>{});
  // Observe only after the local preview has established the layout. An off-screen
  // editor can take focus and scroll past the route if it is loaded prematurely.
  previewRequest.finally(()=>{
    if(currentTrack || cloudPhase!=='resolved' || !routeState?.currentId)startDocument();
  });
  try { const state = await trackRequest(activity.id); cloudPhase='resolved'; if (token === generation) await acceptState(state,token); }
  catch (error) { cloudPhase='failed'; if (token === generation) $('route-status').textContent = currentTrack ? '当前为已保存路线，更新暂不可用。' : '路线暂时无法加载，请稍后重试。'; }
  finally { if (token === generation){setBusy(false);previewRequest.finally(startDocument);} }
}

function setBusy(value) {
  busy = value; $('gpx-input').disabled = value;
  $('upload-track').disabled = value;
  $('play-route').disabled = value || !currentTrack;
  $('route-progress').disabled = value || !currentTrack;
  $('clear-route').disabled = value || !routeState?.canUndo;
  document.querySelectorAll('.restore-version').forEach(button=>button.disabled = value || button.dataset.version === routeState?.currentId);
}
function clearScene() {
  pausePlayback(); currentTrack = null; displayedTrackId = null; scene?.setTrack(null);
  delete $('route-three').dataset.previewPoints;
  if (trackLayer) map?.removeLayer(trackLayer); if (movingMarker) map?.removeLayer(movingMarker);
  trackLayer = movingMarker = null; $('route-three-wrap').hidden = $('route-map').hidden = true;
  $('activity-route').hidden = true; $('route-tabs').hidden = true; $('profile-section').hidden = true;
  $('route-distance').textContent = $('route-elevation').textContent = '—';
  $('route-progress').value = 0; $('route-progress').removeAttribute('aria-valuetext'); $('playback-position').textContent = '0.0 / 0.0 km';
  $('gpx-input').value = ''; $('upload-label').textContent = '上传轨迹';
  $('route-profile').replaceChildren(); $('route-status').textContent = '暂无轨迹';
  $('route-versions')?.replaceChildren();
}
async function acceptState(state, token = generation) {
  if (token !== generation || state.activityId !== activeActivity?.id || state.revision<acceptedRevision) return;
  acceptedRevision=state.revision;
  routeState = state; renderVersions();
  if (!state.currentId) { clearScene(); renderVersions(); return; }
  if(currentTrack && state.currentId===displayedTrackId){
    const version=state.versions.find(item=>item.id===state.currentId);
    $('route-status').textContent=`${version.name} · ${version.kind==='route' ? '计划路线' : 'GPX 轨迹'}`;
    return;
  }
  const saved = await trackRequest(state.activityId,`/${encodeURIComponent(state.currentId)}`);
  if (token !== generation || state.revision!==acceptedRevision || state.currentId!==routeState?.currentId) return;
  showSavedTrack(saved);
  renderVersions();
}
function showSavedTrack(saved) {
  showTrack(prepareSavedTrack(saved)); displayedTrackId=saved.id;
  $('route-status').textContent = `${saved.name} · ${saved.kind === 'route' ? '计划路线' : 'GPX 轨迹'}`;
  $('upload-label').textContent = '补充 / 管理轨迹';
}
function renderVersions() {
  const host = $('route-versions'); if (!host) return; host.replaceChildren();
  if (!routeState?.versions.length) return;
  const disclosure = document.createElement('details');
  disclosure.append(text('summary',`路线版本（${routeState.versions.length}）`));
  routeState.versions.forEach(version=>{
    const row = text('div','','version-row');
    const info = text('span','','version-info');
    info.append(text('strong',version.name),text('small',`${new Date(version.createdAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}`));
    const button = text('button',version.id === routeState.currentId ? '展示中' : ROUTE_MANAGER_URL ? '切换 ↗' : '恢复','restore-version');
    button.type = 'button'; button.dataset.version = version.id; button.disabled = busy || version.id === routeState.currentId;
    button.addEventListener('click',()=>changeVersion('/restore',{versionId:version.id,expectedRevision:routeState.revision}));
    row.append(info,button); disclosure.append(row);
  }); host.append(disclosure);
  $('clear-route').disabled = busy || !routeState.canUndo;
}
function showTrack(track) {
  pausePlayback(); currentTrack = track;
  $('activity-route').hidden = false; $('route-tabs').hidden = false;
  if (!scene) scene = new Route3D($('route-three'));
  scene.setTrack(track); scene.reset(); setRouteView('3d');
  $('route-three').dataset.previewPoints=String(track.points.length);
  $('route-distance').textContent = `${(track.distance/1000).toFixed(2)} km`;
  $('route-elevation').textContent = track.minElevation === null ? '无海拔' : `${Math.round(track.minElevation)}–${Math.round(track.maxElevation)} m`;
  document.querySelector('.scene-help').textContent = track.points.some(point=>point.ele === null) ? '拖动旋转 · 虚线：无海拔记录' : '拖动旋转';
  $('profile-section').hidden = track.minElevation === null;
  drawProfile($('route-profile'),track);
  $('route-progress').value = 0; updatePosition();
  if (trackLayer) map?.removeLayer(trackLayer); if (movingMarker) map?.removeLayer(movingMarker); trackLayer = movingMarker = null;
}
function setRouteView(view) {
  routeView = view; $('route-three-wrap').hidden = !currentTrack || view !== '3d'; $('route-map').hidden = !currentTrack || view !== 'map';
  document.querySelectorAll('[data-route-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.routeView === view)));
  if (view === 'map' && currentTrack) {
    const token=generation;
    initializeMap(token).catch(()=>{if(token===generation && routeView==='map') $('route-status').textContent='地图暂时未加载，可切回 3D 查看路线。';});
  }
}
function ensureLeaflet() {
  if(!leafletStyleRequest) leafletStyleRequest=new Promise((resolve,reject)=>{
    const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./vendor/leaflet/leaflet.css',import.meta.url);
    link.onload=resolve;link.onerror=()=>{link.remove();reject(new Error('Map style unavailable'));};document.head.append(link);
  }).catch(error=>{leafletStyleRequest=null;throw error;});
  if(!leafletScriptRequest) leafletScriptRequest=window.L ? Promise.resolve() : new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL('./vendor/leaflet/leaflet.js',import.meta.url);
    script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('Map unavailable'));};document.head.append(script);
  }).catch(error=>{leafletScriptRequest=null;throw error;});
  return Promise.all([leafletStyleRequest,leafletScriptRequest]);
}
async function initializeMap(token=generation) {
  await ensureLeaflet();
  if(token!==generation || routeView!=='map' || !currentTrack) return;
  if (!map) {
    map = L.map('route-map',{scrollWheelZoom:false,preferCanvas:true}).setView([39.96,116.25],8);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'}).addTo(map);
  }
  requestAnimationFrame(()=>{
    if(token!==generation || routeView!=='map' || !currentTrack) return;
    map.invalidateSize();
    if (!trackLayer) {
      trackLayer = L.featureGroup(currentTrack.segments.map(segment=>{
        const stride = Math.max(1,Math.ceil(segment.length/10000));
        return L.polyline(segment.filter((_,i)=>i%stride===0||i===segment.length-1).map(p=>[p.lat,p.lon]),{color:'#785486',weight:4});
      })).addTo(map);
      const p = pointAtProgress(currentTrack,Number($('route-progress').value)/1000);
      movingMarker = L.circleMarker([p.lat,p.lon],{radius:6,color:'#fff',weight:2,fillColor:'#61496e',fillOpacity:1}).addTo(map);
      map.fitBounds(trackLayer.getBounds(),{padding:[30,30],maxZoom:16});
    }
  });
}
function updatePosition() {
  if (!currentTrack) return;
  const progress = Number($('route-progress').value)/1000, point = pointAtProgress(currentTrack,progress);
  scene?.setProgress(progress); movingMarker?.setLatLng([point.lat,point.lon]);
  $('route-progress').setAttribute('aria-valuetext',`${Math.round(progress*100)}%，${(currentTrack.distance*progress/1000).toFixed(1)} 公里`);
  $('playback-position').textContent = `${(currentTrack.distance*progress/1000).toFixed(1)} / ${(currentTrack.distance/1000).toFixed(1)} km`;
  const cursor = $('profile-cursor'); if (cursor) {cursor.setAttribute('x1',String(5+progress*990));cursor.setAttribute('x2',String(5+progress*990));}
}
function pausePlayback() { if (animation) cancelAnimationFrame(animation); animation = lastFrame = null; $('play-route').textContent = '沿路走一遍 ▷'; $('play-route').setAttribute('aria-pressed','false'); }
function animate(timestamp) { if (!currentTrack) return; if (lastFrame !== null) playbackPosition = Math.min(1000,playbackPosition+(timestamp-lastFrame)/25); lastFrame=timestamp; $('route-progress').value=playbackPosition; updatePosition(); if(playbackPosition>=1000) pausePlayback(); else animation=requestAnimationFrame(animate); }
async function uploadTrack(file) {
  if (!file || !activeActivity || busy) return;
  const token=generation,activityId=activeActivity.id; pausePlayback(); setBusy(true);
  try {
    if (file.size>12*1024*1024) throw new Error('文件超过 12 MB，请先精简轨迹点');
    const parsed=parseGPX(await file.text());
    if (token!==generation) return;
    const segments=parsed.segments.map(segment=>segment.map(({lat,lon,ele})=>({lat,lon,ele})));
    $('route-status').textContent='正在上传轨迹…';
    const state=await trackRequest(activityId,'',{name:file.name,kind:parsed.kind,segments,requestId:crypto.randomUUID()});
    if(token===generation) await acceptState(state,token);
  } catch(error) {
    if(token===generation) {
      try {const state=await trackRequest(activityId);if(token===generation) await acceptState(state,token);} catch {}
      if(token===generation) $('route-status').textContent=`${error.message}。请核对当前展示的路线。`;
    }
  } finally {if(token===generation){setBusy(false);$('gpx-input').value='';}}
}
async function changeVersion(suffix,body) {
  if(ROUTE_MANAGER_URL){openRouteManager();return;}
  if(busy||!activeActivity)return; const token=generation, id=activeActivity.id; setBusy(true);pausePlayback();
  try {const state=await trackRequest(id,suffix,body); if(token===generation)await acceptState(state,token);}
  catch(error){if(token===generation){try{const state=await trackRequest(id);if(token===generation)await acceptState(state,token);}catch{} if(token===generation)$('route-status').textContent=`${error.message}。`;}}
  finally{if(token===generation)setBusy(false);}
}

$('close-dialog').addEventListener('click',()=>$('activity-dialog').close());
$('activity-dialog').addEventListener('close',()=>{generation++; pausePlayback(); activeActivity=null; documentObserver?.disconnect();documentObserver=null; $('document-frame').removeAttribute('src'); if(location.hash.startsWith('#activity='))history.replaceState(null,'',location.pathname+location.search+'#activities');});
$('activity-dialog').addEventListener('click',event=>{if(event.target===$('activity-dialog')){const r=$('activity-dialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('activity-dialog').close();}});
$('gpx-input').addEventListener('change',event=>uploadTrack(event.target.files?.[0]));
$('clear-route').addEventListener('click',()=>changeVersion('/undo',{expectedRevision:routeState?.revision}));
$('play-route').addEventListener('click',()=>{if(animation){pausePlayback();return;}if(!currentTrack)return;if(Number($('route-progress').value)>=1000)$('route-progress').value=0;playbackPosition=Number($('route-progress').value);$('play-route').textContent='暂停 Ⅱ';$('play-route').setAttribute('aria-pressed','true');animation=requestAnimationFrame(animate);});
$('route-progress').addEventListener('input',()=>{pausePlayback();updatePosition();});
for(const id of ['search-input','year-filter','type-filter'])$(id).addEventListener('input',()=>renderActivities(true));
document.querySelector('.filters').addEventListener('submit',event=>event.preventDefault());
$('reset-filters').addEventListener('click',()=>{$('search-input').value=$('year-filter').value=$('type-filter').value='';renderActivities(true);});
$('load-more').addEventListener('click',()=>{visibleLimit+=30;renderActivities();});
document.querySelectorAll('[data-route-view]').forEach(button=>button.addEventListener('click',()=>setRouteView(button.dataset.routeView)));
$('rotate-left').addEventListener('click',()=>scene?.rotate(-.22,0));$('rotate-right').addEventListener('click',()=>scene?.rotate(.22,0));
$('zoom-in').addEventListener('click',()=>scene?.zoom(1.2));$('zoom-out').addEventListener('click',()=>scene?.zoom(1/1.2));$('reset-camera').addEventListener('click',()=>scene?.reset());
function openRouteManager() {
  if(!activeActivity || busy) return;
  const url=new URL(ROUTE_MANAGER_URL);url.searchParams.set('activity',activeActivity.id);url.searchParams.set('title',displayName(activeActivity));
  window.open(url.href,'_blank','noopener,noreferrer');
  $('route-status').textContent='在飞书页面上传或恢复路线，完成后回到这里即可查看。';
}
$('upload-track').addEventListener('click',()=>{if(!busy){if(ROUTE_MANAGER_URL)openRouteManager();else $('gpx-input').click();}});
if(ROUTE_MANAGER_URL){$('gpx-input').hidden=true;$('clear-route').textContent='切换与恢复路线 ↗';}
let lastRefresh=0;
window.addEventListener('focus',async()=>{
  if(!ROUTE_MANAGER_URL||!activeActivity||busy||Date.now()-lastRefresh<1500)return;
  lastRefresh=Date.now();const token=generation;setBusy(true);
  try{const state=await trackRequest(activeActivity.id);if(token===generation&&state.revision!==routeState?.revision)await acceptState(state,token);}
  catch(error){if(token===generation)$('route-status').textContent=error.message;}
  finally{if(token===generation)setBusy(false);}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pausePlayback();});
window.addEventListener('hashchange',()=>{const id=new URLSearchParams(location.hash.slice(1)).get('activity');const row=activities.find(a=>a.id===id);if(row&&row.id!==activeActivity?.id)openActivity(row,false);});
try {
  const [a,d]=await Promise.all([fetch(new URL('data/activities.json',import.meta.url)),fetch(new URL('data/activity-documents.json',import.meta.url))]);
  if(!a.ok||!d.ok)throw new Error('活动页面暂时没有加载出来');
  activities=validateActivities(await a.json());documents=validateDocuments(await d.json(),activities);
  $('stat-count').textContent=activities.length;
  const years=[...new Set(activities.map(row=>dateInfo(row.date).year).filter(Boolean))].sort().reverse();
  $('stat-span').textContent=years.length?`${years.at(-1)} — ${years[0]}`:'';
  years.forEach(year=>$('year-filter').append(new Option(year,year)));
  if(activities.some(row=>!dateInfo(row.date).year))$('year-filter').append(new Option('日期未注明','unknown'));
  [...new Set(activities.map(row=>row.type))].sort((a,b)=>a.localeCompare(b,'zh-CN')).forEach(type=>$('type-filter').append(new Option(type==='未分类'?'其他活动':type,type)));
  renderActivities();
  renderJourneyMap(selectActivities(activities).filter(row=>dateInfo(row.date).complete).slice(0,10),openActivity);
  const latest=selectActivities(activities).find(row=>dateInfo(row.date).complete);
  if(latest){$('latest-activity').textContent=`最近一次 · ${displayName(latest)} ↗`;$('latest-activity').href=`#activity=${latest.id}`;$('latest-activity').addEventListener('click',event=>{event.preventDefault();openActivity(latest);});}
  const id=new URLSearchParams(location.hash.slice(1)).get('activity'), selected=activities.find(row=>row.id===id);if(selected)openActivity(selected,false);
}catch(error){$('load-error').hidden=false;$('load-error').textContent='活动暂时无法加载，请刷新后再试。';$('result-count').textContent='暂时无法打开活动';}
