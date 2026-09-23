import { formatMoney } from '/money.js';
import { presetWindow } from '/results.js';
import { describeToolInput, toolLabel } from '/terms.js';
const $ = (id) => document.getElementById(id);
let selectedId = null,
  savedMessages = [],
  remoteActive = false,
  loadingChat = false;
let selectionVersion = 0,
  listVersion = 0,
  nextCursor = null,
  deferredHash = false;
let wantedBackend = null;
let categoriseBusy = false;
function setHistoryOpen(open) {
  $('history-panel').hidden = !open;
  $('chat-nav').setAttribute('aria-expanded', String(open));
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('history-panel').hidden) {
    setHistoryOpen(false);
    $('chat-nav').focus();
  }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.workspace-nav')) setHistoryOpen(false);
});
function setHash(id) {
  showWorkspace('chat');
  if (location.hash === (id ? `#chat=${id}` : '')) return;
  window.history.pushState(null, '', id ? `#chat=${id}` : location.pathname + location.search);
}
function restoreBackend(spec) {
  wantedBackend = spec;
  if (!spec) return;
  if (![...$('backend').options].some((o) => o.value === spec)) {
    const option = element('option', 'Saved model unavailable — choose a model');
    option.value = spec;
    option.dataset.unavailable = 'true';
    $('backend').append(option);
  }
  $('backend').value = spec;
}
async function loadList(more = false) {
  const version = ++listVersion;
  $('history-state').textContent = 'Loading saved chats…';
  $('history-retry').hidden = true;
  $('load-more').disabled = true;
  try {
    const page = await jsonRequest(
      '/api/conversations?limit=50' +
        (more && nextCursor ? `&before=${encodeURIComponent(nextCursor)}` : ''),
    );
    if (version !== listVersion) return;
    if (!more) $('saved-chats').replaceChildren();
    for (const chat of page.conversations) {
      if ([...$('saved-chats').children].some((row) => row.dataset.id === chat.id)) continue;
      const row = element('li');
      row.dataset.id = chat.id;
      const open = element('button', undefined, 'open-chat');
      open.type = 'button';
      open.append(element('span', chat.title));
      const time = element('time', relativeTime(chat.updated_at));
      time.dateTime = chat.updated_at;
      open.append(time);
      open.title = chat.title;
      open.addEventListener('click', () => {
        if (!active) {
          setHash(chat.id);
          void selectChat(chat.id);
        }
      });
      const remove = element('button', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Delete ${chat.title}`);
      remove.addEventListener('click', async () => {
        if (active || !confirm(`Permanently delete “${chat.title}” and its messages?`)) return;
        remove.disabled = true;
        try {
          const response = await fetch(`/api/conversations/${chat.id}`, { method: 'DELETE' });
          if (!response.ok) throw new Error((await response.json()).error);
          if (selectedId === chat.id) {
            setHash(null);
            await selectChat(null);
          }
          await loadList();
        } catch (error) {
          notice(error.message);
          remove.disabled = false;
        }
      });
      row.append(open, remove);
      $('saved-chats').append(row);
    }
    nextCursor = page.nextCursor;
    $('load-more').hidden = !nextCursor;
    $('history-state').textContent = $('saved-chats').children.length
      ? ''
      : 'No saved chats yet. Ask a question to start one.';
    updateAvailability();
  } catch {
    if (version !== listVersion) return;
    $('history-state').textContent = 'Saved chats could not be loaded.';
    $('history-retry').hidden = false;
  } finally {
    if (version === listVersion) $('load-more').disabled = false;
  }
}
async function selectChat(id) {
  setHistoryOpen(false);
  const version = ++selectionVersion;
  selectedId = id;
  savedMessages = [];
  remoteActive = false;
  loadingChat = !!id;
  $('messages').replaceChildren();
  $('question').value = '';
  $('welcome').hidden = !!id;
  document.body.classList.toggle('has-messages', !!id);
  $('transcript-state').hidden = !id;
  $('transcript-state').textContent = id ? 'Loading conversation…' : '';
  notice('');
  updateAvailability();
  resizeComposer();
  if (!id) return;
  try {
    const saved = await jsonRequest(`/api/conversations/${encodeURIComponent(id)}`);
    if (version !== selectionVersion) return;
    savedMessages = saved.messages;
    remoteActive = saved.active;
    restoreBackend(saved.conversation.backend_spec);
    for (const m of savedMessages) {
      const message = addMessage(m.role, m.text);
      if (m.role === 'assistant') {
        if (m.status === 'completed') renderAnswer(message.body, m.text);
        else
          showError(
            message,
            `${m.status === 'pending' ? 'Generating in another session — refresh the page to check progress.' : m.status === 'interrupted' ? 'Interrupted answer.' : 'Failed answer.'} ${m.error_text || ''}`,
          );
      }
    }
    loadingChat = false;
    $('transcript-state').textContent = remoteActive
      ? 'This conversation is generating. Refresh the page to check its outcome.'
      : '';
    $('transcript-state').hidden = !remoteActive;
  } catch (error) {
    if (version !== selectionVersion) return;
    $('transcript-state').textContent =
      `${error.message} Refresh the page to retry or use New chat to start fresh.`;
  } finally {
    if (version === selectionVersion) {
      updateAvailability();
      followLatest();
    }
  }
}
$('load-more').addEventListener('click', () => void loadList(true));
$('history-retry').addEventListener('click', () => void loadList());
function navigateHash() {
  if (active) {
    deferredHash = true;
    return;
  }
  const hash = new URLSearchParams(location.hash.slice(1));
  const view = hash.get('view');
  showWorkspace(view || 'chat');
  if (currentView === 'chat' && hash.get('chat') !== selectedId) void selectChat(hash.get('chat'));
  else if (currentView === 'transactions') void openLedger(true);
}
window.addEventListener('hashchange', navigateHash);
let active = null;
let statusPending = false;
let statusRefreshQueued = false;
let emptyStateShown = false;
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
// "Just now", "3 h ago", "Yesterday", then a short date.
function relativeTime(iso) {
  const then = new Date(iso),
    diff = Date.now() - then.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}
async function jsonRequest(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}
function updateAvailability() {
  const selected = $('backend').selectedOptions[0];
  const message =
    selected?.dataset.unavailable === 'true'
      ? 'The saved backend is unavailable. Choose an available model before sending.'
      : !$('backend').value
        ? 'No model configured. Open Settings to choose a model.'
        : selected?.dataset.reachable === 'false'
          ? 'This backend is currently unreachable. Check that its server and model are running.'
          : '';
  $('availability').textContent = message;
  $('availability').hidden = !message;
  $('backend-dot').dataset.state = !$('backend').value ? 'none' : message ? 'off' : 'on';
  const full =
    savedMessages.filter((m) => m.role === 'assistant' && m.status === 'completed').length >= 49;
  $('send').disabled =
    !!active ||
    loadingChat ||
    remoteActive ||
    full ||
    selected?.dataset.unavailable === 'true' ||
    selected?.dataset.reachable === 'false' ||
    !$('backend').value ||
    !$('question').value.trim();
  if (full) notice('This conversation is full. Start a New chat to continue.');
  for (const row of $('saved-chats').children) {
    row
      .querySelector('.open-chat')
      .setAttribute('aria-current', String(row.dataset.id === selectedId));
    for (const button of row.querySelectorAll('button'))
      button.disabled =
        !!active || (button !== row.firstChild && row.dataset.id === selectedId && remoteActive);
  }
  $('new-chat').disabled = !!active;
  if (workspaceStatus) updateAccountCategorise(workspaceStatus);
  updateProcessing();
}
// Status details. Import times are when a file was
// imported, shown in local time. Coverage is what has been observed,
// never proof of completeness: a file is only as complete as the export.
// The Accounts view carries the detail; the toolbar shows nothing about it.
const localTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
// Observed dates are UTC calendar days; format them without a timezone shift.
const calendarDate = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
async function refreshStatus() {
  if (statusPending) {
    statusRefreshQueued = true;
    return;
  }
  statusPending = true;
  try {
    const status = await jsonRequest('/api/status');
    workspaceStatus = status;
    $('nav-coverage').textContent = status.coverage.to
      ? `Data through ${calendarDate(status.coverage.to)}`
      : 'No data imported yet';
    const empty = status.transactions === 0;
    $('welcome-empty').hidden = !empty;
    // A fresh database opens on the import view, once per page load.
    if (empty && !emptyStateShown && !location.hash && !$('importer').open) {
      emptyStateShown = true;
      showWorkspace('accounts');
    }
    const selected = wantedBackend || $('backend').value;
    $('backend').replaceChildren(
      ...status.backends.map((item) => {
        const label = `Local · ${item.spec.replace(/^local\//, '')}`;
        const option = element('option', label);
        option.title = item.spec;
        option.value = item.spec;
        option.dataset.reachable = String(item.reachable);
        return option;
      }),
    );
    if (!status.backends.length) {
      const option = element('option', 'No backend configured');
      option.value = '';
      $('backend').append(option);
    } else if (status.backends.some((item) => item.spec === selected))
      $('backend').value = selected;
    if (selected) restoreBackend(selected);
    updateAvailability();
    renderAccounts(status);
  } catch {
    $('account-status').textContent =
      'Accounts could not be refreshed. Check that the local server is running, then retry.';
    $('account-status').hidden = false;
    $('accounts-retry').hidden = false;
  } finally {
    statusPending = false;
    if (statusRefreshQueued) {
      statusRefreshQueued = false;
      void refreshStatus();
    }
  }
}
function addMessage(role, text = '') {
  const article = element('article', undefined, `message ${role}`);
  article.append(element('h2', role === 'user' ? 'You' : 'ledgerchat'));
  const body = element('div', text, 'body');
  article.append(body);
  $('messages').append(article);
  return { article, body };
}
// Activity: each tool call is a step in words, with the raw call and result
// one disclosure deeper for anyone who wants them.
function tracePanel(message) {
  const details = element('details', undefined, 'trace');
  details.append(element('summary', 'How this was worked out'));
  const meta = element('p', '', 'trace-meta');
  const steps = element('ol', undefined, 'trace-steps');
  details.append(meta, steps);
  message.article.append(details);
  return { details, meta, steps };
}
function traceStep(trace, call) {
  const li = element('li', undefined, 'trace-step');
  const head = element('div', undefined, 'trace-step-head');
  head.append(element('strong', toolLabel(call.name)));
  const summary = describeToolInput(call.name, call.rawInput);
  if (summary) head.append(element('span', summary, 'trace-step-args'));
  const status = element('span', 'Working…', 'trace-step-status');
  head.append(status);
  const raw = element('details', undefined, 'trace-raw');
  raw.append(element('summary', 'Details'));
  const pre = element('pre', `${call.name}\n${JSON.stringify(call.rawInput, null, 2)}`);
  raw.append(pre);
  li.append(head, raw);
  trace.steps.append(li);
  return { li, status, pre };
}
function traceNote(trace, text) {
  const li = element('li', text, 'trace-step trace-note');
  trace.steps.append(li);
  return li;
}
function showError(message, text) {
  let error = message.article.querySelector('.error');
  if (!error) {
    error = element('p', '', 'error');
    error.setAttribute('role', 'alert');
    message.article.append(error);
  }
  error.textContent = text;
}
async function readEvents(response, onEvent) {
  if (!response.body) throw new Error('No response stream was received.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  function drain(final = false) {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data));
    }
    if (final && buffer.trim()) throw new Error('The response stream ended unexpectedly.');
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain();
    }
    buffer += decoder.decode();
    drain(true);
  } finally {
    reader.releaseLock();
  }
}
$('chat').addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = $('question').value.trim();
  if (
    active ||
    loadingChat ||
    remoteActive ||
    !question ||
    !$('backend').value ||
    $('backend').selectedOptions[0]?.dataset.unavailable === 'true' ||
    $('backend').selectedOptions[0]?.dataset.reachable === 'false'
  )
    return;
  if (
    savedMessages.filter((m) => m.role === 'assistant' && m.status === 'completed').length >= 49
  ) {
    notice('This conversation is full. Start a New chat.');
    return;
  }
  notice('');
  $('welcome').hidden = true;
  document.body.classList.add('has-messages');
  following = true;
  addMessage('user', question);
  const assistant = addMessage('assistant');
  assistant.article.classList.add('busy');
  const trace = tracePanel(assistant);
  trace.details.hidden = true;
  const pending = new Map();
  let streamed = '';
  active = new AbortController();
  $('question').value = '';
  resizeComposer();
  followLatest();
  $('backend').disabled = true;
  $('send').hidden = true;
  $('stop').hidden = false;
  updateAvailability();
  let done = false;
  let failed = false;
  const requestId = crypto.randomUUID();
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: selectedId || undefined,
        text: question,
        requestId,
        backend: $('backend').value,
      }),
      signal: active.signal,
    });
    if (!response.ok) {
      const body = await response.json();
      if (body.conversationId) {
        selectedId = body.conversationId;
        setHash(selectedId);
      }
      throw new Error(body.error || 'Chat request failed.');
    }
    await readEvents(response, (event) => {
      followLatest();
      if (event.type === 'conversation') {
        selectedId = event.conversationId;
        if (!deferredHash) setHash(selectedId);
        void loadList();
      } else if (event.type === 'text') {
        // The server releases answer text only after checking its figures.
        streamed += event.text;
        if (streamed.trim()) renderAnswer(assistant.body, streamed);
      } else if (event.type === 'retry') {
        // The answer could not be tied to the required tool result.
        streamed = '';
        assistant.body.replaceChildren();
        trace.details.hidden = false;
        trace.details.open = true;
        traceNote(
          trace,
          event.reason === 'comparison_needs_tool'
            ? 'Answer withheld: a spending comparison needs one tool result with both periods. Asking again.'
            : event.reason === 'direct_answer_needs_tool'
              ? 'Answer withheld: the account balance or cash flow needs a matching tool result. Asking again.'
              : 'Answer withheld: a numerical claim was unsupported by the tool results. Asking again.',
        );
      } else if (event.type === 'tool_call') {
        // Steps stay open while the model is working, so the reader can
        // see what it is looking at, and fold away once the answer lands.
        trace.details.hidden = false;
        trace.details.open = true;
        streamed = '';
        assistant.body.replaceChildren();
        pending.set(event.call.id, traceStep(trace, event.call));
      } else if (event.type === 'tool_result') {
        const step = pending.get(event.result.callId);
        if (step) {
          step.pre.textContent += `\n${event.result.isError ? 'Error' : 'Result'}: ${event.result.content}`;
          step.status.textContent = event.result.isError ? 'Failed' : 'Done';
          step.li.classList.toggle('is-error', !!event.result.isError);
        }
      } else if (event.type === 'error') {
        failed = true;
        showError(assistant, event.error);
      } else if (event.type === 'done') {
        done = true;
        failed = failed || event.failed;
        if (!failed && !event.text.trim()) {
          failed = true;
          showError(
            assistant,
            'The model finished without an answer. Try asking again or choose another model.',
          );
        } else if (!failed) {
          renderAnswer(assistant.body, event.text);
        }
        trace.details.open = false;
        if (event.status !== 'completed')
          showError(
            assistant,
            `${event.status === 'interrupted' ? 'Interrupted' : 'Failed'} answer. Any partial text has been saved.`,
          );
        if (event.trace) {
          trace.details.hidden = false;
          const turns = event.trace.turns;
          trace.meta.textContent = `${event.trace.backendLabel} · ${Math.round(turns.reduce((n, t) => n + t.latencyMs, 0))} ms · ${turns.reduce((n, t) => n + t.usage.inputTokens, 0)} input / ${turns.reduce((n, t) => n + t.usage.outputTokens, 0)} output tokens`;
          for (const [i, turn] of turns.entries()) {
            const repeated = (turn.repeatedCalls || [])
              .map(
                (r) =>
                  `\nRepeated ${r.name} (occurrence ${r.occurrence}): ${r.action === 'terminated' ? 'request stopped' : 'not re-run, asked the model to change its arguments'}`,
              )
              .join('');
            const unverified = turn.unverified
              ? '\nWithheld: quoted figures with no tool result in the conversation'
              : '';
            trace.details.append(
              element(
                'p',
                `Turn ${i + 1}: ${Math.round(turn.latencyMs)} ms · ${turn.usage.inputTokens} input / ${turn.usage.outputTokens} output tokens${repeated}${unverified}`,
                'trace-turn',
              ),
            );
          }
        }
      }
    });
    if (!done) throw new Error('The response ended before completion. Please try again.');
  } catch (error) {
    showError(
      assistant,
      active.signal.aborted
        ? 'Request stopped. You can ask another question.'
        : error.message || 'Chat failed. Please try again.',
    );
  } finally {
    if (!deferredHash && selectedId) {
      if (!done) await selectChat(selectedId);
      else {
        try {
          const saved = await jsonRequest(`/api/conversations/${selectedId}`);
          savedMessages = saved.messages;
          remoteActive = saved.active;
        } catch {
          notice('Could not reload saved state. Refresh the page before continuing.');
          loadingChat = true;
        }
      }
    }
    active = null;
    if (deferredHash) {
      deferredHash = false;
      navigateHash();
    }
    void loadList();
    assistant.article.classList.remove('busy');
    $('backend').disabled = false;
    $('send').hidden = false;
    $('stop').hidden = true;
    updateAvailability();
    $('question').focus({ preventScroll: true });
    followLatest();
  }
});

