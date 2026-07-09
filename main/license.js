// PieFlow Pro licensing.
//
// PieFlow is open source, so this is a supporter license, not DRM: it unlocks
// the Pro power features and funds the project. Licenses are sold through a
// Merchant of Record (Lemon Squeezy) which handles global payments and tax.
//
// Validation uses Lemon Squeezy's public license API (no secret key needed):
//   POST https://api.lemonsqueezy.com/v1/licenses/activate {license_key, instance_name}
//   POST https://api.lemonsqueezy.com/v1/licenses/validate {license_key, instance_id}
// The key is stored locally; after activation it works offline within a grace
// window and re-validates in the background.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron');

// ---- config: set these once your Lemon Squeezy store + product exist ----
// The checkout URL is where "Get Pro" / "Upgrade" sends the user.
const CHECKOUT_URL = process.env.PIEFLOW_CHECKOUT_URL || 'https://pieflow.lemonsqueezy.com/buy/REPLACE-WITH-VARIANT';
const API = 'https://api.lemonsqueezy.com/v1/licenses';

const RECHECK_MS = 3 * 24 * 3600 * 1000;   // re-validate every 3 days when online
const OFFLINE_GRACE_MS = 21 * 24 * 3600 * 1000; // stay Pro up to 21 days offline

let cache = null;

function licenseFile() {
  return path.join(app.getPath('userData'), 'license.json');
}

function machineName() {
  return `${os.hostname()}-${crypto.createHash('sha1').update(os.hostname() + os.userInfo().username).digest('hex').slice(0, 8)}`;
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(licenseFile(), 'utf8'));
  } catch {
    cache = { key: '', instanceId: '', status: 'inactive', valid: false, lastCheck: 0, activatedAt: 0 };
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  try {
    fs.mkdirSync(path.dirname(licenseFile()), { recursive: true });
    fs.writeFileSync(licenseFile(), JSON.stringify(cache, null, 2));
  } catch {}
  return cache;
}

async function api(action, body) {
  const res = await fetch(`${API}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, data: j };
}

// Activate a freshly purchased key on this machine.
async function activate(key) {
  key = (key || '').trim();
  if (!key) return { ok: false, error: 'Enter your license key.' };
  try {
    const { ok, data } = await api('activate', { license_key: key, instance_name: machineName() });
    if (ok && data.activated && data.instance) {
      save({
        key,
        instanceId: data.instance.id,
        status: (data.license_key && data.license_key.status) || 'active',
        valid: true,
        lastCheck: Date.now(),
        activatedAt: Date.now(),
      });
      return { ok: true, pro: true };
    }
    // already activated on this machine? try a plain validate.
    const v = await validate(key);
    if (v.pro) return { ok: true, pro: true };
    return { ok: false, error: data.error || 'That license key could not be activated. Check the key, or it may have reached its device limit.' };
  } catch (e) {
    return { ok: false, error: 'Could not reach the license server. Check your connection and try again.' };
  }
}

async function validate(key) {
  const lic = load();
  key = (key || lic.key || '').trim();
  if (!key) return { pro: false };
  try {
    const body = { license_key: key };
    if (lic.instanceId) body.instance_id = lic.instanceId;
    const { ok, data } = await api('validate', body);
    if (ok && data.valid) {
      save({ key, status: (data.license_key && data.license_key.status) || 'active', valid: true, lastCheck: Date.now() });
      return { pro: true };
    }
    // server reachable but says invalid (refunded, disabled, wrong key)
    save({ valid: false, status: (data.license_key && data.license_key.status) || 'invalid', lastCheck: Date.now() });
    return { pro: false };
  } catch {
    // offline: honor the grace window off the last successful check
    return { pro: lic.valid && Date.now() - lic.lastCheck < OFFLINE_GRACE_MS };
  }
}

async function deactivate() {
  const lic = load();
  try {
    if (lic.key && lic.instanceId) await api('deactivate', { license_key: lic.key, instance_id: lic.instanceId });
  } catch {}
  save({ key: '', instanceId: '', status: 'inactive', valid: false, activatedAt: 0 });
  return { ok: true };
}

// Synchronous gate for feature checks. Uses cached state; triggers a background
// re-validate if the cache is stale. Never blocks a dictation.
function isPro() {
  const lic = load();
  if (!lic.valid) return false;
  const age = Date.now() - lic.lastCheck;
  if (age > RECHECK_MS && lic.key) {
    validate(lic.key).catch(() => {}); // fire and forget
  }
  return lic.valid && age < OFFLINE_GRACE_MS;
}

function status() {
  const lic = load();
  return {
    pro: isPro(),
    status: lic.status,
    hasKey: !!lic.key,
    keyMasked: lic.key ? `${lic.key.slice(0, 4)}...${lic.key.slice(-4)}` : '',
    checkoutUrl: CHECKOUT_URL,
    configured: !CHECKOUT_URL.includes('REPLACE-WITH'),
  };
}

// Re-validate at startup (non-blocking).
function refresh() {
  const lic = load();
  if (lic.key) validate(lic.key).catch(() => {});
}

module.exports = { activate, validate, deactivate, isPro, status, refresh, CHECKOUT_URL };
