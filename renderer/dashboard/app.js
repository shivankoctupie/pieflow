// PieFlow dashboard renderer. Vanilla JS, talks to main via window.pie.*
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- navigation ----------
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.page').forEach((p) => p.classList.remove('active'));
    $(`#page-${btn.dataset.page}`).classList.add('active');
    loaders[btn.dataset.page] && loaders[btn.dataset.page]();
  });
});

// ---------- home ----------
async function loadHome() {
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('#welcome').textContent = `${greet}, welcome back`;

  const cfg = await pie.settings.get();
  if (cfg.hotkey) $('#hero-hotkey').textContent = cfg.hotkey.label;
  if (cfg.commandHotkey) $('#hero-cmdkey').textContent = cfg.commandHotkey.label;

  const stats = await pie.stats.get();
  $('#stat-words').textContent = stats.words.toLocaleString();
  $('#stat-wpm').textContent = stats.avgWpm || '0';
  $('#stat-streak').textContent = stats.streak;
  $('#stat-count').textContent = stats.dictations.toLocaleString();

  renderEngineChips();
  loadHistory();
}

async function renderEngineChips() {
  const box = $('#engine-status');
  const [stt, llmS] = await Promise.all([pie.stt.status(), pie.llm.status()]);
  const chips = [];
  if (stt.state === 'ready') chips.push(`<span class="chip ok"><span class="dot"></span>Whisper ${esc(stt.model || '')} ready</span>`);
  else if (stt.state === 'error') chips.push(`<span class="chip err"><span class="dot"></span>${esc(stt.detail || 'STT error')}</span>`);
  else if (stt.state === 'setup' || stt.state === 'loading-model') chips.push(`<span class="chip warn"><span class="dot"></span>${esc(stt.detail || 'Preparing speech engine...')}</span>`);
  else chips.push(`<span class="chip warn"><span class="dot"></span>Speech engine warming up</span>`);

  if (llmS.active === 'ollama') chips.push(`<span class="chip ok"><span class="dot"></span>Cleanup: Ollama (${esc(llmS.activeModel || '')})</span>`);
  else if (llmS.active) chips.push(`<span class="chip ok"><span class="dot"></span>Cleanup: ${esc(llmS.active)}</span>`);
  else chips.push(`<span class="chip"><span class="dot"></span>Cleanup: built-in rules (add a key or run Ollama for smarter cleanup)</span>`);
  box.innerHTML = chips.join('');
}

let searchTimer = null;
$('#history-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 250);
});

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

async function loadHistory() {
  const q = $('#history-search').value.trim();
  const rows = await pie.history.list({ query: q, limit: 60 });
  const box = $('#history-list');
  if (!rows.length) {
    box.innerHTML = `<div class="empty">No dictations yet. Hold your hotkey and say hello.</div>`;
    return;
  }
  let html = '';
  let lastDay = '';
  for (const r of rows) {
    const day = dayLabel(r.ts);
    if (day !== lastDay) {
      if (lastDay) html += '</div>';
      html += `<div class="day-group"><div class="day-label">${esc(day)}</div>`;
      lastDay = day;
    }
    const time = new Date(r.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const meta = [r.app_exe, r.mode === 'command' ? 'command' : null, r.words ? `${r.words} words` : null, r.wpm ? `${r.wpm} wpm` : null]
      .filter(Boolean).join(' &middot; ');
    html += `
      <div class="history-item" data-id="${r.id}">
        <div class="time">${esc(time)}</div>
        <div class="body">
          <div class="text">${esc(r.clean_text)}</div>
          <div class="meta">${meta}</div>
        </div>
        <div class="actions">
          <button class="icon-btn" data-act="copy" title="Copy">&#10697;</button>
          <button class="icon-btn" data-act="edit" title="Edit (teaches PieFlow)">&#9998;</button>
          <button class="icon-btn" data-act="del" title="Delete">&#10005;</button>
        </div>
      </div>`;
  }
  html += '</div>';
  box.innerHTML = html;

  box.querySelectorAll('.history-item').forEach((item) => {
    const id = +item.dataset.id;
    const textEl = item.querySelector('.text');
    item.querySelector('[data-act=copy]').addEventListener('click', () => navigator.clipboard.writeText(textEl.textContent));
    item.querySelector('[data-act=del]').addEventListener('click', async () => { await pie.history.delete(id); loadHistory(); });
    item.querySelector('[data-act=edit]').addEventListener('click', () => {
      textEl.contentEditable = 'true';
      textEl.focus();
      const done = async () => {
        textEl.contentEditable = 'false';
        await pie.history.update({ id, text: textEl.textContent.trim() });
      };
      textEl.addEventListener('blur', done, { once: true });
      textEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textEl.blur(); }
      });
    });
  });
}

