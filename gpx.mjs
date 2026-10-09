import {prepareTrack} from './lib.mjs';
export function parseGPX(xmlText) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlText)) throw new Error('暂时无法读取这份 GPX，请重新导出后再试');
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'gpx') throw new Error('这不是有效的 GPX 文件');
  const elements = (root, tag) => [...root.getElementsByTagNameNS('*', tag)];
  const trkSegments = elements(xml, 'trkseg');
  const containers = trkSegments.length ? trkSegments : elements(xml, 'rte');
  if (!containers.length) throw new Error('文件中没有轨迹或路线');
  let invalid = 0;
  const segments = [];
  for (const container of containers) {
    let segment = [];
    for (const element of elements(container, container.localName === 'rte' ? 'rtept' : 'trkpt')) {
      const latText = element.getAttribute('lat'), lonText = element.getAttribute('lon');
      const lat = latText?.trim() ? Number(latText) : NaN, lon = lonText?.trim() ? Number(lonText) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        invalid++; if (segment.length) segments.push(segment); segment = []; continue;
      }
      const eleText = elements(element, 'ele')[0]?.textContent?.trim();
      const ele = eleText ? Number(eleText) : null;
      segment.push({lat, lon, ele: Number.isFinite(ele) ? ele : null});
    }
    if (segment.length) segments.push(segment);
  }
  return {...prepareTrack(segments), invalid, kind: trkSegments.length ? 'track' : 'route'};
}

export function drawProfile(svg, track) {
  svg.replaceChildren();
  svg.setAttribute('aria-label', track.minElevation === null ? '文件里没有海拔数据' : `海拔最低 ${Math.round(track.minElevation)} 米，最高 ${Math.round(track.maxElevation)} 米`);
  if (track.minElevation === null || !track.distance) return;
  const ns = 'http://www.w3.org/2000/svg';
  const low = track.minElevation, range = Math.max(10, track.maxElevation - low);
  const step = Math.max(1, Math.ceil(track.count / 2000));
  for (const segment of track.segments) {
    let d = '', continuation = false;
    segment.forEach((point, i) => {
      if (point.ele === null) { continuation = false; return; }
      if (i % step && i !== segment.length - 1) return;
      const x = 5 + point.distance / track.distance * 990, y = 118 - (point.ele - low) / range * 104;
      d += `${continuation ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `; continuation = true;
    });
    const path = document.createElementNS(ns, 'path');
    for (const [key, value] of Object.entries({d, fill:'none', stroke:'#80628b', 'stroke-width':'1.7'})) path.setAttribute(key,value);
    svg.append(path);
  }
  const cursor = document.createElementNS(ns, 'line'); cursor.id = 'profile-cursor';
  for (const [key, value] of Object.entries({x1:'5',x2:'5',y1:'5',y2:'125',stroke:'#b3916f','stroke-width':'1.2'})) cursor.setAttribute(key,value);
  svg.append(cursor);
}