let following = true;
function followLatest() {
  if (following)
    requestAnimationFrame(() =>
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }),
    );
}
window.addEventListener(
  'scroll',
  () => {
    following = document.documentElement.scrollHeight - innerHeight - scrollY < 100;
    $('jump-latest').hidden = following || !document.body.classList.contains('has-messages');
  },
  { passive: true },
);
$('jump-latest').addEventListener('click', () => {
  following = true;
  followLatest();
});
function resizeComposer() {
  const input = $('question');
  input.style.height = 'auto';
  input.style.height = `${Math.min(210, Math.max(document.body.classList.contains('has-messages') ? 58 : 84, input.scrollHeight))}px`;
}
$('question').addEventListener('input', () => {
  resizeComposer();
  updateAvailability();
});
$('new-chat').addEventListener('click', () => {
  if (active) return;
  setHash(null);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  void selectChat(null);
  window.scrollTo({ top: 0 });
  $('question').focus({ preventScroll: true });
});
// Render a deliberately small Markdown subset with DOM nodes only. Model
// text is never parsed as HTML, including transaction descriptions.
function inline(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (part.startsWith('**') && part.endsWith('**'))
      parent.append(element('strong', part.slice(2, -2)));
    else if (part.startsWith('`') && part.endsWith('`'))
      parent.append(element('code', part.slice(1, -1)));
    else parent.append(document.createTextNode(part));
  }
}
// An unescaped pipe: `\|` inside a cell is literal text, not a separator.
const pipe = /(?<!\\)\|/;
function cells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(pipe)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}
// The alignments of a delimiter row, or null when the line is not one. A
// table is only recognised when this returns non-null for its second line,
// so a sentence containing a stray pipe stays a paragraph.
function alignments(line) {
  const parts = cells(line);
  if (!parts.every((part) => /^:?-+:?$/.test(part))) return null;
  return parts.map((part) =>
    part.endsWith(':')
      ? part.startsWith(':')
        ? 'center'
        : 'right'
      : part.startsWith(':')
        ? 'left'
        : '',
  );
}
function renderTable(body, lines) {
  const header = cells(lines[0]),
    align = alignments(lines[1]);
  const scroll = element('div', undefined, 'table-scroll'),
    table = element('table'),
    head = element('tr');
  for (const [i, text] of header.entries()) {
    const th = element('th');
    if (align[i]) th.style.textAlign = align[i];
    inline(th, text);
    head.append(th);
  }
  const thead = element('thead');
  thead.append(head);
  const tbody = element('tbody');
  // Ragged rows are padded to the header width and any extra cells are
  // dropped; model output is not guaranteed well formed.
  for (const line of lines.slice(2)) {
    const row = cells(line),
      tr = element('tr');
    for (let i = 0; i < header.length; i++) {
      const td = element('td');
      if (align[i]) td.style.textAlign = align[i];
      inline(td, row[i] ?? '');
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  scroll.append(table);
  body.append(scroll);
}
function renderAnswer(body, text) {
  body.replaceChildren();
  body.classList.add('formatted');
  let list = null;
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (pipe.test(line) && lines[i + 1] !== undefined && alignments(lines[i + 1])) {
        let end = i + 1;
        while (lines[end + 1] !== undefined && pipe.test(lines[end + 1])) end++;
        list = null;
        renderTable(body, lines.slice(i, end + 1));
        i = end;
        continue;
      }
      const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+)/.exec(line);
      if (bullet) {
        const ordered = /^\s*\d/.test(line),
          tag = ordered ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = element(tag);
          body.append(list);
        }
        const li = element('li');
        inline(li, bullet[1]);
        list.append(li);
      } else {
        list = null;
        const heading = /^#{1,3}\s+(.+)/.exec(line);
        const node = element(heading ? 'h3' : 'p');
        inline(node, heading ? heading[1] : line);
        body.append(node);
      }
    }
    list = null;
  }
}
$('stop').addEventListener('click', () => active?.abort());
window.addEventListener('model-settings-saved', (event) => {
  wantedBackend = event.detail;
  restoreBackend(wantedBackend);
  void refreshStatus();
});
$('backend').addEventListener('change', () => {
  wantedBackend = $('backend').value;
  updateAvailability();
});
$('question').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('chat').requestSubmit();
  }
});
for (const button of document.querySelectorAll('.suggestions button'))
  button.addEventListener('click', () => {
    $('question').value = button.dataset.question;
    resizeComposer();
    updateAvailability();
    $('question').focus();
  });