pie.history.onChanged(() => {
  if ($('#page-home').classList.contains('active')) loadHome();
});

// ---------- insights ----------
async function loadInsights() {
  const { daily, apps } = await pie.insights.get();

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = daily.find((r) => r.d === key);
    days.push({ label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), words: row ? row.words : 0, wpm: row ? Math.round(row.wpm || 0) : 0 });
  }

  const maxW = Math.max(1, ...days.map((d) => d.words));
  $('#chart-words').innerHTML = `<div class="bar-chart">${days.map((d) => `
    <div class="bar-col">
      <div class="bv">${d.words || ''}</div>
      <div class="bar" style="height:${Math.max(2, (d.words / maxW) * 100)}%"></div>
      <div class="bl">${esc(d.label)}</div>
    </div>`).join('')}</div>`;

  const maxWpm = Math.max(1, ...days.map((d) => d.wpm));
  $('#chart-wpm').innerHTML = `<div class="bar-chart">${days.map((d) => `
    <div class="bar-col">
      <div class="bv">${d.wpm || ''}</div>
      <div class="bar alt" style="height:${Math.max(2, (d.wpm / maxWpm) * 100)}%"></div>
      <div class="bl">${esc(d.label)}</div>
    </div>`).join('')}</div>`;

  const maxApp = Math.max(1, ...apps.map((a) => a.n));
  $('#chart-apps').innerHTML = apps.length
    ? apps.map((a) => `
      <div class="hbar-row">
        <div class="name">${esc(a.app_exe)}</div>
        <div class="track"><div class="fill" style="width:${(a.n / maxApp) * 100}%"></div></div>
        <div class="val">${a.n}</div>
      </div>`).join('')
    : '<div class="empty">Dictate into a few apps first.</div>';
}

// ---------- dictionary ----------
async function loadDictionary() {
  const rows = await pie.dict.list();
  const box = $('#dict-list');
  box.innerHTML = rows.length ? rows.map((r) => {
    let variants = [];
    try { variants = JSON.parse(r.misheard || '[]'); } catch {}
    return `
      <div class="list-item">
        <div class="grow">
          <b>${esc(r.word)}</b>
          <span class="muted">${variants.length ? 'sounds like: ' + esc(variants.join(', ')) : ''}
          ${r.uses ? ` &middot; corrected ${r.uses}x` : ''}</span>
        </div>
        <button class="icon-btn" data-id="${r.id}" title="Remove">&#10005;</button>
      </div>`;
  }).join('') : '<div class="empty">No words yet. Add names and jargon PieFlow should know.</div>';
  box.querySelectorAll('.icon-btn').forEach((b) => b.addEventListener('click', async () => {
    await pie.dict.delete(+b.dataset.id); loadDictionary();
  }));
}
$('#dict-add').addEventListener('click', async () => {
  const word = $('#dict-word').value.trim();
  if (!word) return;
  const misheard = $('#dict-misheard').value.split(',').map((s) => s.trim()).filter(Boolean);
  await pie.dict.add({ word, misheard });
  $('#dict-word').value = ''; $('#dict-misheard').value = '';
  loadDictionary();
});

// ---------- snippets ----------
async function loadSnippets() {
  const rows = await pie.snip.list();
  const box = $('#snip-list');
  box.innerHTML = rows.length ? rows.map((r) => `
    <div class="list-item">
      <div class="grow">
        <b>"${esc(r.trigger)}"${r.uses ? ` <span class="muted">used ${r.uses}x</span>` : ''}</b>
        <pre>${esc(r.content)}</pre>
      </div>
      <button class="icon-btn" data-id="${r.id}" title="Remove">&#10005;</button>
    </div>`).join('') : '<div class="empty">No snippets yet.</div>';
  box.querySelectorAll('.icon-btn').forEach((b) => b.addEventListener('click', async () => {
    await pie.snip.delete(+b.dataset.id); loadSnippets();
  }));
}
$('#snip-add').addEventListener('click', async () => {
  const trigger = $('#snip-trigger').value.trim();
  const content = $('#snip-content').value;
  if (!trigger || !content) return;
  await pie.snip.add({ trigger, content });
  $('#snip-trigger').value = ''; $('#snip-content').value = '';
  loadSnippets();
});

