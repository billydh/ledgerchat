import {
  accountName,
  accounts,
  api,
  button,
  categories,
  content,
  el,
  field,
  money,
  register,
  table,
  today,
} from './pages.js';
import { describeWindow, presetWindow } from './results.js';
import { cadenceLabel, classLabel as termClass, GLOSSARY, reconciliationLabel } from './terms.js';
const link = (text, href) => el('a', text, { href });
async function overview() {
  const root = el('div', undefined, { className: 'overview-home' });
  content.append(root);
  const todayText = today();
  const PRESETS = [
    ['this_month', 'This month'],
    ['last_month', 'Last month'],
    ['last_30_days', '30 days'],
    ['ytd', 'Year to date'],
    ['custom', 'Custom'],
  ];
  let window_ = presetWindow('this_month', todayText),
    request = 0;
  // Header: period control on the right, the window in words underneath the title.
  const intro = el('div', undefined, { className: 'ov-intro' });
  const subline = el('p', '', { className: 'page-lede ov-subline', ariaLive: 'polite' });
  const controls = el('div', undefined, { className: 'ov-controls' });
  const chips = el('div', undefined, { className: 'ov-presets', role: 'group' });
  chips.setAttribute('aria-label', 'Period');
  const customRow = el('div', undefined, { className: 'ov-custom', hidden: true });
  const from = field(customRow, 'From', window_.from, 'date'),
    to = field(customRow, 'To', window_.to, 'date');
  customRow.append(
    button('Apply', async () => {
      window_ = { from: from.value, to: to.value };
      await render();
    }),
  );
  for (const [key, label] of PRESETS) {
    const chip = el('button', label, { type: 'button', className: 'chip' });
    chip.dataset.preset = key;
    chip.onclick = async () => {
      if (key === 'custom') {
        customRow.hidden = false;
        syncChips();
        from.focus();
        return;
      }
      window_ = presetWindow(key, todayText);
      customRow.hidden = true;
      await render();
    };
    chips.append(chip);
  }
  const stepper = el('div', undefined, { className: 'ov-stepper' });
  const monthLabel = el('span', '');
  const arrow = (label, direction, delta) => {
    const b = button('', () => shiftMonth(delta));
    b.setAttribute('aria-label', label);
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${direction === 'left' ? 'm14 6-6 6 6 6' : 'm10 6 6 6-6 6'}"/></svg>`;
    return b;
  };
  stepper.append(arrow('Previous month', 'left', -1), monthLabel, arrow('Next month', 'right', 1));
  controls.append(chips, stepper);
  intro.append(subline, controls, customRow);
  root.append(intro);
  const windowMonth = () =>
    window_.from.slice(0, 7) === window_.to.slice(0, 7) && window_.from.endsWith('-01')
      ? window_.from.slice(0, 7)
      : null;
  async function shiftMonth(delta) {
    const base = windowMonth() ?? window_.to.slice(0, 7);
    const d = new Date(`${base}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    const month = d.toISOString().slice(0, 7);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    window_ = { from: `${month}-01`, to: month === todayText.slice(0, 7) ? todayText : end };
    customRow.hidden = true;
    await render();
  }
  function syncChips() {
    let match = customRow.hidden ? 'custom' : 'custom';
    for (const [key] of PRESETS) {
      const w = presetWindow(key, todayText);
      if (w && w.from === window_.from && w.to === window_.to) match = key;
    }
    if (!customRow.hidden) match = 'custom';
    for (const chip of chips.children)
      chip.setAttribute('aria-pressed', String(chip.dataset.preset === match));
    const month = windowMonth();
    monthLabel.textContent = month
      ? new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-AU', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : 'Custom period';
    from.value = window_.from;
    to.value = window_.to;
  }
  // Layout: hero tiles, then two columns of cards.
  const tiles = el('div', undefined, { className: 'ov-tiles' });
  const grid = el('div', undefined, { className: 'ov-grid' });
  const categoriesOut = card('ov-categories'),
    trendOut = card('ov-trend'),
    balancesOut = card('ov-accounts'),
    upcomingOut = card('ov-upcoming'),
    regularOut = card('ov-regular'),
    tasksOut = card('ov-attention');
  const main = el('div', undefined, { className: 'ov-col' }),
    side = el('div', undefined, { className: 'ov-col' });
  main.append(categoriesOut, trendOut, regularOut);
  side.append(balancesOut, upcomingOut, tasksOut);
  grid.append(main, side);
  root.append(tiles, grid);
  function card(className) {
    return el('section', undefined, { className: `card card-pad ${className}` });
  }
  const head = (parent, title, text, href, glossaryKey) => {
    const h = el('div', undefined, { className: 'card-head' });
    const title_ = el('h3', title);
    if (glossaryKey) title_.append(info(glossaryKey));
    h.append(title_);
    if (href) h.append(link(text, href));
    parent.append(h);
  };
  function info(key, alignEnd = false) {
    const d = el('details', undefined, { className: `info${alignEnd ? ' align-end' : ''}` });
    const s = el('summary', 'i');
    s.setAttribute('aria-label', `About ${GLOSSARY[key].title.toLowerCase()}`);
    const body = el('div');
    body.append(el('strong', GLOSSARY[key].title), el('p', GLOSSARY[key].text));
    d.append(s, body);
    return d;
  }
  const details = el('details', undefined, { className: 'ov-source' });
  details.append(el('summary', 'About these numbers'));
  const detailBody = el('div');
  details.append(detailBody);
  root.append(details);
  const colorFor = (categoryId) => {
    const index = categories.findIndex((c) => c.id === categoryId);
    return index >= 0 && index < 6 ? `var(--viz-${index + 1})` : 'var(--viz-other)';
  };
  const categoryLabel = (id) =>
    categories.find((c) => c.id === id)?.label ?? (id ? id.replaceAll('_', ' ') : 'Uncategorised');
  const pct = (part, whole) =>
    !whole ? '' : part / whole < 0.01 ? '<1%' : `${Math.round((part / whole) * 100)}%`;
  const insights = (path) => fetch('/api/insights' + path).then((r) => (r.ok ? r.json() : null));
  // The comparison window: the previous calendar month for a month view,
  // otherwise the same number of days immediately before.
  function previousWindow() {
    const month = windowMonth();
    if (month) {
      const d = new Date(`${month}-01T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - 1);
      const prev = d.toISOString().slice(0, 7);
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
        .toISOString()
        .slice(0, 10);
      return {
        from: `${prev}-01`,
        to: end,
        label: d.toLocaleDateString('en-AU', { month: 'long', timeZone: 'UTC' }),
      };
    }
    const days = Math.round((Date.parse(window_.to) - Date.parse(window_.from)) / 86400000) + 1;
    const to = new Date(Date.parse(window_.from) - 86400000),
      from = new Date(to.getTime() - (days - 1) * 86400000);
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      label: `the previous ${days} days`,
    };
  }
  function delta(current, previous, label, lessIsGood) {
    const wrap = el('p', undefined, { className: 'stat-delta' });
    if (previous === null || previous === undefined) return wrap;
    if (!previous) {
      wrap.append(el('span', `Nothing recorded for ${label}`));
      return wrap;
    }
    const change = current - previous;
    if (!change) {
      wrap.append(el('span', `Same as ${label}`));
      return wrap;
    }
    const share = Math.abs(change) / previous;
    const words =
      share < 0.005
        ? 'about the same as'
        : `${Math.round(share * 100)}% ${change < 0 ? 'less than' : 'more than'}`;
    const good = lessIsGood ? change < 0 : change > 0;
    wrap.classList.add(good ? 'is-down' : 'is-up');
    wrap.append(el('i', undefined, { className: 'mark' }), el('span', `${words} ${label}`));
    return wrap;
  }
  function sparkline(months, currency, current) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 120 34');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('aria-hidden', 'true');
    const values = months.map(
      (m) => m.totals.find((t) => t.currency === currency)?.consumption_cents ?? 0,
    );
    const max = Math.max(1, ...values);
    const slot = 120 / values.length,
      width = Math.min(14, slot - 3);
    values.forEach((v, i) => {
      const h = Math.max(v > 0 ? 2 : 0, (v / max) * 30);
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', String(i * slot + (slot - width) / 2));
      r.setAttribute('y', String(34 - h));
      r.setAttribute('width', String(width));
      r.setAttribute('height', String(h));
      r.setAttribute('rx', '2');
      r.setAttribute('fill', i === values.length - 1 ? 'var(--viz-out)' : 'var(--track)');
      if (i === values.length - 1 && !current) r.setAttribute('fill', 'var(--viz-other)');
      svg.append(r);
    });
    return svg;
  }
  function renderTiles(r, prev, trend) {
    tiles.replaceChildren();
    if (!r.totals.length) {
      const empty = el('div', undefined, { className: 'empty ov-empty' });
      if (!r.coverage.transactions) {
        // An empty ledger, not an empty period: offer the sample dataset
        // alongside the importer.
        const actions = el('div', undefined, { className: 'ov-empty-actions' });
        actions.append(
          button('Load sample data', () => window.dispatchEvent(new CustomEvent('sample-open'))),
          button('Import a file', () => document.querySelector('#import').click()),
        );
        empty.append(
          el('strong', 'Nothing here yet.'),
          el(
            'p',
            'Try a year of sample banking to see what the overview shows, or import a statement from your bank.',
          ),
          actions,
        );
      } else
        empty.append(
          el('strong', 'A fresh page.'),
          el('p', 'No activity in this period. Choose another period, or import a statement.'),
          button('Import a statement', () => document.querySelector('#import').click()),
        );
      tiles.append(empty);
      return;
    }
    let i = 0;
    for (const t of r.totals) {
      const p = prev?.totals.find((x) => x.currency === t.currency);
      const left = t.income_cents - t.consumption_cents;
      const mixed = r.totals.length > 1;
      const tile = (label, value, cls, glossaryKey, extra, hero = false) => {
        const s = el('div', undefined, { className: `stat reveal${hero ? ' hero' : ''}` });
        s.style.setProperty('--i', String(i++));
        const l = el('span', undefined, { className: 'stat-label' });
        l.append(el('span', label));
        if (mixed) l.append(el('span', t.currency, { className: 'badge' }));
        l.append(info(glossaryKey));
        s.append(l, el('strong', money(value, t.currency), { className: `stat-value ${cls}` }));
        if (extra) s.append(extra);
        return s;
      };
      const spent = tile(
        'Spent',
        t.consumption_cents,
        'money-out',
        'spending',
        delta(t.consumption_cents, p?.consumption_cents ?? null, prev.label, true),
        true,
      );
      if (trend?.months?.length) spent.append(sparkline(trend.months, t.currency, true));
      tiles.append(
        spent,
        tile(
          'Income',
          t.income_cents,
          'money-in',
          'income',
          delta(t.income_cents, p?.income_cents ?? null, prev.label, false),
        ),
        tile(
          'Left over',
          left,
          left < 0 ? 'money-out' : '',
          'left_over',
          el('span', left < 0 ? 'Spending was more than income' : 'Income minus spending', {
            className: 'stat-hint',
          }),
        ),
      );
    }
  }
  function renderCategories(r) {
    categoriesOut.replaceChildren();
    head(categoriesOut, 'Where it went', 'All transactions', '#view=transactions', 'spending');
    if (!r.totals.length) {
      categoriesOut.append(
        el('p', 'Your spending by category will appear here.', { className: 'muted' }),
      );
      return;
    }
    for (const t of r.totals) {
      const spent = t.categories
        .filter((k) => k.consumption_cents > 0)
        .sort((a, b) => b.consumption_cents - a.consumption_cents);
      const total = spent.reduce((s, k) => s + k.consumption_cents, 0);
      if (r.totals.length > 1) categoriesOut.append(el('h4', t.currency));
      const ribbon = el('div', undefined, { className: 'ov-ribbon', ariaHidden: 'true' });
      for (const k of spent.slice(0, 6)) {
        const seg = el('span');
        seg.style.width = `${(k.consumption_cents / total) * 100}%`;
        seg.style.background = colorFor(k.category);
        ribbon.append(seg);
      }
      const rest = spent.slice(6).reduce((s, k) => s + k.consumption_cents, 0);
      if (rest) {
        const seg = el('span');
        seg.style.width = `${(rest / total) * 100}%`;
        seg.style.background = 'var(--viz-other)';
        ribbon.append(seg);
      }
      categoriesOut.append(ribbon);
      const list = el('div', undefined, { className: 'ov-category-list' });
      const rowFor = (label, cents, color, href) => {
        const item = el(href ? 'a' : 'div', undefined, { className: 'ov-category' });
        if (href) item.href = href;
        const dot = el('i', undefined, { className: 'dot', ariaHidden: 'true' });
        dot.style.background = color;
        const track = el('span', undefined, { className: 'track', ariaHidden: 'true' }),
          fill = el('span');
        fill.style.width = `${(cents / total) * 100}%`;
        fill.style.background = color;
        track.append(fill);
        item.append(
          dot,
          el('span', label),
          track,
          el('span', pct(cents, total), { className: 'ov-share' }),
          el('strong', money(cents, t.currency), { className: 'num' }),
        );
        return item;
      };
      for (const k of spent.slice(0, 6))
        list.append(
          rowFor(
            categoryLabel(k.category),
            k.consumption_cents,
            colorFor(k.category),
            `#view=transactions&category=${encodeURIComponent(k.category)}&from=${window_.from}&to=${window_.to}`,
          ),
        );
      if (rest)
        list.append(rowFor(`Other (${spent.length - 6} categories)`, rest, 'var(--viz-other)'));
      if (!spent.length)
        list.append(el('p', 'No spending recorded in this period.', { className: 'muted' }));
      categoriesOut.append(list);
      if (t.categories.some((k) => k.consumption_cents < 0))
        categoriesOut.append(
          el('p', 'Bars show positive spending; the total also includes net refunds.', {
            className: 'muted',
          }),
        );
    }
  }
  // Grouped bars, one pair per month, drawn to the dataviz mark specs: thin
  // bars with a 2px surface gap, rounded data-ends, a hairline baseline and a
  // table equivalent for screen readers.
  function renderTrend(trend) {
    trendOut.replaceChildren();
    head(trendOut, 'Month by month', undefined, undefined, 'coverage');
    if (!trend?.months?.length) {
      trendOut.append(
        el('p', 'Six months of history will appear here as you import.', { className: 'muted' }),
      );
      return;
    }
    const currencies = [...new Set(trend.months.flatMap((m) => m.totals.map((t) => t.currency)))];
    if (!currencies.length) {
      trendOut.append(
        el('p', 'No posted transactions in the last six months.', { className: 'muted' }),
      );
      return;
    }
    for (const currency of currencies) {
      if (currencies.length > 1) trendOut.append(el('h4', currency));
      const series = trend.months.map((m) => {
        const t = m.totals.find((x) => x.currency === currency);
        return { month: m.month, out: t?.consumption_cents ?? 0, in: t?.income_cents ?? 0 };
      });
      const max = Math.max(1, ...series.flatMap((s) => [s.out, s.in]));
      const step = niceStep(max),
        top = Math.ceil(max / step) * step;
      const W = 640,
        H = 220,
        padL = 40,
        padR = 8,
        padT = 12,
        padB = 28,
        plotW = W - padL - padR,
        plotH = H - padT - padB;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `Spending and income per month, ${currency}`);
      const ns = (tag, attrs) => {
        const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
        return n;
      };
      const y = (v) => padT + plotH - (v / top) * plotH;
      for (let v = 0; v <= top; v += step) {
        svg.append(
          ns('line', {
            x1: padL,
            x2: W - padR,
            y1: y(v),
            y2: y(v),
            class: v === 0 ? 'ov-axis' : 'ov-gridline',
          }),
        );
        svg.append(
          Object.assign(
            ns('text', { x: padL - 8, y: y(v) + 4, class: 'ov-tick', 'text-anchor': 'end' }),
            {
              textContent: compact(v),
            },
          ),
        );
      }
      const slot = plotW / series.length,
        bar = Math.min(24, (slot - 16) / 2);
      series.forEach((s, i) => {
        const x0 = padL + i * slot + slot / 2;
        const pair = [
          ['out', s.out, 'var(--viz-out)', 'Spent'],
          ['in', s.in, 'var(--viz-in)', 'Income'],
        ];
        pair.forEach(([key, v, fill, label], j) => {
          const x = x0 - bar - 1 + j * (bar + 2);
          const h = Math.max(v > 0 ? 2 : 0, (v / top) * plotH);
          const g = ns('g', { class: 'ov-bar' });
          g.append(
            ns('rect', { x: x - 4, y: padT, width: bar + 8, height: plotH, fill: 'transparent' }),
          );
          // Rounded at the data end, square at the baseline.
          const rad = Math.min(4, h / 2),
            topY = y(0) - h;
          const r = ns('path', {
            d: `M${x} ${y(0)}V${topY + rad}a${rad} ${rad} 0 0 1 ${rad} -${rad}h${bar - 2 * rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}V${y(0)}Z`,
            fill,
          });
          const title = ns('title', {});
          title.textContent = `${monthName(s.month)}: ${label} ${money(v, currency)}`;
          r.append(title);
          g.append(r);
          g.dataset.key = key;
          svg.append(g);
        });
        svg.append(
          Object.assign(
            ns('text', { x: x0, y: H - 8, class: 'ov-month', 'text-anchor': 'middle' }),
            {
              textContent: monthName(s.month, true),
            },
          ),
        );
      });
      const figure = el('figure', undefined, { className: 'ov-chart' });
      figure.append(svg);
      const legend = el('div', undefined, { className: 'ov-legend' });
      for (const [label, color] of [
        ['Spent', 'var(--viz-out)'],
        ['Income', 'var(--viz-in)'],
      ]) {
        const item = el('span');
        const sw = el('i', undefined, { className: 'ov-swatch' });
        sw.style.background = color;
        item.append(sw, label);
        legend.append(item);
      }
      figure.append(legend);
      trendOut.append(figure);
      const t = table(
        trendOut,
        `Spending and income per month (${currency})`,
        ['Month', 'Spent', 'Income'],
        series.map((s) => [monthName(s.month), money(s.out, currency), money(s.in, currency)]),
      );
      t.parentElement.classList.add('sr-only');
    }
  }
  const monthName = (month, short = false) =>
    new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-AU', {
      month: short ? 'short' : 'long',
      ...(short ? {} : { year: 'numeric' }),
      timeZone: 'UTC',
    });
  const compact = (cents) => {
    const v = cents / 100;
    return v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v));
  };
  function niceStep(max) {
    const rough = max / 4,
      mag = Math.pow(10, Math.floor(Math.log10(rough)));
    for (const m of [1, 2, 2.5, 5, 10]) if (rough <= m * mag) return m * mag;
    return 10 * mag;
  }
  function renderBalances(r) {
    balancesOut.replaceChildren();
    head(balancesOut, 'Account balances', 'Accounts', '#view=accounts', 'balance');
    for (const b of r.balances) {
      const item = link('', '#view=accounts');
      item.className = 'ov-account';
      const name = accountName(b.account_id);
      const icon = el('span', name.slice(0, 1), {
        className: 'ov-account-icon',
        ariaHidden: 'true',
      });
      const rec = r.reconciliation.find((x) => x.account_id === b.account_id);
      const state = reconciliationLabel(rec, (c) => money(c, b.currency ?? 'AUD'));
      const text = el('span');
      text.append(
        el('strong', name),
        el('small', b.as_of ? `Statement of ${b.as_of.slice(0, 10)}` : 'No statement balance'),
      );
      const right = el('span', undefined, { className: 'ov-account-right' });
      right.append(
        el('strong', b.current_cents === null ? 'Unknown' : money(b.current_cents, b.currency), {
          className: b.current_cents === null ? 'num is-unknown' : 'num',
        }),
        el('span', state.text, { className: `badge ${state.tone === 'muted' ? '' : state.tone}` }),
      );
      item.append(icon, text, right);
      balancesOut.append(item);
    }
    if (!r.balances.length)
      balancesOut.append(
        el('p', 'Your accounts will appear after your first import.', { className: 'muted' }),
      );
  }
  function renderUpcoming(data) {
    upcomingOut.replaceChildren();
    head(upcomingOut, 'Coming up', undefined, undefined, 'regular');
    if (!data?.payments?.length) {
      upcomingOut.append(
        el(
          'p',
          'No regular payments detected yet. They appear once a charge has repeated three times.',
          {
            className: 'muted',
          },
        ),
      );
      return;
    }
    const totals = new Map();
    for (const p of data.payments)
      totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.mean_amount.cents);
    const summary = el('p', undefined, { className: 'ov-upcoming-total' });
    summary.append(
      el('strong', [...totals].map(([c, cents]) => money(cents, c)).join(' + '), {
        className: 'num',
      }),
      el(
        'span',
        ` expected in the next ${data.date_range ? Math.round((Date.parse(data.date_range.to) - Date.parse(data.date_range.from)) / 86400000) : 30} days`,
      ),
    );
    upcomingOut.append(summary);
    const list = el('div', undefined, { className: 'ov-list' });
    for (const p of data.payments.slice(0, 6)) {
      const item = el('div', undefined, { className: 'ov-list-row' });
      const text = el('span');
      text.append(
        el('strong', p.description),
        el('small', `${cadenceLabel(p.cadence)} · ${accountName(p.account_id)}`),
      );
      const right = el('span', undefined, { className: 'ov-list-right' });
      right.append(
        el('strong', `about ${money(p.mean_amount.cents, p.currency)}`, { className: 'num' }),
        el('small', shortDate(p.next_date)),
      );
      item.append(text, right);
      list.append(item);
    }
    upcomingOut.append(list);
    if (data.payments.length > 6)
      upcomingOut.append(
        el('p', `${data.payments.length - 6} more in the same window.`, { className: 'muted' }),
      );
  }
  function renderRegular(data) {
    regularOut.replaceChildren();
    head(regularOut, 'Regular charges', undefined, undefined, 'regular');
    if (!data?.charges?.length) {
      regularOut.append(
        el(
          'p',
          'Subscriptions and bills that repeat will be listed here after three similar charges.',
          {
            className: 'muted',
          },
        ),
      );
      return;
    }
    const list = el('div', undefined, { className: 'ov-list' });
    for (const c of data.charges.slice(0, 6)) {
      const item = link('', `#view=transactions&query=${encodeURIComponent(c.description)}`);
      item.className = 'ov-list-row';
      const text = el('span');
      text.append(
        el('strong', c.description),
        el(
          'small',
          `${cadenceLabel(c.cadence)} · ${c.count} charges · last ${shortDate(c.last_date)}`,
        ),
      );
      const right = el('span', undefined, { className: 'ov-list-right' });
      right.append(el('strong', money(c.mean_amount.cents, c.currency), { className: 'num' }));
      if (Math.abs(c.amount_drift.cents) >= 100)
        right.append(
          el(
            'small',
            `${c.amount_drift.cents > 0 ? 'up' : 'down'} ${money(Math.abs(c.amount_drift.cents), c.currency)} lately`,
          ),
        );
      item.append(text, right);
      list.append(item);
    }
    regularOut.append(list);
    if (data.charges.length > 6)
      regularOut.append(
        el('p', `${data.charges.length - 6} more regular charges.`, { className: 'muted' }),
      );
  }
  const shortDate = (day) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  function renderTasks(r) {
    tasksOut.replaceChildren();
    head(tasksOut, 'Needs a look');
    // Rows the report leaves out of spending: loan repayments, mortgage, cash
    // movements, unlabelled rows and unexplained credits. Labelling a row in
    // Transactions is the one way to move it.
    const unresolved = r.unresolved_transaction_ids.length;
    if (unresolved) {
      const item = el('div', undefined, { className: 'ov-task' });
      const text = el('span');
      text.append(
        el('strong', 'Not counted as spending'),
        el('small', 'Loan repayments, cash, unlabelled rows and unexplained credits.'),
      );
      const target = link('', `#view=transactions&from=${r.from}&to=${r.to}`);
      target.append(el('span', String(unresolved), { className: 'ov-task-count' }), text);
      item.append(target);
      tasksOut.append(item);
    } else {
      const clear = el('div', undefined, { className: 'ov-clear' });
      clear.append(
        el('strong', 'Nothing waiting.'),
        el('span', 'No checks flagged for this data.'),
      );
      tasksOut.append(clear);
    }
    const pending = r.totals.reduce((sum, t) => sum + t.pending_count, 0);
    const notes = el('div', undefined, { className: 'ov-notes' });
    if (pending)
      notes.append(
        el(
          'p',
          `${pending} pending transaction${pending === 1 ? '' : 's'} left out of the totals.`,
          { className: 'muted' },
        ),
      );
    notes.append(
      el(
        'p',
        r.coverage.to
          ? `Transactions through ${r.coverage.to}. Imported history may be incomplete.`
          : 'Import a statement to start your overview.',
        { className: 'muted' },
      ),
    );
    tasksOut.append(notes);
  }
  function renderDetails(r) {
    detailBody.replaceChildren();
    for (const key of [
      'spending',
      'income',
      'left_over',
      'balance',
      'regular',
      'not_classified',
      'coverage',
    ]) {
      const p = el('p');
      p.append(el('strong', `${GLOSSARY[key].title}. `), GLOSSARY[key].text);
      detailBody.append(p);
    }
    for (const t of r.totals)
      table(
        detailBody,
        `${t.currency} money movements in this period`,
        ['Movement', 'Amount'],
        [
          ['All money out (including transfers)', money(t.posted_outgoing_cents, t.currency)],
          ['All money in (including transfers)', money(t.posted_incoming_cents, t.currency)],
          ['Pending, net', money(t.pending_net_cents, t.currency)],
          ...t.classes.map((k) => [termClass(k.classification), money(k.net_cents, t.currency)]),
        ],
      );
    for (const t of r.totals)
      table(
        detailBody,
        `${t.currency} spending by category`,
        ['Category', 'Net spending'],
        t.categories.map((k) => [
          categoryLabel(k.category),
          money(k.consumption_cents, t.currency),
        ]),
      );
    for (const text of [
      r.inclusion_rules,
      r.reconciliation_basis,
      `Dates: ${r.date_basis}.`,
      `${r.coverage.transactions} imported transactions. Complete history is not verified.`,
    ])
      detailBody.append(el('p', text, { className: 'muted' }));
    if (r.last_import)
      detailBody.append(
        el(
          'p',
          `Last import: ${r.last_import.file_name} · ${(r.last_import.finished_at ?? r.last_import.started_at).slice(0, 10)}`,
          { className: 'muted' },
        ),
      );
  }
  async function render() {
    if (!window_.from || !window_.to || window_.from > window_.to)
      throw new Error('Choose a start date on or before the end date.');
    const version = ++request;
    syncChips();
    root.setAttribute('aria-busy', 'true');
    try {
      const prev = previousWindow();
      const [r, p, trend, upcoming, regular] = await Promise.all([
        api(`/api/insights/report?from=${window_.from}&to=${window_.to}`),
        api(`/api/insights/report?from=${prev.from}&to=${prev.to}`).catch(() => null),
        insights(`/trend?to=${window_.to.slice(0, 7)}&months=6`).catch(() => null),
        insights('/upcoming?days=30').catch(() => null),
        insights('/recurring').catch(() => null),
      ]);
      if (version !== request || !root.isConnected) return;
      subline.textContent = `${describeWindow(r.from, r.to)} · ${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`;
      renderTiles(r, { ...prev, totals: p?.totals ?? [] }, trend);
      renderCategories(r);
      renderTrend(trend);
      renderBalances(r);
      renderUpcoming(upcoming);
      renderRegular(regular);
      renderTasks(r);
      renderDetails(r);
      let i = 0;
      for (const c of root.querySelectorAll('.ov-grid > .ov-col > .card')) {
        c.classList.add('reveal');
        c.style.setProperty('--i', String(3 + i++));
      }
    } finally {
      if (version === request) root.removeAttribute('aria-busy');
    }
  }
  await render();
}
register('overview', 'Overview', overview);
