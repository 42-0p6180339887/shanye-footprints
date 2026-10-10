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
  const page = document, byId = id => page.getElementById(id);
  const pins = byId('journey-pins'), map = byId('journey-map'), neighbors = byId('map-neighbors');
  if (!pins || !map || !neighbors) return;
  const baseline = {bounds: MAP_BOUNDS, asset: 'assets/journey-satellite-original.jpg'};
  let source = baseline, remoteSource = null, locations = {}, selectedId, neighborControl = null;
  let layout, observer, resizeTimer, imageTimer, imageRequest = '', alive = true, imageGeneration = 0;
  let renderedWidth = 0;
  const controls = new Map();
  const basemap = byId('journey-basemap'), basemapNote = byId('map-basemap-note');
  const outside = event => { if (!neighbors.contains(event.target) && !pins.contains(event.target)) closeNeighbors(); };
  const escape = event => { if (event.key === 'Escape' && !neighbors.hidden) { event.preventDefault(); closeNeighbors(true); } };
  const leave = event => { if (event.relatedTarget && !neighbors.contains(event.relatedTarget) && event.relatedTarget !== neighborControl) closeNeighbors(); };
  page.addEventListener('pointerdown', outside); neighbors.addEventListener('keydown', escape); neighbors.addEventListener('focusout', leave);
  cleanup = () => {
    alive = false; observer?.disconnect(); clearTimeout(resizeTimer); clearTimeout(imageTimer); imageGeneration++;
    page.removeEventListener('pointerdown', outside); neighbors.removeEventListener('keydown', escape); neighbors.removeEventListener('focusout', leave); closeNeighbors();
  };
  neighbors.hidden = true;
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

  function markActivity(id) {
    selectedId = id;
    for (const [group, control] of controls) {
      const active = group.members.some(point => point.activity.id === id);
      control.classList.toggle('is-selected', active);
    }
    const point = layout.points.find(item => item.activity.id === id);
    const focus = byId('map-selected-point'); focus.replaceChildren();
    if (point) {
      focus.append(svg('circle', {cx: point.x, cy: point.y, r: 15, class: 'selected-ring'}));
      focus.append(svg('path', {d: STAR, transform: `translate(${point.x} ${point.y})`, class: 'pin-star selected-star'}));
    }
  }

  function closeNeighbors(restoreFocus = false) {
    const trigger = neighborControl;
    neighbors.hidden = true; neighborControl = null;
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus({preventScroll: true});
  }

  function openGroup(group, control) {
    if (neighborControl === control && !neighbors.hidden) { closeNeighbors(true); return; }
    closeNeighbors(); neighborControl = control;
    control.setAttribute('aria-expanded', 'true');
    neighbors.replaceChildren();
    const heading = document.createElement('div'); heading.className = 'map-neighbors-heading';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'map-neighbors-close';
    close.textContent = '×'; close.setAttribute('aria-label', '关闭此处活动列表');
    close.addEventListener('click', () => closeNeighbors(true));
    heading.append(span('map-neighbors-label', `此处 ${group.members.length} 次活动`), close); neighbors.append(heading);
    let firstButton;
    for (const member of group.members) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'map-neighbor-activity';
      button.append(span('map-neighbor-name', `${number(member.index)} ${shortName(member.activity)}`),
        span('map-neighbor-date', member.activity.date || '日期未注明'));
      button.setAttribute('aria-label', `查看活动：${member.activity.name}，${member.activity.date || '日期未注明'}`);
      button.addEventListener('click', () => { markActivity(member.activity.id); closeNeighbors(true); openActivity(member.activity); });
      neighbors.append(button); firstButton ||= button;
    }
    neighbors.hidden = false; firstButton?.focus({preventScroll: true});
  }

  function render(width) {
    const previousGroup = neighborControl, restoreId = previousGroup && [...controls].find(([, control]) => control === previousGroup)?.[0].members[0].activity.id;
    const restoreFocus = neighbors.contains(page.activeElement); closeNeighbors();
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
        transform: `translate(${group.x} ${group.y})`, 'aria-label': grouped ? `此处 ${group.members.length} 次活动，打开列表` : `查看活动：${first.activity.name}`});
      if (grouped) { control.setAttribute('aria-controls', 'map-neighbors'); control.setAttribute('aria-expanded', 'false'); control.setAttribute('aria-haspopup', 'dialog'); }
      control.append(svg('rect', {x: -24, y: -37, width: 48, height: 61, rx: 10, class: 'pin-hit'}));
      control.append(svg('rect', {x: -20, y: -32, width: 40, height: 21, rx: 10, class: 'pin-badge'}));
      const text = svg('text', {x: 0, y: -18, 'text-anchor': 'middle', class: 'pin-number'}); text.textContent = label; control.append(text);
      const choose = () => {
        if (grouped) openGroup(group, control);
        else { closeNeighbors(); markActivity(first.activity.id); openActivity(first.activity); }
      };
      control.addEventListener('click', choose);
      control.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
      pins.append(control); controls.set(group, control);
      if (restoreFocus && group.members.some(point => point.activity.id === restoreId)) control.focus({preventScroll: true});
    }
    const locationNote = byId('map-location-note'), missing = activities.length - layout.points.length;
    locationNote.hidden = missing === 0; locationNote.textContent = missing ? `${missing} 次活动暂无路线位置` : '';
    markActivity(selectedId);
  }

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
