/* Real-browser E2E: launches Edge/Chrome headless with the unpacked extension.
   node tests/e2e.test.js   (set BROWSER=/path/to/browser.exe to override) */
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Core = require('../masker.js');

const EXT = path.resolve(__dirname, '..');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'page.html'), 'utf8');
const BROWSER = process.env.BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let passes = 0;
const failures = [];

function ok(name) { passes++; console.log('  PASS  ' + name); }
function fail(name, detail) { failures.push(name + ' :: ' + detail); console.log('  FAIL  ' + name + ' :: ' + detail); }
function check(name, fn) { try { fn(); ok(name); } catch (e) { fail(name, e.message); } }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function startFixtureServer(port) {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(FIXTURE);
  });
  return new Promise(resolve => s.listen(port, '127.0.0.1', () => resolve(s)));
}
function launch(profile, cdpPort) {
  const exe = fs.existsSync(BROWSER) ? BROWSER : EDGE;
  if (!fs.existsSync(exe)) throw new Error('no Chromium browser found: ' + exe);
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--no-sandbox',
    '--user-data-dir=' + profile,
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--remote-debugging-port=' + cdpPort,
    '--remote-allow-origins=*',
    'about:blank'
  ];
  const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.browserExe = exe;
  p.stderrText = '';
  p.stderr.on('data', d => { p.stderrText += String(d); });
  p.stdout.on('data', d => { p.stderrText += String(d); });
  return p;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchJson(port, urlPath, method) {
  const r = await fetch('http://127.0.0.1:' + port + urlPath, { method: method || 'GET' });
  if (!r.ok) throw new Error('CDP HTTP ' + r.status + ' for ' + urlPath);
  return r.json();
}
async function waitCDP(port) {
  for (let i = 0; i < 60; i++) {
    try { return await fetchJson(port, '/json/version'); } catch (e) { await sleep(250); }
  }
  throw new Error('CDP port did not open (browser may have exited)');
}
function connect(wsUrl, events) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', e => reject(new Error('WS error: ' + (e.message || 'unknown'))));
  });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, timer } = pending.get(m.id);
      clearTimeout(timer); pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    } else if (!m.id && events && m.method) {
      events.push({ method: m.method, data: m.params });
    }
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
  const end = Date.now() + (timeout || 6000);
  let last;
  while (Date.now() < end) {
    last = await ev(c, expression);
    if (predicate(last)) return last;
    await sleep(120);
  }
  throw new Error('timeout waiting for ' + label + '; last=' + JSON.stringify(last));
}
function textExpr(id) { return "(document.getElementById('" + id + "') || {}).textContent || ''"; }

async function findOwnExtension(cdpPort) {
  for (let i = 0; i < 40; i++) {
    let list = [];
    try { list = await fetchJson(cdpPort, '/json/list'); } catch (e) {}
    const sws = list.filter(t => t.type === 'service_worker' && /background\.js/.test(t.url || '') && t.webSocketDebuggerUrl);
    for (const t of sws) {
      let c;
      try {
        c = await connect(t.webSocketDebuggerUrl);
        await c.ready;
        await c.send('Runtime.enable');
        const name = await ev(c, "(function(){try{return chrome.runtime.getManifest().name}catch(e){return ''}})()");
        c.close();
        if (String(name).indexOf('MaskGuard') >= 0) return { extId: new URL(t.url).hostname, url: t.url };
      } catch (e) { if (c) c.close(); }
    }
    await sleep(250);
  }
  return null;
}
async function setConfig(opt, cfg) {
  const expr = 'new Promise(function(r){ chrome.storage.local.set({config: ' + JSON.stringify(cfg) + '}, function(){ r("ok"); }); })';
  return ev(opt, expr);
}
async function getConfig(opt) {
  return ev(opt, 'new Promise(function(r){ chrome.storage.local.get("config", function(d){ r(d.config); }); })');
}
async function sendToPage(opt, type) {
  const expr = 'new Promise(function(r){ chrome.tabs.query({},function(all){' +
    'var t=all.filter(function(x){ return (x.url||"").indexOf("http://127.0.0.1:")===0; });' +
    'if(!t.length) return r("no-tab"); chrome.tabs.sendMessage(t[0].id,{type:' + JSON.stringify(type) + '},function(res){' +
    'r(chrome.runtime.lastError ? "err:"+chrome.runtime.lastError.message : (res||"no-res")); }); }); })';
  return ev(opt, expr);
}

