import { button, content, el, field, formShell, register, say } from './pages.js';
// The one setting that matters: which local model answers. The server lists
// what the endpoint serves, so a model can only be saved once it is known to
// exist there; the API key never comes back to the page.
async function settings() {
  const request = async (method = 'GET', data, path = '') => {
    const response = await fetch('/api/settings' + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Could not load settings.');
    return result;
  };
  let saved = await request();
  content.append(
    el(
      'p',
      'Point ledgerchat at a model server running on this machine. Chat and categorisation use the saved model straight away.',
      { className: 'page-lede' },
    ),
  );
  const layout = el('div', undefined, { className: 'settings-layout' });
  content.append(layout);
  const form = formShell(layout);
  form.className = 'model-settings card card-pad';
  const aside = el('aside', undefined, { className: 'settings-aside' });
  for (const [title, text] of [
    [
      'Local model endpoint',
      'The app listens on this machine and sends transaction data only to a model endpoint at localhost, 127.0.0.1 or [::1]. Use a model server you trust, since it controls any onward processing.',
    ],
    [
      'Which servers work',
      'Any OpenAI-compatible chat completions endpoint with tool calling: Ollama on port 11434, oMLX on 8000, LM Studio, llama.cpp or vLLM. Pick a model that supports tools, such as the Qwen 3 family.',
    ],
    [
      'Where the key lives',
      'Most local servers need no key. If yours does, it is written to a private settings file next to your database and never sent back to the browser.',
    ],
  ]) {
    const block = el('div', undefined, { className: 'settings-note' });
    block.append(el('h3', title), el('p', text));
    aside.append(block);
  }
  layout.append(aside);
  const endpoint = field(form, 'Server URL', saved.baseUrl, 'url');
  endpoint.placeholder = 'http://localhost:11434';
  endpoint.required = true;
  const key = field(form, 'API key', '', 'password');
  key.autocomplete = 'new-password';
  key.maxLength = 4096;
  const keyHint = el('p', '', { className: 'settings-hint' });
  form.append(keyHint);
  const model = field(form, 'Model', '', 'text', []);
  model.required = true;
  const modelHint = el('p', '', { className: 'settings-hint', role: 'status' });
  form.append(modelHint);
  const refresh = button('Refresh models', refreshModels);
  form.append(refresh);
  const thinking = field(form, 'Let the model think before answering', saved.thinking, 'checkbox');
  form.append(
    el(
      'p',
      'Off sends enable_thinking=false, so hybrid reasoning models such as Qwen 3 answer directly instead of spending the whole output budget on reasoning. Turn it on only with a larger LLM_MAX_TOKENS.',
      { className: 'settings-hint' },
    ),
  );
  let modelVersion = 0;
  const connection = () => ({
    baseUrl: endpoint.value.trim(),
    ...(key.value.trim() ? { apiKey: key.value.trim() } : {}),
  });
  function populateModels(models, selected) {
    model.replaceChildren(
      new Option('Choose a model', ''),
      ...models.map((m) => new Option(m.label, m.id)),
    );
    model.value = models.some((m) => m.id === selected) ? selected : '';
    model.disabled = !models.length;
  }
  async function refreshModels() {
    const version = ++modelVersion;
    const selected = model.value || saved.model;
    populateModels([], '');
    modelHint.textContent = 'Loading models from your server…';
    try {
      const result = await request('POST', connection(), '/models');
      if (version !== modelVersion) return;
      populateModels(result.models, selected);
      modelHint.textContent = result.models.length
        ? 'Models available on your server.'
        : 'No models found. Load a model on your server, then refresh.';
    } catch (error) {
      if (version === modelVersion) modelHint.textContent = error.message;
    }
  }
  function showSaved() {
    key.value = '';
    key.placeholder = saved.hasApiKey ? 'Key configured, leave blank to keep it' : 'Optional';
    keyHint.textContent = saved.hasApiKey
      ? 'A key is saved. Enter a new one to replace it.'
      : 'Only for servers that require authentication.';
    thinking.checked = saved.thinking;
    void refreshModels();
  }
  for (const input of [endpoint, key])
    input.addEventListener('input', () => {
      ++modelVersion;
      populateModels([], '');
      modelHint.textContent = 'Refresh models to load choices for this server.';
    });
  form.addEventListener('input', () => say(''));
  showSaved();
  const actions = el('div', undefined, { className: 'row' });
  actions.append(
    button('Save', async () => {
      if (!model.value || model.disabled)
        throw new Error('Choose an available model before saving.');
      saved = await request('PUT', {
        model: model.value.trim(),
        ...connection(),
        thinking: thinking.checked,
      });
      showSaved();
      window.dispatchEvent(new CustomEvent('model-settings-saved', { detail: saved.spec }));
    }),
  );
  form.append(actions);
}
register('settings', 'Settings', settings);
