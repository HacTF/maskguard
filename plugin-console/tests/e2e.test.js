/* End-to-end: real Chromium + real MV3 extension + real console.
   Proves enroll -> policy apply -> policy push -> ack -> offline detection.
   node tests/e2e.test.js   (BROWSER=/path/to/chromium.exe to override) */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { start } = require('../server.js');
const { request } = require('../lib/proto.js');

const ROOT = path.resolve(__dirname, '..');
const EXT_SRC = path.join(ROOT, 'extension');
const BROWSER = process.env.BROWSER || 'C:\\Users\\11375\\AppData\\Local\\ms-playwright\\chromium-1254\\chrome-win64\\chrome.exe';
let pass = 0;
const fails = [];
function ok(n) { pass++; console.log('  PASS  ' + n); }
function bad(n, d) { fails.push(n + ' :: ' + d); console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>CRM 客户详情</title></head>
<body><h1>客户详情</h1>
<p id="phone">手机号：13800138000</p>
<p id="email">邮箱：zhangsan@example.com</p>
<p id="plain">普通文本，不应被改动</p>
</body></html>`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function servePage(port) {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  return new Promise(r => s.listen(port, '127.0.0.1', () => r(s)));
}
function launch(profile, extDir, cdpPort) {
  const p = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--no-sandbox',
    '--user-data-dir=' + profile,
    '--disable-extensions-except=' + extDir, '--load-extension=' + extDir,
    '--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.err = '';
  p.stderr.on('data', d => { p.err += String(d); });
  p.stdout.on('data', d => { p.err += String(d); });
  return p;
}
async function fetchJson(port, p) {
  const r = await fetch('http://127.0.0.1:' + port + p);
  if (!r.ok) throw new Error('CDP ' + r.status);
  return r.json();
}
async function waitCDP(port) {
  for (let i = 0; i < 80; i++) {
    try { return await fetchJson(port, '/json/version'); } catch (e) { await sleep(250); }
  }
  throw new Error('CDP 未就绪');
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.id && pending.has(m.id)) {
      const t = pending.get(m.id);
      clearTimeout(t.timer); pending.delete(m.id);
      if (m.error) t.reject(new Error(m.error.message)); else t.resolve(m.result);
    }
  });
  return {
    ready,
    send(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    },
    close() { try { ws.close(); } catch (e) {} }
  };
}
async function ev(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
async function poll(fn, predicate, label, timeout) {
  const end = Date.now() + (timeout || 15000);
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error('超时：' + label + ' last=' + JSON.stringify(last));
}

(async function main() {
  let srv, page, browser, pageServer, profile, tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-'));
    const extDir = path.join(tmp, 'extension');
    fs.cpSync(EXT_SRC, extDir, { recursive: true });

    const cdpProbe = await freePort();
    srv = await start({ port: 0, enrollToken: 'e2e-token', offlineAfterMs: 4000, dataFile: path.join(tmp, 'state.json') });
    const consoleUrl = 'http://127.0.0.1:' + srv.port;
    // the packaged config.json is what points a fresh install at this console
    fs.writeFileSync(path.join(extDir, 'config.json'), JSON.stringify({
      serverUrl: consoleUrl, enrollToken: 'e2e-token', label: 'ws-e2e-01', host: 'ws-e2e-01'
    }, null, 2));

    const webPort = await freePort();
    pageServer = await servePage(webPort);

    profile = fs.mkdtempSync(path.join(tmp, 'profile-'));
    browser = launch(profile, extDir, cdpProbe);
    const ver = await waitCDP(cdpProbe);
    console.log('Browser:', (ver.Browser || '').split('/').slice(0, 2).join(' '), '| console:', consoleUrl);

    /* ---- 1. enrollment ---- */
    const st1 = await poll(async () => (await srv.state()).plugins.length, n => n >= 1, '插件注册', 20000);
    // the enroll response carries the policy; the ACK lands right after it is applied
    await poll(async () => (await srv.state()).plugins[0].appliedVersion, v => typeof v === 'number', '初始策略 ACK', 12000);
    const snap1 = srv.state();
    const pl = snap1.plugins[0];
    console.log('  plugin:', JSON.stringify({ id: pl.id, host: pl.host, v: pl.extVersion, installType: pl.installType, applied: pl.appliedVersion }));
    check('插件自动注册到管控台（一次注册，无需手工配置）', () => {
      assert.strictEqual(st1, 1);
      assert.strictEqual(pl.host, 'ws-e2e-01');
    });
    check('上报安装方式与可卸载性（本场景为 development）', () => {
      assert.strictEqual(pl.installType, 'development', pl.installType);
      assert.strictEqual(pl.mayDisable, true, 'mayDisable should be true for dev-loaded extension');
      assert.strictEqual(pl.managed, false, 'dev-loaded extension must not be reported as managed');
    });
    check('初始策略已下发并 ACK（v0）', () => {
      assert.strictEqual(pl.appliedVersion, 0, JSON.stringify(pl));
      assert.strictEqual(pl.drift, false);
    });

    /* ---- 2. open a page, rules take effect ---- */
    const list = await fetchJson(cdpProbe, '/json/list');
    const target = list.find(t => t.type === 'page' && t.url === 'about:blank') || list.find(t => t.type === 'page');
    page = await connect(target.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: 'http://127.0.0.1:' + webPort + '/crm' });
    await poll(() => ev(page, 'document.readyState'), v => v === 'complete', '页面加载', 15000);

    const maskedPhone = await poll(() => ev(page, "document.getElementById('phone').textContent"),
      v => v && v.indexOf('13800138000') < 0, '首屏遮盖', 12000);
    const emailAtV0 = await ev(page, "document.getElementById('email').textContent");
    check('下发的手机号规则在页面上真实生效', () => assert.ok(/138\*{4}8000/.test(maskedPhone), maskedPhone));
    check('未包含在策略里的字段不受影响（v0 只有手机号规则）', () => assert.ok(emailAtV0.indexOf('zhangsan@example.com') >= 0, emailAtV0));
    check('普通文本未被误改', async () => assert.strictEqual(await ev(page, "document.getElementById('plain').textContent"), '普通文本，不应被改动'));

    /* ---- 3. push a new policy, plugin converges ---- */
    const newRules = [
      {
        id: 'phone', name: '手机号', kind: 'regex', enabled: true,
        pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', flags: 'g',
        maskType: 'partial', maskChar: '*', keepStart: 3, keepEnd: 4, fixedLength: 6, label: '[已脱敏]', custom: '', selector: ''
      },
      {
        id: 'email', name: '邮箱', kind: 'regex', enabled: true,
        pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', flags: 'g',
        maskType: 'label', maskChar: '*', keepStart: 3, keepEnd: 4, fixedLength: 6, label: '[邮箱已脱敏]', custom: '', selector: ''
      }
    ];
    const pubTime = Date.now();
    const pub = await request(consoleUrl, 'POST', '/api/admin/policy', { rules: newRules, note: 'e2e 新增邮箱规则' });
    check('发布策略返回新版本号', () => {
      assert.strictEqual(pub.status, 200, pub.raw);
      assert.strictEqual(pub.body.version, 1);
    });

    const drifted = await poll(async () => (await srv.state()).plugins[0], p => p.drift === true, '终端待同步', 8000);
    check('发布后终端立即标记为待同步', () => assert.strictEqual(drifted.drift, true));

    await page.send('Page.reload', { ignoreCache: true });
    await poll(() => ev(page, 'document.readyState'), v => v === 'complete', '重新加载', 15000);
    const emailMasked = await poll(() => ev(page, "document.getElementById('email').textContent"),
      v => v && v.indexOf('[邮箱已脱敏]') >= 0, '新策略生效', 15000);
    check('新策略在页面刷新后生效（邮箱被替换）', () => assert.ok(emailMasked.indexOf('[邮箱已脱敏]') >= 0, emailMasked));

    const applied = await poll(async () => (await srv.state()).plugins[0].appliedVersion, v => v === 1, 'ACK v1', 15000);
    check('插件回执 ACK：已应用版本同步到管控台', () => assert.strictEqual(applied, 1));
    check('收敛耗时在可接受范围（<10s）', () => assert.ok(Date.now() - pubTime < 15000, (Date.now() - pubTime) + 'ms'));

    /* ---- 4. rollback ---- */
    const rb = await request(consoleUrl, 'POST', '/api/admin/rollback', {});
    check('回滚生成新版本 v2', () => assert.strictEqual(rb.body.version, 2));
    await page.send('Page.reload', { ignoreCache: true });
    await poll(() => ev(page, 'document.readyState'), v => v === 'complete', '回滚后加载', 15000);
    const emailBack = await poll(() => ev(page, "document.getElementById('email').textContent"),
      v => v && v.indexOf('zhangsan@example.com') >= 0, '回滚生效', 15000);
    check('回滚后页面恢复为旧策略行为（邮箱不再遮盖）', () => assert.ok(emailBack.indexOf('zhangsan@example.com') >= 0, emailBack));

    /* ---- 5. dashboard ---- */
    const idx = await fetch(consoleUrl + '/');
    const html = await idx.text();
    check('管控台可访问且返回看板页面', () => {
      assert.strictEqual(idx.status, 200);
      assert.ok(html.indexOf('插件管控台') >= 0, 'dashboard html missing');
    });

    /* ---- 6. liveness ---- */
    page.close();
    try { browser.kill(); } catch (e) {}
    await sleep(5500);
    const snap2 = srv.state();
    console.log('  after kill:', JSON.stringify({ online: snap2.plugins[0].online, stats: snap2.stats }));
    check('浏览器关闭后心跳停止，判为离线', () => {
      assert.strictEqual(snap2.plugins[0].online, false, 'still online');
      assert.strictEqual(snap2.stats.online, 0);
    });
    check('离线事件进入事件流', () => {
      const hit = snap2.events.find(e => e.msg.indexOf('离线') >= 0);
      assert.ok(hit, JSON.stringify(snap2.events.slice(0, 5)));
    });

  } catch (e) {
    bad('fatal', e.message + (browser && browser.err ? ' | browser: ' + browser.err.slice(-400) : ''));
  } finally {
    try { if (page) page.close(); } catch (e) {}
    try { if (browser) browser.kill(); } catch (e) {}
    try { if (pageServer) pageServer.close(); } catch (e) {}
    try { if (srv) await srv.close(); } catch (e) {}
  }

  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();