// ---------- styles ----------
async function loadStyles() {
  await refreshPro();
  const ok = proGate('style', 'Custom style profiles', 'Built-in tones still apply automatically for free. Pro lets you create and edit your own per-app style profiles.');
  $('#style-new').style.display = ok ? '' : 'none';
  const rows = await pie.styles.list();
  const box = $('#style-list');
  box.classList.toggle('locked', !ok);
  box.innerHTML = rows.map((r) => {
    let apps = [];
    try { apps = JSON.parse(r.apps || '[]'); } catch {}
    return `
    <div class="card" data-id="${r.id}">
      <div class="setting-row" style="border:none;padding:0">
        <h3 style="margin:0">${esc(r.name)} ${r.builtin ? '<span class="muted">built-in</span>' : ''}</h3>
        ${r.builtin ? '' : `<button class="btn danger" data-act="del">Delete</button>`}
      </div>
      <div class="editor-grid">
        <label>Apps (comma separated)</label>
        <input data-f="apps" value="${esc(apps.join(', '))}" ${r.name === 'Default' ? 'disabled placeholder="fallback for all apps"' : ''}>
        <label>Tone instructions</label>
        <textarea data-f="tone" rows="2">${esc(r.tone)}</textarea>
        <label>Preserve casing (code)</label>
        <input type="checkbox" data-f="keep" class="switch" ${r.keep_casing ? 'checked' : ''}>
      </div>
      <div class="row-right"><button class="btn primary" data-act="save">Save</button></div>
    </div>`;
  }).join('');

  box.querySelectorAll('.card').forEach((card) => {
    const id = +card.dataset.id;
    const row = rows.find((r) => r.id === id);
    card.querySelector('[data-act=save]').addEventListener('click', async () => {
      await pie.styles.save({
        id,
        name: row.name,
        apps: card.querySelector('[data-f=apps]').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
        tone: card.querySelector('[data-f=tone]').value,
        keep_casing: card.querySelector('[data-f=keep]').checked,
      });
      loadStyles();
    });
    const del = card.querySelector('[data-act=del]');
    if (del) del.addEventListener('click', async () => { await pie.styles.delete(id); loadStyles(); });
  });
}
$('#style-new').addEventListener('click', async () => {
  const name = prompt('Style profile name:');
  if (!name) return;
  await pie.styles.save({ name, apps: [], tone: '', keep_casing: false });
  loadStyles();
});

// ---------- transforms ----------
async function loadTransforms() {
  await refreshPro();
  const ok = proGate('transforms', 'Transforms', 'Transforms are saved Command Mode instructions you trigger by voice. Command Mode and transforms are part of Pro.');
  $('#transform-new').style.display = ok ? '' : 'none';
  const rows = await pie.transforms.list();
  const box = $('#transform-list');
  box.classList.toggle('locked', !ok);
  box.innerHTML = rows.map((r) => `
    <div class="card" data-id="${r.id}">
      <div class="setting-row" style="border:none;padding:0">
        <h3 style="margin:0">"${esc(r.name)}" ${r.builtin ? '<span class="muted">built-in</span>' : ''}</h3>
        ${r.builtin ? '' : `<button class="btn danger" data-act="del">Delete</button>`}
      </div>
      <div class="editor-grid">
        <label>Instruction</label>
        <textarea data-f="instruction" rows="2">${esc(r.instruction)}</textarea>
      </div>
      <div class="row-right"><button class="btn primary" data-act="save">Save</button></div>
    </div>`).join('');

  box.querySelectorAll('.card').forEach((card) => {
    const id = +card.dataset.id;
    const row = rows.find((r) => r.id === id);
    card.querySelector('[data-act=save]').addEventListener('click', async () => {
      await pie.transforms.save({ id, name: row.name, instruction: card.querySelector('[data-f=instruction]').value });
      loadTransforms();
    });
    const del = card.querySelector('[data-act=del]');
    if (del) del.addEventListener('click', async () => { await pie.transforms.delete(id); loadTransforms(); });
  });
}
$('#transform-new').addEventListener('click', async () => {
  const name = prompt('Transform name (say this in Command Mode):');
  if (!name) return;
  const instruction = prompt('Instruction for the LLM:');
  if (!instruction) return;
  await pie.transforms.save({ name, instruction });
  loadTransforms();
});

// ---------- scratchpad ----------
let scratchTimer = null;
async function loadScratchpad() {
  $('#scratch').value = await pie.scratchpad.get();
}
$('#scratch').addEventListener('input', () => {
  clearTimeout(scratchTimer);
  scratchTimer = setTimeout(async () => {
    await pie.scratchpad.set($('#scratch').value);
    $('#scratch-saved').textContent = 'Saved';
    setTimeout(() => { $('#scratch-saved').textContent = ''; }, 1200);
  }, 500);
});
$('#scratch-copy').addEventListener('click', () => navigator.clipboard.writeText($('#scratch').value));
$('#scratch-clear').addEventListener('click', async () => {
  $('#scratch').value = '';
  await pie.scratchpad.set('');
});

