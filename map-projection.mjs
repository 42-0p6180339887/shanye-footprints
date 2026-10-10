// Extent of the retained original NASA image, used only as a registered fallback.
export const MAP_BOUNDS = {west: 114.35, south: 38.95, east: 117.75, north: 40.65};
export const CAMPUS = {lat: 40, lon: 116.326667};
const RAD = Math.PI / 180;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function validMapPoint(point) {
  return Boolean(point) && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;
}

export function validMapBounds(bounds) {
  return Boolean(bounds) && validMapPoint({lat: bounds.south, lon: bounds.west})
    && validMapPoint({lat: bounds.north, lon: bounds.east})
    && bounds.north > bounds.south && bounds.east > bounds.west;
}

function latitudeScale(bounds) {
  return Math.max(.01, Math.cos((bounds.north + bounds.south) / 2 * RAD));
}

function interval(center, size, low, high) {
  const span = Math.min(size, high - low);
  const start = clamp(center - span / 2, low, high - span);
  return [start, start + span];
}

/** Fit all known points. Bounds never determine whether a real coordinate exists. */
export function fitMapBounds(points, {width = 1200, height = 780, padding = 60, minSpan = .04} = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0 && height > 0)
      || !Number.isFinite(padding) || !Number.isFinite(minSpan) || minSpan <= 0) throw new Error('Invalid map dimensions');
  const known = points.filter(validMapPoint);
  if (!known.length) known.push(CAMPUS);
  const latitudes = known.map(point => point.lat), longitudes = known.map(point => point.lon);
  const south = Math.min(...latitudes), north = Math.max(...latitudes);
  const west = Math.min(...longitudes), east = Math.max(...longitudes);
  const centerLat = (south + north) / 2, centerLon = (west + east) / 2;
  const cosine = Math.max(.01, Math.cos(centerLat * RAD));
  const margin = clamp(padding, 0, Math.min(width, height) * .4);
  const perPixel = Math.max((north - south) / (height - margin * 2),
    (east - west) * cosine / (width - margin * 2), minSpan / Math.min(width, height));
  const [left, right] = interval(centerLon, perPixel * width / cosine, -180, 180);
  const [bottom, top] = interval(centerLat, perPixel * height, -90, 90);
  return {west: left, south: bottom, east: right, north: top};
}

/** Same local equirectangular scale for imagery and markers; letterbox at world limits. */
export function mapContentRect(bounds, width = 1200, height = 780) {
  if (!validMapBounds(bounds) || !Number.isFinite(width) || !Number.isFinite(height) || !(width > 0 && height > 0)) throw new Error('Invalid map frame');
  const horizontal = (bounds.east - bounds.west) * latitudeScale(bounds);
  const vertical = bounds.north - bounds.south;
  const scale = Math.min(width / horizontal, height / vertical);
  const contentWidth = horizontal * scale, contentHeight = vertical * scale;
  return {x: (width - contentWidth) / 2, y: (height - contentHeight) / 2, width: contentWidth, height: contentHeight};
}

export function projectMapPoint(lat, lon, bounds = MAP_BOUNDS, width = 1200, height = 780, clip = true) {
  if (!validMapPoint({lat, lon}) || !validMapBounds(bounds)) return null;
  if (clip && (lat < bounds.south - 1e-9 || lat > bounds.north + 1e-9 || lon < bounds.west - 1e-9 || lon > bounds.east + 1e-9)) return null;
  const frame = mapContentRect(bounds, width, height);
  return {x: frame.x + (lon - bounds.west) / (bounds.east - bounds.west) * frame.width,
    y: frame.y + (bounds.north - lat) / (bounds.north - bounds.south) * frame.height};
}

export function mapImagePlacement(sourceBounds, viewBounds, width, height) {
  if (!validMapBounds(sourceBounds)) throw new Error('Invalid image extent');
  const nw = projectMapPoint(sourceBounds.north, sourceBounds.west, viewBounds, width, height, false);
  const se = projectMapPoint(sourceBounds.south, sourceBounds.east, viewBounds, width, height, false);
  return {x: nw.x, y: nw.y, width: se.x - nw.x, height: se.y - nw.y};
}

