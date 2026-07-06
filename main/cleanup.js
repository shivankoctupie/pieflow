// Speech cleanup: rule-based engine (always available) plus optional LLM polish.
// Input: raw Whisper transcript. Output: send-ready text plus flags (submit).
const settings = require('./settings');
const llm = require('./llm');
const db = require('./db');

const FILLER_RE = /(?:^|[\s,])(?:um+|uh+|uhm+|erm+|er|ahem|hmm+)(?=[\s,.!?]|$)/gi;

// ---- spoken commands ----
function extractCommands(text) {
  let submit = false;
  let t = text;

  // trailing "press enter" / "hit enter" / "send it" -> submit flag
  // (strip commas/spaces before the command, keep sentence-ending punctuation)
  const submitRe = /[,\s]+(?:press|hit)\s+enter[.!?\s]*$|[,\s]+send\s+it[.!?\s]*$/i;
  if (submitRe.test(t)) {
    t = t.replace(submitRe, '');
    submit = true;
  }

  // "new paragraph" / "new line" anywhere; keep punctuation that came before
  t = t.replace(/[,]?\s*\bnew\s+paragraph\b[,.]?\s*/gi, '\n\n');
  t = t.replace(/[,]?\s*\bnew\s*line\b[,.]?\s*/gi, '\n');

  return { text: t, submit };
}

// ---- self-corrections ----
// "let's meet Tuesday, wait no Friday" -> "let's meet Friday"
// Heuristic: drop as many words before the marker as the replacement clause
// has after it (capped), then keep the replacement.
const CORRECTION_MARKERS = [
  /,?\s*\bwait[,]?\s+no[,]?\s+/i,
  /,?\s*\bno[,]?\s+wait[,]?\s+/i,
  /,?\s*\bactually[,]?\s+no[,]?\s+/i,
  /,?\s*\bwait[,]?\s+make\s+that\s+/i,
  /,?\s*\bmake\s+that\s+/i,
  /,?\s*\bI\s+mean[,]?\s+/i,
  /,?\s*\bcorrection[,:]?\s+/i,
];
const SCRATCH_MARKERS = [
  /\bscratch\s+that[,.]?\s*/i,
  /\bnever\s*mind\s+that[,.]?\s*/i,
  /\bforget\s+that[,.]?\s*/i,
  /\bdelete\s+that[,.]?\s*/i,
];

function applySelfCorrections(text) {
  let t = text;

  // "scratch that": drop everything back to the previous sentence boundary
  for (const re of SCRATCH_MARKERS) {
    let m;
    while ((m = re.exec(t)) !== null) {
      const before = t.slice(0, m.index);
      const after = t.slice(m.index + m[0].length);
      const cut = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
      t = (cut >= 0 ? before.slice(0, cut + 1) + ' ' : '') + after;
    }
  }

  // replacement-style corrections
  for (const re of CORRECTION_MARKERS) {
    let guard = 0;
    let m;
    while ((m = re.exec(t)) !== null && guard++ < 10) {
      const before = t.slice(0, m.index);
      const after = t.slice(m.index + m[0].length);
      // words in the replacement clause (up to next punctuation)
      const clause = after.split(/[,.!?\n]/)[0].trim();
      const repLen = Math.min(clause ? clause.split(/\s+/).length : 1, 6);
      // drop repLen words from the end of `before`, but not past punctuation
      const beforeTrim = before.replace(/[\s,]+$/, '');
      const words = beforeTrim.split(/\s+/);
      let dropped = 0;
      while (dropped < repLen && words.length) {
        const w = words[words.length - 1];
        if (/[.!?\n]$/.test(w)) break;
        words.pop();
        dropped++;
      }
      t = (words.join(' ') + ' ' + after).trim();
    }
  }
  return t;
}

