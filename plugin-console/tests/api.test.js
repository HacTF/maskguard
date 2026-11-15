/* Control-plane API contract + security tests (no browser needed).
   node tests/api.test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server.js');
const { hmac, request, signedRequest } = require('../lib/proto.js');

let pass = 0;
const fails = [];
function ok(n) { pass++; console.log('  PASS  ' + n); }
function bad(n, d) { fails.push(n + ' :: ' + d); console.log('  FAIL  ' + n + ' :: ' + d); }
async function check(n, fn) {
  try { await fn(); ok(n); } catch (e) { bad(n, e.message); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-')), 'state.json');
  const srv = await start({ port: 0, offlineAfterMs: 400, dataFile, enrollToken: 'tkn' });
  // port 0 -> the real port is resolved by the OS; read it back from the server
  const port = srv.server.address().port;
  const base = 'http://127.0.0.1:' + port;
  console.log('server on', base);

  try {
    /* ---- enrollment ---- */
    await check('注册令牌错误被拒（403）', async () => {
      const r = await request(base, 'POST', '/api/plugin/enroll', { enrollToken: 'wrong', host: 'h1' });
      assert.strictEqual(r.status, 403, r.raw);
    });

    let cred = null;
    await check('注册成功并下发初始策略', async () => {
      const r = await request(base, 'POST', '/api/plugin/enroll', {
        enrollToken: 'tkn', deviceKey: 'dev-1', host: 'ws-01', label: 'ws-01',
        extVersion: '1.0.0', installType: 'development', mayDisable: true, enabled: true
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.ok(r.body.pluginId && r.body.secret, r.raw);
      assert.strictEqual(r.body.policy.version, 0);
      assert.ok(Array.isArray(r.body.policy.rules) && r.body.policy.rules.length > 0);
      cred = { id: r.body.pluginId, secret: r.body.secret };
    });

    await check('同一 deviceKey 重复注册幂等（不产生重复终端）', async () => {
      const r = await request(base, 'POST', '/api/plugin/enroll', {
        enrollToken: 'tkn', deviceKey: 'dev-1', host: 'ws-01', label: 'ws-01'
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.pluginId, cred.id, 'pluginId changed on re-enroll');
      const st = await (await request(base, 'GET', '/api/state')).body;
      assert.strictEqual(st.stats.total, 1, 'duplicate plugin rows: ' + st.stats.total);
    });

    /* ---- auth ---- */
    await check('无签名心跳被拒（401）', async () => {
      const r = await request(base, 'POST', '/api/plugin/heartbeat', { extVersion: '1.0.0' });
      assert.strictEqual(r.status, 401, r.raw);
    });

    await check('签名错误被拒（401）', async () => {
      const ts = Date.now();
      const body = JSON.stringify({ extVersion: '1.0.0' });
      const r = await request(base, 'POST', '/api/plugin/heartbeat', { extVersion: '1.0.0' }, {
        'x-plugin-id': cred.id, 'x-plugin-ts': String(ts), 'x-plugin-sign': hmac('wrong-secret', ts + '.' + body)
      });
      assert.strictEqual(r.status, 401, r.raw);
    });

    await check('时间戳过期被拒（防重放）', async () => {
      const ts = Date.now() - 10 * 60 * 1000;
      const body = JSON.stringify({ extVersion: '1.0.0' });
      const r = await request(base, 'POST', '/api/plugin/heartbeat', { extVersion: '1.0.0' }, {
        'x-plugin-id': cred.id, 'x-plugin-ts': String(ts), 'x-plugin-sign': hmac(cred.secret, ts + '.' + body)
      });
      assert.strictEqual(r.status, 401, r.raw);
    });

  /* ---- heartbeat / policy / ack ---- */
    await check('合法心跳返回期望策略版本', async () => {
      const r = await signedRequest(base, cred.id, cred.secret, 'POST', '/api/plugin/heartbeat', {
        extVersion: '1.0.0', appliedVersion: 0, masked: 5
      });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.body.desiredVersion, 0);
    });

    await check('拉取策略且签名可被插件验证', async () => {
      const r = await signedRequest(base, cred.id, cred.secret, 'GET', '/api/plugin/policy?v=-1');
      assert.strictEqual(r.status, 200, r.raw);
      const expect = hmac(cred.secret, r.body.version + '.' + JSON.stringify(r.body.rules));
      assert.strictEqual(r.body.sig, expect, 'signature mismatch');
    });

    await check('版本未变化时不重复下发（unchanged）', async () => {
      const r = await signedRequest(base, cred.id, cred.secret, 'GET', '/api/plugin/policy?v=0');
      assert.strictEqual(r.body.unchanged, true, r.raw);
    });

    await check('发布策略后版本递增、终端出现待同步', async () => {
      const rules = [{ id: 'r1', name: '邮箱', kind: 'regex', enabled: true, pattern: '[\\w.]+@[\\w.]+\\.\\w+', flags: 'g', maskType: 'label', label: '[邮箱已脱敏]' }];
      const pub = await request(base, 'POST', '/api/admin/policy', { rules, note: '加邮箱规则' });
      assert.strictEqual(pub.status, 200, pub.raw);
      assert.strictEqual(pub.body.version, 1);
      const st = (await request(base, 'GET', '/api/state')).body;
      assert.strictEqual(st.policy.version, 1);
      assert.strictEqual(st.plugins[0].drift, true, 'drift not detected: ' + JSON.stringify(st.plugins[0]));
      const hb = await signedRequest(base, cred.id, cred.secret, 'POST', '/api/plugin/heartbeat', {});
      assert.strictEqual(hb.body.desiredVersion, 1);
    });

    await check('ACK 成功后台账标记已应用且不再漂移', async () => {
      const r = await signedRequest(base, cred.id, cred.secret, 'POST', '/api/plugin/ack', { version: 1, ok: true });
      assert.strictEqual(r.status, 200, r.raw);
      const st = (await request(base, 'GET', '/api/state')).body;
      assert.strictEqual(st.plugins[0].appliedVersion, 1);
      assert.strictEqual(st.plugins[0].drift, false);
      assert.strictEqual(st.plugins[0].policyError, '');
    });

    await check('ACK 失败会带回错误原因', async () => {
      await request(base, 'POST', '/api/admin/policy', { rules: [{ id: 'x', name: 'x', kind: 'regex', enabled: true, pattern: '\\d+', flags: 'g', maskType: 'full' }], note: 'v2' });
      await signedRequest(base, cred.id, cred.secret, 'POST', '/api/plugin/ack', { version: 2, ok: false, error: '正则编译失败' });
      const st = (await request(base, 'GET', '/api/state')).body;
      assert.strictEqual(st.plugins[0].policyError, '正则编译失败', JSON.stringify(st.plugins[0]));
      assert.strictEqual(st.stats.drift, 1);
    });

    await check('回滚以新版本号下发旧策略', async () => {
      const r = await request(base, 'POST', '/api/admin/rollback', {});
      assert.strictEqual(r.status, 200, r.raw);
      const st = (await request(base, 'GET', '/api/state')).body;
      assert.strictEqual(st.policy.version, r.body.version);
      assert.strictEqual(st.policy.rules[0].id, 'r1', 'rolled-back rules wrong: ' + JSON.stringify(st.policy.rules));
    });

    /* ---- coverage ---- */
    await check('资产台账差集算出未安装主机', async () => {
      await request(base, 'POST', '/api/admin/assets', { assets: [{ host: 'ws-01' }, { host: 'ws-02' }, { host: 'ws-03' }] });
      const st = (await request(base, 'GET', '/api/state')).body;
      assert.strictEqual(st.coverage.expected, 3);
      assert.deepStrictEqual(st.coverage.missing.map(m => m.host).sort(), ['ws-02', 'ws-03']);
      assert.strictEqual(st.stats.missing, 2);
    });

    /* ---- liveness ---- */
    await check('心跳超时后判定离线', async () => {
      await sleep(700);
      const st = (await request(base, 'GET', '/api/state')).body;
      assert.strictEqual(st.plugins[0].online, false, 'still online after TTL');
      assert.strictEqual(st.stats.online, 0);
    });

    await check('重新心跳后恢复在线', async () => {
      await signedRequest(base, cred.id, cred.secret, 'POST', '/api/plugin/heartbeat', {});
      const st = (await request(base, 'GET', '/api/state')).body;
      assert.strictEqual(st.plugins[0].online, true);
    });

    /* ---- admin guard ---- */
    await check('管理接口在配置令牌后拒绝无令牌请求', async () => {
      const s2 = await start({ port: 0, adminToken: 'adm', dataFile: path.join(path.dirname(dataFile), 's2.json') });
      const base2 = 'http://127.0.0.1:' + s2.server.address().port;
      const r = await request(base2, 'POST', '/api/admin/policy', { rules: [{ id: 'a' }] });
      assert.strictEqual(r.status, 401, r.raw);
      const ok2 = await request(base2, 'POST', '/api/admin/policy', { rules: [{ id: 'a' }] }, { 'x-admin-token': 'adm' });
      assert.strictEqual(ok2.status, 200, ok2.raw);
      await s2.close();
    });

  } finally {
    await srv.close();
  }

  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();
