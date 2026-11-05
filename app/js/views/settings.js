// Settings: providers and models, Claude key and budget, speech-to-text, coach and notes defaults.
import { api, getHealth, getTemplates, invalidateHealth, invalidateSettings, DEMO } from '../api.js';
import { html, mount, loading, toast, toastError, setBusy, sentence, $, on } from '../ui.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const WHISPER_MODELS = ['large-v3-turbo', 'large-v3', 'distil-large-v3.5', 'distil-large-v3', 'medium', 'small', 'base', 'tiny'];
const CAREERS_DEFAULTS = { daily_application_limit: 10, rerank_top: 25, browser_channel: 'auto', fill_wait_minutes: 20 };

function textField(id, label, value, { hint = '', type = 'text', list = '', placeholder = '', min, max, step } = {}) {
  return html`<div class="field"><label for="${id}">${label}</label>
    <input id="${id}" class="input" type="${type}" value="${value ?? ''}" ${list ? html`list="${list}"` : ''} ${placeholder ? html`placeholder="${placeholder}"` : ''}
      ${min !== undefined ? html`min="${min}"` : ''} ${max !== undefined ? html`max="${max}"` : ''} ${step !== undefined ? html`step="${step}"` : ''} autocomplete="off" spellcheck="false">
    ${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
}
function selectField(id, label, value, options, { hint = '' } = {}) {
  return html`<div class="field"><label for="${id}">${label}</label>
    <select id="${id}" class="select">${options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, sentence(o)]; return html`<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`; })}</select>
    ${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
}
function checkField(id, label, checked, hint = '') {
  return html`<label class="check"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span><strong>${label}</strong>${hint ? html`<br><span class="subtle">${hint}</span>` : ''}</span></label>`;
}