// Category editor. Every value from the API is rendered with
// textContent, so a description is never interpreted as markup.
const editor = {
  taxonomy: null,
  rows: new Map(),
  next: null,
  filters: null,
  selected: null,
  selectionVersion: 0,
  busy: false,
};
const categoryName = (id) =>
  editor.taxonomy?.find((category) => category.id === id)?.label ?? 'Uncategorised';
const subcategoryName = (id) => {
  if (!id) return 'Not set';
  const words = id.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
// The currency code is shown only when the ledger mixes currencies.
const multiCurrency = () =>
  new Set((workspaceStatus?.coverage.accounts ?? []).map((a) => a.currency)).size > 1;
const formatAmount = (cents, currency, sign = 'auto') =>
  formatMoney(cents, currency, { sign, code: multiCurrency() });
const shortDate = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
// Category colours follow the taxonomy order so a category keeps its colour
// everywhere; anything past the six validated slots shares the neutral.
const categoryColor = (id) => {
  const index = editor.taxonomy?.findIndex((c) => c.id === id) ?? -1;
  return index >= 0 && index < 6 ? `var(--viz-${index + 1})` : 'var(--viz-other)';
};
function editorState(id, text, isError = false) {
  $(id).textContent = text;
  $(id).classList.toggle('is-error', isError);
}
async function loadTaxonomy() {
  if (editor.taxonomy) return editor.taxonomy;
  editor.taxonomy = (await jsonRequest('/api/categories')).categories;
  for (const category of editor.taxonomy) {
    const option = element('option', category.label);
    option.value = category.id;
    $('editor-filter').append(option);
    $('editor-category').append(option.cloneNode(true));
  }
  return editor.taxonomy;
}
function populateSubcategories(categoryId, selected = '') {
  const select = $('editor-subcategory');
  const placeholder = element('option', 'Choose a subcategory');
  placeholder.value = '';
  select.replaceChildren(placeholder);
  const category = editor.taxonomy?.find((item) => item.id === categoryId);
  for (const leaf of category?.subcategories ?? []) {
    const option = element('option', subcategoryName(leaf.id));
    option.value = leaf.id;
    option.title = leaf.gloss;
    select.append(option);
  }
  select.disabled = !category;
  select.value = selected;
}
$('editor-category').addEventListener('change', () => {
  populateSubcategories($('editor-category').value);
});
// The correction form is a drawer beside the table (a sheet on phones);
// the selected row stays highlighted so the two read as one thing.
function closeTransaction() {
  editor.selectionVersion++;
  editor.selected = null;
  $('editor-panel').hidden = true;
  document.body.classList.remove('drawer-open');
  for (const row of $('editor-rows').children) {
    row.setAttribute('aria-selected', 'false');
    row.querySelector('button').setAttribute('aria-expanded', 'false');
  }
}
function openTransactionRow(id) {
  $('editor-panel').hidden = false;
  document.body.classList.add('drawer-open');
  for (const item of $('editor-rows').querySelectorAll('tr[data-id]')) {
    const selected = Number(item.dataset.id) === id;
    item.setAttribute('aria-selected', String(selected));
    item.querySelector('button').setAttribute('aria-expanded', String(selected));
  }
}
function renderRow(row) {
  const tr = element('tr', undefined, 'editor-row-line');
  tr.dataset.id = String(row.id);
  tr.setAttribute('aria-selected', String(editor.selected?.transaction_id === row.id));
  const dateCell = element('td');
  const button = element('button', row.posted_at.slice(0, 10), 'editor-row');
  button.type = 'button';
  button.setAttribute('aria-expanded', String(editor.selected?.transaction_id === row.id));
  button.setAttribute('aria-controls', 'editor-panel');
  button.setAttribute('aria-label', `Select ${row.description} on ${row.posted_at.slice(0, 10)}`);
  button.addEventListener('click', () => void selectTransaction(row.id));
  dateCell.append(button);
  button.textContent = shortDate(row.posted_at.slice(0, 10));
  button.classList.add('num');
  const description = element('td', undefined, 'editor-description');
  const descriptionCell = element('span', undefined, 'editor-cell');
  descriptionCell.append(element('span', row.description, 'editor-merchant'));
  if (row.is_internal_transfer)
    descriptionCell.append(element('span', 'Moved between accounts', 'badge gold'));
  if (row.status === 'pending') descriptionCell.append(element('span', 'Pending', 'badge'));
  description.append(descriptionCell);
  const amount = element('td', undefined, 'editor-amount num');
  const cents = row.amount.cents;
  amount.append(
    element(
      'span',
      formatAmount(cents, row.currency, 'always'),
      `editor-cell ${row.is_internal_transfer ? 'money-moved' : cents < 0 ? 'money-out' : 'money-in'}`,
    ),
  );
  const category = element('td', undefined, 'editor-label');
  const chipCell = element('span', undefined, 'editor-cell category-chip');
  const dot = element('i', undefined, 'dot');
  dot.style.background = row.subcategory ? categoryColor(row.category) : 'transparent';
  if (!row.subcategory) dot.classList.add('is-empty');
  chipCell.append(dot);
  const names = element('span', undefined, 'category-names');
  names.append(element('strong', categoryName(row.category)));
  if (row.subcategory) names.append(element('span', subcategoryName(row.subcategory)));
  chipCell.append(names);
  if (row.category_origin && row.category_origin !== 'llm')
    chipCell.append(element('span', 'Corrected', 'badge ok'));
  category.append(chipCell);
  const account = element('td', undefined, 'editor-account');
  account.append(element('span', row.account_name || 'Unknown account', 'editor-cell'));
  tr.append(dateCell, description, account, amount, category);
  tr.addEventListener('click', (event) => {
    if (event.target !== button && !event.target.closest('a')) button.click();
  });
  return tr;
}
function refreshRow(label) {
  const existing = editor.rows.get(label.transaction_id);
  if (!existing) return;
  editor.rows.set(label.transaction_id, {
    ...existing,
    category: label.category,
    subcategory: label.subcategory,
    category_origin: label.category_origin,
    is_internal_transfer: label.is_internal_transfer,
  });
  const tr = $('editor-rows').querySelector(`tr[data-id="${label.transaction_id}"]`);
  if (tr) tr.replaceWith(renderRow(editor.rows.get(label.transaction_id)));
}
async function searchTransactions(more = false) {
  if (editor.busy) return;
  if (
    !more &&
    $('editor-from').value &&
    $('editor-to').value &&
    $('editor-from').value > $('editor-to').value
  ) {
    editorState('editor-results-state', 'From must be on or before To.', true);
    return;
  }
  const params = new URLSearchParams();
  if (!more) {
    closeTransaction();
    syncPresetChips();
    editor.filters = {
      query: $('editor-query').value.trim(),
      category: $('editor-filter').value,
      account_id: $('editor-account').value,
      from: $('editor-from').value,
      to: $('editor-to').value,
      sort: $('editor-sort').value,
    };
    editor.next = null;
    editor.rows.clear();
    $('editor-rows').replaceChildren();
    $('editor-results').hidden = true;
  }
  for (const [key, value] of Object.entries(editor.filters)) if (value) params.set(key, value);
  if (!more && currentView === 'transactions') {
    const route = new URLSearchParams(params);
    route.set('view', 'transactions');
    history.replaceState(null, '', `#${route}`);
  }
  params.set('limit', '25');
  if (more && editor.next) params.set('cursor', editor.next);
  editor.busy = true;
  $('editor-more').disabled = true;
  editorState('editor-results-state', 'Searching...');
  try {
    const page = await jsonRequest(`/api/transactions?${params}`);
    for (const row of page.rows) {
      editor.rows.set(row.id, row);
      $('editor-rows').append(renderRow(row));
    }
    editor.route = currentView === 'transactions' ? location.hash : null;
    editor.next = page.next_cursor;
    $('editor-results').hidden = editor.rows.size === 0;
    $('editor-more').hidden = !page.has_more;
    const remaining = page.total_matched_count - editor.rows.size;
    $('editor-more').textContent =
      remaining > 0 ? `Show more (${remaining.toLocaleString()} left)` : 'Show more';
    editorState(
      'editor-results-state',
      editor.rows.size === 0
        ? 'No transactions match these filters.'
        : `${page.total_matched_count.toLocaleString()} ${page.total_matched_count === 1 ? 'transaction' : 'transactions'}${editor.rows.size < page.total_matched_count ? `, showing ${editor.rows.size}` : ''}. Select one to review its category or transfer status.`,
    );
    $('editor-totals').replaceChildren(
      ...(page.matched_rows_totals ?? []).flatMap((t) => [
        element(
          'span',
          `${formatMoney(-t.debit_total.cents, t.currency, { code: true })} out`,
          'money-out',
        ),
        element(
          'span',
          `${formatMoney(t.credit_total.cents, t.currency, { code: true, sign: 'always' })} in`,
          'money-in',
        ),
      ]),
    );
  } catch (error) {
    editorState('editor-results-state', error.message, true);
  } finally {
    editor.busy = false;
    $('editor-more').disabled = false;
  }
}
function showLabel(label) {
  const changedTransaction = editor.selected?.transaction_id !== label.transaction_id;
  const record = editor.rows.get(label.transaction_id);
  $('editor-panel-title').textContent = record?.description ?? 'Transaction';
  $('editor-panel-meta').replaceChildren();
  if (record) {
    const amount = element(
      'span',
      formatAmount(record.amount.cents, record.currency, 'always'),
      `num ${record.amount.cents < 0 ? 'money-out' : 'money-in'}`,
    );
    $('editor-panel-meta').append(
      amount,
      element(
        'span',
        ` · ${calendarDate(record.posted_at.slice(0, 10))} · ${record.account_name ?? 'Unknown account'}`,
      ),
    );
  }
  const suggested = label.machine_subcategory
    ? ` The model suggested ${subcategoryName(label.machine_subcategory)}.`
    : '';
  $('transaction-provenance').textContent =
    label.category_origin === 'transaction_override'
      ? `You corrected this transaction.${suggested}`
      : label.category_origin === 'description_rule'
        ? `Set by your rule for this description.${suggested}`
        : label.category_origin === 'llm'
          ? `Labelled automatically by the model as ${subcategoryName(label.subcategory)}.`
          : `Not labelled yet.${suggested}`;
  $('editor-transfer-note').textContent =
    label.transfer_override === null
      ? label.is_internal_transfer
        ? 'Matched automatically with a transfer-like transaction in another account. Review this match if the amount also appears elsewhere by coincidence.'
        : 'This transaction is included in normal spending or income unless its category excludes it.'
      : label.transfer_override
        ? 'You marked this as money moved between your accounts.'
        : 'You marked this as an ordinary transaction; automatic matching will leave it alone.';
  $('editor-transfer-toggle').textContent = label.is_internal_transfer
    ? 'This is not a transfer'
    : 'Mark as transfer between my accounts';
  editor.selected = label;
  $('editor-panel').hidden = false;
  if (changedTransaction) {
    $('editor-apply').querySelector('input[value="transaction"]').checked = true;
    $('editor-options').open = false;
  }
  $('editor-category').value = label.subcategory ? label.category : '';
  populateSubcategories($('editor-category').value, label.subcategory ?? '');
  const count = label.rule_scope.match_count;
  $('editor-scope-description').textContent =
    `Same description (${count} ${count === 1 ? 'transaction' : 'transactions'} + future matches)`;
  $('editor-scope-description').title =
    `Exact description matches from the same source: ${label.rule_scope.description}`;
  $('editor-options').hidden = !label.override && !label.rule;
  $('editor-remove-override').hidden = !label.override;
  $('editor-remove-rule').hidden = !label.rule;
  if (label.rule)
    $('editor-remove-rule').textContent =
      `Remove matching-description rule (${subcategoryName(label.rule.subcategory)})`;
  openTransactionRow(label.transaction_id);
}
$('editor-transfer-toggle').addEventListener('click', async () => {
  if (!editor.selected || editor.busy) return;
  const id = editor.selected.transaction_id;
  const isTransfer = !editor.selected.is_internal_transfer;
  editor.selectionVersion++;
  editor.busy = true;
  $('editor-transfer-toggle').disabled = true;
  editorState('editor-panel-state', 'Saving transfer decision...');
  try {
    const result = await jsonRequest(`/api/transactions/${id}/transfer`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ is_internal_transfer: isTransfer }),
    });
    showLabel(result.label);
    refreshRow(result.label);
    await Promise.all(
      result.affected_ids
        .filter((affected) => affected !== id && editor.rows.has(affected))
        .map(async (affected) =>
          refreshRow(await jsonRequest(`/api/transactions/${affected}/category`)),
        ),
    );
    editorState(
      'editor-panel-state',
      isTransfer
        ? 'Marked as a transfer. It will be excluded from spending and income.'
        : 'No longer treated as a transfer. Its category still determines spending and income; any matched counterpart was corrected too.',
    );
    void refreshStatus();
  } catch (error) {
    editorState('editor-panel-state', error.message, true);
  } finally {
    editor.busy = false;
    $('editor-transfer-toggle').disabled = false;
  }
});
async function selectTransaction(id) {
  if (editor.busy) return;
  if (editor.selected?.transaction_id === id) {
    closeTransaction();
    return;
  }
  const version = ++editor.selectionVersion;
  editorState('editor-results-state', 'Loading transaction...');
  try {
    const label = await jsonRequest(`/api/transactions/${id}/category`);
    if (version !== editor.selectionVersion) return;
    editorState('editor-panel-state', '');
    editorState('editor-results-state', 'Select a transaction to correct it.');
    showLabel(label);
    $('editor-category').focus({ preventScroll: true });
  } catch (error) {
    if (version === editor.selectionVersion)
      editorState('editor-results-state', error.message, true);
  }
}
async function mutateLabel(run, done) {
  if (!editor.selected || editor.busy) return;
  editor.selectionVersion++;
  editor.busy = true;
  for (const button of $('editor-apply').querySelectorAll('button')) button.disabled = true;
  editorState('editor-panel-state', 'Saving...');
  try {
    const label = await run(editor.selected.transaction_id);
    showLabel(label);
    refreshRow(label);
    for (const row of editor.rows.values())
      if (row.id !== label.transaction_id && row.description === label.rule_scope.description)
        void jsonRequest(`/api/transactions/${row.id}/category`).then(refreshRow, () => {});
    editorState('editor-panel-state', done(label));
    void refreshStatus();
  } catch (error) {
    editorState('editor-panel-state', error.message, true);
  } finally {
    editor.busy = false;
    for (const button of $('editor-apply').querySelectorAll('button')) button.disabled = false;
  }
}
$('editor-apply').addEventListener('submit', (event) => {
  event.preventDefault();
  const scope = new FormData($('editor-apply')).get('scope');
  const subcategory = $('editor-subcategory').value;
  if (!subcategory) {
    editorState('editor-panel-state', 'Choose a subcategory first.', true);
    return;
  }
  void mutateLabel(
    (id) =>
      jsonRequest(`/api/transactions/${id}/category`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subcategory, scope }),
      }),
    (label) =>
      scope === 'transaction'
        ? `Saved: ${categoryName(label.category)} → ${subcategoryName(label.subcategory)}.`
        : `Saved: ${label.rule_scope.match_count} stored ${label.rule_scope.match_count === 1 ? 'transaction' : 'transactions'} with this description are now ${subcategoryName(label.subcategory)}; future matches will be too.`,
  );
});
for (const [id, scope] of [
  ['editor-remove-override', 'transaction'],
  ['editor-remove-rule', 'description'],
])
  $(id).addEventListener(
    'click',
    () =>
      void mutateLabel(
        async (transactionId) =>
          (
            await jsonRequest(`/api/transactions/${transactionId}/category?scope=${scope}`, {
              method: 'DELETE',
            })
          ).label,
        (label) =>
          label.subcategory
            ? `Correction removed. Now ${categoryName(label.category)} → ${subcategoryName(label.subcategory)}.`
            : 'Correction removed. This transaction is uncategorised.',
      ),
  );
