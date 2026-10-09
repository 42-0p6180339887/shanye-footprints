/** A dependency-free, equal-scale GPX route viewer. No DEM or invented terrain. */

export const EARTH_RADIUS_METERS = 6371008.8;
export const RENDER_MAX_POINTS = 800;
export const MAX_DEVICE_PIXEL_RATIO = 1.25;
const RAD = Math.PI / 180;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = Number.isFinite;

function longitudeDelta(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

/** Local equirectangular projection: east / up / north, all measured in meters.
 * This is a local route view, not a globe. No vertical exaggeration is applied.
 * Missing elevation remains null, never a fabricated zero-meter observation.
 */
export function projectPosition(point, origin) {
  if (!finite(point.lat) || !finite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
    throw new Error('三维轨迹包含无效坐标');
  }
  return {
    x: EARTH_RADIUS_METERS * longitudeDelta(point.lon - origin.lon) * RAD * Math.cos(origin.lat * RAD),
    y: finite(point.ele) ? point.ele - origin.elevation : null,
    z: EARTH_RADIUS_METERS * (point.lat - origin.lat) * RAD,
  };
}

/** Uniformly sample within runs while keeping every run's first and last point.
 * Run boundaries include both GPX segment breaks and changes in elevation availability.
 * If the boundary count alone exceeds the cap, refusing is safer than joining gaps.
 */
export function samplePreservingRuns(runs, maxPoints = 4000) {
  if (!Number.isInteger(maxPoints) || maxPoints < 2) throw new Error('三维采样上限必须至少为 2');
  const nonempty = runs.filter(run => run.points.length);
  const total = nonempty.reduce((sum, run) => sum + run.points.length, 0);
  if (total <= maxPoints) return nonempty.map(run => ({...run, points: [...run.points]}));
  const required = nonempty.map(run => Math.min(2, run.points.length));
  const minimum = required.reduce((sum, n) => sum + n, 0);
  if (minimum > maxPoints) throw new Error('轨迹断点过多，无法在三维预览点数上限内保留所有分段');
  const remaining = maxPoints - minimum;
  const interior = nonempty.map((run, i) => run.points.length - required[i]);
  const interiorTotal = interior.reduce((sum, n) => sum + n, 0);
  const allocation = interior.map(n => remaining * n / interiorTotal);
  const extra = allocation.map(Math.floor);
  let remainder = remaining - extra.reduce((sum, n) => sum + n, 0);
  const order = allocation.map((value, i) => ({i, fraction: value - extra[i]}))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (const {i} of order) {
    if (!remainder) break;
    if (extra[i] < interior[i]) { extra[i]++; remainder--; }
  }
  return nonempty.map((run, index) => {
    const count = required[index] + extra[index];
    if (count === run.points.length) return {...run, points: [...run.points]};
    if (count === 1) return {...run, points: [run.points[0]]};
    const points = Array.from({length: count}, (_, i) => run.points[Math.round(i * (run.points.length - 1) / (count - 1))]);
    return {...run, points};
  });
}

/** Build a browser-independent coordinate model from prepareTrack() output. */
export function buildRouteModel(track, {maxPoints = 4000} = {}) {
  if (!track || !Array.isArray(track.segments)) throw new Error('缺少三维轨迹分段');
  const segments = track.segments.filter(segment => Array.isArray(segment) && segment.length);
  const sourcePoints = segments.flat();
  if (sourcePoints.length < 2) throw new Error('三维预览至少需要两个轨迹点');
  let latSum = 0, lonCos = 0, lonSin = 0, minElevation = Infinity, maxElevation = -Infinity;
  let missingElevationCount = 0;
  for (const p of sourcePoints) {
    if (!finite(p.lat) || !finite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) throw new Error('三维轨迹包含无效坐标');
    latSum += p.lat; lonCos += Math.cos(p.lon * RAD); lonSin += Math.sin(p.lon * RAD);
    if (finite(p.ele)) { minElevation = Math.min(minElevation, p.ele); maxElevation = Math.max(maxElevation, p.ele); }
    else missingElevationCount++;
  }
  const hasElevation = minElevation !== Infinity;
  const origin = {
    lat: latSum / sourcePoints.length,
    lon: Math.atan2(lonSin, lonCos) / RAD,
    elevation: hasElevation ? (minElevation + maxElevation) / 2 : 0,
  };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let minY = Infinity, maxY = -Infinity, index = 0;
  const rawRuns = [];
  segments.forEach((segment, segmentIndex) => {
    let run;
    for (const point of segment) {
      const xyz = projectPosition(point, origin);
      const elevationKnown = xyz.y !== null;
      minX = Math.min(minX, xyz.x); maxX = Math.max(maxX, xyz.x);
      minZ = Math.min(minZ, xyz.z); maxZ = Math.max(maxZ, xyz.z);
      if (elevationKnown) { minY = Math.min(minY, xyz.y); maxY = Math.max(maxY, xyz.y); }
      if (!run || run.elevationKnown !== elevationKnown) {
        run = {segmentIndex, runIndex: rawRuns.length, elevationKnown, points: []};
        rawRuns.push(run);
      }
      run.points.push({...xyz, distance: finite(point.distance) ? point.distance : 0, sourceIndex: index++, segmentIndex, runIndex: run.runIndex});
    }
  });
  if (!hasElevation) { minY = 0; maxY = 0; }
  const center = {x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2};
  const horizontalRadius = Math.hypot((maxX - minX) / 2, (maxZ - minZ) / 2);
  const radius = Math.max(1, Math.hypot(horizontalRadius, (maxY - minY) / 2));
  const floorY = hasElevation ? minY - radius * .055 : 0;
  const runs = samplePreservingRuns(rawRuns, Math.min(4000, maxPoints));
  const points = runs.flatMap(run => run.points);
  const totalDistance = finite(track.distance) && track.distance >= 0 ? track.distance : Math.max(0, points.at(-1).distance);
  return {
    origin, runs, points, center, radius, floorY, distance: totalDistance,
    bounds: {minX, maxX, minY, maxY, minZ, maxZ}, hasElevation,
    minElevation: hasElevation ? minElevation : null,
    maxElevation: hasElevation ? maxElevation : null,
    missingElevationCount, originalPointCount: sourcePoints.length,
    sampledPointCount: points.length, sourceSegmentCount: segments.length,
  };
}

/** Interpolate only inside the same run. Never bridge GPX or missing-elevation gaps. */
export function positionAtProgress(model, progress) {
  if (!model?.points?.length) return null;
  const points = model.points, p = clamp(finite(progress) ? progress : 0, 0, 1);
  if (p <= 0) return {...points[0]};
  if (p >= 1) return {...points.at(-1)};
  if (!model.distance) return {...points[0]};
  const target = model.distance * p;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].distance < target) lo = mid + 1; else hi = mid; }
  const next = points[lo], previous = points[Math.max(0, lo - 1)];
  const span = next.distance - previous.distance;
  if (next.runIndex !== previous.runIndex || span <= 0) return {...next};
  const t = clamp((target - previous.distance) / span, 0, 1);
  return {
    ...next,
    x: previous.x + (next.x - previous.x) * t,
    y: previous.y === null || next.y === null ? null : previous.y + (next.y - previous.y) * t,
    z: previous.z + (next.z - previous.z) * t,
    distance: target,
  };
}

