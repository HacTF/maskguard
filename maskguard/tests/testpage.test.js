/* Real-browser verification of the "real-world rendering shapes" matrix.
   node tests/testpage.test.js   (BROWSER=/path/to/chromium.exe to override) */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Core = require('../masker.js');

const ROOT = path.resolve(__dirname, '..');
const PAGE_HTML = fs.readFileSync(path.join(ROOT, 'test-page.html'), 'utf8');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-config.json'), 'utf8'));
const BROWSER = process.env.BROWSER || 'C:\\Users\\11375\\AppData\\Local\\ms-playwright\\chromium-1254\\chrome-win64\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let passes = 0;
const failures = [];

function ok(name) { passes++; console.log('  PASS  ' + name); }
function fail(name, detail) { failures.push(name + ' :: ' + detail); console.log('  FAIL  ' + name + ' :: ' + detail); }
function check(name, fn) { try { fn(); ok(name); } catch (e) { fail(name, e.message); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function startServer(port) {
  const s = http.createServer((req, res) => {
    const u = String(req.url).split('?')[0];
    if (u === '/test-config.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(CFG));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE_HTML);
    }
  });
  return new Promise(resolve => s.listen(port, '127.0.0.1', () => resolve(s)));
}
function launch(profile, cdpPort) {
  const exe = fs.existsSync(BROWSER) ? BROWSER : EDGE;
  if (!fs.existsSync(exe)) throw new Error('no Chromium browser: ' + exe);
  const p = spawn(exe, [
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
function connect(wsUrl, events) {
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
    } else if (!m.id && events && m.method) events.push({ method: m.method, data: m.params });
  });
  return {
    ready,
    send(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    },
    close() { try { ws.close(); } catch (e) {} }
  };
}
async function ev(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
  return r.result.value;
}
async function poll(c, expression, predicate, label, timeout) {
  const end = Date.now() + (timeout || 8000);
  let last;
  while (Date.now() < end) {
    last = await ev(c, expression);
    if (predicate(last)) return last;
    await sleep(120);
  }
  throw new Error('timeout: ' + label + '; last=' + JSON.stringify(last));
}
async function findSW(cdpPort) {
  for (let i = 0; i < 40; i++) {
    let list = [];
    try { list = await fetchJson(cdpPort, '/json/list'); } catch (e) {}
    const cands = list.filter(t => t.type === 'service_worker' && /background\.js/.test(t.url || '') && t.webSocketDebuggerUrl);
    for (const t of cands) {
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
function setConfig(c, cfg) {
  return ev(c, 'new Promise(function(r){ chrome.storage.local.set({config:' + JSON.stringify(cfg) + '},function(){r("ok")}); })');
}

const READ = `({
  a12: document.querySelector('[data-shape="A12"] > div').textContent,
  a14: document.getElementById('wc-host').shadowRoot.textContent,
  a11: (function(){try{return document.getElementById('mail-frame').contentDocument.body.textContent}catch(e){return 'ERR'}})(),
  a13: document.querySelector('[data-shape="A13"] svg text').textContent,
  a09: document.querySelector('.textLayer span').textContent,
  a02: document.querySelector('.el-table__cell').textContent + '|' + document.querySelector('.clone-cell').textContent,
  a16: document.querySelector('[data-shape="A16"] template').content.textContent,
  b01: document.getElementById('b01-input').value,
  b02: document.getElementById('b02-input').getAttribute('placeholder'),
  b10: document.querySelector('[data-shape="B10"] [aria-label]').getAttribute('aria-label'),
  b04attr: document.getElementById('b04-canvas').hasAttribute('data-mg-blur'),
  log: document.querySelector('[data-shape="A05"] .log').textContent,
  a19: (function(){var r=document.getElementById('a19-row');if(!r)return 'no-row';
    return Array.prototype.map.call(r.children,function(c){return c.textContent}).join('|')})()
})`;

(async function main() {
  let browser, server, profile, page, sw, browserCdp;
  const pageEvents = [];
  try {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-shapes-'));
    const webPort = await freePort();
    const cdpPort = await freePort();
    server = await startServer(webPort);
    browser = launch(profile, cdpPort);
    const ver = await waitCDP(cdpPort);
    console.log('Browser:', (ver.Browser || '').split('/').slice(0, 2).join(' '));
    browserCdp = await connect(ver.webSocketDebuggerUrl);
    await browserCdp.ready;
    sw = await findSW(cdpPort);
    if (!sw) throw new Error('扩展未加载：未找到 MaskGuard service worker');

    const list = await fetchJson(cdpPort, '/json/list');
    const target = list.find(t => t.type === 'page' && t.url === 'about:blank') || list.find(t => t.type === 'page');
    page = await connect(target.webSocketDebuggerUrl, pageEvents);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.navigate', { url: 'http://127.0.0.1:' + webPort + '/test-page.html' });
    await poll(page, "document.readyState==='complete' && !!document.getElementById('st-fail') ? 'ready':'wait'", v => v === 'ready', 'page load', 10000);
    await sleep(1200);

    /* ---------- 1. structure ---------- */
    const structure = await ev(page, "({a:document.querySelectorAll('#a .shape').length,b:document.querySelectorAll('#b .shape').length,c:document.querySelectorAll('#c .shape').length,shapes:document.querySelectorAll('[data-shape]').length,basis:document.querySelectorAll('#basis tbody tr').length,title:document.title})");
    console.log('  structure:', JSON.stringify(structure));
    check('形态矩阵结构齐全（A 19 / B 10 / C 8，共 37 个探针）', () => {
      assert.strictEqual(structure.a, 19, JSON.stringify(structure));
      assert.strictEqual(structure.b, 10, JSON.stringify(structure));
      assert.strictEqual(structure.c, 8, JSON.stringify(structure));
      assert.strictEqual(structure.shapes, 37, JSON.stringify(structure));
      assert.ok(structure.basis >= 8, structure.basis);
    });

    const errors0 = pageEvents.filter(e => e.method === 'Runtime.exceptionThrown');
    check('页面脚本无未捕获异常', () => assert.strictEqual(errors0.length, 0, JSON.stringify(errors0).slice(0, 500)));

    /* ---------- 2. default configuration: zero deviation ---------- */
    let deviation;
    try { deviation = await poll(page, "document.getElementById('st-fail').textContent", v => v === '0', 'zero deviation', 7000); }
    catch (e) { deviation = await ev(page, "document.getElementById('st-fail').textContent + ' :: ' + document.getElementById('deviation-list').textContent"); }
    console.log('  self-check:', deviation);
    check('默认配置下 37 个形态的实测行为与标注预期一致（偏差 0）', () => assert.strictEqual(deviation, '0', String(deviation)));

    const s0 = await ev(page, READ);
    console.log('  probes:', JSON.stringify(s0));
    check('增强① 跨标签拆分：formatter 打散的手机号被拼接识别', () => assert.ok(s0.a12.indexOf('13800138000') < 0, s0.a12));
    check('增强② Shadow DOM：open root 内文本被遮盖', () => assert.ok(s0.a14.indexOf('13800138000') < 0, s0.a14));
    check('增强③ iframe srcdoc：子帧注入并遮盖邮件正文', () => assert.ok(s0.a11.indexOf('13800138000') < 0, s0.a11));
    check('SVG 图表标签默认跳过（不破坏图表）', () => assert.ok(s0.a13.indexOf('13800138000') >= 0, s0.a13));
    check('PDF.js 文本层 / 固定列克隆 / 日志均被遮盖', () => {
      assert.ok(s0.a09.indexOf('110101199001011234') < 0, s0.a09);
      assert.ok(s0.a02.indexOf('13912345678') < 0, s0.a02);
      assert.ok(s0.log.indexOf('13800138000') < 0, s0.log);
    });
    check('A19 同行多字段相邻：每格各自遮盖，不塌陷、不合并', () => {
      const cells = String(s0.a19).split('|');
      assert.strictEqual(cells.length, 4, s0.a19);
      assert.strictEqual(cells[0], '客户0', cells[0]);
      assert.ok(/^138\*{4}\d{4}$/.test(cells[1]), cells[1]);
      assert.ok(cells[2].length === 18 && cells[2].indexOf('*') > 0, cells[2]);
      assert.ok(cells[3].indexOf('*') > 0, cells[3]);
      assert.ok(cells.every(c => c.length > 0), s0.a19);
    });
    check('B 组：input.value / 属性 / template 保持原样（不破坏业务）', () => {
      assert.strictEqual(s0.b01, '13800138000', s0.b01);
      assert.ok(s0.b02.indexOf('13800138000') >= 0, s0.b02);
      assert.ok(s0.b10.indexOf('13800138000') >= 0, s0.b10);
      assert.ok(s0.a16.indexOf('13800138000') >= 0, s0.a16);
    });
    check('Canvas 默认不被模糊（无规则时不越界）', () => assert.strictEqual(s0.b04attr, false));

    /* ---------- 3. C 组时序形态 ---------- */
    await ev(page, "Array.prototype.forEach.call(document.querySelectorAll('[data-trigger]'),function(b){b.click()}); 'ok'");
    await sleep(3200);
    const dyn = await ev(page, "({fail:document.getElementById('st-fail').textContent,wait:document.getElementById('st-wait').textContent,list:document.getElementById('deviation-list').textContent.slice(0,300),verdicts:Array.prototype.map.call(document.querySelectorAll('#c .verdict'),function(v){return v.textContent})})");
    console.log('  dynamic:', JSON.stringify(dyn));
    check('C 组 8 种时序形态（AJAX / SPA / 框架重渲染 / 轮询 / 骨架屏 / 批量 / 无限滚动 / 嵌套）全部符合预期', () => {
      assert.strictEqual(dyn.wait, '0', JSON.stringify(dyn));
      assert.strictEqual(dyn.fail, '0', JSON.stringify(dyn));
      assert.strictEqual(dyn.verdicts.length, 8, JSON.stringify(dyn));
      assert.ok(dyn.verdicts.every(v => v === '符合预期'), JSON.stringify(dyn.verdicts));
    });

    /* ---------- 4. imported config (7 algorithms) ---------- */
    await setConfig(sw, CFG);
    await sleep(900);
    const alg = await ev(page, "({amount:document.querySelector('.tbl td:nth-child(4)').textContent,jwt:document.querySelector('[data-shape=\"A05\"] .log').textContent,json:document.querySelector('.json-str').textContent})");
    console.log('  algorithms:', JSON.stringify(alg));
    check('导入 test-config.json 后扩展算法生效（金额自定义替换 / JWT 标签替换）', () => {
      assert.ok(alg.amount.indexOf('[金额已脱敏]') >= 0, alg.amount);
      assert.ok(alg.jwt.indexOf('[Token 已脱敏]') >= 0, alg.jwt);
      assert.ok(alg.json.indexOf('6222021234567890123') < 0, alg.json);
    });

    /* ---------- 5. visual blur for canvas / images ---------- */
    const blurCfg = JSON.parse(JSON.stringify(CFG));
    blurCfg.rules.forEach(r => { if (r.id === 'test_blur_canvas' || r.id === 'test_blur_image') r.enabled = true; });
    await setConfig(sw, blurCfg);
    await sleep(800);
    const blurOn = await ev(page, "({canvas:document.getElementById('b04-canvas').hasAttribute('data-mg-blur'),chart:document.getElementById('b05-canvas').hasAttribute('data-mg-blur'),img:document.querySelector('.scan-img').hasAttribute('data-mg-blur'),radius:document.getElementById('b04-canvas').style.getPropertyValue('--mg-blur')})");
    console.log('  blur on:', JSON.stringify(blurOn));
    check('增强④ 视觉模糊位置规则遮盖 Canvas 表格 / 图表 / 扫描件', () => {
      assert.strictEqual(blurOn.canvas, true, JSON.stringify(blurOn));
      assert.strictEqual(blurOn.chart, true, JSON.stringify(blurOn));
      assert.strictEqual(blurOn.img, true, JSON.stringify(blurOn));
      assert.ok(/px/.test(blurOn.radius), blurOn.radius);
    });
    await setConfig(sw, CFG);
    await sleep(700);
    const blurOff = await ev(page, "document.getElementById('b04-canvas').hasAttribute('data-mg-blur')");
    check('停用视觉模糊规则后容器恢复清晰', () => assert.strictEqual(blurOff, false));

    /* ---------- 6. optional switches ---------- */
    const attrCfg = JSON.parse(JSON.stringify(CFG));
    attrCfg.settings.maskAttributes = true;
    attrCfg.settings.maskTitle = true;
    attrCfg.settings.maskSvgText = true;
    await setConfig(sw, attrCfg);
    await sleep(900);
    const switches = await ev(page, "({ph:document.getElementById('b02-input').getAttribute('placeholder'),aria:document.querySelector('[data-shape=\"B10\"] [aria-label]').getAttribute('aria-label'),svg:document.querySelector('[data-shape=\"A13\"] svg text').textContent,title:document.title})");
    console.log('  switches:', JSON.stringify(switches));
    check('增强⑤ 展示类属性遮盖（placeholder / aria-label）可按需开启', () => {
      assert.ok(switches.ph.indexOf('13800138000') < 0, switches.ph);
      assert.ok(switches.aria.indexOf('13800138000') < 0, switches.aria);
    });
    check('增强⑥ SVG 文字开关开启后图表标签被遮盖', () => assert.ok(switches.svg.indexOf('13800138000') < 0, switches.svg));
    check('增强⑦ document.title 开关开启后标签页标题被遮盖', () => assert.ok(switches.title.indexOf('13800138000') < 0, switches.title));

    /* ---------- 7. join switch off = original behaviour ---------- */
    const noJoin = JSON.parse(JSON.stringify(CFG));
    noJoin.settings.joinSplitText = false;
    await setConfig(sw, noJoin);
    await sleep(800);
    const a12off = await ev(page, "document.querySelector('[data-shape=\"A12\"] > div').textContent");
    check('关闭「跨标签拼接识别」后 A12 回到未遮盖状态（开关可逆）', () => assert.ok(a12off.indexOf('13800138000') >= 0, a12off));

    /* ---------- 8. restore default, no leaks ---------- */
    await setConfig(sw, Core.defaultConfig());
    await sleep(900);
    const final = await ev(page, "({title:document.title,ph:document.getElementById('b02-input').getAttribute('placeholder'),blur:document.getElementById('b04-canvas').hasAttribute('data-mg-blur')})");
    check('恢复默认配置后属性 / 标题 / 模糊状态全部复原', () => {
      assert.ok(final.title.indexOf('13800138000') >= 0, final.title);
      assert.ok(final.ph.indexOf('13800138000') >= 0, final.ph);
      assert.strictEqual(final.blur, false);
    });
    const errors1 = pageEvents.filter(e => e.method === 'Runtime.exceptionThrown');
    check('全流程无页面脚本异常', () => assert.strictEqual(errors1.length, 0, JSON.stringify(errors1).slice(0, 500)));

    console.log('\n' + passes + ' passed, ' + failures.length + ' failed.');
    if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
  } catch (e) {
    console.error('FATAL:', e.stack || e.message);
    if (browser) console.error('browser stderr:', (browser.stderrText || '').slice(-1200));
    process.exitCode = 1;
  } finally {
    if (page) page.close();
    if (sw) sw.close();
    if (browserCdp) browserCdp.close();
    if (browser) browser.kill();
    if (server) server.close();
    if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
  }
})();