$('editor-search').addEventListener('submit', (event) => {
  event.preventDefault();
  void searchTransactions();
});
$('editor-cancel').addEventListener('click', () => {
  const id = editor.selected?.transaction_id;
  closeTransaction();
  $('editor-rows').querySelector(`tr[data-id="${id}"] button`)?.focus({ preventScroll: true });
});
$('editor-more').addEventListener('click', () => void searchTransactions(true));
$('editor-close').addEventListener('click', () => $('editor-cancel').click());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('editor-panel').hidden && !$('importer').open)
    $('editor-cancel').click();
});
// Period chips fill the date fields; selects search as soon as they change.
function syncPresetChips() {
  const from = $('editor-from').value,
    to = $('editor-to').value;
  const todayText = new Date().toISOString().slice(0, 10);
  let match = from || to ? 'custom' : 'all';
  for (const key of ['this_month', 'last_month', 'last_30_days', 'ytd']) {
    const w = presetWindow(key, todayText);
    if (w && w.from === from && w.to === to) match = key;
  }
  for (const chip of document.querySelectorAll('#editor-search [data-preset]'))
    chip.setAttribute('aria-pressed', String(chip.dataset.preset === match));
  const custom = match === 'custom';
  $('editor-from-field').hidden = !custom;
  $('editor-to-field').hidden = !custom;
}
for (const chip of document.querySelectorAll('#editor-search [data-preset]'))
  chip.addEventListener('click', () => {
    const key = chip.dataset.preset;
    if (key === 'custom') {
      $('editor-from-field').hidden = false;
      $('editor-to-field').hidden = false;
      for (const c of document.querySelectorAll('#editor-search [data-preset]'))
        c.setAttribute('aria-pressed', String(c === chip));
      $('editor-from').focus();
      return;
    }
    const w = presetWindow(key, new Date().toISOString().slice(0, 10));
    $('editor-from').value = w?.from ?? '';
    $('editor-to').value = w?.to ?? '';
    void searchTransactions();
  });
