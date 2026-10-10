export const ACTIVITY_KEYS = ['id', 'name', 'date', 'type', 'location', 'status'];
export const STATUSES = new Set(['存在成行证据', '仅有计划证据', '待核对']);

const TITLE_DATE = '(?:20\\d{2}[.\\/-]\\d{1,2}[.\\/-]\\d{1,2}|20\\d{6})';
const TITLE_DATE_END = `(?:${TITLE_DATE}|\\d{1,2}[.\\/-]\\d{1,2}|\\d{1,4})(?![\\d./]|日|天|夜|批|[dD]\\d)`;
const TITLE_DATE_PREFIX = new RegExp(`^${TITLE_DATE}(?![\\d.])(?:\\s*[-—–~～/至到]\\s*${TITLE_DATE_END})?[\\s_—–-]*`, 'u');

export function displayActivityName(activity) {
  // Remove a complete leading date/range in one pass; never strip numeric
  // fragments repeatedly, because a title may contain 2日1夜 or 攀冰2批.
  return activity.name.replace(/^【(?:总文件|总文档|活动\s*Event|野营|准备会|拉练)】\s*/u, '')
    .replace(/^(?:技术|十险)[｜|]\s*/u, '')
    .replace(TITLE_DATE_PREFIX, '')
    .replace(/\s*(?:总文件|总文档|准备会文档)$/u, '').trim() || activity.name;
}

export function validateDocuments(documents, activities) {
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) throw new Error('活动文档列表格式不正确');
  const ids = new Set(activities.map(row => row.id));
  if (Object.keys(documents).length !== ids.size) throw new Error('活动文档数量不匹配');
  for (const [id, doc] of Object.entries(documents)) {
    if (!ids.has(id)) throw new Error('文档所属活动不正确');
    if (doc === null) continue;
    if (Object.keys(doc).sort().join() !== 'kind,title,url' || typeof doc.title !== 'string' || !doc.title.trim() || doc.title.length > 500) throw new Error('活动文档字段不正确');
    if (!['总文档', '准备会文档', '活动文档'].includes(doc.kind)) throw new Error('活动文档类型不正确');
    if (typeof doc.url !== 'string' || !/^https:\/\/(?:tsinghuamc|my)\.feishu\.cn\/(?:wiki|docx)\/[A-Za-z0-9]+$/.test(doc.url)) throw new Error('只允许已经核对的飞书活动文档链接');
  }
  return documents;
}

export function validateActivities(rows) {
  if (!Array.isArray(rows)) throw new Error('活动索引不是列表');
  const ids = new Set();
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join() !== [...ACTIVITY_KEYS].sort().join()) throw new Error('活动索引包含未允许的字段');
    if (!/^act-[a-f0-9]{16}$/.test(row.id) || ids.has(row.id)) throw new Error('活动编号无效或重复');
    ids.add(row.id);
    for (const field of ['name', 'type', 'status']) if (typeof row[field] !== 'string' || !row[field].trim() || row[field].length > 400) throw new Error('活动字段无效');
    for (const field of ['date', 'location']) if (row[field] !== null && (typeof row[field] !== 'string' || row[field].length > 300)) throw new Error('活动字段无效');
    if (!STATUSES.has(row.status)) throw new Error('活动状态无效');
    if (Object.values(row).some(v => typeof v === 'string' && /https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(v))) throw new Error('活动投影不应包含链接或邮箱');
  }
  return rows;
}

export const ACTIVITY_SEASONS = {
  spring: '春季（3—5月）', summer: '夏季（6—8月）',
  autumn: '秋季（9—11月）', winter: '冬季（12—2月）',
};

function calendarDay(year, month, day) {
  // A leap year validates month/day-only records without assigning them a year.
  const checkYear = year || 2000, time = Date.UTC(checkYear, month - 1, day), check = new Date(time);
  return check.getUTCFullYear() === checkYear && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    ? {year, month, day, time} : null;
}

function datePrefix(raw) {
  const full = raw.match(/^(20\d{2}|19\d{2})(?:[./年\s-](\d{1,2})[./月\s-](\d{1,2})日?|(\d{2})(\d{2}))(.*)$/);
  const partial = full ? null : raw.match(/^(?:(\d{1,2})[./月-](\d{1,2})日?|(\d{2})(\d{2}))(.*)$/);
  if (!full && !partial) return null;
  const date = full ? calendarDay(Number(full[1]), Number(full[2] || full[4]), Number(full[3] || full[5]))
    : calendarDay(0, Number(partial[1] || partial[3]), Number(partial[2] || partial[4]));
  return date && {...date, remainder: (full ? full[6] : partial[5]).trim()};
}