// ---------- pro / licensing ----------
let PRO = false;
const PRO_PAGES = ['style', 'transforms'];

async function refreshPro() {
  let s = { pro: false, configured: false, hasKey: false, keyMasked: '', status: 'inactive' };
  try { s = await pie.license.status(); } catch {}
  PRO = !!s.pro;

  const stateEl = $('#pro-state');
  if (stateEl) {
    stateEl.textContent = PRO ? 'Pro' : 'Free';
    stateEl.classList.toggle('on', PRO);
  }
  const buy = $('#pro-buy');
  const activate = $('#pro-activate');
  if (buy && activate) {
    if (PRO) {
      buy.textContent = 'Manage';
      $('#pro-sub').textContent = `Pro is active on this device${s.keyMasked ? ` (${s.keyMasked})` : ''}. Thank you for supporting PieFlow.`;
      activate.style.display = 'none';
    } else {
      buy.textContent = 'Get Pro';
      activate.style.display = 'flex';
    }
  }

  // nav tags + page gating
  PRO_PAGES.forEach((p) => {
    const nav = document.querySelector(`.nav-item[data-page="${p}"]`);
    if (nav) {
      let tag = nav.querySelector('.pro-tag');
      if (!PRO && !tag) { tag = document.createElement('span'); tag.className = 'pro-tag'; tag.textContent = 'PRO'; nav.appendChild(tag); }
      if (PRO && tag) tag.remove();
    }
  });
}

function proGate(pageId, title, blurb) {
  // Returns true if the page should show its normal content, false if gated.
  const page = $(`#page-${pageId}`);
  if (!page) return true;
  const existing = page.querySelector('.upgrade-banner');
  if (existing) existing.remove();
  page.querySelector('[data-progated]')?.classList.remove('locked');
  if (PRO) return true;
  const banner = document.createElement('div');
  banner.className = 'upgrade-banner';
  banner.innerHTML = `<div><b>${esc(title)} is a Pro feature</b><div class="muted">${esc(blurb)}</div></div>
    <button class="btn primary" data-upgrade>Unlock with Pro</button>`;
  const h1 = page.querySelector('h1');
  h1.insertAdjacentElement('afterend', banner);
  banner.querySelector('[data-upgrade]').addEventListener('click', goPro);
  return false;
}

async function goPro() {
  try {
    const s = await pie.license.status();
    if (!s.configured) {
      alert('Pro checkout is not set up yet. Add your Lemon Squeezy checkout URL in main/license.js (or the PIEFLOW_CHECKOUT_URL env var).');
      return;
    }
    await pie.license.checkout();
  } catch {}
}

$('#pro-buy')?.addEventListener('click', async () => {
  if (PRO) { $('#page-settings').scrollIntoView(); return; }
  goPro();
});
$('#license-activate')?.addEventListener('click', async () => {
  const key = $('#license-key').value.trim();
  const msg = $('#license-msg');
  if (!key) { msg.textContent = 'Enter your license key.'; msg.className = 'err'; return; }
  msg.textContent = 'Activating...'; msg.className = 'muted';
  const r = await pie.license.activate(key);
  if (r.ok) {
    msg.textContent = 'Pro activated. Thank you!'; msg.className = 'ok';
    $('#license-key').value = '';
    await refreshPro();
  } else {
    msg.textContent = r.error || 'Activation failed.'; msg.className = 'err';
  }
});