const DEFAULT_CAMERA = {yaw: 0, pitch: .5, zoom: 1.08};
const COLORS = {background: '#24272b', grid: '#56575c', line: '#f2e9de', unknown: '#b2a1bd', glow: '#c0a9ce', muted: '#b6b0ba', start: '#bad8cd', end: '#e8bf87'};
const niceStep = value => {
  const power = 10 ** Math.floor(Math.log10(Math.max(value, .0001)));
  const f = value / power;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * power;
};

/** Canvas-only rendering. The constructor does not fetch or persist any data. */
export class Route3D {
  constructor(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new Error('三维预览需要 Canvas');
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    if (!this.context) throw new Error('当前浏览器不支持 Canvas 三维预览');
    this.camera = {...DEFAULT_CAMERA};
    this.progress = 0;
    this.model = null;
    this.destroyed = false;
    this.frame = null;
    this.pointer = null;
    this.lightFrame = false;
    this.frameTransform = null;
    this.background = this.glow = null;
    this.width = 1; this.height = 1;
    this.listeners = [];
    this.previousTouchAction = canvas.style.touchAction;
    this.previousCursor = canvas.style.cursor;
    this.previousTabIndex = canvas.getAttribute('tabindex');
    canvas.style.touchAction = 'none'; canvas.style.cursor = 'grab';
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '三维轨迹预览，尚未导入轨迹。导入后可拖动或用方向键旋转。');
    const on = (event, fn, options) => { canvas.addEventListener(event, fn, options); this.listeners.push([event, fn, options]); };
    on('pointerdown', event => {
      if (!event.isPrimary || event.button > 0) return;
      this.pointer = {id: event.pointerId, x: event.clientX, y: event.clientY};
      canvas.setPointerCapture?.(event.pointerId); canvas.style.cursor = 'grabbing'; canvas.focus({preventScroll: true});
      this.requestDraw();
    });
    on('pointermove', event => {
      if (this.pointer?.id !== event.pointerId) return;
      const dx = event.clientX - this.pointer.x, dy = event.clientY - this.pointer.y;
      this.pointer.x = event.clientX; this.pointer.y = event.clientY;
      this.rotate(dx * .007, dy * .006);
    });
    const release = event => {
      if (this.pointer?.id !== event.pointerId) return;
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      this.pointer = null; canvas.style.cursor = 'grab';
      this.requestDraw();
    };
    on('pointerup', release); on('pointercancel', release); on('lostpointercapture', release);
    on('keydown', event => {
      const keys = {ArrowLeft: [-.08, 0], ArrowRight: [.08, 0], ArrowUp: [0, -.08], ArrowDown: [0, .08]};
      if (keys[event.key]) { event.preventDefault(); this.rotate(...keys[event.key]); }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoom(1.15); }
      else if (event.key === '-') { event.preventDefault(); this.zoom(1 / 1.15); }
      else if (event.key === 'Home') { event.preventDefault(); this.reset(); }
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    } else {
      this.windowResize = () => this.resize();
      window.addEventListener('resize', this.windowResize);
    }
    this.resize();
  }

  resize() {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    this.width = rect.width; this.height = rect.height;
    const dpr = Math.min(MAX_DEVICE_PIXEL_RATIO, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.background = this.glow = null;
    this.requestDraw();
  }

  setTrack(track) {
    if (this.destroyed) return null;
    // Build before replacing so a rejected, over-fragmented track cannot corrupt the prior view.
    const model = track ? buildRouteModel(track, {maxPoints: RENDER_MAX_POINTS}) : null;
    this.model = model; this.progress = 0;
    this.camera = {...DEFAULT_CAMERA};
    this.canvas.setAttribute('aria-label', model
      ? `三维轨迹：${model.sourceSegmentCount} 个独立分段，${track.originalPointCount || model.originalPointCount} 个原始点，预览 ${model.sampledPointCount} 点。${model.hasElevation ? `海拔 ${Math.round(track.minElevation ?? model.minElevation)} 至 ${Math.round(track.maxElevation ?? model.maxElevation)} 米。` : '无海拔数据，仅显示平面位置。'}${model.missingElevationCount ? '缺失海拔的部分以虚线平面参考表示。' : ''}坐标等比例，无地形模型。可拖动或用方向键旋转，加减键缩放，Home 键重置视角。`
      : '三维轨迹预览，尚未导入轨迹。导入后可拖动或用方向键旋转。');
    this.requestDraw();
    return model;
  }

  setProgress(value) {
    if (this.destroyed) return;
    const next = clamp(finite(value) ? value : 0, 0, 1);
    if (next === this.progress) return;
    this.progress = next; this.lightFrame = true; this.requestDraw();
  }
  reset() { if (!this.destroyed) { this.camera = {...DEFAULT_CAMERA}; this.requestDraw(); } }
  rotate(deltaYaw, deltaPitch) {
    if (this.destroyed) return;
    if (finite(deltaYaw)) this.camera.yaw = (this.camera.yaw + deltaYaw) % (Math.PI * 2);
    if (finite(deltaPitch)) this.camera.pitch = clamp(this.camera.pitch + deltaPitch, .08, Math.PI / 2 - .04);
    this.requestDraw();
  }
  zoom(factor) {
    if (this.destroyed || !finite(factor) || factor <= 0) return;
    this.camera.zoom = clamp(this.camera.zoom * factor, .35, 4);
    this.requestDraw();
  }

  requestDraw() {
    if (this.destroyed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; if (!this.destroyed) this.draw(); });
  }

  project(point, forceFloor = false) {
    const {model, camera, width, height} = this;
    const x = (point.x - model.center.x) / model.radius;
    const y = ((forceFloor || point.y === null ? model.floorY : point.y) - model.center.y) / model.radius;
    const z = (point.z - model.center.z) / model.radius;
    const transform = this.frameTransform || {cosYaw: Math.cos(camera.yaw), sinYaw: Math.sin(camera.yaw), cosPitch: Math.cos(camera.pitch), sinPitch: Math.sin(camera.pitch)};
    const rotatedX = x * transform.cosYaw - z * transform.sinYaw;
    const rotatedZ = x * transform.sinYaw + z * transform.cosYaw;
    // Positive z is north: from the south, north goes up-screen and away from the camera.
    const vertical = y * transform.cosPitch + rotatedZ * transform.sinPitch;
    const depth = y * transform.sinPitch - rotatedZ * transform.cosPitch;
    const perspective = 4.4 / Math.max(.5, 4.4 - depth);
    const scale = Math.min(width * .43, Math.max(60, height - 105) * .52) * camera.zoom;
    return {x: width / 2 + rotatedX * scale * perspective, y: height * .53 - vertical * scale * perspective, depth};
  }

  drawPath(points, {floor = false, color = COLORS.line, width = 2, dashed = false, alpha = 1, shadow = false} = {}) {
    if (!points.length) return;
    const ctx = this.context; ctx.save();
    ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (dashed) ctx.setLineDash([4, 5]);
    if (shadow) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
    ctx.beginPath();
    points.forEach((point, i) => { const p = this.project(point, floor); if (!i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.stroke();
    if (points.length === 1) {
      const p = this.project(points[0], floor); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, width, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  draw() {
    const ctx = this.context, {width, height, model} = this;
    const light = Boolean(this.pointer) || this.lightFrame;
    this.lightFrame = false;
    this.frameTransform = {cosYaw: Math.cos(this.camera.yaw), sinYaw: Math.sin(this.camera.yaw), cosPitch: Math.cos(this.camera.pitch), sinPitch: Math.sin(this.camera.pitch)};
    ctx.clearRect(0, 0, width, height);
    if (!this.background) {
      this.background = ctx.createLinearGradient(0, 0, width, height);
      this.background.addColorStop(0, '#2c2e32'); this.background.addColorStop(1, '#1b1e22');
      this.glow = ctx.createRadialGradient(width * .5, height * .48, 0, width * .5, height * .48, Math.max(width, height) * .55);
      this.glow.addColorStop(0, '#a292a218'); this.glow.addColorStop(1, '#24272b00');
    }
    ctx.fillStyle = this.background; ctx.fillRect(0, 0, width, height);
    if (!light) { ctx.fillStyle = this.glow; ctx.fillRect(0, 0, width, height); }
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = COLORS.muted;
    if (!model) {
      ctx.textAlign = 'center'; ctx.font = '18px system-ui, sans-serif'; ctx.fillStyle = COLORS.line;
      ctx.fillText('一段真实的路，等待展开', width / 2, height / 2 - 4);
      ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = COLORS.muted;
      ctx.fillText('导入 GPX 后可旋转查看路径 · 不生成地形', width / 2, height / 2 + 25);
      ctx.textAlign = 'left'; return;
    }
    const span = model.radius * 1.25;
    const step = niceStep(span / 4);
    const xStart = Math.floor((model.center.x - span) / step) * step;
    const xEnd = Math.ceil((model.center.x + span) / step) * step;
    const zStart = Math.floor((model.center.z - span) / step) * step;
    const zEnd = Math.ceil((model.center.z + span) / step) * step;
    for (let x = xStart; x <= xEnd + step * .01; x += step) {
      this.drawPath([{x, y: model.floorY, z: zStart}, {x, y: model.floorY, z: zEnd}], {color: COLORS.grid, width: .6, alpha: .7});
    }
    for (let z = zStart; z <= zEnd + step * .01; z += step) {
      this.drawPath([{x: xStart, y: model.floorY, z}, {x: xEnd, y: model.floorY, z}], {color: COLORS.grid, width: .6, alpha: .7});
    }
    for (const run of light ? [] : model.runs) {
      if (run.elevationKnown) this.drawPath(run.points, {floor: true, color: '#070610', width: 4, alpha: .35, shadow: true});
    }
    // Farther runs first; no route is joined across its source or elevation break.
    const ordered = [...model.runs].sort((a, b) => this.project(a.points[Math.floor(a.points.length / 2)]).depth - this.project(b.points[Math.floor(b.points.length / 2)]).depth);
    for (const run of ordered) {
      if (!light) this.drawPath(run.points, {color: run.elevationKnown ? COLORS.glow : COLORS.unknown, width: 5, alpha: run.elevationKnown ? .2 : .14, dashed: !run.elevationKnown, shadow: true});
      this.drawPath(run.points, {color: run.elevationKnown ? COLORS.line : COLORS.unknown, width: run.elevationKnown ? 2 : 1.4, alpha: run.elevationKnown ? .96 : .85, dashed: !run.elevationKnown});
    }
    const drawEndpoint = (point, color, label) => {
      const screen = this.project(point); ctx.save(); ctx.fillStyle = color; ctx.strokeStyle = COLORS.background; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(screen.x, screen.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.font = '10px system-ui, sans-serif'; ctx.fillText(label, screen.x + 9, screen.y + 3); ctx.restore();
    };
    drawEndpoint(model.points[0], COLORS.start, '起'); drawEndpoint(model.points.at(-1), COLORS.end, '终');
    const position = positionAtProgress(model, this.progress);
    if (position) {
      const screen = this.project(position); ctx.save();
      if (!light) {
        const halo = ctx.createRadialGradient(screen.x, screen.y, 1, screen.x, screen.y, 17);
        halo.addColorStop(0, '#e4d6eb90'); halo.addColorStop(1, '#c0a9ce00');
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(screen.x, screen.y, 17, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#fff9ef'; ctx.strokeStyle = '#c6b4d0'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(screen.x, screen.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    if (this.windowResize) window.removeEventListener('resize', this.windowResize);
    for (const [event, fn, options] of this.listeners) this.canvas.removeEventListener(event, fn, options);
    this.listeners.length = 0;
    this.canvas.style.touchAction = this.previousTouchAction;
    this.canvas.style.cursor = this.previousCursor;
    if (this.previousTabIndex === null) this.canvas.removeAttribute('tabindex');
    else this.canvas.setAttribute('tabindex', this.previousTabIndex);
    this.model = null; this.pointer = null;
  }
}
