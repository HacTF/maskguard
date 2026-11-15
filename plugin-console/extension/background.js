/* Managed plugin client (MV3 service worker).
   Responsibilities: enroll once, heartbeat, pull policy, verify signature,
   apply locally, ack. Everything degrades gracefully when the console is down. */
'use strict';

const DEFAULT_CFG = { serverUrl: 'http://127.0.0.1:8787', enrollToken: 'demo-enroll-token', label: '', host: '' };
const ALARM = 'mg-sync';

/* ---------- config: managed policy > packaged config.json > defaults ---------- */

async function loadConfig() {
  let fileCfg = {};
  try {
    const r = await fetch(chrome.runtime.getURL('config.json'));
    fileCfg = await r.json();
  } catch (e) { /* optional */ }
  let managed = {};
  try {
    managed = (await chrome.storage.managed.get(null)) || {};
  } catch (e) { /* no enterprise policy installed */ }
  return Object.assign({}, DEFAULT_CFG, fileCfg, managed);
}

function deviceKey() {
  return chrome.storage.local.get('deviceKey').then(s => {
    if (s.deviceKey) return s.deviceKey;
    const k = 'dk_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    return chrome.storage.local.set({ deviceKey: k }).then(() => k);
  });
}

/* ---------- crypto ---------- */

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- http ---------- */