// ---------- settings ----------
async function loadSettings() {
  await refreshPro();
  const cfg = await pie.settings.get();
  if (cfg.hotkey) $('#hotkey-btn').textContent = cfg.hotkey.label;
  if (cfg.commandHotkey) $('#cmdkey-btn').textContent = cfg.commandHotkey.label;
  $('#stt-engine').value = cfg.stt.engine;
  $('#stt-model').value = cfg.stt.model;
  $('#stt-lang').value = cfg.stt.language === 'auto' ? '' : cfg.stt.language;
  $('#cleanup-mode').value = cfg.cleanup.mode;
  $('#cleanup-provider').value = cfg.cleanup.provider;
  $('#typing-method').value = cfg.typing.method;
  $('#launch-startup').checked = !!cfg.launchAtStartup;
  $('#mic-processing').checked = cfg.micProcessing !== false;

  // mics
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const sel = $('#mic-select');
    sel.innerHTML = '<option value="default">System default</option>' +
      mics.filter((m) => m.deviceId !== 'default' && m.deviceId !== 'communications')
        .map((m) => `<option value="${esc(m.deviceId)}">${esc(m.label || 'Microphone')}</option>`).join('');
    sel.value = cfg.mic || 'default';
    if (sel.selectedIndex < 0) sel.value = 'default';
  } catch {}

  // key state
  const keys = await pie.keys.get();
  $('#openai-key-state').textContent = keys.openaiSet ? `Saved (${keys.openai})` : 'Not set';
  $('#groq-key-state').textContent = keys.groqSet ? `Saved (${keys.groq})` : 'Free tier available at console.groq.com';

  // ollama
  const llmS = await pie.llm.status();
  const os = $('#ollama-status');
  if (llmS.ollama.running) {
    os.textContent = `Ollama running, ${llmS.ollama.models.length} model(s)`;
    $('#ollama-model').innerHTML = '<option value="">auto (first model)</option>' +
      llmS.ollama.models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    $('#ollama-model').value = cfg.cleanup.ollamaModel || '';
  } else {
    os.textContent = 'Ollama not running (install/start it for free local cleanup)';
  }

  const stt = await pie.stt.status();
  renderSttSetupStatus(stt);
}

function renderSttSetupStatus(s) {
  const el = $('#stt-setup-status');
  if (!el) return;
  if (s.state === 'error') el.textContent = s.detail;
  else if (s.state === 'setup' || s.state === 'loading-model') el.textContent = s.detail;
  else if (s.state === 'ready') el.textContent = `Local Whisper ready (model: ${s.model})`;
  else el.textContent = '';
}
pie.stt.onStatus((s) => {
  renderSttSetupStatus(s);
  if ($('#page-home').classList.contains('active')) renderEngineChips();
});

function bindSetting(sel, fn) {
  $(sel).addEventListener('change', async () => { await fn(); });
}
bindSetting('#stt-engine', () => pie.settings.set({ stt: { engine: $('#stt-engine').value } }));
bindSetting('#stt-model', () => pie.settings.set({ stt: { model: $('#stt-model').value } }));
$('#stt-lang').addEventListener('change', () => pie.settings.set({ stt: { language: $('#stt-lang').value.trim() || 'auto' } }));
bindSetting('#cleanup-mode', () => pie.settings.set({ cleanup: { mode: $('#cleanup-mode').value } }));
bindSetting('#cleanup-provider', () => pie.settings.set({ cleanup: { provider: $('#cleanup-provider').value } }));
bindSetting('#ollama-model', () => pie.settings.set({ cleanup: { ollamaModel: $('#ollama-model').value } }));
bindSetting('#typing-method', () => pie.settings.set({ typing: { method: $('#typing-method').value } }));
bindSetting('#mic-select', () => pie.settings.set({ mic: $('#mic-select').value }));
bindSetting('#mic-processing', () => pie.settings.set({ micProcessing: $('#mic-processing').checked }));
bindSetting('#launch-startup', () => pie.settings.set({ launchAtStartup: $('#launch-startup').checked }));

$('#save-openai').addEventListener('click', async () => {
  await pie.keys.set({ openai: $('#key-openai').value.trim() });
  $('#key-openai').value = '';
  loadSettings();
});
$('#save-groq').addEventListener('click', async () => {
  await pie.keys.set({ groq: $('#key-groq').value.trim() });
  $('#key-groq').value = '';
  loadSettings();
});

async function captureHotkey(btnSel, settingKey) {
  const btn = $(btnSel);
  const old = btn.textContent;
  btn.textContent = 'Press keys...';
  btn.classList.add('capturing');
  const combo = await pie.hotkey.capture();
  btn.classList.remove('capturing');
  if (combo) {
    await pie.settings.set({ [settingKey]: combo });
    btn.textContent = combo.label;
  } else {
    btn.textContent = old;
  }
}
$('#hotkey-btn').addEventListener('click', () => captureHotkey('#hotkey-btn', 'hotkey'));
$('#cmdkey-btn').addEventListener('click', () => captureHotkey('#cmdkey-btn', 'commandHotkey'));

// ---------- boot ----------
const loaders = {
  home: loadHome,
  insights: loadInsights,
  dictionary: loadDictionary,
  snippets: loadSnippets,
  style: loadStyles,
  transforms: loadTransforms,
  scratchpad: loadScratchpad,
  settings: loadSettings,
};
loadHome();
refreshPro();
setInterval(() => {
  if ($('#page-home').classList.contains('active')) renderEngineChips();
}, 5000);
