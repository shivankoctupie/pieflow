// SQLite storage via sql.js (WASM). Real SQLite file on disk, zero native build risk.
// Writes are debounced to disk; also flushed on quit.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const initSqlJs = require('sql.js');

let db = null;
let dirty = false;
let saveTimer = null;

function dbFile() {
  return path.join(app.getPath('userData'), 'pieflow.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  clean_text TEXT NOT NULL,
  app_exe TEXT DEFAULT '',
  app_title TEXT DEFAULT '',
  duration_ms INTEGER DEFAULT 0,
  words INTEGER DEFAULT 0,
  wpm REAL DEFAULT 0,
  mode TEXT DEFAULT 'dictate',
  language TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS dictionary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  misheard TEXT DEFAULT '[]',
  added_ts INTEGER NOT NULL,
  uses INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  added_ts INTEGER NOT NULL,
  uses INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  apps TEXT DEFAULT '[]',
  tone TEXT DEFAULT '',
  keep_casing INTEGER DEFAULT 0,
  builtin INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transforms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  instruction TEXT NOT NULL,
  builtin INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  original TEXT NOT NULL,
  corrected TEXT NOT NULL
);
`;

const BUILTIN_STYLES = [
  { name: 'Default', apps: [], tone: 'Neutral, clear, everyday writing.', keep_casing: 0 },
  { name: 'Professional', apps: ['outlook', 'olk', 'thunderbird', 'hxoutlook', 'winmail'], tone: 'Professional and polished, suitable for business email. Complete sentences, courteous tone.', keep_casing: 0 },
  { name: 'Casual', apps: ['slack', 'discord', 'teams', 'ms-teams', 'telegram', 'whatsapp', 'signal'], tone: 'Casual and friendly chat style. Contractions welcome, keep it light, no stiff formality.', keep_casing: 0 },
  { name: 'Code', apps: ['code', 'cursor', 'windsurf', 'idea64', 'webstorm64', 'pycharm64', 'devenv', 'windowsterminal', 'wt', 'sublime_text', 'notepad++'], tone: 'Text for a code editor. Preserve technical terms, identifiers, and casing exactly. No added pleasantries.', keep_casing: 1 },
];

const BUILTIN_TRANSFORMS = [
  { name: 'Make concise', instruction: 'Rewrite the text to be significantly more concise while keeping all key information.' },
  { name: 'Bullet points', instruction: 'Turn the text into a clean bulleted list of its key points.' },
  { name: 'Fix grammar', instruction: 'Fix all grammar, spelling, and punctuation mistakes. Change nothing else.' },
  { name: 'More formal', instruction: 'Rewrite the text in a more formal, professional tone.' },
  { name: 'More casual', instruction: 'Rewrite the text in a relaxed, casual tone.' },
  { name: 'Translate to Spanish', instruction: 'Translate the text to Spanish. Output only the translation.' },
];

async function open() {
  if (db) return db;
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f),
  });
  try {
    const buf = fs.readFileSync(dbFile());
    db = new SQL.Database(buf);
  } catch {
    db = new SQL.Database();
  }
  db.exec(SCHEMA);
  seed();
  flush();
  return db;
}

function seed() {
  const count = one(`SELECT COUNT(*) AS c FROM styles`);
  if (count.c === 0) {
    for (const s of BUILTIN_STYLES) {
      run(`INSERT INTO styles (name, apps, tone, keep_casing, builtin) VALUES (?, ?, ?, ?, 1)`,
        [s.name, JSON.stringify(s.apps), s.tone, s.keep_casing]);
    }
  }
  const tcount = one(`SELECT COUNT(*) AS c FROM transforms`);
  if (tcount.c === 0) {
    for (const t of BUILTIN_TRANSFORMS) {
      run(`INSERT INTO transforms (name, instruction, builtin) VALUES (?, ?, 1)`, [t.name, t.instruction]);
    }
  }
}

function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 500);
}

function flush() {
  if (!db) return;
  try {
    fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
    fs.writeFileSync(dbFile(), Buffer.from(db.export()));
    dirty = false;
  } catch (e) {
    console.error('db flush failed', e);
  }
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function one(sql, params = []) {
  return all(sql, params)[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  markDirty();
}

// ---- history ----
function addHistory(entry) {
  run(
    `INSERT INTO history (ts, raw_text, clean_text, app_exe, app_title, duration_ms, words, wpm, mode, language)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.ts, entry.raw_text, entry.clean_text, entry.app_exe || '', entry.app_title || '',
     entry.duration_ms || 0, entry.words || 0, entry.wpm || 0, entry.mode || 'dictate', entry.language || '']
  );
  return one(`SELECT last_insert_rowid() AS id`).id;
}

function listHistory({ query = '', limit = 100, offset = 0 } = {}) {
  if (query) {
    return all(
      `SELECT * FROM history WHERE clean_text LIKE ? OR raw_text LIKE ? OR app_exe LIKE ?
       ORDER BY ts DESC LIMIT ? OFFSET ?`,
      [`%${query}%`, `%${query}%`, `%${query}%`, limit, offset]
    );
  }
  return all(`SELECT * FROM history ORDER BY ts DESC LIMIT ? OFFSET ?`, [limit, offset]);
}