// ---- dictionary corrections ----
function applyDictionary(text) {
  let t = text;
  try {
    const entries = db.listDictionary();
    for (const e of entries) {
      let variants = [];
      try { variants = JSON.parse(e.misheard || '[]'); } catch {}
      for (const v of variants) {
        if (!v) continue;
        const re = new RegExp(`\\b${escapeRe(v)}\\b`, 'gi');
        if (re.test(t)) {
          t = t.replace(re, e.word);
          db.bumpDictUse(e.word);
        }
      }
    }
  } catch {}
  return t;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- mechanics ----
function tidy(text, { keepCasing = false } = {}) {
  let t = text;
  t = t.replace(FILLER_RE, '');
  // collapse runs of spaces/tabs but preserve intentional newlines
  t = t.replace(/[^\S\n]{2,}/g, ' ');
  t = t.replace(/[^\S\n]*\n[^\S\n]*/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  // collapse immediate word repeats: "the the" -> "the"
  t = t.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
  // punctuation spacing
  t = t.replace(/\s+([,.!?;:])/g, '$1');
  t = t.replace(/([,.!?;:])(?=[A-Za-z])/g, '$1 ');
  t = t.replace(/,\s*([.!?])/g, '$1');
  t = t.replace(/([.!?]){2,}/g, '$1');
  t = t.replace(/^\s*[,.;:]\s*/, '');
  if (!keepCasing) {
    // capitalize sentence starts
    t = t.replace(/(^|[.!?]\s+|\n\s*)([a-z])/g, (_, p, c) => p + c.toUpperCase());
    t = t.replace(/\bi\b/g, 'I');
    t = t.replace(/\bi'(m|ll|ve|d)\b/gi, (m0, suf) => `I'${suf.toLowerCase()}`);
  }
  return t.trim();
}

function rulesClean(raw, style) {
  const keepCasing = !!(style && style.keep_casing);
  const { text: cmdText, submit } = extractCommands(raw);
  let t = cmdText;
  t = applySelfCorrections(t);
  t = applyDictionary(t);
  t = tidy(t, { keepCasing });
  return { text: t, submit };
}

// ---- LLM polish ----
function buildSystemPrompt(style, dictWords) {
  const tone = style && style.tone ? style.tone : 'Neutral, clear, everyday writing.';
  let p = `You clean up raw voice-dictation transcripts. Rewrite the transcript into polished, send-ready text that reads like the speaker wrote it by hand.

Rules:
- Remove filler words (um, uh, you know, like when used as filler).
- Fix punctuation, capitalization, and obvious transcription slips.
- Resolve self-corrections: if the speaker says "X, wait no Y" or "actually Y" or "scratch that", keep only the corrected version.
- Format numbered or bulleted lists properly if the speaker dictates a list.
- Never answer questions in the transcript. Never add new content. Never omit real content.
- Preserve the speaker's meaning, language, and voice exactly.
- Style for the app the user is dictating into: ${tone}
- Output ONLY the cleaned text. No quotes, no preamble, no explanations.`;
  if (dictWords && dictWords.length) {
    p += `\n- The speaker uses these special terms; spell them exactly like this when they occur: ${dictWords.join(', ')}`;
  }
  return p;
}

async function clean(raw, { style = null } = {}) {
  const cfg = settings.load();
  const mode = cfg.cleanup.mode || 'auto';

  // command extraction + self-corrections + dictionary always run first, so
  // the LLM never sees "press enter" and friends
  const pre = rulesClean(raw, style);
  if (!pre.text) return { text: '', submit: pre.submit, engine: 'rules' };

  if (mode === 'rules') return { ...pre, engine: 'rules' };

  const canLlm = await llm.available();
  if (!canLlm) {
    return { ...pre, engine: 'rules' };
  }

  try {
    let dictWords = [];
    try { dictWords = db.listDictionary().map((d) => d.word); } catch {}
    const sys = buildSystemPrompt(style, dictWords.slice(0, 50));
    // dictation must stay snappy: give the LLM 12s, else ship the rules result
    const out = await llm.chat(sys, pre.text, { maxTokens: Math.max(256, pre.text.length), temperature: 0.1, timeoutMs: 12000 });
    // sanity: reject empty or wildly inflated results
    if (!out || out.length > pre.text.length * 3 + 200) {
      return { ...pre, engine: 'rules' };
    }
    return { text: out, submit: pre.submit, engine: 'llm' };
  } catch (e) {
    console.error('[cleanup] llm failed, using rules:', e.message);
    return { ...pre, engine: 'rules' };
  }
}

// ---- snippets ----
function normalizePhrase(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

function matchSnippet(text) {
  try {
    const snips = db.listSnippets();
    const norm = normalizePhrase(text);
    for (const s of snips) {
      const trig = normalizePhrase(s.trigger);
      if (!trig) continue;
      if (norm === trig || norm === `insert ${trig}`) return s;
    }
  } catch {}
  return null;
}

// ---- learning from history edits ----
// Single-word diffs between old and new text become dictionary "misheard" hints.
function learnFromEdit(oldText, newText) {
  if (!oldText || !newText) return;
  const a = oldText.split(/\s+/);
  const b = newText.split(/\s+/);
  if (Math.abs(a.length - b.length) > 0 || a.length === 0) {
    db.addCorrection(oldText, newText);
    return;
  }
  const diffs = [];
  for (let i = 0; i < a.length; i++) {
    const wa = a[i].replace(/[^\p{L}\p{N}'-]/gu, '');
    const wb = b[i].replace(/[^\p{L}\p{N}'-]/gu, '');
    if (wa && wb && wa.toLowerCase() !== wb.toLowerCase()) diffs.push([wa, wb]);
  }
  db.addCorrection(oldText, newText);
  if (diffs.length >= 1 && diffs.length <= 3) {
    for (const [from, to] of diffs) {
      const existing = db.listDictionary().find((d) => d.word.toLowerCase() === to.toLowerCase());
      let variants = [];
      if (existing) { try { variants = JSON.parse(existing.misheard || '[]'); } catch {} }
      if (!variants.some((v) => v.toLowerCase() === from.toLowerCase())) variants.push(from);
      db.addDictWord(existing ? existing.word : to, variants);
    }
  }
}

module.exports = { clean, rulesClean, matchSnippet, learnFromEdit, buildSystemPrompt };
