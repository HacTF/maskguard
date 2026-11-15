/* Headless smoke test for content.js using a minimal DOM mock: node tests/content.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const Core = require('../masker.js');

function matchOne(el, sel) {
  sel = sel.trim();
  if (!sel) return false;
  if (sel[0] === '#') return el.id === sel.slice(1);
  if (sel[0] === '.') return String(el.className || '').split(/\s+/).indexOf(sel.slice(1)) >= 0;
  if (sel[0] === '[') {
    const m = sel.match(/^\[([^\]=]+)(?:="?([^"\]]+)"?)?\]$/);
    if (!m) return false;
    const v = el.attrs[m[1]];
    return m[2] === undefined ? v !== undefined : String(v) === m[2];
  }
  return el.tagName.toLowerCase() === sel.toLowerCase();
}
function matchAny(el, sel) { return String(sel).split(',').some(s => matchOne(el, s)); }

function buildEnv(config) {
  const eventHandlers = { document: {}, window: {} };
  const observers = [];
  let selectionText = '';
  const store = { config: Core.normalizeConfig(config) };
  const storageListeners = [];
  const msgListeners = [];

  class El {
    constructor(tag, attrs) {
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.childNodes = [];
      this.parentNode = null;
      this.attrs = attrs || {};
      this.id = this.attrs.id || '';
      this.className = this.attrs.class || '';
      this.style = { setProperty() {}, cssText: '' };
    }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    appendChild(n) {
      n.parentNode = this;
      this.childNodes.push(n);
      if (this._inDoc) {
        observers.forEach(o => o.cb([{ type: 'childList', addedNodes: [n], target: this }]));
      }
      return n;
    }
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; }
    getAttribute(k) { return this.attrs[k]; }
    remove() {
      if (!this.parentNode) return;
      const i = this.parentNode.childNodes.indexOf(this);
      if (i >= 0) this.parentNode.childNodes.splice(i, 1);
      this.parentNode = null;
    }
    closest(sel) {
      let cur = this;
      while (cur && cur.nodeType === 1) { if (matchAny(cur, sel)) return cur; cur = cur.parentElement; }
      return null;
    }
    get textContent() {
      return this.childNodes.map(n => n.nodeType === 3 ? n.nodeValue : n.textContent).join('');
    }
    set textContent(v) {
      this.childNodes = [new Txt(v)];
      this.childNodes[0].parentNode = this;
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; }
  }
  class Txt {
    constructor(v) { this.nodeType = 3; this.nodeValue = String(v); this.parentNode = null; }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  }

  function collectText(root, out) {
    out = out || [];
    if (!root) return out;
    if (root.nodeType === 3) { out.push(root); return out; }
    (root.childNodes || []).forEach(n => collectText(n, out));
    return out;
  }

  const html = new El('html');
  const body = new El('body');
  html._inDoc = true; body._inDoc = true;
  html.appendChild(body);

  const document = {
    readyState: 'complete',
    documentElement: html,
    body: body,
    createElement: tag => new El(tag),
    createTextNode: v => new Txt(v),
    getElementById: () => null,
    querySelectorAll: sel => {
      const out = [];
      const first = String(sel).split(',')[0].trim();
      const walk = e => { if (matchOne(e, first)) out.push(e); e.children.forEach(walk); };
      walk(html);
      return out;
    },
    createTreeWalker: (root, what, filter) => {
      let list = null, i = 0;
      return {
        nextNode() {
          if (!list) {
            list = collectText(root);
            if (filter && filter.acceptNode) list = list.filter(n => filter.acceptNode(n) === 1);
          }
          return i < list.length ? list[i++] : null;
        }
      };
    },
    addEventListener: (type, fn) => { (eventHandlers.document[type] = eventHandlers.document[type] || []).push(fn); }
  };

  const window = {
    top: null,
    addEventListener: (type, fn) => { (eventHandlers.window[type] = eventHandlers.window[type] || []).push(fn); },
    getSelection: () => ({ toString: () => selectionText }),
    CSS: null
  };
  window.top = window;

  class MutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    takeRecords() { return []; }
    disconnect() {}
  }

  const chrome = {
    storage: {
      local: {
        get: (k, cb) => cb({ config: store.config }),
        set: (o, cb) => {
          Object.assign(store, o);
          storageListeners.forEach(fn => fn({ config: { newValue: store.config } }, 'local'));
          if (cb) cb();
        },
        remove: (k, cb) => { delete store[k]; if (cb) cb(); }
      },
      onChanged: { addListener: fn => storageListeners.push(fn) }
    },
    runtime: {
      lastError: undefined,
      onMessage: { addListener: fn => msgListeners.push(fn) },
      sendMessage: (msg, cb) => { if (cb) cb({ ok: true }); }
    }
  };

  const env = {
    window, document, chrome, MutationObserver,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    location: { hostname: 'example.com', pathname: '/test' },
    console, setTimeout, clearTimeout, Date, Math, WeakMap, WeakSet, Set, Map, Promise,
    El, Txt, collectText, store, eventHandlers, observers, msgListeners,
    setSelection: v => { selectionText = v; }
  };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'masker.js'), 'utf8'), env, { filename: 'masker.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'), env, { filename: 'content.js' });
  return env;
}

function nodeWith(body, tag, text, attrs) {
  const { El, Txt } = body;
  const e = new El(tag, attrs);
  const t = new Txt(text);
  e.appendChild(t);
  return { e, t };
}

function send(env, msg) {
  let out;
  env.msgListeners.forEach(fn => fn(msg, { tab: { id: 1 } }, r => { out = r; }));
  return out;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function run() {
  const env = buildEnv(Core.defaultConfig());
  const { El, Txt, document } = env;
  const body = document.body;

  const p1 = nodeWith(env, 'p', '手机号：13800138000，联系人张三');
  const p2 = nodeWith(env, 'p', '邮箱：zhangsan@example.com');
  const sc = nodeWith(env, 'script', 'var phone = 13800138000;');
  const secret = nodeWith(env, 'div', '自定义敏感字段 ABC-778899', { id: 'secret' });
  body.appendChild(p1.e); body.appendChild(p2.e); body.appendChild(sc.e); body.appendChild(secret.e);
  await sleep(220);

  assert.ok(p1.t.nodeValue.includes('138****8000'), '自动脱敏手机号失败: ' + p1.t.nodeValue);
  assert.ok(!p2.t.nodeValue.includes('zhangsan@example.com'), '自动脱敏邮箱失败: ' + p2.t.nodeValue);
  assert.ok(sc.t.nodeValue.includes('13800138000'), 'script 不应被修改');
  console.log('  PASS  页面加载后自动识别并遮盖（正则规则）');

  const maskedPhone = p1.t.nodeValue;
  (env.eventHandlers.document.keydown || []).forEach(fn => fn({ key: 'Alt', altKey: true, preventDefault() {} }));
  assert.ok(p1.t.nodeValue.includes('13800138000'), 'Alt 应显示原文');
  (env.eventHandlers.document.keyup || []).forEach(fn => fn({ key: 'Alt', altKey: false }));
  assert.strictEqual(p1.t.nodeValue, maskedPhone, '松开 Alt 应恢复遮盖');
  console.log('  PASS  按住 Alt 临时显示原文 / 松开恢复');

  let st = send(env, { type: 'MG_GET_STATE' });
  assert.ok(st && st.masked >= 2, '状态统计异常: ' + JSON.stringify(st));
  assert.strictEqual(st.host, 'example.com');
  console.log('  PASS  状态上报（站点 / 遮盖处数）');

  env.chrome.storage.local.set({
    config: Object.assign({}, env.store.config, {
      rules: [Core.normalizeRule({ id: 'x', pattern: '1[3-9]\\d{9}', maskType: 'fixed', maskChar: '█', fixedLength: 6 })]
    })
  }, () => {});
  assert.ok(p1.t.nodeValue.includes('██████'), '配置变更未重新应用: ' + p1.t.nodeValue);
  assert.ok(!p2.t.nodeValue.includes('*') || p2.t.nodeValue.includes('zhangsan@example.com'), '旧规则应被撤销');
  console.log('  PASS  配置热更新：撤销旧遮盖并按新规则重算');

  const cfg = Object.assign({}, env.store.config, {
    rules: [Core.normalizeRule({ id: 's', kind: 'selector', selector: '#secret', maskType: 'fixed', maskChar: '█', fixedLength: 8 })]
  });
  env.chrome.storage.local.set({ config: cfg }, () => {});
  assert.strictEqual(secret.t.nodeValue, '████████', '位置规则未生效: ' + secret.t.nodeValue);
  console.log('  PASS  手动指定位置（CSS 选择器整块遮盖）');

  env.chrome.storage.local.set({
    config: Object.assign({}, env.store.config, {
      rules: [
        Core.normalizeRule({ id: 's', kind: 'selector', selector: '#secret', maskType: 'fixed', maskChar: '█', fixedLength: 8 }),
        Core.normalizeRule({ id: 'p', pattern: '1[3-9]\\d{9}', maskType: 'partial', maskChar: '*', keepStart: 3, keepEnd: 4 })
      ]
    })
  }, () => {});

  const p3 = nodeWith(env, 'p', '动态插入：13900139000');
  body.appendChild(p3.e);
  await sleep(260);
  assert.ok(!p3.t.nodeValue.includes('13900139000'), '动态内容未被遮盖: ' + p3.t.nodeValue);
  console.log('  PASS  MutationObserver 动态内容增量遮盖');

  send(env, { type: 'MG_INSERT_DEMO' });
  await sleep(260);
  const demo = env.collectText(document.body).filter(t => t.nodeValue.includes('演示数据') || t.nodeValue.includes('手机号：'));
  assert.ok(demo.length > 0, '演示数据未插入');
  console.log('  PASS  一键插入演示数据');

  send(env, { type: 'MG_RESTORE' });
  assert.strictEqual(secret.t.nodeValue, '自定义敏感字段 ABC-778899', '还原原文失败');
  console.log('  PASS  还原原文');

  const res = send(env, { type: 'MG_TEST_SELECTOR', selector: '#secret' });
  assert.ok(res && res.ok && res.count === 1, '选择器验证失败: ' + JSON.stringify(res));
  console.log('  PASS  选择器在当前页验证');

  // ---- security: overbroad selector ----
  const cfgWide = Core.defaultConfig();
  cfgWide.rules = [Core.normalizeRule({ id: 'wide', kind: 'selector', selector: 'body', maskType: 'fixed', maskChar: '█', fixedLength: 8 })];
  env.chrome.storage.local.set({ config: cfgWide }, () => {});
  assert.ok(secret.t.nodeValue.includes('ABC-778899'), '整页选择器必须被忽略：' + secret.t.nodeValue);
  assert.ok(p1.t.nodeValue.includes('13800138000'), '页面不应被整块遮盖：' + p1.t.nodeValue);
  console.log('  PASS  安全：html/body 级宽泛选择器被拒绝');

  // ---- security: selected-text rule never persists the sensitive literal ----
  env.chrome.storage.local.set({ config: Core.defaultConfig() }, () => {});
  env.setSelection('ABC-778899');
  const ruleCountBefore = env.store.config.rules.length;
  const selRes = send(env, { type: 'MG_MASK_SELECTION' });
  assert.ok(selRes && selRes.ok && selRes.transient, JSON.stringify(selRes));
  assert.strictEqual(env.store.config.rules.length, ruleCountBefore, '敏感原文不得写入 storage');
  assert.ok(!env.store.config.rules.some(r => String(r.pattern).indexOf('ABC') >= 0), 'storage 中不得出现选中原文');
  assert.ok(!secret.t.nodeValue.includes('ABC-778899'), '选中文本应被遮盖：' + secret.t.nodeValue);
  assert.strictEqual(send(env, { type: 'MG_GET_STATE' }).sessionRules, 1);
  console.log('  PASS  安全：选中文本规则仅存内存，敏感原文不落盘');

  console.log('\n11 content-script checks passed.');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