for (const id of ['editor-account', 'editor-filter', 'editor-sort', 'editor-from', 'editor-to'])
  $(id).addEventListener('change', () => void searchTransactions());
$('categories').addEventListener('click', () => {
  location.hash = 'view=transactions';
});
$('editor-reset').addEventListener('click', () => {
  $('editor-search').reset();
  void searchTransactions();
});

// Workspace navigation shares the existing ledger and import contracts.
let currentView = 'chat';
let workspaceStatus = null;
const viewScroll = new Map();
let ledgerRoute = null;
function invalidateDeletedAccount(accountId) {
  editor.route = null;
  if (!ledgerRoute) return;
  const route = new URLSearchParams(ledgerRoute.slice(1));
  if (route.get('account_id') !== String(accountId)) return;
  route.delete('account_id');
  ledgerRoute = `#${route}`;
}
document.querySelectorAll('.workspace-nav [data-view]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    if (active) {
      notice('Stop the current response before changing workspaces.');
      return;
    }
    const target = link.dataset.view;
    if (target === 'chat') setHistoryOpen($('history-panel').hidden);
    else setHistoryOpen(false);
    if (target === currentView) return;
    if (currentView === 'transactions') ledgerRoute = location.hash;
    location.hash =
      target === 'transactions'
        ? ledgerRoute || 'view=transactions'
        : target === 'chat' && selectedId
          ? `chat=${selectedId}`
          : `view=${target}`;
  });
});
function showWorkspace(view) {
  const changing = view !== currentView;
  if (changing) viewScroll.set(currentView, window.scrollY);
  currentView = view;
  document.body.dataset.view = view;
  $('chat-view').hidden = view !== 'chat';
  if (view !== 'chat') setHistoryOpen(false);
  $('editor').hidden = view !== 'transactions';
  $('accounts-view').hidden = view !== 'accounts';
  $('mobile-sections').value = view;
  document.querySelectorAll('.workspace-nav [data-view]').forEach((a) => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (changing) window.scrollTo({ top: viewScroll.get(view) ?? 0 });
}
async function openLedger(fromRoute = false) {
  if (fromRoute && editor.route === location.hash && editor.rows.size) return;
  try {
    await loadTaxonomy();
    // Status may still be loading when a bookmarked ledger opens.
    const { accounts } = await jsonRequest('/api/accounts');
    const selected = $('editor-account').value;
    $('editor-account').replaceChildren(
      new Option('All accounts', ''),
      ...accounts.map((a) => new Option(a.name, String(a.id))),
    );
    $('editor-account').value = selected;
    if (fromRoute) {
      const route = new URLSearchParams(location.hash.slice(1));
      for (const [key, id] of Object.entries({
        query: 'editor-query',
        category: 'editor-filter',
        account_id: 'editor-account',
        from: 'editor-from',
        to: 'editor-to',
        sort: 'editor-sort',
      }))
        $(id).value = route.get(key) || (key === 'sort' ? 'newest' : '');
    }
    await searchTransactions();
  } catch (error) {
    editorState('editor-results-state', error.message, true);
  }
}
// Accounts view. Totals, the latest import attempt and one card per
// account; the file, its account and the row counts stay visible so a
// failed or partial import is never mistaken for a complete one.
const statCard = (label, value, hint, tone = '') => {
  const card = element('div', undefined, `stat${tone ? ` ${tone}` : ''}`);
  card.append(element('span', label, 'stat-label'));
  card.append(element('strong', value.toLocaleString(), 'stat-value'));
  if (hint) card.append(element('span', hint, 'stat-hint'));
  return card;
};
const ACCOUNT_GLYPHS = {
  transaction: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18M7 15.5h3"/>',
  savings:
    '<path d="M5 11a7 6 0 0 1 14 0v3a3 3 0 0 1-3 3h-1l-1 2h-4l-1-2H8a3 3 0 0 1-3-3z"/><path d="M15 10h.01M9 5 8 3"/>',
  credit_card: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18M7 15h4"/>',
  credit: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18M7 15h4"/>',
  loan: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M10 20v-6h4v6"/>',
  other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
};
const accountGlyph = (type) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('account-glyph');
  svg.innerHTML = ACCOUNT_GLYPHS[type] ?? ACCOUNT_GLYPHS.other;
  return svg;
};
const chip = (text, tone) => element('span', text, `chip${tone ? ` chip-${tone}` : ''}`);
function renderImportCard(run, previousOk) {
  const body = $('account-import-body');
  body.replaceChildren();
  if (!run) {
    body.append(
      element(
        'p',
        'Nothing imported yet. Add a CSV, OFX or QFX statement to get started.',
        'import-empty',
      ),
    );
    return;
  }
  const tone = run.status === 'ok' ? 'ok' : run.status === 'running' ? 'pending' : 'error';
  const head = element('div', undefined, 'import-head');
  head.append(
    chip(run.status === 'ok' ? 'Completed' : run.status === 'running' ? 'Running' : 'Failed', tone),
  );
  const title = element('p', undefined, 'import-title');
  title.append(element('strong', run.file_name));
  if (run.account) title.append(element('span', ` into ${run.account.name}`));
  head.append(title);
  body.append(head);
  body.append(
    element(
      'p',
      run.status === 'running'
        ? `Started ${localTime(run.started_at)}`
        : `${localTime(run.finished_at || run.started_at)}${run.status === 'error' && run.has_error ? ' · Error recorded in the import log' : ''}`,
      'import-when',
    ),
  );
  if (run.status !== 'running') {
    const counts = element('div', undefined, 'import-counts');
    counts.append(chip(plural(run.rows_inserted, 'new row')));
    counts.append(chip(`${run.rows_updated} updated`));
    if (run.rows_unchanged !== null && run.rows_unchanged !== undefined)
      counts.append(chip(`${run.rows_unchanged} unchanged`));
    if (run.rows_duplicate) counts.append(chip(`${run.rows_duplicate} repeated in file`));
    counts.append(chip(`${run.rows_skipped} skipped`));
    body.append(counts);
  }
  if (previousOk)
    body.append(
      element(
        'p',
        `Last successful import: ${previousOk.file_name}${previousOk.account ? ` into ${previousOk.account.name}` : ''}, ${localTime(previousOk.finished_at || previousOk.started_at)}.`,
        'import-previous',
      ),
    );
}
const ACCOUNT_TYPES = {
  transaction: 'Everyday',
  savings: 'Savings',
  credit: 'Credit card',
  credit_card: 'Credit card',
  loan: 'Loan',
  other: 'Other',
};
function updateAccountCategorise(status) {
  const panel = $('account-categorise');
  const state = $('account-categorise-state');
  panel.hidden = !status.uncategorised && !categoriseBusy && !state.textContent;
  const button = $('account-categorise-now');
  button.hidden = !status.uncategorised;
  const selected = status.backends.find((item) => item.spec === $('backend').value);
  const available = selected?.configured && selected.reachable !== false;
  button.disabled = categoriseBusy || !available;
  $('account-categorise-hint').textContent = !status.uncategorised
    ? 'Everything is labelled.'
    : !available
      ? 'Choose an available local model in Settings to label these transactions.'
      : `${plural(status.uncategorised, 'transaction')} unlabelled. Categorise them with the selected local model.`;
}
function renderAccounts(status) {
  $('accounts-retry').hidden = true;
  $('account-status').hidden = true;
  const cov = status.coverage;
  $('account-summary').replaceChildren(
    statCard('Accounts', status.accounts),
    statCard(
      'Transactions',
      status.transactions,
      cov.from ? `${calendarDate(cov.from)} to ${calendarDate(cov.to)}` : undefined,
    ),
    statCard('Moved between accounts', status.transfers, 'Not counted as spending'),
    statCard(
      'Uncategorised',
      status.uncategorised,
      status.uncategorised ? 'Ready to categorise' : 'Everything is labelled',
      status.uncategorised ? 'warn' : '',
    ),
  );
  updateAccountCategorise(status);
  const last = status.lastImport,
    ok = status.lastSuccessfulImport;
  renderImportCard(last, ok && last && ok.id !== last.id ? ok : null);
  const signature = JSON.stringify(cov.accounts);
  if ($('account-list').dataset.signature === signature) return;
  $('account-list').dataset.signature = signature;
  if (!cov.accounts.length) {
    $('account-list').replaceChildren(
      element('p', 'Accounts appear here once a statement is imported.', 'import-empty'),
    );
    return;
  }
  $('account-list').replaceChildren(
    ...cov.accounts.map((a, index) => {
      const card = element('article', undefined, 'account-card card');
      const head = element('div', undefined, 'account-card-head');
      head.append(accountGlyph(a.type));
      const titles = element('div');
      titles.append(element('h4', a.name));
      const type = ACCOUNT_TYPES[a.type] || a.type;
      const meta = [type === a.name ? null : type, a.institution, a.currency]
        .filter(Boolean)
        .join(' · ');
      if (meta) titles.append(element('p', meta, 'account-meta'));
      head.append(titles);
      card.append(head);
      const balance = element('div', undefined, 'account-balance');
      if (a.balance) {
        balance.append(
          element(
            'strong',
            formatMoney(a.balance.current_cents, a.balance.currency),
            'account-balance-value',
          ),
          element(
            'span',
            `Statement balance, ${calendarDate(a.balance.as_of.slice(0, 10))}`,
            'account-balance-note',
          ),
        );
      } else {
        balance.append(
          element('strong', 'Unknown', 'account-balance-value is-unknown'),
          element('span', 'No statement balance in the imported file', 'account-balance-note'),
        );
      }
      card.append(balance);
      const facts = element('dl', undefined, 'account-facts');
      const fact = (label, value) => {
        facts.append(element('dt', label));
        facts.append(element('dd', value));
      };
      fact('Transactions', a.transactions ? a.transactions.toLocaleString() : 'None yet');
      fact(
        'Covers',
        a.transactions ? `${calendarDate(a.from)} to ${calendarDate(a.to)}` : 'No dates observed',
      );
      fact(
        'Last import',
        a.last_import
          ? `${localTime(a.last_import.imported_at)} · ${a.last_import.file_name}`
          : 'None recorded',
      );
      card.append(facts);
      const button = element('button', 'View transactions', 'btn-quiet btn-sm');
      button.type = 'button';
      button.addEventListener('click', () => {
        location.hash = `view=transactions&account_id=${a.id}`;
      });
      const remove = element('button', undefined, 'icon-btn btn-danger account-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${a.name}`);
      remove.title = 'Remove account';
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      remove.addEventListener('click', async () => {
        const consequence = a.transactions
          ? `${plural(a.transactions, 'transaction')} and its statement balances will be deleted from this device.`
          : 'Nothing has been imported into it yet.';
        if (!confirm(`Remove “${a.name}”? ${consequence} This cannot be undone.`)) return;
        remove.disabled = button.disabled = true;
        try {
          const response = await fetch(`/api/accounts/${a.id}`, { method: 'DELETE' });
          if (!response.ok && response.status !== 404) throw new Error();
          invalidateDeletedAccount(a.id);
          delete $('account-list').dataset.signature;
          await refreshStatus();
        } catch {
          remove.disabled = button.disabled = false;
          $('account-status').textContent =
            `“${a.name}” could not be removed. Check that the local server is running, then try again.`;
          $('account-status').hidden = false;
        }
      });
      card.append(remove, button);
      card.style.setProperty('--i', String(index));
      card.classList.add('reveal');
      return card;
    }),
  );
}
function processingText() {
  const backend = workspaceStatus?.backends.find((b) => b.spec === $('backend').value);
  if (!backend) return 'No model selected. You can still import and browse transactions.';
  const p = backend.processing;
  if (!p)
    return 'Processing location unavailable. Check your model configuration before sending financial data.';
  return `Local model · Runs on this device at ${p.destination}.`;
}
function updateProcessing() {
  $('processing-note').textContent = processingText();
}
$('accounts-import').addEventListener('click', openImporter);
$('accounts-retry').addEventListener('click', () => void refreshStatus());
$('account-categorise-now').addEventListener('click', () => void categoriseAccounts());
$('importer-review').addEventListener('click', () => {
  $('importer').close();
  location.hash = importer.lastAccountId
    ? `view=transactions&account_id=${importer.lastAccountId}`
    : 'view=transactions';
});

// File import. One state object, five steps; every preview comes
// from the server so the table shows exactly what Import would write.
const importer = {
  file: null,
  format: null,
  account: null,
  overrides: {},
  preview: null,
  busy: false,
  previewVersion: 0,
};
const ROLE_LABELS = {
  date: 'Date',
  amount: 'Amount',
  debit: 'Debit (money out)',
  credit: 'Credit (money in)',
  description: 'Description',
  memo: 'Memo or reference',
  balance: 'Balance',
  status: 'Status',
};
function importerState(text, isError = false) {
  editorState('importer-state', text, isError);
}
function showStep(step) {
  for (const id of ['file', 'account', 'preview', 'result']) $(`step-${id}`).hidden = id !== step;
  const order = ['file', 'account', 'preview', 'result'];
  for (const item of $('importer-steps').children) {
    const index = order.indexOf(item.dataset.step);
    item.classList.toggle('is-done', index < order.indexOf(step));
    if (item.dataset.step === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  importerState('');
}
function describeFile() {
  const text = `${importer.file.name} · ${importer.format.toUpperCase()} · ${(importer.file.size / 1024).toFixed(1)} KB`;
  for (const id of ['importer-file', 'importer-preview-file']) $(id).textContent = text;
}
async function sniffFormat(file) {
  if (/\.(ofx|qfx)$/i.test(file.name)) return 'ofx';
  if (/\.csv$/i.test(file.name)) return 'csv';
  const head = await file.slice(0, 4096).text();
  return /<OFX>/i.test(head) ? 'ofx' : 'csv';
}
function resetImporter() {
  importer.file = null;
  importer.format = null;
  importer.account = null;
  importer.overrides = {};
  $('mapping-advanced').open = false;
  importer.preview = null;
  importer.busy = false;
  $('importer-input').value = '';
  showStep('file');
}
async function loadAccountsInto(select) {
  const { accounts } = await jsonRequest('/api/accounts');
  select.replaceChildren();
  for (const account of accounts) {
    const option = element(
      'option',
      `${account.name} (${(account.type || 'account').replaceAll('_', ' ')}, ${account.currency})`,
    );
    option.value = String(account.id);
    select.append(option);
  }
  const create = element('option', accounts.length ? 'Create a new account…' : 'Create an account');
  create.value = 'new';
  select.append(create);
  select.value = accounts.length ? String(accounts[0].id) : 'new';
  $('importer-new-account').hidden = select.value !== 'new';
}
async function chooseFile(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    importerState(
      'The file is larger than 20 MB. Export a shorter date range and try again.',
      true,
    );
    return;
  }
  if (file.size === 0) {
    importerState('The file is empty.', true);
    return;
  }
  importer.file = file;
  importer.format = await sniffFormat(file);
  importer.overrides = {};
  $('mapping-advanced').open = false;
  importer.account = null;
  describeFile();
  if (importer.format === 'ofx') {
    // OFX names its own account; go straight to the preview.
    showStep('preview');
    await runPreview();
    return;
  }
  showStep('account');
  try {
    await loadAccountsInto($('importer-account'));
  } catch (error) {
    importerState(error.message, true);
  }
}
function importOptions() {
  const options = {};
  if (importer.account) options.account = importer.account;
  if (Object.keys(importer.overrides).length) options.mapping = importer.overrides;
  return options;
}
function importForm() {
  const form = new FormData();
  form.set('file', importer.file, importer.file.name);
  form.set('options', JSON.stringify(importOptions()));
  return form;
}
async function runPreview() {
  const version = ++importer.previewVersion;
  importerState('Reading the file…');
  importer.busy = true;
  $('importer-run').disabled = true;
  try {
    const preview = await jsonRequest('/api/import/preview', {
      method: 'POST',
      body: importForm(),
    });
    if (version !== importer.previewVersion) return;
    importer.preview = preview;
    renderMapping(preview);
    renderPreview(preview);
    importerState('');
  } catch (error) {
    if (version !== importer.previewVersion) return;
    importer.preview = null;
    importerState(error.message, true);
  } finally {
    if (version === importer.previewVersion) {
      importer.busy = false;
      $('importer-run').disabled = !importer.preview || importer.preview.row_count === 0;
    }
  }
}
function confidenceCell(value, unused) {
  if (unused) return element('span', 'not in file', 'confidence');
  const node = element('span', undefined, `confidence${value < 0.6 ? ' is-low' : ''}`);
  const bar = element('i');
  bar.style.setProperty('--value', `${Math.round(value * 100)}%`);
  node.append(bar, value >= 0.85 ? 'High' : value >= 0.6 ? 'Medium' : 'Low');
  node.title = `${Math.round(value * 100)}% confident`;
  return node;
}
function columnSelect(columns, selected, role, allowNone) {
  const select = element('select');
  select.setAttribute('aria-label', `${ROLE_LABELS[role]} column`);
  if (allowNone) {
    const none = element('option', 'None');
    none.value = '';
    select.append(none);
  }
  columns.forEach((name, index) => {
    const option = element('option', name);
    option.value = String(index);
    select.append(option);
  });
  select.value = selected === undefined ? '' : String(selected);
  select.addEventListener('change', () => {
    const value = select.value === '' ? null : Number(select.value);
    if (role === 'debit' || role === 'credit') {
      const other = role === 'debit' ? 'credit' : 'debit';
      const current = currentColumns();
      importer.overrides[role] = value;
      importer.overrides[other] = importer.overrides[other] ?? current[other];
      delete importer.overrides.amount;
    } else {
      importer.overrides[role] = value;
      if (role === 'amount') {
        delete importer.overrides.debit;
        delete importer.overrides.credit;
      }
    }
    void runPreview();
  });
  return select;
}
/** Column per role as the last preview reported them. */
function currentColumns() {
  const columns = {};
  for (const role of importer.preview?.mapping?.roles ?? []) {
    if (role.role === 'amount') {
      if (importer.preview.mapping.amount_kind === 'split') {
        columns.debit = role.columns[0];
        columns.credit = role.columns[1];
      } else columns.amount = role.columns[0];
    } else if (role.columns.length) columns[role.role] = role.columns[0];
  }
  return columns;
}
function renderMapping(preview) {
  const m = preview.mapping;
  $('mapping-advanced').hidden = !m;
  if (!m) return;
  const rows = [];
  const columns = currentColumns();
  const byRole = Object.fromEntries(m.roles.map((r) => [r.role, r]));
  const add = (role, selected, confidence, allowNone) => {
    const tr = element('tr');
    tr.append(element('td', ROLE_LABELS[role]));
    const cell = element('td');
    cell.append(columnSelect(m.columns, selected, role, allowNone));
    tr.append(cell);
    const conf = element('td');
    conf.append(confidenceCell(confidence, allowNone && selected === undefined));
    tr.append(conf);
    rows.push(tr);
  };
  add('date', columns.date, byRole.date.confidence, false);
  if (m.amount_kind === 'split') {
    add('debit', columns.debit, byRole.amount.confidence, false);
    add('credit', columns.credit, byRole.amount.confidence, false);
  } else add('amount', columns.amount, byRole.amount.confidence, false);
  add('description', columns.description, byRole.description.confidence, false);
  add('memo', columns.memo, byRole.memo ? byRole.memo.confidence : 0, true);
  add('balance', columns.balance, byRole.balance.confidence, true);
  add('status', columns.status, byRole.status ? byRole.status.confidence : 0, true);
  $('mapping-rows').replaceChildren(...rows);
  for (const input of $('mapping-amount-kind').querySelectorAll('input'))
    input.checked = input.value === m.amount_kind;
  for (const input of $('mapping-sign').querySelectorAll('input'))
    input.checked = input.value === m.sign;
  $('mapping-sign').hidden = m.amount_kind === 'split';
  $('mapping-date-format').value = m.date_format;
  const signConfidence = byRole.sign.confidence;
  const hints = [];
  if (m.ambiguous_date)
    hints.push(
      'Every date fits both DD/MM and MM/DD, so the format is a guess. Pick the right one.',
    );
  if (m.amount_kind === 'signed' && signConfidence < 0.6)
    hints.push(
      'The sign convention is a guess: check that purchases show as money out in the preview.',
    );
  if (
    hints.length ||
    preview.error_count ||
    m.roles.some((r) => ['date', 'amount', 'description'].includes(r.role) && r.confidence < 0.6)
  )
    $('mapping-advanced').open = true;
  $('mapping-hint').textContent = hints.join(' ');
  $('mapping-hint').classList.toggle('is-warn', hints.length > 0);
}
function renderPreview(preview) {
  const parts = [
    `${preview.row_count} ${preview.row_count === 1 ? 'row' : 'rows'}`,
    `${preview.existing_count} already stored (updated or unchanged once imported)`,
    `${preview.error_count} ${preview.error_count === 1 ? 'error' : 'errors'}`,
  ];
  $('preview-summary').textContent = parts.join(', ');
  const account = preview.accounts[0];
  const target = preview.accounts
    .map((a) => `${a.name}${a.id === null ? ' (new)' : ''}`)
    .join(', ');
  const balance = preview.balances[0];
  $('preview-balance').textContent = [
    `Into ${target}.`,
    balance
      ? `Balance in file: ${formatAmount(balance.current_cents, account?.currency ?? '')}${balance.as_of ? ` as of ${localTime(balance.as_of)}` : ''}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  $('preview-errors').hidden = preview.error_count === 0;
  $('preview-errors-summary').textContent =
    `${preview.error_count} ${preview.error_count === 1 ? 'row' : 'rows'} could not be read and will be skipped`;
  $('preview-error-list').replaceChildren(
    ...preview.errors.slice(0, 50).map((e) => element('li', `Line ${e.line}: ${e.message}`)),
  );
  $('preview-rows').replaceChildren(
    ...preview.rows.map((row) => {
      const tr = element('tr', undefined, row.exists ? 'is-existing' : '');
      tr.append(element('td', row.line ? String(row.line) : ''));
      tr.append(element('td', row.date, 'date'));
      tr.append(element('td', row.description));
      tr.append(element('td', formatAmount(row.amount_cents, row.currency), 'num'));
      tr.append(
        element(
          'td',
          [row.status === 'pending' ? 'pending' : '', row.exists ? 'already stored' : '']
            .filter(Boolean)
            .join(', '),
          'flag',
        ),
      );
      return tr;
    }),
  );
}
function accountTarget() {
  const select = $('importer-account');
  if (select.value !== 'new') return { id: Number(select.value) };
  const name = $('importer-account-name').value.trim();
  const currency = $('importer-account-currency').value.trim().toUpperCase();
  if (!name) throw new Error('Give the new account a name.');
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error('Currency must be a three-letter code such as AUD.');
  return { create: { name, type: $('importer-account-type').value, currency } };
}
async function runImportNow() {
  if (importer.busy || !importer.preview) return;
  importer.busy = true;
  $('importer-run').disabled = true;
  importerState('Importing…');
  try {
    const { run, result } = await jsonRequest('/api/import', {
      method: 'POST',
      body: importForm(),
    });
    showStep('result');
    const tiles = element('div', undefined, 'import-tiles');
    for (const [label, value] of [
      ['New', run.rows_inserted],
      ['Updated', run.rows_updated],
      ['Unchanged', run.rows_unchanged ?? 0],
      ['Skipped', run.rows_skipped],
    ]) {
      const tile = element('div', undefined, 'import-tile');
      tile.append(element('strong', value.toLocaleString()), element('span', label));
      tiles.append(tile);
    }
    $('import-result').replaceChildren(
      element('strong', `Imported ${run.file_name}`),
      tiles,
      element(
        'span',
        (run.rows_duplicate ? `${plural(run.rows_duplicate, 'row')} repeated in the file. ` : '') +
          (result.balancesSeen
            ? 'Statement balance recorded.'
            : 'No statement balance in this file.'),
        'importer-hint',
      ),
    );
    $('categorise-progress').hidden = true;
    $('categorise-state').textContent = '';
    $('account-categorise-state').textContent = '';
    $('categorise-now').disabled = !$('backend').value;
    importer.lastAccountId = run.account_id;
    editor.route = null;
    $('categorise-hint').textContent = $('backend').value
      ? `New descriptions are unlabelled until the model categorises them. Runs with ${$('backend').selectedOptions[0]?.textContent ?? 'the selected model'}. ${processingText()}`
      : 'You can review transactions now and categorise them once a model is configured.';
    void refreshStatus();
  } catch (error) {
    importerState(error.message, true);
    $('importer-run').disabled = false;
  } finally {
    importer.busy = false;
  }
}
async function streamCategorisation(onEvent) {
  const response = await fetch('/api/categorise', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend: $('backend').value }),
  });
  if (!response.ok)
    throw new Error((await response.json()).error || `Request failed (${response.status}).`);
  await readEvents(response, (event) => {
    if (event.type === 'error') throw new Error(event.error);
    onEvent(event);
  });
}
async function categoriseAccounts() {
  if (categoriseBusy) return;
  categoriseBusy = true;
  const state = $('account-categorise-state');
  state.textContent = 'Starting…';
  if (workspaceStatus) updateAccountCategorise(workspaceStatus);
  try {
    await streamCategorisation((event) => {
      if (event.type === 'progress')
        state.textContent = `${event.categorised} of ${event.total} descriptions labelled (${event.batch}/${event.batches} batches).`;
      else if (event.type === 'done')
        state.textContent =
          event.new_descriptions === 0
            ? 'Nothing new to label.'
            : `Labelled ${event.categorised} of ${event.new_descriptions} descriptions${event.failures ? `; ${event.failures} batches failed. Run again to resume.` : '.'}`;
    });
  } catch (error) {
    state.textContent = error.message;
  } finally {
    categoriseBusy = false;
    void refreshStatus();
  }
}
async function categoriseNow() {
  if (categoriseBusy) return;
  categoriseBusy = true;
  const button = $('categorise-now');
  button.disabled = true;
  $('importer-done').disabled = true;
  $('importer-review').disabled = true;
  $('importer-another').disabled = true;
  const bar = $('categorise-progress');
  bar.hidden = false;
  bar.firstElementChild.style.setProperty('--value', '0%');
  $('categorise-state').textContent = 'Starting…';
  try {
    await streamCategorisation((event) => {
      if (event.type === 'progress') {
        const pct = event.batches ? Math.round((event.batch / event.batches) * 100) : 100;
        bar.firstElementChild.style.setProperty('--value', `${pct}%`);
        $('categorise-state').textContent =
          `${event.categorised} of ${event.total} descriptions labelled (${event.batch}/${event.batches} batches${event.failures ? `, ${event.failures} failed` : ''})`;
      } else if (event.type === 'done') {
        bar.firstElementChild.style.setProperty('--value', '100%');
        $('categorise-state').textContent =
          event.new_descriptions === 0
            ? 'Nothing new to label.'
            : `Labelled ${event.categorised} of ${event.new_descriptions} descriptions${event.failures ? `; ${event.failures} batches failed, run again to resume` : ''}. ${event.transfers.pairsCreated} transfer pairs matched.`;
      }
    });
  } catch (error) {
    $('categorise-state').textContent = error.message;
    button.disabled = false;
  } finally {
    categoriseBusy = false;
    $('importer-done').disabled = false;
    $('importer-review').disabled = false;
    editor.route = null;
    $('importer-another').disabled = false;
    void refreshStatus();
  }
}
function openImporter() {
  resetImporter();
  $('importer').showModal();
}
$('import').addEventListener('click', openImporter);
$('welcome-import').addEventListener('click', openImporter);
// The sample dataset: one dialog that explains what it is, then
// streams the import and the categorise run the way the importer does.
const sample = { busy: false };
function openSample() {
  if (sample.busy) return $('sample-dialog').showModal();
  $('sample-progress').hidden = true;
  $('sample-steps').hidden = true;
  $('sample-steps').replaceChildren();
  $('sample-state').textContent = $('backend').value
    ? `Labelling runs with ${$('backend').selectedOptions[0]?.textContent ?? 'the selected model'}. ${processingText()}`
    : 'No model is selected, so the rows are loaded unlabelled. You can categorise them later.';
  $('sample-load').hidden = false;
  $('sample-load').disabled = false;
  $('sample-cancel').hidden = false;
  $('sample-done').hidden = true;
  $('sample-dialog').showModal();
}
async function loadSample() {
  if (sample.busy) return;
  sample.busy = true;
  const bar = $('sample-progress');
  const steps = $('sample-steps');
  const step = (text) => {
    const item = element('li', text);
    steps.append(item);
    return item;
  };
  $('sample-load').disabled = true;
  $('sample-cancel').hidden = true;
  bar.hidden = false;
  bar.firstElementChild.style.setProperty('--value', '0%');
  steps.hidden = false;
  $('sample-state').textContent = 'Importing the sample accounts…';
  let labelling = null;
  try {
    const response = await fetch('/api/sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify($('backend').value ? { backend: $('backend').value } : {}),
    });
    if (!response.ok)
      throw new Error((await response.json()).error || `Request failed (${response.status}).`);
    await readEvents(response, (event) => {
      if (event.type === 'import') {
        step(`${event.account}: ${plural(event.inserted, 'transaction')} imported.`);
        bar.firstElementChild.style.setProperty('--value', `${10 * steps.childElementCount}%`);
      } else if (event.type === 'progress') {
        const pct = event.batches ? Math.round(30 + (event.batch / event.batches) * 70) : 100;
        bar.firstElementChild.style.setProperty('--value', `${pct}%`);
        if (!labelling) labelling = step('');
        labelling.textContent = `${event.categorised} of ${event.total} descriptions labelled (${event.batch}/${event.batches} batches${event.failures ? `, ${event.failures} failed` : ''}).`;
        $('sample-state').textContent = 'Labelling descriptions with the model…';
      } else if (event.type === 'done') {
        bar.firstElementChild.style.setProperty('--value', '100%');
        $('sample-state').textContent = event.backend
          ? `Loaded ${plural(event.transactions, 'transaction')} across ${plural(event.accounts.length, 'account')} and labelled ${event.categorised} of ${event.new_descriptions} descriptions${event.failures ? ` (${event.failures} batches failed; run Categorise to resume)` : ''}. ${event.transfers.pairsCreated} transfer pairs matched.`
          : `Loaded ${plural(event.transactions, 'transaction')} across ${plural(event.accounts.length, 'account')}. Run Categorise from the importer once a model is available.`;
        $('sample-load').hidden = true;
        $('sample-done').hidden = false;
        $('sample-done').focus();
      } else if (event.type === 'error') throw new Error(event.error);
    });
  } catch (error) {
    $('sample-state').textContent = error.message;
    $('sample-load').disabled = false;
    $('sample-cancel').hidden = false;
  } finally {
    sample.busy = false;
    void refreshStatus();
  }
}
$('welcome-sample').addEventListener('click', openSample);
$('sample-load').addEventListener('click', () => void loadSample());
$('sample-cancel').addEventListener('click', () => $('sample-dialog').close());
$('sample-done').addEventListener('click', () => {
  $('sample-dialog').close();
  setHash(null);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  void selectChat(null);
  window.scrollTo({ top: 0 });
  $('question').focus({ preventScroll: true });
});
$('sample-dialog').addEventListener('cancel', (event) => {
  if (sample.busy) event.preventDefault();
});
window.addEventListener('sample-open', openSample);
$('importer-close').addEventListener('click', () => $('importer').close());
$('importer-done').addEventListener('click', () => $('importer').close());
$('importer-another').addEventListener('click', resetImporter);
$('importer-input').addEventListener('change', (event) => void chooseFile(event.target.files[0]));
const dropzone = $('dropzone');
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('is-over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('is-over');
  void chooseFile(event.dataTransfer.files[0]);
});
$('importer-account').addEventListener('change', () => {
  $('importer-new-account').hidden = $('importer-account').value !== 'new';
  if ($('importer-account').value === 'new') $('importer-account-name').focus();
});
$('importer-account-next').addEventListener('click', async () => {
  try {
    importer.account = accountTarget();
  } catch (error) {
    importerState(error.message, true);
    return;
  }
  showStep('preview');
  await runPreview();
  if (!importer.preview) {
    const message = $('importer-state').textContent;
    showStep('account');
    importerState(message, true);
  }
});
$('importer-account-back').addEventListener('click', resetImporter);
$('importer-preview-back').addEventListener('click', () =>
  showStep(importer.format === 'csv' ? 'account' : 'file'),
);
$('importer-run').addEventListener('click', () => void runImportNow());
$('categorise-now').addEventListener('click', () => void categoriseNow());
for (const input of $('mapping-sign').querySelectorAll('input'))
  input.addEventListener('change', () => {
    importer.overrides.sign = input.value;
    void runPreview();
  });
$('mapping-date-format').addEventListener('change', () => {
  importer.overrides.dateFormat = $('mapping-date-format').value;
  void runPreview();
});
for (const input of $('mapping-amount-kind').querySelectorAll('input'))
  input.addEventListener('change', () => {
    const columns = currentColumns();
    const numeric = importer.preview.mapping.columns.map((_, i) => i);
    if (input.value === 'split') {
      // Start the pair from the current amount column and the next one over.
      const debit = columns.amount ?? columns.debit ?? 0;
      const credit =
        numeric.find((i) => i !== debit && i !== columns.date && i !== columns.description) ??
        debit;
      importer.overrides.debit = debit;
      importer.overrides.credit = credit;
      delete importer.overrides.amount;
    } else {
      importer.overrides.amount = columns.debit ?? columns.amount ?? 0;
      delete importer.overrides.debit;
      delete importer.overrides.credit;
    }
    void runPreview();
  });
void refreshStatus();
void loadList();
navigateHash();
setInterval(() => {
  if (!document.hidden) void refreshStatus();
}, 15000);
window.addEventListener('focus', () => void refreshStatus());
$('mobile-sections').addEventListener('change', (event) => {
  location.hash = 'view=' + event.target.value;
});
