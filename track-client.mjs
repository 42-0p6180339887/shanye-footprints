import {TRACK_API_BASE} from './site-config.mjs';
import {prepareTrack} from './lib.mjs';

const ACTIVITY = /^act-[a-f0-9]{16}$/;
const VERSION = /^trk-[a-f0-9]{32}$/;
const PREFIX = 'shanye-route-preview-v1:';
const MAX_CACHE_BYTES = 256 * 1024;

function validState(state, activityId) {
  return Boolean(state) && state.activityId === activityId && Number.isInteger(state.revision) && state.revision >= 0
    && Array.isArray(state.versions) && state.versions.length <= 5
    && state.versions.every(version => VERSION.test(version?.id))
    && (state.currentId === null || VERSION.test(state.currentId) && state.versions.some(version => version.id === state.currentId));
}

function validTrack(track, activityId, versionId) {
  if (track?.activityId !== activityId || track.id !== versionId || !['route', 'track'].includes(track.kind)
      || typeof track.name !== 'string' || !Array.isArray(track.segments)) return false;
  let count = 0;
  for (const segment of track.segments) {
    if (!Array.isArray(segment) || !segment.length) return false;
    for (const point of segment) {
      if (!point || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180
          || point.ele !== null && !Number.isFinite(point.ele)) return false;
      if (++count > 150000) return false;
    }
  }
  return count >= 2;
}

/** Use full-source distances even when drawing a rounded, sampled preview. */
export function prepareSavedTrack(saved) {
  const track = {...prepareTrack(saved.segments), kind: saved.kind};
  if (!saved.preview || !saved.sourceMetrics) return track;
  const sourcePoints = saved.segments.flat(), metrics = saved.sourceMetrics;
  const validDistances = Number.isFinite(metrics.distance) && metrics.distance >= 0
    && sourcePoints.every((point, index) => Number.isFinite(point.distance) && point.distance >= 0
      && (!index || point.distance >= sourcePoints[index - 1].distance))
    && Math.abs(sourcePoints.at(-1).distance - metrics.distance) < .02;
  if (validDistances) {
    track.points.forEach((point, index) => { point.distance = sourcePoints[index].distance; });
    track.distance = metrics.distance;
  }
  if ((metrics.minElevation === null && metrics.maxElevation === null)
      || Number.isFinite(metrics.minElevation) && Number.isFinite(metrics.maxElevation) && metrics.minElevation <= metrics.maxElevation) {
    track.minElevation = metrics.minElevation; track.maxElevation = metrics.maxElevation;
  }
  track.preview = true;
  track.originalPointCount = saved.originalPointCount;
  return track;
}

/** State always comes from the shared service. Immutable geometry is keyed by
 * both activity and version; a historical preview can never satisfy another ID.
 */
export function createTrackClient({apiBase = TRACK_API_BASE, previewBase = new URL('./data/route-previews/', import.meta.url), fetchImpl = (...args) => fetch(...args), storage = () => globalThis.sessionStorage} = {}) {
  const states = new Map(), tracks = new Map(), pending = new Map();
  let manifestRequest;
  const readStorage = key => {
    try { return JSON.parse(storage()?.getItem(PREFIX + key) || 'null'); } catch { return null; }
  };
  const writeStorage = (key, value) => {
    try { const encoded = JSON.stringify(value); if (encoded.length <= MAX_CACHE_BYTES) storage()?.setItem(PREFIX + key, encoded); } catch { /* Private mode or full storage must not prevent loading. */ }
  };
  const remember = (map, key, value, limit) => { map.delete(key); map.set(key, value); while (map.size > limit) map.delete(map.keys().next().value); };
  const saveState = state => { if (validState(state, state?.activityId)) { remember(states, state.activityId, state, 32); writeStorage(`state:${state.activityId}`, state); } };
  const saveTrack = track => { const key = `${track.activityId}:${track.id}`; remember(tracks, key, track, 12); writeStorage(`track:${key}`, track); return track; };
  const cachedTrack = (activityId, versionId) => {
    const key = `${activityId}:${versionId}`, cached = tracks.get(key) || readStorage(`track:${key}`);
    if (!validTrack(cached, activityId, versionId)) return null;
    remember(tracks, key, cached, 12); return cached;
  };
  async function jsonRequest(url, body, timeout = body === undefined ? 20000 : 60000) {
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit',
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('共享路线服务暂时没有连接上');
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error?.message || result.message || '操作没有完成，请稍后再试'); error.status = response.status; throw error; }
    return result;
  }
  async function manifest() {
    if (!manifestRequest) manifestRequest = jsonRequest(new URL('index.json', previewBase), undefined, 3000).catch(() => ({}));
    return manifestRequest;
  }
  async function staticTrack(activityId, versionId) {
    const entry = (await manifest())[activityId];
    if (!validState(entry?.state, activityId) || !entry.state.versions.some(version => version.id === versionId)) return null;
    const key = `static:${activityId}:${versionId}`;
    if (!pending.has(key)) pending.set(key, (async () => {
      try {
        const track = await jsonRequest(new URL(`${activityId}/${versionId}.json`, previewBase), undefined, 5000);
        return track.preview === true && validTrack(track, activityId, versionId) ? saveTrack(track) : null;
      } catch { return null; }
      finally { pending.delete(key); }
    })());
    return pending.get(key);
  }
  async function trackRequest(activityId, suffix = '', body) {
    const versionId = body === undefined && /^\/trk-[a-f0-9]{32}$/.test(suffix) ? suffix.slice(1) : null;
    if (ACTIVITY.test(activityId) && versionId) {
      const cached = cachedTrack(activityId, versionId);
      if (cached) return cached;
      const preview = await staticTrack(activityId, versionId);
      if (preview) return preview;
    }
    const result = await jsonRequest(`${apiBase.replace(/\/$/, '')}/activities/${encodeURIComponent(activityId)}/tracks${suffix}`, body);
    if (versionId) {
      if (!validTrack(result, activityId, versionId)) throw new Error('路线加载异常，请刷新后重试');
      saveTrack(result);
    }
    else if (!suffix || body !== undefined) saveState(result);
    return result;
  }
  /** A loading/offline snapshot, never a confirmation of the current cloud version.
   * Call trackRequest(activityId) concurrently and let that response take priority.
   */
  async function getTrackPreview(activityId) {
    if (!ACTIVITY.test(activityId)) return null;
    let state = states.get(activityId) || readStorage(`state:${activityId}`);
    if (validState(state, activityId) && state.currentId) {
      const track = cachedTrack(activityId, state.currentId);
      if (track) return {state, track, source: 'cache'};
    }
    const entry = (await manifest())[activityId];
    const staticState = validState(entry?.state, activityId) ? entry.state : null;
    if (!validState(state, activityId) || staticState && staticState.revision > state.revision) state = staticState;
    if (!state?.currentId) return null;
    const track = cachedTrack(activityId, state.currentId) || await staticTrack(activityId, state.currentId);
    return track ? {state, track, source: 'static'} : null;
  }
  return {trackRequest, getTrackPreview};
}

const defaultClient = createTrackClient();
export const trackRequest = defaultClient.trackRequest;
export const getTrackPreview = defaultClient.getTrackPreview;