export function containsMapBounds(outer, inner) {
  return validMapBounds(outer) && validMapBounds(inner) && outer.west <= inner.west + 1e-9
    && outer.east >= inner.east - 1e-9 && outer.south <= inner.south + 1e-9 && outer.north >= inner.north - 1e-9;
}

export const journeyMapHeight = width => Math.min(360, Math.max(220, width * .46));

/** One local raster covers the complete responsive family, not just a desktop screenshot. */
export function journeyBasemapBounds(points) {
  const frames = [280, 354, 600, 900, 1400].map(width => fitMapBounds([...points, CAMPUS],
    {width, height: journeyMapHeight(width), padding: 48}));
  const west = Math.min(...frames.map(bounds => bounds.west)), east = Math.max(...frames.map(bounds => bounds.east));
  const south = Math.min(...frames.map(bounds => bounds.south)), north = Math.max(...frames.map(bounds => bounds.north));
  const extraLon = (east - west) * .02, extraLat = (north - south) * .02;
  return {west: Math.max(-180, west - extraLon), east: Math.min(180, east + extraLon),
    south: Math.max(-90, south - extraLat), north: Math.min(90, north + extraLat)};
}

export function nasaMapUrl(bounds, width = 1400, height = 1000) {
  if (!validMapBounds(bounds)) throw new Error('Invalid NASA image extent');
  const params = new URLSearchParams({SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap',
    LAYERS: 'BlueMarble_ShadedRelief_Bathymetry', STYLES: '', FORMAT: 'image/jpeg', CRS: 'EPSG:4326',
    // EPSG:4326 in WMS 1.3.0 uses latitude, longitude axis order.
    BBOX: [bounds.south, bounds.west, bounds.north, bounds.east].join(','),
    WIDTH: String(Math.round(width)), HEIGHT: String(Math.round(height))});
  return `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${params}`;
}

/** Group colliding controls, retaining every coordinate and a real member as the group anchor. */
export function groupMapPoints(points, separation = 54) {
  const groups = [];
  const remaining = new Set(points);
  for (const first of points) {
    if (!remaining.delete(first)) continue;
    const members = [first];
    for (let index = 0; index < members.length; index++) {
      for (const point of remaining) {
        if (Math.hypot(point.x - members[index].x, point.y - members[index].y) < separation) {
          remaining.delete(point); members.push(point);
        }
      }
    }
    members.sort((a, b) => a.index - b.index);
    groups.push({x: members[0].x, y: members[0].y, members});
  }
  return groups;
}

export function createJourneyLayout(activities, locations, width = 600, height = 390) {
  const known = activities.flatMap((activity, index) => validMapPoint(locations[activity.id])
    ? [{activity, index, location: locations[activity.id]}] : []);
  const bounds = fitMapBounds([...known.map(point => point.location), CAMPUS], {width, height, padding: 48});
  const points = known.map(point => ({...point, ...projectMapPoint(point.location.lat, point.location.lon, bounds, width, height)}));
  return {bounds, width, height, points, groups: groupMapPoints(points), campus: projectMapPoint(CAMPUS.lat, CAMPUS.lon, bounds, width, height)};
}

function routeDistance(a, b) {
  const lat = (b.lat - a.lat) * RAD, lon = (b.lon - a.lon) * RAD;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(lon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/** A real route vertex nearest half the travelled length, never a synthetic lat/lon median. */
export function routeRepresentative(segments) {
  const points = [], distances = [];
  let distance = 0;
  for (const segment of segments || []) {
    let previous = null;
    for (const point of segment) {
      if (!validMapPoint(point)) { previous = null; continue; }
      if (previous) distance += routeDistance(previous, point);
      points.push(point); distances.push(distance); previous = point;
    }
  }
  if (!points.length) return null;
  // Published previews retain full-source cumulative distances before downsampling.
  const preserved = points.every((point, index) => Number.isFinite(point.distance) && point.distance >= 0
    && (!index || point.distance >= points[index - 1].distance));
  const along = preserved ? points.map(point => point.distance) : distances;
  const target = (along[0] + along.at(-1)) / 2;
  let selected = 0;
  along.forEach((value, index) => { if (Math.abs(value - target) < Math.abs(along[selected] - target)) selected = index; });
  return {lat: points[selected].lat, lon: points[selected].lon};
}
