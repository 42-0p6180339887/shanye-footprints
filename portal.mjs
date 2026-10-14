import {selectActivities, dateInfo, displayActivityName} from './lib.mjs';

const element = (tag, value, className) => {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
};

export function recentActivities(rows) {
  return selectActivities(rows).filter(row => dateInfo(row.date).complete).slice(0, 2);
}

export function initializePortal() {
  const entry = document.getElementById('training-entry');
  const dialog = document.getElementById('training-entry-dialog');
  if (!entry || !dialog) return;
  entry.addEventListener('click', () => dialog.showModal());
  document.getElementById('close-training-entry')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => entry.focus());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
}

export function renderRecentActivities(rows, openActivity) {
  const container = document.getElementById('recent-activities');
  if (!container) return;
  const recent = recentActivities(rows);
  const fragment = document.createDocumentFragment();
  for (const row of recent) {
    const date = dateInfo(row.date);
    const link = element('a', '', 'portal-journey');
    link.href = `#activity=${encodeURIComponent(row.id)}`;
    const dateLabel = element('span', '', 'portal-journey-date');
    dateLabel.append(element('strong', date.day), element('small', `${date.year} · ${date.month}`));
    const copy = element('span', '', 'portal-journey-copy');
    const status = row.status === '待核对' ? '是否成行不详' : row.status === '仅有计划证据' ? '仅有活动计划' : '';
    copy.append(element('strong', displayActivityName(row)), element('small', [row.type === '未分类' ? '山野活动' : row.type, status].filter(Boolean).join(' · ')));
    link.append(dateLabel, copy);
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openActivity(row);
    });
    fragment.append(link);
  }
  if (!recent.length) fragment.append(element('p', '暂无日期完整的近期活动，请在活动集锦中浏览全部记录。'));
  container.replaceChildren(fragment);
}

export function showRecentError() {
  const container = document.getElementById('recent-activities');
  if (container) container.replaceChildren(element('p', '近期活动暂时无法加载，请刷新后再试。'));
}