function updateHistoryText(id, newText) {
  const row = one(`SELECT clean_text FROM history WHERE id = ?`, [id]);
  run(`UPDATE history SET clean_text = ? WHERE id = ?`, [newText, id]);
  return row ? row.clean_text : null;
}

function deleteHistory(id) {
  run(`DELETE FROM history WHERE id = ?`, [id]);
}

// ---- dictionary ----
function listDictionary() {
  return all(`SELECT * FROM dictionary ORDER BY word COLLATE NOCASE`);
}
function addDictWord(word, misheard = []) {
  run(`INSERT OR REPLACE INTO dictionary (word, misheard, added_ts, uses)
       VALUES (?, ?, ?, COALESCE((SELECT uses FROM dictionary WHERE word = ?), 0))`,
    [word, JSON.stringify(misheard), Date.now(), word]);
}
function deleteDictWord(id) {
  run(`DELETE FROM dictionary WHERE id = ?`, [id]);
}
function bumpDictUse(word) {
  run(`UPDATE dictionary SET uses = uses + 1 WHERE word = ?`, [word]);
}

// ---- snippets ----
function listSnippets() {
  return all(`SELECT * FROM snippets ORDER BY trigger COLLATE NOCASE`);
}
function addSnippet(trigger, content) {
  run(`INSERT OR REPLACE INTO snippets (trigger, content, added_ts, uses)
       VALUES (?, ?, ?, COALESCE((SELECT uses FROM snippets WHERE trigger = ?), 0))`,
    [trigger, content, Date.now(), trigger]);
}
function deleteSnippet(id) {
  run(`DELETE FROM snippets WHERE id = ?`, [id]);
}
function bumpSnippetUse(id) {
  run(`UPDATE snippets SET uses = uses + 1 WHERE id = ?`, [id]);
}

// ---- styles ----
function listStyles() {
  return all(`SELECT * FROM styles ORDER BY builtin DESC, name`);
}
function saveStyle(s) {
  if (s.id) {
    run(`UPDATE styles SET name = ?, apps = ?, tone = ?, keep_casing = ? WHERE id = ?`,
      [s.name, JSON.stringify(s.apps || []), s.tone || '', s.keep_casing ? 1 : 0, s.id]);
  } else {
    run(`INSERT INTO styles (name, apps, tone, keep_casing, builtin) VALUES (?, ?, ?, ?, 0)`,
      [s.name, JSON.stringify(s.apps || []), s.tone || '', s.keep_casing ? 1 : 0]);
  }
}
function deleteStyle(id) {
  run(`DELETE FROM styles WHERE id = ? AND builtin = 0`, [id]);
}

// ---- transforms ----
function listTransforms() {
  return all(`SELECT * FROM transforms ORDER BY builtin DESC, name`);
}
function saveTransform(t) {
  if (t.id) {
    run(`UPDATE transforms SET name = ?, instruction = ? WHERE id = ?`, [t.name, t.instruction, t.id]);
  } else {
    run(`INSERT INTO transforms (name, instruction, builtin) VALUES (?, ?, 0)`, [t.name, t.instruction]);
  }
}
function deleteTransform(id) {
  run(`DELETE FROM transforms WHERE id = ?`, [id]);
}

// ---- corrections (learning from user edits) ----
function addCorrection(original, corrected) {
  run(`INSERT INTO corrections (ts, original, corrected) VALUES (?, ?, ?)`, [Date.now(), original, corrected]);
}
function listCorrections(limit = 500) {
  return all(`SELECT * FROM corrections ORDER BY ts DESC LIMIT ?`, [limit]);
}

// ---- stats ----
function getStats() {
  const totals = one(`SELECT COUNT(*) AS dictations, COALESCE(SUM(words), 0) AS words,
                      COALESCE(AVG(NULLIF(wpm, 0)), 0) AS avg_wpm FROM history`) || {};
  const days = all(`SELECT DISTINCT date(ts / 1000, 'unixepoch', 'localtime') AS d FROM history ORDER BY d DESC LIMIT 400`);
  let streak = 0;
  const today = new Date();
  for (let i = 0; ; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (days.some((r) => r.d === key)) streak++;
    else if (i === 0) continue; // today empty does not break streak yet
    else break;
  }
  return {
    dictations: totals.dictations || 0,
    words: totals.words || 0,
    avgWpm: Math.round(totals.avg_wpm || 0),
    streak,
  };
}

function getInsights(daysBack = 14) {
  const rows = all(
    `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS d,
            SUM(words) AS words, COUNT(*) AS n, AVG(NULLIF(wpm, 0)) AS wpm
     FROM history WHERE ts > ? GROUP BY d ORDER BY d`,
    [Date.now() - daysBack * 86400000]
  );
  const apps = all(
    `SELECT app_exe, COUNT(*) AS n, SUM(words) AS words FROM history
     WHERE app_exe != '' GROUP BY app_exe ORDER BY n DESC LIMIT 8`
  );
  return { daily: rows, apps };
}

module.exports = {
  open, flush,
  addHistory, listHistory, updateHistoryText, deleteHistory,
  listDictionary, addDictWord, deleteDictWord, bumpDictUse,
  listSnippets, addSnippet, deleteSnippet, bumpSnippetUse,
  listStyles, saveStyle, deleteStyle,
  listTransforms, saveTransform, deleteTransform,
  addCorrection, listCorrections,
  getStats, getInsights,
};