function activityStart(raw) {
  const start = datePrefix(raw);
  if (!start) return null;
  if (!start.remainder) return {...start, range: false};
  const tail = start.remainder.match(/^[-—–~～至到/]\s*(.+)$/)?.[1];
  if (!tail) return null;
  let end = datePrefix(tail);
  if (!end) {
    const day = tail.match(/^(\d{1,2})日?$/)?.[1];
    end = day && calendarDay(start.year, start.month, Number(day));
  }
  if (!end || end.remainder) return null;
  if (start.year) {
    // A shortened range end carries the start year, rolling over only at New Year.
    const endYear = end.year || start.year + Number(end.month < start.month);
    const endDate = calendarDay(endYear, end.month, end.day);
    if (!endDate || endDate.time < start.time) return null;
  } else if (!end.year && end.month === start.month && end.day < start.day) return null;
  return {...start, range: true};
}

// Only an explicit four-digit start year is used; titles and school terms are not dates.
export function dateInfo(value) {
  const raw = (value || '').trim(), start = activityStart(raw);
  if (start) return {
    year: start.year ? String(start.year) : '', month: String(start.month).padStart(2, '0'),
    day: String(start.day).padStart(2, '0'), sort: start.year ? start.time : -Infinity,
    complete: Boolean(start.year), range: start.range, raw,
  };
  const year = raw.match(/^(20\d{2}|19\d{2})(?!\d)/)?.[1] || '';
  return {year, month: '', day: '', sort: year ? Date.UTC(Number(year), 0, 1) - 1 : -Infinity, complete: false, range: false, raw};
}

export function seasonForDate(value) {
  const month = Number(dateInfo(value).month);
  return !month ? '' : month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer'
    : month >= 9 && month <= 11 ? 'autumn' : 'winter';
}

export function selectActivities(rows, {query = '', year = '', type = '', season = ''} = {}) {
  const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return rows.filter(row => {
    const searchable = [row.name, row.location, row.type, row.date].join(' ').toLocaleLowerCase();
    return (!year || (dateInfo(row.date).year || 'unknown') === year) && (!type || row.type === type)
      && (!season || seasonForDate(row.date) === season) && tokens.every(t => searchable.includes(t));
  }).sort((a, b) => dateInfo(b.date).sort - dateInfo(a.date).sort || a.name.localeCompare(b.name, 'zh-CN'));
}

export function haversine(a, b) {
  const rad = Math.PI / 180;
  const p = (b.lat - a.lat) * rad, q = (b.lon - a.lon) * rad;
  const x = Math.sin(p / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(q / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
}

export function prepareTrack(rawSegments) {
  const segments = rawSegments.filter(s => s.length > 0);
  const count = segments.reduce((sum, s) => sum + s.length, 0);
  if (count < 2) throw new Error('至少需要两个有效轨迹点');
  if (count > 150000) throw new Error('轨迹点过多，请先导出精简轨迹（最多 150,000 点）');
  let distance = 0;
  let minElevation = Infinity, maxElevation = -Infinity;
  const all = [];
  const measured = segments.map((segment, segmentIndex) => segment.map((point, i) => {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) throw new Error('轨迹包含无效经纬度');
    if (i) distance += haversine(segment[i - 1], point);
    const ele = Number.isFinite(point.ele) ? point.ele : null;
    if (ele !== null) { minElevation = Math.min(minElevation, ele); maxElevation = Math.max(maxElevation, ele); }
    const result = {...point, ele, distance, segment: segmentIndex};
    all.push(result);
    return result;
  }));
  return {segments: measured, points: all, distance, count, minElevation: Number.isFinite(minElevation) ? minElevation : null, maxElevation: Number.isFinite(maxElevation) ? maxElevation : null};
}

export function pointAtProgress(track, progress) {
  const target = Math.max(0, Math.min(1, progress)) * track.distance;
  let lo = 0, hi = track.points.length - 1;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (track.points[mid].distance < target) lo = mid + 1; else hi = mid; }
  return track.points[lo];
}
