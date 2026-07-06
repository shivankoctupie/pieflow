// Unified LLM client. Providers: OpenAI (key), Groq (key, OpenAI-compatible),
// Ollama (local, auto-detected). Everything degrades gracefully to null.
const settings = require('./settings');

const OLLAMA = 'http://127.0.0.1:11434';
let ollamaCache = { ts: 0, running: false, models: [] };

async function detectOllama(force = false) {
  if (!force && Date.now() - ollamaCache.ts < 30000) return ollamaCache;
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const j = await res.json();
    ollamaCache = { ts: Date.now(), running: true, models: (j.models || []).map((m) => m.name) };
  } catch {
    ollamaCache = { ts: Date.now(), running: false, models: [] };
  }
  return ollamaCache;
}

// Pick provider by settings priority: explicit choice, else key > ollama.
async function pickProvider() {
  const cfg = settings.load();
  const keys = settings.getKeys();
  const pref = cfg.cleanup.provider || 'auto';
  if (pref === 'openai' && keys.openai) return { kind: 'openai' };
  if (pref === 'groq' && keys.groq) return { kind: 'groq' };
  if (pref === 'ollama') {
    const o = await detectOllama();
    if (o.running && o.models.length) return { kind: 'ollama', model: cfg.cleanup.ollamaModel || o.models[0] };
    return null;
  }
  // auto
  if (keys.groq) return { kind: 'groq' };
  if (keys.openai) return { kind: 'openai' };
  const o = await detectOllama();
  if (o.running && o.models.length) return { kind: 'ollama', model: cfg.cleanup.ollamaModel || o.models[0] };
  return null;
}

async function available() {
  return (await pickProvider()) !== null;
}

async function chat(systemPrompt, userPrompt, { maxTokens = 1024, temperature = 0.2, timeoutMs = 45000 } = {}) {
  const provider = await pickProvider();
  if (!provider) throw new Error('no LLM available');
  const keys = settings.getKeys();

  if (provider.kind === 'ollama') {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        think: false, // reasoning models (qwen3 etc): answer directly
        options: { temperature, num_predict: maxTokens },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const j = await res.json();
    let out = (j.message && j.message.content || '').trim();
    // belt and braces: some model builds still inline their reasoning
    out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return out;
  }

  const conf = provider.kind === 'groq'
    ? { url: 'https://api.groq.com/openai/v1/chat/completions', key: keys.groq, model: 'llama-3.3-70b-versatile' }
    : { url: 'https://api.openai.com/v1/chat/completions', key: keys.openai, model: 'gpt-4o-mini' };

  const res = await fetch(conf.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.key}` },
    body: JSON.stringify({
      model: conf.model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${provider.kind} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.choices[0].message.content || '').trim();
}

async function statusReport() {
  const keys = settings.getKeys();
  const o = await detectOllama(true);
  const provider = await pickProvider();
  return {
    openaiKey: !!keys.openai,
    groqKey: !!keys.groq,
    ollama: o,
    active: provider ? provider.kind : null,
    activeModel: provider && provider.model ? provider.model : null,
  };
}

module.exports = { chat, available, detectOllama, pickProvider, statusReport };
