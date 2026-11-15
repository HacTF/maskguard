/* Managed browser-plugin console (feasibility PoC).
   - plugins enroll once, then sign every call with an HMAC over ts + body
   - server keeps a versioned desired policy and each plugin's applied version
   - dashboard reads state, publishes / rolls back policy
   No dependencies; state persisted to a JSON file. One instance per process start(). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hmac } = require('./lib/proto.js');

const DEFAULTS = {
  port: Number(process.env.PORT || 8787),
  enrollToken: process.env.ENROLL_TOKEN || 'demo-enroll-token',
  offlineAfterMs: Number(process.env.OFFLINE_AFTER_MS || 15000),
  hmacWindowMs: Number(process.env.HMAC_WINDOW_MS || 5 * 60 * 1000),
  adminToken: process.env.ADMIN_TOKEN || '',
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json'),
  maxBody: 256 * 1024,
  eventLimit: 200
};

const DEFAULT_RULES = [{
  id: 'phone', name: '手机号', kind: 'regex', enabled: true,
  pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', flags: 'g',
  maskType: 'partial', maskChar: '*', keepStart: 3, keepEnd: 4,
  fixedLength: 6, label: '[已脱敏]', custom: '', selector: ''
}];

function emptyState() {
  return {
    policyVersion: 0,
    policy: { version: 0, rules: DEFAULT_RULES, note: '初始策略', updatedAt: Date.now() },
    history: [],
    plugins: {},
    assets: [],
    events: []
  };
}

function createConsole(overrides) {
  const cfg = Object.assign({}, DEFAULTS, overrides || {});
  let state = emptyState();
  let saveTimer = null;
  const clients = new Set();

  /* ---------- persistence ---------- */

  function loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8'));
      state = Object.assign(emptyState(), parsed);
      if (!Array.isArray(state.history)) state.history = [];
      if (!Array.isArray(state.events)) state.events = [];
      if (!Array.isArray(state.assets)) state.assets = [];
    } catch (e) {
      state = emptyState();
    }
  }

  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(cfg.dataFile), { recursive: true });
        const tmp = cfg.dataFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, cfg.dataFile);
      } catch (e) {
        console.error('[state] save failed:', e.message);
      }
    }, 120);
    if (saveTimer.unref) saveTimer.unref();
  }

  function logEvent(level, msg, extra) {
    const ev = Object.assign({ ts: Date.now(), level, msg }, extra || {});
    state.events.unshift(ev);
    if (state.events.length > cfg.eventLimit) state.events.length = cfg.eventLimit;
    broadcast({ type: 'event', event: ev });
    saveState();
  }

  /* ---------- push to dashboard ---------- */

  function broadcast(payload) {
    const frame = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const res of clients) {
      try { res.write(frame); } catch (e) { clients.delete(res); }
    }
  }

  /* ---------- helpers ---------- */

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,x-plugin-id,x-plugin-ts,x-plugin-sign,x-admin-token',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > cfg.maxBody) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function policySig(secret, version, rules) {
    return hmac(secret, version + '.' + JSON.stringify(rules));
  }

  function verifyPlugin(req, rawBody) {
    const id = req.headers['x-plugin-id'];
    const ts = Number(req.headers['x-plugin-ts']);
    const sign = String(req.headers['x-plugin-sign'] || '');
    const p = id && state.plugins[id];
    if (!p) return { error: 'unknown plugin' };
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > cfg.hmacWindowMs) return { error: 'stale timestamp' };
    const expect = hmac(p.secret, ts + '.' + (rawBody || ''));
    const a = Buffer.from(expect);
    const b = Buffer.from(sign);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'bad signature' };
    return { plugin: p };
  }

  function isOnline(p) {
    return !!p.lastSeen && Date.now() - p.lastSeen <= cfg.offlineAfterMs;
  }

  function publicPlugin(p) {
    return {
      id: p.id,
      label: p.label,
      host: p.host,
      os: p.os,
      browser: p.browser,
      extVersion: p.extVersion,
      installType: p.installType,
      managed: p.installType === 'admin' && p.mayDisable === false,
      mayDisable: p.mayDisable,
      enabled: p.enabled !== false,
      online: isOnline(p),
      lastSeen: p.lastSeen,
      appliedVersion: p.appliedVersion,
      drift: p.appliedVersion !== state.policyVersion,
      policyError: p.policyError || '',
      maskedTotal: p.maskedTotal || 0,
      syncCount: p.syncCount || 0
    };
  }

  function computeState() {
    const list = Object.keys(state.plugins).map(k => publicPlugin(state.plugins[k]));
    const registeredHosts = new Set(list.map(p => String(p.host || '').toLowerCase()));
    const missing = state.assets
      .filter(a => !registeredHosts.has(String(a.host || '').toLowerCase()))
      .map(a => ({ host: a.host, user: a.user || '', dept: a.dept || '' }));
    return {
      policy: { version: state.policy.version, rules: state.policy.rules, note: state.policy.note, updatedAt: state.policy.updatedAt },
      canRollback: state.history.length > 0,
      plugins: list.sort((a, b) => String(a.label).localeCompare(String(b.label))),
      events: state.events.slice(0, 60),
      assets: state.assets,
      stats: {
        total: list.length,
        online: list.filter(p => p.online).length,
        offline: list.filter(p => !p.online).length,
        disabled: list.filter(p => !p.enabled).length,
        drift: list.filter(p => p.online && p.drift).length,
        managed: list.filter(p => p.managed).length,
        unmanaged: list.filter(p => !p.managed).length,
        assets: state.assets.length,
        missing: missing.length
      },
      coverage: { expected: state.assets.length, registered: list.length, missing },
      serverTime: Date.now(),
      offlineAfterMs: cfg.offlineAfterMs
    };
  }

  /* ---------- routes ---------- */

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method === 'OPTIONS') return json(res, 204, {});

    if (p === '/api/plugin/enroll' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      if (body.enrollToken !== cfg.enrollToken) {
        logEvent('warn', '注册被拒：令牌无效（' + String(body.host || '?').slice(0, 40) + '）');
        return json(res, 403, { error: 'invalid enroll token' });
      }
      const deviceKey = String(body.deviceKey || (body.host + '|' + (body.label || ''))).slice(0, 120);
      let rec = Object.values(state.plugins).find(x => x.deviceKey === deviceKey);
      const isNew = !rec;
      if (!rec) {
        rec = { id: 'p_' + crypto.randomBytes(6).toString('hex'), secret: crypto.randomBytes(24).toString('hex'), deviceKey, firstSeen: Date.now() };
        state.plugins[rec.id] = rec;
      }
      Object.assign(rec, {
        label: String(body.label || body.host || '未命名终端').slice(0, 60),
        host: String(body.host || '').slice(0, 80),
        os: String(body.os || '').slice(0, 90),
        browser: String(body.browser || '').slice(0, 60),
        extVersion: String(body.extVersion || '').slice(0, 20),
        installType: String(body.installType || 'unknown').slice(0, 20),
        mayDisable: body.mayDisable !== false,
        enabled: body.enabled !== false,
        lastSeen: Date.now(),
        ip: (req.socket.remoteAddress || '').replace('::ffff:', '')
      });
      logEvent('info', (isNew ? '新插件注册：' : '插件重新注册：') + rec.label + '（' + rec.host + '）', { pluginId: rec.id });
      saveState();
      return json(res, 200, {
        pluginId: rec.id,
        secret: rec.secret,
        heartbeatSec: 30,
        policy: {
          version: state.policy.version,
          rules: state.policy.rules,
          sig: policySig(rec.secret, state.policy.version, state.policy.rules)
        }
      });
    }

    if (p === '/api/plugin/heartbeat' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const v = verifyPlugin(req, raw);
      if (v.error) return json(res, 401, { error: v.error });
      const rec = v.plugin;
      rec.lastSeen = Date.now();
      rec.syncCount = (rec.syncCount || 0) + 1;
      if (body.extVersion) rec.extVersion = String(body.extVersion).slice(0, 20);
      if (body.installType) rec.installType = String(body.installType).slice(0, 20);
      if (body.mayDisable !== undefined) rec.mayDisable = body.mayDisable !== false;
      if (body.enabled !== undefined) rec.enabled = body.enabled !== false;
      if (typeof body.masked === 'number') rec.maskedTotal = (rec.maskedTotal || 0) + body.masked;
      saveState();
      return json(res, 200, { ok: true, desiredVersion: state.policyVersion, offlineAfterMs: cfg.offlineAfterMs, serverTime: Date.now() });
    }

    if (p === '/api/plugin/policy' && req.method === 'GET') {
      const v = verifyPlugin(req, '');
      if (v.error) return json(res, 401, { error: v.error });
      v.plugin.lastSeen = Date.now();
      const have = Number(url.searchParams.get('v') === null ? -1 : url.searchParams.get('v'));
      if (have === state.policy.version) return json(res, 200, { unchanged: true, version: state.policy.version });
      return json(res, 200, {
        version: state.policy.version,
        rules: state.policy.rules,
        note: state.policy.note,
        sig: policySig(v.plugin.secret, state.policy.version, state.policy.rules)
      });
    }

    if (p === '/api/plugin/ack' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const v = verifyPlugin(req, raw);
      if (v.error) return json(res, 401, { error: v.error });
      const rec = v.plugin;
      rec.lastSeen = Date.now();
      if (body.ok) {
        rec.appliedVersion = Number(body.version);
        rec.policyError = '';
        rec.lastAckAt = Date.now();
        logEvent('info', rec.label + ' 已应用策略 v' + rec.appliedVersion);
      } else {
        rec.policyError = String(body.error || '应用失败').slice(0, 200);
        logEvent('error', rec.label + ' 应用策略失败：' + rec.policyError, { pluginId: rec.id });
      }
      saveState();
      return json(res, 200, { ok: true, desiredVersion: state.policyVersion });
    }

    if (p.startsWith('/api/admin/')) {
      if (cfg.adminToken && req.headers['x-admin-token'] !== cfg.adminToken) return json(res, 401, { error: 'admin token required' });

      if (p === '/api/admin/policy' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        const rules = Array.isArray(body.rules) ? body.rules : null;
        if (!rules || !rules.length) return json(res, 400, { error: 'rules required' });
        if (rules.length > 100) return json(res, 400, { error: 'too many rules' });
        state.history.push({ version: state.policy.version, rules: state.policy.rules, note: state.policy.note, updatedAt: state.policy.updatedAt });
        if (state.history.length > 20) state.history.shift();
        state.policyVersion += 1;
        state.policy = { version: state.policyVersion, rules, note: String(body.note || '').slice(0, 120), updatedAt: Date.now() };
        logEvent('info', '发布策略 v' + state.policyVersion + (body.note ? '：' + body.note : ''));
        broadcast({ type: 'state', state: computeState() });
        saveState();
        return json(res, 200, { ok: true, version: state.policyVersion });
      }

      if (p === '/api/admin/rollback' && req.method === 'POST') {
        const prev = state.history.pop();
        if (!prev) return json(res, 400, { error: 'nothing to roll back' });
        state.policyVersion += 1;
        state.policy = { version: state.policyVersion, rules: prev.rules, note: '回滚自 v' + prev.version, updatedAt: Date.now() };
        logEvent('warn', '回滚到 v' + prev.version + '（以新版本 v' + state.policyVersion + ' 下发）');
        broadcast({ type: 'state', state: computeState() });
        saveState();
        return json(res, 200, { ok: true, version: state.policyVersion });
      }

      if (p === '/api/admin/assets' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        state.assets = Array.isArray(body.assets) ? body.assets.slice(0, 5000).map(a => ({
          host: String(a.host || '').slice(0, 80),
          user: String(a.user || '').slice(0, 60),
          dept: String(a.dept || '').slice(0, 60)
        })) : [];
        logEvent('info', '资产台账已更新：' + state.assets.length + ' 台');
        broadcast({ type: 'state', state: computeState() });
        saveState();
        return json(res, 200, { ok: true, count: state.assets.length });
      }

      return json(res, 404, { error: 'not found' });
    }

    if (p === '/api/state') return json(res, 200, computeState());

    if (p === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'access-control-allow-origin': '*'
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify({ type: 'state', state: computeState() }) + '\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
      if (ping.unref) ping.unref();
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    const file = p === '/' ? '/index.html' : p;
    const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full);
      const type = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'application/javascript; charset=utf-8'
          : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(full));
    }

    json(res, 404, { error: 'not found' });
  }

  return {
    cfg,
    handle,
    snapshot: computeState,
    loadState,
    /* marks online->offline transitions once, used by the liveness timer and tests */
    sweep() {
      let changed = false;
      for (const id of Object.keys(state.plugins)) {
        const pl = state.plugins[id];
        const nowOnline = isOnline(pl);
        if (pl._online !== undefined && pl._online !== nowOnline) {
          changed = true;
          logEvent(nowOnline ? 'info' : 'warn', pl.label + (nowOnline ? ' 恢复在线' : ' 心跳超时，判定离线'), { pluginId: id });
        }
        pl._online = nowOnline;
      }
      return changed;
    }
  };
}

function start(overrides) {
  const api = createConsole(overrides);
  api.loadState();
  const server = http.createServer((req, res) => {
    api.handle(req, res).catch(e => {
      console.error('[http]', e.message);
      try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch (e2) {}
    });
  });
  return new Promise(resolve => {
    server.listen(api.cfg.port, '127.0.0.1', () => {
      const timer = setInterval(() => api.sweep(), 3000);
      if (timer.unref) timer.unref();
      resolve({
        server,
        port: server.address().port,
        cfg: api.cfg,
        state: api.snapshot,
        close: () => new Promise(r => { clearInterval(timer); server.close(() => r()); })
      });
    });
  });
}

module.exports = { start, createConsole };

if (require.main === module) {
  start().then(s => {
    console.log('插件管控台: http://127.0.0.1:' + s.port + '/');
    console.log('  注册令牌: ' + s.cfg.enrollToken + ' | 离线判定: ' + Math.round(s.cfg.offlineAfterMs / 1000) + 's');
  });
}
