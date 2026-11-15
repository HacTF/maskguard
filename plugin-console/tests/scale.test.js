/* Capacity check: how many managed plugins can one small console handle?
   Simulates N plugins doing enroll -> heartbeat -> policy pull with real signatures.
   node tests/scale.test.js        (SCALE_N=5000 to push harder) */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server.js');
const { request, signedRequest } = require('../lib/proto.js');

const N = Number(process.env.SCALE_N || 1000);
const CONC = Number(process.env.SCALE_CONC || 80);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;

async function runPool(items, conc, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-scale-'));
  const srv = await start({ port: 0, enrollToken: 'scale', offlineAfterMs: 120000, dataFile: path.join(dataDir, 'state.json') });
  const base = 'http://127.0.0.1:' + srv.port;
  const rss0 = process.memoryUsage().rss;
  console.log('console:', base, '| plugins:', N, '| concurrency:', CONC);

  const creds = new Array(N);
  const idx = Array.from({ length: N }, (_, i) => i);

  try {
    /* ---- enroll ---- */
    const t0 = Date.now();
    await runPool(idx, CONC, async i => {
      const r = await request(base, 'POST', '/api/plugin/enroll', {
        enrollToken: 'scale', deviceKey: 'sim-' + i, host: 'host-' + i, label: 'host-' + i,
        extVersion: '1.0.0', installType: 'admin', mayDisable: false, enabled: true
      });
      if (r.status !== 200) throw new Error('enroll ' + i + ' -> ' + r.status);
      creds[i] = { id: r.body.pluginId, secret: r.body.secret };
    });
    const enrollMs = Date.now() - t0;

    /* ---- heartbeat round ---- */
    const lat = [];
    const t1 = Date.now();
    await runPool(idx, CONC, async i => {
      const s = Date.now();
      const r = await signedRequest(base, creds[i].id, creds[i].secret, 'POST', '/api/plugin/heartbeat', {
        extVersion: '1.0.0', appliedVersion: 0, masked: 3
      });
      if (r.status !== 200) throw new Error('hb ' + i + ' -> ' + r.status);
      lat.push(Date.now() - s);
    });
    const hbMs = Date.now() - t1;
    lat.sort((a, b) => a - b);

    /* ---- policy pull + ack ---- */
    const pub = await request(base, 'POST', '/api/admin/policy', {
      rules: [{ id: 'phone', name: '手机号', kind: 'regex', enabled: true, pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', flags: 'g', maskType: 'partial', maskChar: '*', keepStart: 3, keepEnd: 4 }],
      note: 'scale 下发'
    });
    const t2 = Date.now();
    const lat2 = [];
    await runPool(idx, CONC, async i => {
      const s = Date.now();
      const p = await signedRequest(base, creds[i].id, creds[i].secret, 'GET', '/api/plugin/policy?v=0');
      if (p.status !== 200 || !p.body.rules) throw new Error('policy ' + i + ' -> ' + p.status);
      await signedRequest(base, creds[i].id, creds[i].secret, 'POST', '/api/plugin/ack', { version: pub.body.version, ok: true });
      lat2.push(Date.now() - s);
    });
    const syncMs = Date.now() - t2;
    lat2.sort((a, b) => a - b);

    const state = srv.state();
    const rssMb = Math.round((process.memoryUsage().rss - rss0) / 1048576);

    console.log('\n  enroll   : ' + enrollMs + 'ms  (' + Math.round(N / (enrollMs / 1000)) + ' req/s)');
    console.log('  heartbeat: ' + hbMs + 'ms  (' + Math.round(N / (hbMs / 1000)) + ' req/s, p50 ' + pct(lat, 0.5) + 'ms, p95 ' + pct(lat, 0.95) + 'ms)');
    console.log('  pull+ack : ' + syncMs + 'ms  (' + Math.round(N * 2 / (syncMs / 1000)) + ' req/s, p50 ' + pct(lat2, 0.5) + 'ms, p95 ' + pct(lat2, 0.95) + 'ms)');
    console.log('  state    : plugins=' + state.stats.total + ' online=' + state.stats.online +
      ' managed=' + state.stats.managed + ' drift=' + state.stats.drift + ' | rss +' + rssMb + 'MB');
    console.log('  30s 稳态心跳负载 ≈ ' + Math.round(N / 30) + ' req/s');

    const fail = [];
    if (state.stats.total !== N) fail.push('plugin count ' + state.stats.total + ' != ' + N);
    if (state.stats.managed !== N) fail.push('managed flag lost: ' + state.stats.managed);
    if (state.stats.drift !== 0) fail.push('drift after ack: ' + state.stats.drift);
    if (pct(lat, 0.95) > 200) fail.push('heartbeat p95 ' + pct(lat, 0.95) + 'ms');
    if (fail.length) { console.log('\n  FAILED: ' + fail.join('; ')); process.exitCode = 1; }
    else console.log('\n  PASSED: ' + N + ' 个插件全链路一致，无漏注册/漏 ACK');
  } finally {
    await srv.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})();