async function call(baseUrl, pathname, opts) {
  const o = opts || {};
  const payload = o.body === undefined ? '' : JSON.stringify(o.body);
  const headers = { 'content-type': 'application/json' };
  if (o.signed) {
    const ts = Date.now();
    headers['x-plugin-id'] = o.pluginId;
    headers['x-plugin-ts'] = String(ts);
    headers['x-plugin-sign'] = await hmacHex(o.secret, ts + '.' + payload);
  }
  const res = await fetch(baseUrl.replace(/\/+$/, '') + pathname, {
    method: o.method || 'GET',
    headers,
    body: payload || undefined,
    cache: 'no-store'
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, body };
}

/* ---------- self report ---------- */

async function selfInfo() {
  const info = { extVersion: chrome.runtime.getManifest().version, installType: 'unknown', mayDisable: true, enabled: true };
  try {
    const self = await chrome.management.getSelf();
    info.extVersion = self.version || info.extVersion;
    info.installType = self.installType || 'unknown';   // admin = force-installed by enterprise policy
    info.mayDisable = self.mayDisable !== false;
    info.enabled = self.enabled !== false;
  } catch (e) { /* management permission missing */ }
  return info;
}

function hostLabel(cfg) {
  return { label: cfg.label || 'browser-plugin', host: cfg.host || cfg.label || 'unknown-host' };
}

/* ---------- policy ---------- */

async function applyPolicy(cfg, pluginId, secret, policy) {
  const sig = await hmacHex(secret, policy.version + '.' + JSON.stringify(policy.rules));
  if (!sameHex(sig, policy.sig)) {
    const msg = '策略签名校验失败，已丢弃';
    await chrome.storage.local.set({ lastError: msg });
    await ack(cfg, pluginId, secret, policy.version, false, msg);
    return false;
  }
  await chrome.storage.local.set({
    rules: policy.rules,
    policyVersion: policy.version,
    policyNote: policy.note || '',
    policyAppliedAt: Date.now(),
    lastError: ''
  });
  await ack(cfg, pluginId, secret, policy.version, true, '');
  notifyTabs();
  return true;
}

async function ack(cfg, pluginId, secret, version, ok, error) {
  try {
    await call(cfg.serverUrl, '/api/plugin/ack', {
      method: 'POST', signed: true, pluginId, secret, body: { version, ok, error }
    });
  } catch (e) { /* console unreachable; next heartbeat retries */ }
}

function notifyTabs() {
  chrome.tabs.query({}, tabs => {
    for (const t of tabs) {
      if (t.id) chrome.tabs.sendMessage(t.id, { type: 'mg-policy-updated' }, () => void chrome.runtime.lastError);
    }
  });
}

/* ---------- sync loop ---------- */

let syncing = null;

async function sync(reason) {
  if (syncing) return syncing;
  syncing = doSync(reason).finally(() => { syncing = null; });
  return syncing;
}

async function doSync(reason) {
  const cfg = await loadConfig();
  const store = await chrome.storage.local.get(['pluginId', 'secret', 'policyVersion', 'pushedMasked']);
  const info = await selfInfo();
  const pushedMasked = Number(store.pushedMasked || 0);
  if (pushedMasked) await chrome.storage.local.set({ pushedMasked: 0 });

  try {
    if (!store.pluginId || !store.secret) {
      const key = await deviceKey();
      const hl = hostLabel(cfg);
      const res = await call(cfg.serverUrl, '/api/plugin/enroll', {
        method: 'POST',
        body: Object.assign({
          enrollToken: cfg.enrollToken,
          deviceKey: key,
          os: navigator.userAgent,
          browser: 'Chromium',
          reason
        }, hl, info)
      });
      if (res.status !== 200) throw new Error('enroll ' + res.status + ' ' + JSON.stringify(res.body));
      await chrome.storage.local.set({ pluginId: res.body.pluginId, secret: res.body.secret, serverUrl: cfg.serverUrl });
      await applyPolicy(cfg, res.body.pluginId, res.body.secret, res.body.policy);
      await chrome.storage.local.set({ lastSyncAt: Date.now(), lastReason: reason });
      return { enrolled: true, version: res.body.policy.version };
    }

    const hb = await call(cfg.serverUrl, '/api/plugin/heartbeat', {
      method: 'POST', signed: true, pluginId: store.pluginId, secret: store.secret,
      body: Object.assign({ appliedVersion: store.policyVersion, masked: pushedMasked }, info)
    });
    if (hb.status === 401) {
      // secret rejected (console reset / plugin reinstalled): drop credentials and re-enroll
      await chrome.storage.local.remove(['pluginId', 'secret', 'policyVersion']);
      throw new Error('credentials rejected, will re-enroll');
    }
    if (hb.status !== 200) throw new Error('heartbeat ' + hb.status);

    const pol = await call(cfg.serverUrl, '/api/plugin/policy?v=' + (store.policyVersion === undefined ? -1 : store.policyVersion), {
      method: 'GET', signed: true, pluginId: store.pluginId, secret: store.secret
    });
    if (pol.status === 200 && !pol.body.unchanged) {
      await applyPolicy(cfg, store.pluginId, store.secret, pol.body);
    }
    await chrome.storage.local.set({ lastSyncAt: Date.now(), lastReason: reason, lastError: '' });
    return { version: store.policyVersion };
  } catch (e) {
    await chrome.storage.local.set({ lastError: String(e.message || e).slice(0, 200), lastSyncAt: Date.now() });
    scheduleRetry();
    return { error: String(e.message || e) };
  }
}

let retryDelay = 5000;

function scheduleRetry() {
  chrome.alarms.create('mg-retry', { delayInMinutes: Math.min(5, retryDelay / 60000) });
  retryDelay = Math.min(60000, retryDelay * 2);
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM) { retryDelay = 5000; sync('alarm'); }
  if (a.name === 'mg-retry') sync('retry');
});

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.02 }); sync('installed'); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); sync('startup'); });

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'sync-now') {
    sync(msg.reason || 'content').then(r => respond(r)).catch(() => respond({ error: 'sync failed' }));
    return true;
  }
  if (msg.type === 'masked-count') {
    chrome.storage.local.get('pushedMasked').then(s => {
      chrome.storage.local.set({ pushedMasked: Number(s.pushedMasked || 0) + (msg.count || 0) });
    });
    return;
  }
  if (msg.type === 'get-status') {
    chrome.storage.local.get(null).then(s => respond({
      pluginId: s.pluginId, policyVersion: s.policyVersion, lastSyncAt: s.lastSyncAt,
      lastError: s.lastError, rules: (s.rules || []).length
    }));
    return true;
  }
});

/* keep the alarm alive across worker restarts */
chrome.alarms.get(ALARM, a => { if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); });
sync('boot');
