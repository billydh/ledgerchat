// The shell the Overview and Settings pages render into: one section mounted
// before the importer, a heading, a status line and a content area, plus the
// small DOM helpers both pages share. Each page registers a renderer for its
// route; the hash router here shows the section and calls it.
export const el = (tag, text, attrs = {}) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  Object.assign(n, attrs);
  return n;
};
export const api = async (path, method = 'GET', data) => {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? 'Request failed');
  return v;
};
const dialog = el('section', undefined, {
    className: 'finance-workspace workspace-page',
    id: 'finance-view',
    hidden: true,
  }),
  heading = el('h2', 'Overview', { tabIndex: -1 }),
  notice = el('p', '', { role: 'status', className: 'error', tabIndex: -1 });
export const content = el('div');
dialog.append(heading, notice, content);
document.querySelector('#importer').before(dialog);
export const say = (message, kind = 'error') => {
  notice.className = kind;
  notice.textContent = message;
};
// Enter submits through the section's primary button; the browser reports required fields first.
export function formShell(parent) {
  const form = el('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    form.querySelector('[data-submit]')?.click();
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  parent.append(form);
  return form;
}
export function button(text, action) {
  const b = el('button', text, { type: 'button' });
  if (text === 'Save') b.dataset.submit = 'true';
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
    say('');
    b.parentElement.querySelector('.action-error')?.remove();
    try {
      if (b.dataset.submit && b.closest('form') && !b.closest('form').reportValidity()) return;
      await action();
      if (b.dataset.submit) say('Saved.', 'success');
    } catch (e) {
      say(e.message);
      // Failures get an alert by the button as well as the status line.
      const local =
        b.parentElement.querySelector('.action-error') ||
        el('p', '', { className: 'action-error error', role: 'alert', tabIndex: -1 });
      local.textContent = e.message;
      b.parentElement.append(local);
      local.focus();
    } finally {
      b.disabled = false;
      b.removeAttribute('aria-busy');
    }
  });
  return b;
}
export function field(parent, label, value = '', type = 'text', options) {
  const wrap = el('label'),
    input = options ? el('select') : el('input', undefined, { type });
  if (options) for (const [value, label] of options) input.append(el('option', label, { value }));
  if (type === 'checkbox') input.checked = Boolean(value);
  else input.value = value ?? '';
  input.id = 'field-' + crypto.randomUUID();
  input.setAttribute('aria-label', label);
  if (type === 'checkbox') wrap.className = 'field-check';
  wrap.append(el('span', label), input);
  parent.append(wrap);
  return input;
}
export function stats(parent) {
  const n = el('dl', undefined, { className: 'stats' });
  parent.append(n);
  return n;
}
export function stat(list, label, value, hint = '', tone = '') {
  const item = el('div', undefined, { className: 'stat' + (tone ? ' ' + tone : '') });
  item.append(el('dt', label), el('dd', value, { className: 'stat-value' }));
  if (hint) item.append(el('dd', hint, { className: 'muted' }));
  list.append(item);
  return item;
}
export function table(parent, caption, headers, rows) {
  const wrap = el('div', undefined, { className: 'scroll' }),
    t = el('table');
  if (caption) t.append(el('caption', caption));
  const head = el('tr');
  for (const h of headers) head.append(el('th', h, { scope: 'col' }));
  t.append(head);
  for (const cells of rows) {
    const tr = el('tr');
    for (const v of cells) {
      const td = el('td');
      if (v instanceof Node) td.append(v);
      else td.textContent = v;
      tr.append(td);
    }
    t.append(tr);
  }
  wrap.append(t);
  parent.append(wrap);
  return t;
}
export const money = (n, c = 'AUD') =>
  n === null
    ? 'Unknown'
    : new Intl.NumberFormat('en-AU', { style: 'currency', currency: c }).format(n / 100);
export const today = () => new Date().toISOString().slice(0, 10);
// Accounts and the taxonomy, fetched when a page opens.
export let accounts = [];
export let categories = [];
export const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? `Account ${id}`;
const pages = new Map();
/** A page: its route slug, its heading and the renderer that fills `content`. */
export function register(slug, title, render) {
  pages.set(slug, { title, render });
}
let routeVersion = 0;
async function syncRoute() {
  const version = ++routeVersion;
  content.replaceChildren();
  say('');
  const view = new URLSearchParams(location.hash.slice(1)).get('view') || 'chat';
  const page = pages.get(view);
  dialog.hidden = !page;
  if (!page) return;
  heading.textContent = page.title;
  const [a, c] = await Promise.all([
    fetch('/api/accounts').then((r) => r.json()),
    fetch('/api/categories').then((r) => r.json()),
  ]);
  if (version !== routeVersion) return;
  accounts = a.accounts;
  categories = c.categories;
  content.setAttribute('aria-busy', 'true');
  try {
    await page.render();
  } catch (e) {
    say(e.message);
  } finally {
    content.removeAttribute('aria-busy');
    heading.focus({ preventScroll: true });
    for (const region of content.querySelectorAll('.scroll')) {
      region.tabIndex = 0;
      region.setAttribute('role', 'region');
      region.setAttribute('aria-label', page.title + ' details');
    }
  }
}
window.addEventListener('hashchange', () => void syncRoute().catch((e) => say(e.message)));
// Pages register while their modules evaluate. Module scripts run before
// DOMContentLoaded (the document is already "interactive" then), so wait for
// that event to route once every page is in.
const start = () => void syncRoute().catch((e) => say(e.message));
if (document.readyState === 'complete') start();
else document.addEventListener('DOMContentLoaded', start);