(async function main() {
  let browser, server, profile, page, opt, browserCdp;
  const pageEvents = [], optEvents = [];
  try {
    if (!fs.existsSync(BROWSER) && !fs.existsSync(EDGE)) throw new Error('no browser');
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-e2e-'));
    const webPort = await freePort();
    const cdpPort = await freePort();
    server = await startFixtureServer(webPort);
    browser = launch(profile, cdpPort);
    const ver = await waitCDP(cdpPort);
    console.log('Browser:', (ver.Browser || '').split('/').slice(0, 2).join(' '));

    browserCdp = await connect(ver.webSocketDebuggerUrl);
    await browserCdp.ready;
    const own = await findOwnExtension(cdpPort);
    if (!own) {
      console.log('  browser stderr:', (browser.stderrText || '').slice(-1800));
      throw new Error('扩展未被浏览器加载（未找到 MaskGuard service worker）');
    }
    const extId = own.extId;
    console.log('Extension id:', extId, '| own target:', own.url);

    const list = await fetchJson(cdpPort, '/json/list');
    const pageTarget = list.find(t => t.type === 'page' && t.url === 'about:blank') || list.find(t => t.type === 'page');
    if (!pageTarget) throw new Error('no page target');
    page = await connect(pageTarget.webSocketDebuggerUrl, pageEvents);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');

    const optUrl = 'chrome-extension://' + extId + '/panel.html?full=1';
    try { await browserCdp.send('Target.createTarget', { url: optUrl }); } catch (e) { console.log('  createTarget:', e.message); }
    await sleep(600);
    const allTargets = await fetchJson(cdpPort, '/json/list');
    console.log('  devtools targets:', allTargets.map(t => t.type + ':' + (t.url || '').slice(0, 60)).join(' | '));
    const swTarget = allTargets.find(t => t.type === 'service_worker' && t.url && t.url.startsWith('chrome-extension://' + extId));
    const extPageTarget = allTargets.find(t => t.type === 'page' && t.url && t.url.startsWith('chrome-extension://' + extId));
    let controlIsPage = false;
    for (const cand of [extPageTarget, swTarget].filter(Boolean)) {
      const c = await connect(cand.webSocketDebuggerUrl, optEvents);
      await c.ready;
      await c.send('Runtime.enable');
      const info = await ev(c, "({href:(typeof location!=='undefined'?location.href:''), storage:typeof (chrome&&chrome.storage), name:(function(){try{return chrome.runtime.getManifest().name}catch(e){return 'n/a'}})()})");
      console.log('  candidate', cand.type, JSON.stringify(info));
      if (info.storage === 'object') { opt = c; controlIsPage = cand.type === 'page'; break; }
      c.close();
    }
    if (!opt) throw new Error('无法连接具备 chrome.storage 的扩展控制器');
    console.log('  control:', controlIsPage ? 'extension page' : 'service worker');
    if (controlIsPage) await poll(opt, 'document.readyState', v => v === 'complete', 'options page load', 8000);

    const url = 'http://127.0.0.1:' + webPort + '/';
    await page.send('Page.navigate', { url });
    await poll(page, "document.readyState==='complete' && !!document.getElementById('phone') ? 'ready':'wait'", v => v === 'ready', 'fixture load', 10000);
    await sleep(600);
    const diagnostics = pageEvents.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded');
    if (diagnostics.length) console.log('  page diagnostics:', JSON.stringify(diagnostics.slice(0, 4)).slice(0, 1400));
    const cstate = await sendToPage(opt, 'MG_GET_STATE');
    console.log('  content script state:', JSON.stringify(cstate));

    // ---- static detection ----
    const phone = await ev(page, textExpr('phone'));
    const idcard = await ev(page, textExpr('idcard'));
    const email = await ev(page, textExpr('email'));
    const bank = await ev(page, textExpr('bank'));
    const script = await ev(page, "(document.getElementById('rawScript')||{}).textContent||''");
    console.log('  sample:', JSON.stringify({ phone, idcard, email, bank }));
    check('静态手机号遮盖为 138****8000', () => assert.ok(phone.includes('138****8000'), phone));
    check('静态身份证部分保留', () => assert.ok(idcard.includes('110101********1234'), idcard));
    check('静态邮箱遮盖', () => assert.ok(!email.includes('zhangsan@example.com') && email.includes('*'), email));
    check('静态银行卡遮盖', () => assert.ok(bank.includes('6222') && bank.includes('0123') && bank.includes('*'), bank));
    check('script 区域保持原文（跳过规则生效）', () => assert.ok(script.includes('13800138000'), script));

    // ---- no extension API leaked to page ----
    const leak = await ev(page, "({ chromeStorage: !!(window.chrome && window.chrome.storage), extId: typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id })");
    check('页面脚本无法访问 chrome.storage / runtime.id', () => {
      assert.strictEqual(leak.chromeStorage, false, 'chrome.storage leaked');
      assert.ok(!leak.extId, 'runtime.id leaked');
    });

    // ---- extension page CSP ----
    if (controlIsPage) {
      const csp = await ev(opt, "(function(){var s=document.createElement('script');s.textContent='window.__mgCsp=1;';document.documentElement.appendChild(s);return typeof window.__mgCsp;})()");
      check('扩展页面 CSP 阻止内联脚本注入', () => assert.strictEqual(csp, 'undefined', String(csp)));
    } else {
      console.log('  SKIP  扩展页面 CSP（控制器为 service worker，见静态审计）');
    }

    // ---- dynamic DOM ----
    await ev(page, "document.getElementById('add').click(); 'clicked'");
    const dyn = await poll(page, textExpr('dynamic'), v => v && v.includes('*'), 'dynamic node', 5000).catch(() => '');
    check('MutationObserver 遮盖动态插入内容', () => assert.ok(dyn.includes('139****9000') || dyn.includes('*'), dyn));
    await ev(page, "var w=document.createElement('div');w.id='nested';['嵌套手机 13700137000','嵌套邮箱 x@y.com'].forEach(function(t){var p=document.createElement('p');p.textContent=t;w.appendChild(p);});document.body.appendChild(w);'ok'");
    const nested = await poll(page, "(document.getElementById('nested')||{}).textContent||''", v => v.includes('137****7000'), 'nested nodes', 3000).catch(e => String(e.message));
    check('嵌套元素插入（多文本节点）自动遮盖', () => assert.ok(nested.includes('137****7000') && nested.includes('*'), nested));

    // ---- Alt reveal ----
    const beforeAlt = await ev(page, textExpr('phone'));
    await ev(page, "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Alt',altKey:true,bubbles:true})); 'down'");
    const revealed = await ev(page, textExpr('phone'));
    await ev(page, "document.body.dispatchEvent(new KeyboardEvent('keyup',{key:'Alt',altKey:false,bubbles:true})); 'up'");
    const afterAlt = await ev(page, textExpr('phone'));
    check('按住 Alt 显示原文 / 松开恢复遮盖', () => {
      assert.ok(beforeAlt.includes('138****8000'), '前置条件：原文应已被遮盖 -> ' + beforeAlt);
      assert.ok(revealed.includes('13800138000'), revealed);
      assert.strictEqual(afterAlt, beforeAlt, afterAlt);
    });

    // ---- config hot reload ----
    const cfg1 = Core.defaultConfig();
    cfg1.rules = [Core.normalizeRule({ id: 'e2e_fixed', name: '黑条', pattern: '1[3-9]\\d{9}', maskType: 'fixed', maskChar: '█', fixedLength: 6 })];
    await setConfig(opt, cfg1);
    const black = await poll(page, textExpr('phone'), v => v.includes('██████'), 'black-bar config', 5000).catch(e => String(e.message));
    check('配置热更新：改成黑条遮盖即时生效', () => assert.ok(black.includes('██████'), black));

    // ---- selector rule (manual position) ----
    const cfg2 = Core.defaultConfig();
    cfg2.rules = [Core.normalizeRule({ id: 'e2e_sel', name: '位置', kind: 'selector', selector: '#secret', maskType: 'fixed', maskChar: '█', fixedLength: 8 })];
    await setConfig(opt, cfg2);
    const secret = await poll(page, textExpr('secret'), v => v.includes('████████'), 'selector rule', 5000).catch(e => String(e.message));
    const phoneAfterSel = await ev(page, textExpr('phone'));
    check('手动位置规则：整块遮盖且不影响其它文本', () => {
      assert.strictEqual(secret, '████████', secret);
      assert.ok(phoneAfterSel.includes('13800138000'), phoneAfterSel);
    });

    // ---- site blacklist ----
    const cfg3 = Core.defaultConfig();
    cfg3.siteMode = 'blacklist';
    cfg3.siteList = ['127.0.0.1'];
    await setConfig(opt, cfg3);
    const restoredByBlacklist = await poll(page, textExpr('secret'), v => v.includes('ABC-778899'), 'site blacklist', 5000).catch(e => String(e.message));
    check('站点黑名单停用后自动还原原文', () => assert.ok(restoredByBlacklist.includes('ABC-778899'), restoredByBlacklist));

    // ---- restore config, then picker flow ----
    await setConfig(opt, Core.defaultConfig());
    await poll(page, textExpr('phone'), v => v.includes('138****8000'), 'config restored', 5000);
    const pickStart = await sendToPage(opt, 'MG_START_PICK');
    check('框选模式可启动', () => assert.ok(pickStart && pickStart.ok === true, JSON.stringify(pickStart)));
    await poll(page, "!!document.getElementById('mg-picker-box') ? 'yes':'no'", v => v === 'yes', 'picker overlay', 4000);
    await ev(page, [
      "var el=document.getElementById('secret');",
      "el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:10,clientY:10}));",
      "el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:10,clientY:10}));",
      "'clicked'"
    ].join(''));
    const toast = await poll(page, "(document.getElementById('mg-toast')||{}).textContent||'none'", v => v && v.startsWith('已添加位置规则'), 'picker commit', 6000).catch(e => String(e.message));
    check('框选单击生成位置规则并写入配置', () => assert.ok(toast.startsWith('已添加位置规则') && toast.includes('#secret'), toast));
    const cfgAfterPick = await getConfig(opt);
    check('新增规则持久化到 storage', () => {
      const r = (cfgAfterPick.rules || []).find(x => x.kind === 'selector' && x.selector === '#secret');
      assert.ok(r, JSON.stringify((cfgAfterPick.rules || []).map(x => x.selector)));
    });
    const overlayGone = await poll(page, "!!document.getElementById('mg-picker-box') ? 'yes':'no'", v => v === 'no', 'picker cleanup', 4000).catch(e => String(e.message));
    check('框选结束后高亮层已移除', () => assert.strictEqual(overlayGone, 'no', overlayGone));

    // ---- Esc cancel ----
    await sendToPage(opt, 'MG_START_PICK');
    await poll(page, "!!document.getElementById('mg-picker-tip') ? 'yes':'no'", v => v === 'yes', 'picker tip', 4000);
    await ev(page, "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); 'esc'");
    const esc = await poll(page, "!!document.getElementById('mg-picker-tip') ? 'yes':'no'", v => v === 'no', 'picker cancel', 4000).catch(e => String(e.message));
    check('Esc 取消框选并清理浮层', () => assert.strictEqual(esc, 'no', esc));

    // ---- demo injection + restore ----
    await setConfig(opt, Core.defaultConfig());
    await sleep(300);
    const demoMsg = await sendToPage(opt, 'MG_INSERT_DEMO');
    const demoText = await poll(page, "var d=document.querySelector('[data-mg-demo]'); d ? d.textContent : 'none'", v => v !== 'none' && v.includes('138****8000'), 'demo block masked', 4000).catch(e => String(e.message));
    check('一键插入演示数据且自动遮盖', () => {
      assert.ok(demoMsg && demoMsg.ok === true, JSON.stringify(demoMsg));
      assert.ok(demoText.includes('138****8000') && !demoText.includes('13800138000'), demoText);
    });
    await sendToPage(opt, 'MG_RESTORE');
    const restored = await ev(page, textExpr('phone'));
    check('还原本页恢复全部原文', () => assert.ok(restored.includes('13800138000'), restored));

    // ---- security: ReDoS guard ----
    const cfgUnsafe = Core.defaultConfig();
    cfgUnsafe.rules = [Core.normalizeRule({ id: 'redos', name: '危险正则', pattern: '(a+)+$', maskType: 'full', maskChar: '*' })];
    await setConfig(opt, cfgUnsafe);
    await sleep(250);
    const alive = await ev(page, '2+2');
    const redosPhone = await ev(page, textExpr('phone'));
    check('安全：高危正则被拦截，页面保持响应且旧遮盖已还原', () => {
      assert.strictEqual(alive, 4, '页面疑似被正则卡死');
      assert.ok(redosPhone.includes('13800138000'), redosPhone);
    });

    // ---- security: overbroad selector ----
    const cfgWide = Core.defaultConfig();
    cfgWide.rules = [Core.normalizeRule({ id: 'wide', name: '整页', kind: 'selector', selector: 'body', maskType: 'fixed', maskChar: '█', fixedLength: 8 })];
    await setConfig(opt, cfgWide);
    await sleep(250);
    const widePhone = await ev(page, textExpr('phone'));
    check('安全：整页选择器被拒绝，页面未被整块遮盖', () => assert.ok(widePhone.includes('13800138000'), widePhone));

    // ---- security: selected-text rule never persists the literal ----
    await setConfig(opt, Core.defaultConfig());
    await sleep(250);
    const rulesBefore = ((await getConfig(opt)).rules || []).length;
    await ev(page, "var r=document.createRange();r.selectNodeContents(document.getElementById('secret'));var s=window.getSelection();s.removeAllRanges();s.addRange(r);'selected'");
    const selMsg = await sendToPage(opt, 'MG_MASK_SELECTION');
    await sleep(250);
    const rulesAfter = ((await getConfig(opt)).rules || []).length;
    const stSel = await sendToPage(opt, 'MG_GET_STATE');
    const secretAfterSel = await ev(page, textExpr('secret'));
    check('安全：选中文本规则仅内存生效，敏感原文不落盘', () => {
      assert.ok(selMsg && selMsg.ok && selMsg.transient, JSON.stringify(selMsg));
      assert.strictEqual(rulesAfter, rulesBefore, 'storage 规则数不应变化');
      assert.ok(stSel && stSel.sessionRules >= 1, JSON.stringify(stSel));
      assert.ok(!secretAfterSel.includes('ABC-778899'), secretAfterSel);
    });

    // ---- security: no outbound requests ----
    const external = await ev(page, "performance.getEntriesByType('resource').map(function(r){return r.name}).filter(function(n){return /^https?:/.test(n)&&n.indexOf('127.0.0.1')<0})");
    check('安全：扩展未产生任何外部网络请求', () => assert.strictEqual(external.length, 0, JSON.stringify(external)));
    const injected = await ev(page, "Array.from(document.scripts).filter(function(s){return (s.src||'').indexOf('chrome-extension://')>=0||String(s.id).indexOf('mg-')===0}).length");
    check('安全：未向页面注入扩展脚本标签', () => assert.strictEqual(injected, 0, String(injected)));

  } catch (e) {
    fail('E2E 运行', e.stack || e.message);
  } finally {
    [page, opt, browserCdp].forEach(c => { if (c) c.close(); });
    if (browser) {
      try { process.kill(browser.pid); } catch (e) {}
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
      }
    }
    if (server) server.close();
    await sleep(400);
    if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
    console.log('\n' + passes + ' passed, ' + failures.length + ' failed');
    if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  }
})();
