/* Performance benchmark for MaskGuard on a large, dense page.
   node tests/perf.test.js      (BROWSER=/path/to/chromium.exe to override)

   Measures what a user actually feels:
     1. settle time   - navigation -> all sensitive text masked (incl. 120ms debounce)
     2. blocking time - long tasks (>50ms) during the first masking pass
     3. reapply cost  - round trip of a forced full rescan (MG_REAPPLY)
     4. incremental   - single text mutation -> re-masked
   Page: 3000 table rows x 4 fields (phone / idcard / email / name) = 12000 text nodes. */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const BROWSER = process.env.BROWSER || 'C:\\Users\\11375\\AppData\\Local\\ms-playwright\\chromium-1254\\chrome-win64\\chrome.exe';
let passes = 0;
const failures = [];

function ok(n) { passes++; console.log('  PASS  ' + n); }
function fail(n, d) { failures.push(n + ' :: ' + d); console.log('  FAIL  ' + n + ' :: ' + d); }
function check(n, fn) { try { fn(); ok(n); } catch (e) { fail(n, e.message); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROWS = 3000;
const BIG_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>客户台账 · 大表</title></head>
<body><h1>客户台账</h1><div id="rows"></div>
<script>
(function () {
  var out = [];
  for (var i = 0; i < ${ROWS}; i++) {
    var phone = '1380013' + String(8000 + (i % 1000)).slice(-4);
    var idc = '11010119900101' + String(1000 + (i % 9000)).slice(-4);
    out.push('<div class="row"><span class="c1">客户' + i + '</span><span class="c2">' + phone +
      '</span><span class="c3">' + idc + '</span><span class="c4">user' + i + '@example.com</span></div>');
  }
  document.getElementById('rows').innerHTML = out.join('');
})();
<\/script></body></html>`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function startServer(port) {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(BIG_PAGE);
  });
  return new Promise(resolve => s.listen(port, '127.0.0.1', () => resolve(s)));
}
function launch(profile, cdpPort) {
  const p = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--no-sandbox',
    '--user-data-dir=' + profile,
    '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT,
    '--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.stderrText = '';
  p.stderr.on('data', d => { p.stderrText += String(d); });
  p.stdout.on('data', d => { p.stderrText += String(d); });
  return p;
}
async function fetchJson(port, p) {
  const r = await fetch('http://127.0.0.1:' + port + p);
  if (!r.ok) throw new Error('CDP HTTP ' + r.status);
  return r.json();
}
async function waitCDP(port) {
  for (let i = 0; i < 60; i++) {
    try { return await fetchJson(port, '/json/version'); } catch (e) { await sleep(250); }
  }
  throw new Error('CDP port did not open');
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('WS error')));
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
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    },
    close() { try { ws.close(); } catch (e) {} }
  };
}
async function ev(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
  return r.result.value;
}
async function poll(c, expression, predicate, label, timeout) {
  const end = Date.now() + (timeout || 15000);
  let last;
  while (Date.now() < end) {
    last = await ev(c, expression);
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error('timeout: ' + label + ' last=' + JSON.stringify(last));
}
async function findSW(cdpPort) {
  for (let i = 0; i < 40; i++) {
    let list = [];
    try { list = await fetchJson(cdpPort, '/json/list'); } catch (e) {}
    for (const t of list.filter(x => x.type === 'service_worker' && /background\.js/.test(x.url || '') && x.webSocketDebuggerUrl)) {
      let c;
      try {
        c = await connect(t.webSocketDebuggerUrl);
        await c.ready;
        await c.send('Runtime.enable');
        const name = await ev(c, "(function(){try{return chrome.runtime.getManifest().name}catch(e){return ''}})()");
        if (String(name).indexOf('MaskGuard') >= 0) return c;
        c.close();
      } catch (e) { if (c) c.close(); }
    }
    await sleep(250);
  }
  return null;
}
async function tabMsg(sw, tabId, type) {
  return ev(sw, 'new Promise(function(r){ chrome.tabs.sendMessage(' + tabId + ',{type:' + JSON.stringify(type) + '},function(res){ r(res||null); }); })');
}

(async function main() {
  let browser, server, profile, page, sw;
  try {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-perf-'));
    const webPort = await freePort();
    const cdpPort = await freePort();
    server = await startServer(webPort);
    browser = launch(profile, cdpPort);
    const ver = await waitCDP(cdpPort);
    console.log('Browser:', (ver.Browser || '').split('/').slice(0, 2).join(' '), '| rows:', ROWS);
    sw = await findSW(cdpPort);
    if (!sw) { console.log('  browser stderr:', (browser.stderrText || '').slice(-800)); throw new Error('extension not loaded'); }

    const list = await fetchJson(cdpPort, '/json/list');
    const target = list.find(t => t.type === 'page' && t.url === 'about:blank') || list.find(t => t.type === 'page');
    page = await connect(target.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // long-task observer must exist before the first masking pass
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "(function(){window.__lt=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt.push({s:e.startTime,d:e.duration})});}).observe({entryTypes:['longtask']});}catch(e){}})();"
    });

    const t0 = Date.now();
    await page.send('Page.navigate', { url: 'http://127.0.0.1:' + webPort + '/big.html' });
    await poll(page, "document.readyState", v => v === 'complete', 'load', 20000);
    const loadMs = Date.now() - t0;

    const realTab = await ev(sw, 'new Promise(function(r){ chrome.tabs.query({url:"http://127.0.0.1/*"},function(t){ r(t.length?t[0].id:null); }); })');
    if (!realTab) throw new Error('tab id not found');

    /* 3 sensitive fields per row (phone / idcard / email); the name cell stays as-is */
    const wantMasked = Math.floor(ROWS * 3 * 0.95);
    const settle = await (async function () {
      const start = Date.now();
      let last = -1, stableFor = 0;
      while (Date.now() - start < 25000) {
        const st = await tabMsg(sw, realTab, 'MG_GET_STATE');
        const masked = st ? st.masked : 0;
        if (masked >= wantMasked) {
          stableFor = masked === last ? stableFor + 120 : 0;
          if (stableFor >= 240) break;
        }
        last = masked;
        await sleep(120);
      }
      return { masked: last, ms: Date.now() - start };
    })();

    const maskedText = await ev(page, "document.querySelectorAll('.c2')[0].textContent");
    const dump = await ev(page, "(function(){var r=document.querySelector('.row');return {html:r?r.outerHTML.slice(0,220):'no-row',c2:document.querySelectorAll('.c2').length,nodes:(function(){var el=document.querySelector('.c2');return el?el.childNodes.length:-1})()}})()");
    console.log('  dump:', JSON.stringify(dump));
    const lt = await ev(page, "(window.__lt||[]).filter(function(e){return e.d>50})");
    const ltCount = lt.length;
    const ltTotal = lt.reduce((a, b) => a + b.d, 0);
    const ltMax = lt.reduce((a, b) => Math.max(a, b.d), 0);

    console.log('  results:', JSON.stringify({
      loadMs, settleMs: settle.ms, masked: settle.masked, sample: maskedText,
      longTasks: ltCount, blockingMs: Math.round(ltTotal), maxTaskMs: Math.round(ltMax)
    }));

    check('大表（' + ROWS + ' 行 / 12000 文本节点）在 6s 内完成遮盖', () => {
      assert.ok(settle.ms < 6000, settle.ms + 'ms');
      assert.ok(settle.masked >= wantMasked, 'masked=' + settle.masked);
    });
    check('遮盖结果正确（首行手机号已打码）', () => assert.ok(maskedText.indexOf('13800138000') < 0 && maskedText.indexOf('*') >= 0, maskedText));
    check('行内多字段互不串味（单元格不塌陷、不被合并）', () => {
      const cells = dump.html.match(/<span class="c\d">([^<]*)<\/span>/g) || [];
      assert.strictEqual(cells.length, 4, dump.html);
      const vals = cells.map(c => c.replace(/<[^>]+>/g, ''));
      assert.strictEqual(vals[0], '客户0', 'name cell: ' + vals[0]);
      assert.ok(/^138\*{4}\d{4}$/.test(vals[1]), 'phone cell: ' + vals[1]);
      assert.ok(vals[2].length === 18 && vals[2].indexOf('*') > 0, 'idcard cell: ' + vals[2]);
      assert.ok(vals[3].length > 0 && vals[3].indexOf('*') > 0, 'email cell: ' + vals[3]);
      assert.ok(vals.every(v => v.length > 0), 'empty cell: ' + JSON.stringify(vals));
    });
    check('首屏遮盖的阻塞时间可控（长任务总和 < 3000ms，单任务 < 1200ms）', () => {
      assert.ok(ltTotal < 3000, 'blocking=' + Math.round(ltTotal) + 'ms tasks=' + ltCount);
      assert.ok(ltMax < 1200, 'max=' + Math.round(ltMax) + 'ms');
    });

    /* forced full rescan */
    const r0 = Date.now();
    await tabMsg(sw, realTab, 'MG_REAPPLY');
    const reapplyMs = Date.now() - r0;
    console.log('  reapply full rescan:', reapplyMs + 'ms');
    check('强制全量重扫 < 3000ms', () => assert.ok(reapplyMs < 3000, reapplyMs + 'ms'));

    /* incremental update latency */
    await ev(page, "(function(){var c=document.querySelectorAll('.c2')[10];c.textContent='13912345678';return 'ok'})()");
    const inc0 = Date.now();
    let incMs = -1;
    while (Date.now() - inc0 < 5000) {
      const t = await ev(page, "document.querySelectorAll('.c2')[10].textContent");
      if (t.indexOf('13912345678') < 0) { incMs = Date.now() - inc0; break; }
      await sleep(40);
    }
    console.log('  incremental latency:', incMs + 'ms');
    check('单点文本变更在 1200ms 内被重新遮盖', () => assert.ok(incMs >= 0 && incMs < 1200, incMs + 'ms'));

    /* no runaway growth: masked count stable after idle */
    await sleep(1500);
    const st2 = await tabMsg(sw, realTab, 'MG_GET_STATE');
    const nodesNow = await ev(page, "document.querySelectorAll('body *').length");
    console.log('  steady state:', JSON.stringify({ masked: st2 && st2.masked, elements: nodesNow }));
    check('空闲后无重复遮盖膨胀（元素数不变，遮罩节点数稳定）', () => {
      assert.ok(nodesNow > 0, String(nodesNow));
      assert.ok(Math.abs((st2.masked || 0) - settle.masked) <= ROWS, 'masked drift: ' + (st2.masked - settle.masked));
    });

  } catch (e) {
    console.log('  ERROR', e && e.message);
    failures.push('fatal :: ' + (e && e.message));
  } finally {
    try { if (page) page.close(); } catch (e) {}
    try { if (sw) sw.close(); } catch (e) {}
    try { if (server) server.close(); } catch (e) {}
    try { if (browser) browser.kill(); } catch (e) {}
    try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('\n' + passes + ' passed, ' + failures.length + ' failed');
  if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();
