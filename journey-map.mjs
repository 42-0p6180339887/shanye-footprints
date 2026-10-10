import {MAP_BOUNDS, createJourneyLayout, validMapBounds, containsMapBounds, mapImagePlacement, nasaMapUrl, journeyMapHeight} from './map-projection.mjs';
import {assetUrl} from './asset-urls.mjs';

const NS = 'http://www.w3.org/2000/svg';
const STAR = 'M0-9 2.7-3 8.8-2.8 4.3 1.4 5.5 8 0 4.5-5.5 8-4.3 1.4-8.8-2.8-2.7-3Z';
const number = index => String(index + 1).padStart(2, '0');
const shortName = activity => (activity.location || activity.name).replace(/一日徒步|重装野营|野营|探路|拉练|清山/g, '');
let cleanup = () => {};

function svg(tag, attrs = {}) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function span(className, text) {
  const element = document.createElement('span'); element.className = className; element.textContent = text; return element;
}

export async function renderJourneyMap(activities, openActivity) {
  cleanup();
  const byId = id => document.getElementById(id);
  const pins = byId('journey-pins'), legend = byId('journey-legend'), map = byId('journey-map');
  if (!pins || !legend || !map) return;
  const baseline = {bounds: MAP_BOUNDS, asset: 'assets/journey-satellite-original.jpg'};
  let source = baseline, remoteSource = null, locations = {}, selectedId = activities[0]?.id;
  let layout, observer, resizeTimer, imageTimer, imageRequest = '', alive = true, imageGeneration = 0;
  let renderedWidth = 0;
  const buttons = new Map(), controls = new Map();
  const selected = byId('map-selection'), neighbors = byId('map-neighbors');
  const basemap = byId('journey-basemap'), basemapNote = byId('map-basemap-note');
  cleanup = () => { alive = false; observer?.disconnect(); clearTimeout(resizeTimer); clearTimeout(imageTimer); imageGeneration++; };
  const read = async name => {
    try { const response = await fetch(new URL(`./data/${name}`, import.meta.url), {signal: AbortSignal.timeout(10000)}); return response.ok ? await response.json() : null; }
    catch { return null; }
  };
  const [readLocations, metadata] = await Promise.all([read('activity-locations.json'), read('map-source.json')]);
  if (!alive) return;
  if (readLocations && typeof readLocations === 'object' && !Array.isArray(readLocations)) locations = readLocations;
  if (metadata?.projection === 'EPSG:4326' && validMapBounds(metadata.bounds)
      && /^assets\/journey-geographic-[a-f0-9]{12}\.jpg$/.test(metadata.asset)) source = {bounds: metadata.bounds, asset: metadata.asset};

  function note(text) { basemapNote.textContent = text; basemapNote.hidden = !text; }
  function placeImage(imageSource) {
    const placement = mapImagePlacement(imageSource.bounds, layout.bounds, layout.width, layout.height);
    for (const [key, value] of Object.entries(placement)) basemap.setAttribute(key, String(value));
    const href = assetUrl(imageSource.asset);
    if (basemap.getAttribute('href') !== href) basemap.setAttribute('href', href);
    basemap.removeAttribute('visibility');
  }

  function updateBasemap() {
    const available = remoteSource && containsMapBounds(remoteSource.bounds, layout.bounds) ? remoteSource : source;
    placeImage(available);
    if (containsMapBounds(available.bounds, layout.bounds)) {
      imageGeneration++; clearTimeout(imageTimer); imageRequest = ''; note(''); return;
    }
    // Old imagery keeps its own geographic rectangle. It is never stretched to a new extent.
    const bounds = {...layout.bounds}, url = nasaMapUrl(bounds, 1400, Math.round(1400 * layout.height / layout.width));
    if (imageRequest === url) return;
    imageRequest = url;
    const generation = ++imageGeneration, image = new Image();
    clearTimeout(imageTimer); note('正在加载底图…');
    image.referrerPolicy = 'no-referrer';
    const fail = () => {
      if (alive && generation === imageGeneration) note('底图暂未完整加载，活动位置仍可查看');
    };
    image.onload = () => {
      if (!alive || generation !== imageGeneration) return;
      clearTimeout(imageTimer); remoteSource = {bounds, asset: url};
      if (containsMapBounds(bounds, layout.bounds)) { placeImage(remoteSource); note(''); }
    };
    image.onerror = () => { if (alive && generation === imageGeneration) { clearTimeout(imageTimer); fail(); } };
    imageTimer = setTimeout(fail, 12000); image.src = url;
  }
  basemap.onerror = () => {
    if (!alive) return;
    basemap.setAttribute('visibility', 'hidden'); note('底图暂不可用，活动位置仍可查看');
  };

  function selectActivity(id) {
    const activity = activities.find(item => item.id === id);
    if (!activity || !layout) return;
    selectedId = id;
    for (const [activityId, button] of buttons) {
      button.classList.toggle('is-selected', activityId === id);
      button.setAttribute('aria-pressed', String(activityId === id));
    }
    for (const [group, control] of controls) {
      const active = group.members.some(point => point.activity.id === id);
      control.classList.toggle('is-selected', active); control.setAttribute('aria-pressed', String(active));
    }
    const point = layout.points.find(item => item.activity.id === id);
    const focus = byId('map-selected-point'); focus.replaceChildren();
    if (point) {
      focus.append(svg('circle', {cx: point.x, cy: point.y, r: 15, class: 'selected-ring'}));
      focus.append(svg('path', {d: STAR, transform: `translate(${point.x} ${point.y})`, class: 'pin-star selected-star'}));
    }
    selected.replaceChildren();
    const copy = document.createElement('div');
    copy.append(span('map-selection-name', `${number(activities.indexOf(activity))}  ${shortName(activity)}`));
    copy.append(span('map-selection-date', `${activity.date || '日期未注明'}${point ? '' : ' · 暂无路线位置'}`));
    const open = document.createElement('button'); open.type = 'button'; open.className = 'map-open-activity'; open.textContent = '查看活动 ↗';
    open.addEventListener('click', () => openActivity(activity)); selected.append(copy, open);
    const restoreNeighborFocus = neighbors.contains?.(document.activeElement);
    neighbors.replaceChildren();
    const group = layout.groups.find(item => item.members.some(member => member.activity.id === id));
    neighbors.hidden = !group || group.members.length < 2;
    if (!neighbors.hidden) {
      neighbors.append(span('map-neighbors-label', '附近活动'));
      for (const member of group.members) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `${number(member.index)} ${shortName(member.activity)}`;
        button.setAttribute('aria-pressed', String(member.activity.id === id));
        button.addEventListener('click', () => selectActivity(member.activity.id)); neighbors.append(button);
        if (restoreNeighborFocus && member.activity.id === id) button.focus({preventScroll: true});
      }
    }
  }

  function render(width) {
    renderedWidth = width;
    const height = journeyMapHeight(width);
    layout = createJourneyLayout(activities, locations, width, height);
    map.setAttribute('viewBox', `0 0 ${width} ${height}`); map.style.aspectRatio = `${width} / ${height}`;
    updateBasemap();
    byId('map-compass').setAttribute('transform', `translate(${width - 25} 29)`);
    byId('map-campus').setAttribute('transform', `translate(${layout.campus.x} ${layout.campus.y})`);
    const campusLabelX = layout.campus.x + 58 > width - 8 ? -58 : 9;
    byId('map-campus-label').setAttribute('x', String(campusLabelX));
    byId('map-campus-text').setAttribute('x', String(campusLabelX + 24.5));
    pins.replaceChildren(); controls.clear();
    // Every star remains at its route coordinate, including members of a dense group.
    for (const point of layout.points) {
      pins.append(svg('path', {d: STAR, transform: `translate(${point.x} ${point.y})`, class: 'pin-star point-star',
        'data-activity': point.activity.id, 'data-lat': point.location.lat, 'data-lon': point.location.lon}));
    }
    for (const group of layout.groups) {
      const first = group.members[0], grouped = group.members.length > 1;
      const label = grouped ? `${group.members.length} 次` : number(first.index);
      const control = svg('g', {class: 'journey-pin', role: 'button', tabindex: 0,
        transform: `translate(${group.x} ${group.y})`, 'aria-label': group.members.map(point => `${number(point.index)} ${shortName(point.activity)}`).join('、')});
      control.append(svg('rect', {x: -24, y: -37, width: 48, height: 61, rx: 10, class: 'pin-hit'}));
      control.append(svg('rect', {x: -20, y: -32, width: 40, height: 21, rx: 10, class: 'pin-badge'}));
      const text = svg('text', {x: 0, y: -18, 'text-anchor': 'middle', class: 'pin-number'}); text.textContent = label; control.append(text);
      const choose = () => selectActivity(first.activity.id);
      control.addEventListener('click', choose);
      control.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
      pins.append(control); controls.set(group, control);
    }
    const locationNote = byId('map-location-note'), missing = activities.length - layout.points.length;
    locationNote.hidden = missing === 0; locationNote.textContent = missing ? `${missing} 次活动暂无路线位置` : '';
    selectActivity(selectedId || activities[0]?.id);
  }

  legend.replaceChildren();
  activities.forEach((activity, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'journey-legend-item';
    button.append(span('legend-number', number(index)), span('legend-name', shortName(activity)));
    button.setAttribute('aria-label', `${number(index)} ${shortName(activity)}，在地图中选择`);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => selectActivity(activity.id)); legend.append(button); buttons.set(activity.id, button);
  });
  byId('map-count').textContent = `最近 ${activities.length} 次活动`;
  byId('map-period').textContent = activities[0]?.date ? `截至 ${activities[0].date}` : '';
  render(Math.max(280, map.getBoundingClientRect().width || 600));
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(entries => {
      const width = Math.max(280, entries[0].contentRect.width);
      if (Math.abs(width - renderedWidth) < 1) return;
      clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (alive) render(width); }, 100);
    });
    observer.observe(map);
  }
}