export default async function settingsView(root, { signal }) {
  document.title = 'Settings · Interview App';
  mount(root, loading('Loading settings…'));
  let [s, templates, health] = await Promise.all([
    api('/api/settings', { signal }),
    getTemplates().catch(() => []),
    getHealth().catch(() => null),
  ]);

  function render() {
    const o = s.ollama || {};
    const c = s.claude || {};
    const t = s.stt || {};
    const co = s.coach || {};
    const n = s.notes || {};
    const j = { ...CAREERS_DEFAULTS, ...(s.careers || {}) };
    const order = s.provider_order || ['ollama', 'claude'];
    const first = order[0] || 'ollama';
    const second = order[1] || '';
    const fromEnv = c.api_key_source === 'environment';
    mount(root, html`
      <div class="page-head"><div><h1>Settings</h1><p class="lead">Choose which models the agents use and how the coach and notes behave. Everything is stored on this computer${health && health.data_dir ? html` in <code>${health.data_dir}</code>` : ''}.</p></div>
        <div class="actions"><button type="button" class="btn btn-secondary" data-action="test">Test connections</button></div></div>
      <div id="test-out"></div>
      <form id="settings-form" class="stack" novalidate>
        <section class="card stack">
          <h2>AI providers</h2>
          <p class="muted">Agents try the first choice, then the second. If neither answers, built-in rules keep the app working.</p>
          <div class="form-grid">
            ${selectField('provider-first', 'First choice', first, [['ollama', 'Ollama (local, private)'], ['claude', 'Claude (Anthropic API)']])}
            ${selectField('provider-second', 'Second choice', second, [['', 'None'], ['ollama', 'Ollama (local, private)'], ['claude', 'Claude (Anthropic API)']])}
          </div>
          ${checkField('adaptive', 'Adaptive routing', s.adaptive_routing !== false, 'If one provider keeps failing for a particular agent, try the other one first for that agent.')}
        </section>

        <section class="card stack">
          <h2>Ollama — local models</h2>
          <div class="form-grid">
            ${textField('o-url', 'Server URL', o.base_url, { placeholder: 'http://127.0.0.1:11434' })}
            ${textField('o-smart', 'Main model', o.smart_model, { hint: 'Used for analysis and scoring. e.g. qwen3:14b' })}
            ${textField('o-fast', 'Fast model', o.fast_model, { hint: 'Used for quick tasks like live hints. e.g. qwen3:8b' })}
            ${textField('o-embed', 'Embedding model', o.embed_model, { hint: 'For meaning-based search. e.g. nomic-embed-text' })}
            ${textField('o-ctx', 'Context window (tokens)', o.num_ctx, { type: 'number', min: 2048, step: 1024 })}
            ${textField('o-keep', 'Keep model loaded for', o.keep_alive, { hint: 'e.g. 30m, 1h, or -1 for always' })}
            ${textField('o-timeout', 'Timeout (seconds)', o.timeout_sec, { type: 'number', min: 10 })}
            ${selectField('o-think', 'Reasoning ("thinking")', o.think || 'off', [['off', 'Off — fastest, best for structured output'], ['on', 'On'], ['auto', "Model's default"]])}
            ${textField('o-par', 'Parallel requests', o.max_parallel, { type: 'number', min: 1, max: 8 })}
          </div>
        </section>

        <section class="card stack">
          <h2>Claude — optional</h2>
          <div class="field"><label for="c-key">API key</label>
            ${DEMO ? html`<p class="muted">The browser demo can't use API keys. Install the app to connect Claude or a local model.</p>`
              : fromEnv ? html`<p class="muted">Set through the <code>ANTHROPIC_API_KEY</code> environment variable. Change it there.</p>`
              : html`<div class="row"><input id="c-key" class="input" type="password" autocomplete="off" spellcheck="false" placeholder="${c.api_key_set ? '•••••••• (saved)' : 'sk-ant-…'}" style="flex:1;min-width:220px">
                <button type="button" class="btn btn-secondary" data-action="save-key">Save key</button>
                ${c.api_key_set ? html`<button type="button" class="btn btn-ghost" data-action="remove-key">Remove</button>` : ''}</div>
                <span class="hint">${c.api_key_set ? 'A key is saved on this computer. Enter a new one to replace it.' : 'Stored only on this computer (in the data folder). Never shown again after saving.'}</span>`}
          </div>
          <datalist id="claude-models">${CLAUDE_MODELS.map((m) => html`<option value="${m}"></option>`)}</datalist>
          <div class="form-grid">
            ${textField('c-smart', 'Main model', c.smart_model, { list: 'claude-models' })}
            ${textField('c-fast', 'Fast model', c.fast_model, { list: 'claude-models' })}
            ${selectField('c-smart-effort', 'Main effort', c.smart_effort || 'medium', EFFORTS)}
            ${selectField('c-fast-effort', 'Fast effort', c.fast_effort || 'low', EFFORTS)}
            ${textField('c-budget', 'Monthly budget (USD)', c.monthly_budget_usd, { type: 'number', min: 0, step: 1, hint: 'Claude switches off for the month once estimated spend reaches this.' })}
            ${textField('c-timeout', 'Timeout (seconds)', c.timeout_sec, { type: 'number', min: 10 })}
          </div>
          ${checkField('c-fallbacks', 'Refusal fallback', c.use_fallbacks !== false, "If Claude declines a request, Anthropic retries it on its recommended fallback model.")}
        </section>

        <section class="card stack">
          <h2>Speech-to-text</h2>
          <datalist id="whisper-models">${WHISPER_MODELS.map((m) => html`<option value="${m}"></option>`)}</datalist>
          <div class="form-grid">
            ${selectField('t-engine', 'Engine', t.engine || 'auto', [['auto', 'Auto — local Whisper if installed'], ['faster-whisper', 'Local Whisper (faster-whisper)'], ['browser', "Browser's speech recognition"], ['off', 'Off (type answers)']])}
            ${textField('t-model', 'Whisper model', t.whisper_model, { list: 'whisper-models', hint: 'large-v3-turbo suits a 16 GB GPU' })}
            ${selectField('t-device', 'Device', t.device || 'auto', [['auto', 'Auto'], ['cuda', 'GPU (CUDA)'], ['cpu', 'CPU']])}
            ${textField('t-compute', 'Compute type', t.compute_type, { hint: 'auto, float16, int8_float16, int8' })}
            ${textField('t-lang', 'Language', t.language ?? '', { placeholder: 'en', hint: 'Leave empty to auto-detect' })}
          </div>
          ${checkField('t-partials', 'Show words as you speak', t.partials !== false, 'Live partial transcripts. Turn off on slower computers.')}
        </section>

        <section class="card stack">
          <h2>Practice coach</h2>
          <div class="form-grid">
            ${selectField('co-persona', 'Default interviewer style', co.persona || 'neutral', ['friendly', 'neutral', 'challenging'])}
            ${textField('co-limit', 'Default time per answer (seconds)', co.answer_time_limit_sec, { type: 'number', min: 30, max: 600, step: 10 })}
            ${textField('co-follow', 'Follow-up questions per question', co.max_followups, { type: 'number', min: 0, max: 3 })}
          </div>
          ${checkField('co-hints', 'Live coaching hints', co.hints_enabled !== false, 'STAR checklist, pacing and filler-word nudges while you answer (practice only).')}
          ${checkField('co-llm-hints', 'Model-written hints', co.llm_hints !== false, 'Adds one content nudge from the fast model; otherwise hints use built-in rules only.')}
          ${checkField('co-speak', 'Read questions aloud', co.speak_questions !== false, "Uses your computer's built-in voice.")}
        </section>

        <section class="card stack">
          <h2>Meeting notes</h2>
          <div class="form-grid">
            ${selectField('n-template', 'Default template', n.default_template || 'general', (templates.length ? templates : [{ id: 'general', name: 'General meeting' }]).map((x) => [x.id, x.name]))}
            ${textField('n-retention', 'Delete meetings after (days)', n.retention_days ?? 0, { type: 'number', min: 0, hint: '0 keeps meetings until you delete them.' })}
          </div>
        </section>

        <section class="card stack">
          <h2>Jobs</h2>
          <p class="muted">How job searches are reviewed and how the browser assistant fills application forms. It never clicks Submit: you do.</p>
          <div class="form-grid">
            ${textField('j-limit', 'Daily application limit', j.daily_application_limit, { type: 'number', min: 1, max: 100, step: 1, hint: 'Approvals per day. Fewer, better-matched applications get more replies.' })}
            ${textField('j-rerank', 'Jobs reviewed by AI per search', j.rerank_top, { type: 'number', min: 0, max: 200, step: 5, hint: 'The best matches by score get a requirement-by-requirement review by the model.' })}
            ${selectField('j-browser', 'Browser for application forms', j.browser_channel, [['auto', 'Auto'], ['msedge', 'Microsoft Edge'], ['chrome', 'Google Chrome'], ['chromium', 'Chromium']],
    { hint: 'Browser used to fill application forms. Auto = Edge on Windows, Chrome on Mac.' })}
            ${textField('j-wait', 'Keep watching for your Submit (minutes)', j.fill_wait_minutes, { type: 'number', min: 1, max: 240, step: 1, hint: 'How long the filled form stays open for you to check and submit.' })}
          </div>
        </section>

        <div class="row" style="position:sticky;bottom:0;padding:12px 0;background:linear-gradient(transparent, var(--bg) 30%)">
          <button type="submit" class="btn btn-primary btn-lg">Save settings</button><span class="subtle" id="save-note"></span></div>
      </form>`);
  }

  function num(id, fallback) {
    const v = Number($(`#${id}`, root).value);
    return Number.isFinite(v) && $(`#${id}`, root).value !== '' ? v : fallback;
  }
  function val(id) { return $(`#${id}`, root).value.trim(); }
  function checked(id) { return $(`#${id}`, root).checked; }

  function collect() {
    const first = val('provider-first');
    const second = val('provider-second');
    const order = [first];
    if (second && second !== first) order.push(second);
    return {
      provider_order: order,
      adaptive_routing: checked('adaptive'),
      ollama: {
        base_url: val('o-url'), smart_model: val('o-smart'), fast_model: val('o-fast'), embed_model: val('o-embed'),
        num_ctx: num('o-ctx', s.ollama.num_ctx), keep_alive: val('o-keep'), timeout_sec: num('o-timeout', s.ollama.timeout_sec),
        think: val('o-think'), max_parallel: num('o-par', s.ollama.max_parallel),
      },
      claude: {
        smart_model: val('c-smart'), fast_model: val('c-fast'), smart_effort: val('c-smart-effort'), fast_effort: val('c-fast-effort'),
        monthly_budget_usd: num('c-budget', s.claude.monthly_budget_usd), timeout_sec: num('c-timeout', s.claude.timeout_sec), use_fallbacks: checked('c-fallbacks'),
      },
      stt: {
        engine: val('t-engine'), whisper_model: val('t-model'), device: val('t-device'), compute_type: val('t-compute') || 'auto',
        language: val('t-lang') || null, partials: checked('t-partials'),
      },
      coach: {
        persona: val('co-persona'), answer_time_limit_sec: num('co-limit', s.coach.answer_time_limit_sec), max_followups: num('co-follow', s.coach.max_followups),
        hints_enabled: checked('co-hints'), llm_hints: checked('co-llm-hints'), speak_questions: checked('co-speak'),
      },
      notes: { default_template: val('n-template'), retention_days: num('n-retention', (s.notes && s.notes.retention_days) || 0) },
      careers: careersValues(),
    };
  }

  function careersValues() {
    const j = { ...CAREERS_DEFAULTS, ...(s.careers || {}) };
    const whole = (id, fallback, lo) => Math.max(lo, Math.round(num(id, fallback)));
    return {
      daily_application_limit: whole('j-limit', j.daily_application_limit, 1),
      rerank_top: whole('j-rerank', j.rerank_top, 0),
      browser_channel: val('j-browser') || 'auto',
      fill_wait_minutes: whole('j-wait', j.fill_wait_minutes, 1),
    };
  }

  function afterChange() {
    invalidateSettings();
    invalidateHealth();
    window.dispatchEvent(new Event('app:health-changed'));
  }

  render();
  on(root, 'submit', '#settings-form', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    setBusy(btn, true, 'Saving…');
    try {
      s = await api('/api/settings', { method: 'PUT', body: collect() });
      afterChange();
      toast('Settings saved.', 'success', { timeout: 2500 });
      const scrollY = window.scrollY;
      render();
      window.scrollTo(0, scrollY);
    } catch (err) {
      toastError(err);
      setBusy(btn, false);
    }
  });
  on(root, 'click', '[data-action]', async (e, btn) => {
    const a = btn.dataset.action;
    if (a === 'save-key' || a === 'remove-key') {
      const key = a === 'save-key' ? ($('#c-key', root).value || '').trim() : '';
      if (a === 'save-key' && !key) { toast('Paste your API key first.', 'error'); return; }
      setBusy(btn, true, a === 'save-key' ? 'Saving…' : 'Removing…');
      try {
        s = await api('/api/settings', { method: 'PUT', body: { claude: { api_key: key } } });
        afterChange();
        toast(a === 'save-key' ? 'API key saved.' : 'API key removed.', 'success', { timeout: 2500 });
        render();
      } catch (err) { toastError(err); setBusy(btn, false); }
    } else if (a === 'test') {
      setBusy(btn, true, 'Testing…');
      const out = $('#test-out', root);
      try {
        invalidateHealth();
        const h = await getHealth({ force: true });
        window.dispatchEvent(new Event('app:health-changed'));
        mount(out, html`<section class="card stack-sm"><h2>Connection test</h2>
          ${(h.providers || []).map((p) => html`<div class="banner ${p.available ? 'banner-ok' : 'banner-warn'}"><span class="banner-icon" aria-hidden="true">${p.available ? '✓' : '!'}</span><div><strong>${p.name === 'ollama' ? 'Ollama' : 'Claude'}:</strong> ${p.detail}</div></div>`)}
          ${h.stt ? html`<div class="banner ${h.stt.available !== false ? 'banner-ok' : 'banner-warn'}"><span class="banner-icon" aria-hidden="true">${h.stt.available !== false ? '✓' : '!'}</span><div><strong>Speech-to-text:</strong> ${h.stt.detail || h.stt.engine}</div></div>` : ''}
        </section>`);
      } catch (err) { toastError(err); } finally { setBusy(btn, false); }
    }
  });
  return undefined;
}
