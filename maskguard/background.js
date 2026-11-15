/* MaskGuard service worker: defaults, context menus, storage writes, badge. */
try { importScripts('masker.js'); } catch (e) { /* fallback below */ }
var Core = self.MaskGuardCore;

function fallbackConfig() {
  return {
    version: 1, enabled: true, siteMode: 'all', siteList: [],
    settings: {
      observeDynamic: true, debounceMs: 120, revealOnAlt: true, badge: true,
      allowUnsafeRegex: false, maxTextLength: 8000,
      joinSplitText: true, maskShadowDom: true, maskSvgText: false,
      maskAttributes: false, maskTitle: false
    },
    rules: []
  };
}
function defaults() { return Core ? Core.defaultConfig() : fallbackConfig(); }
function norm(raw) { return Core ? Core.normalizeConfig(raw) : Object.assign(fallbackConfig(), raw || {}); }

function getConfig() {
  return new Promise(function (resolve) {
    chrome.storage.local.get('config', function (d) { resolve(norm(d && d.config)); });
  });
}
function setConfig(c) {
  return new Promise(function (resolve) {
    chrome.storage.local.set({ config: c }, function () { resolve(c); });
  });
}

chrome.runtime.onInstalled.addListener(function () {
  getConfig().then(function (c) {
    if (!c.rules.length && !c.siteList.length) return setConfig(defaults());
  });
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({ id: 'mg_mask_selection', title: 'MaskGuard：脱敏选中的文本', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'mg_pick_element', title: 'MaskGuard：将此位置加入脱敏', contexts: ['page', 'selection', 'link', 'image', 'editable'] });
    chrome.contextMenus.create({ id: 'mg_toggle_site', title: 'MaskGuard：启用 / 停用本站点', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'mg_options', title: 'MaskGuard：规则设置', contexts: ['page'] });
  });
});

function sendToTab(tabId, msg) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, msg, function (res) {
      if (!chrome.runtime.lastError && res) return resolve(res);
      chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['masker.js', 'content.js'] }, function () {
        if (chrome.runtime.lastError) return resolve(null);
        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, msg, function (r) {
            resolve(chrome.runtime.lastError ? null : r);
          });
        }, 150);
      });
    });
  });
}

var badgeCache = {};
function setBadge(tabId, text, color) {
  if (!tabId) return;
  try {
    chrome.action.setBadgeBackgroundColor({ color: color || '#16a34a', tabId: tabId });
    chrome.action.setBadgeText({ text: text || '', tabId: tabId });
  } catch (e) {}
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || !tab.id) return;
  switch (info.menuItemId) {
    case 'mg_mask_selection':
      sendToTab(tab.id, { type: 'MG_MASK_SELECTION' });
      break;
    case 'mg_pick_element':
      sendToTab(tab.id, { type: 'MG_PICK_ELEMENT' });
      break;
    case 'mg_toggle_site':
      toggleSite(tab);
      break;
    case 'mg_options':
      chrome.runtime.openOptionsPage();
      break;
  }
});

function toggleSite(tab) {
  var host = '';
  try { host = new URL(tab.url).hostname; } catch (e) { return; }
  if (!host) return;
  getConfig().then(function (c) {
    var matches = function (e) { return Core ? Core.hostMatches(host, e) : String(e) === host; };
    var idx = c.siteList.findIndex(matches);
    if (c.siteMode === 'whitelist') {
      if (idx >= 0) c.siteList.splice(idx, 1); else c.siteList.push(host);
    } else {
      if (c.siteMode !== 'blacklist') c.siteMode = 'blacklist';
      if (idx >= 0) c.siteList.splice(idx, 1); else c.siteList.push(host);
    }
    setConfig(c);
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (!sender || sender.id !== chrome.runtime.id) return; // reject foreign senders
  switch (msg.type) {
    case 'MG_REPORT': {
      var tid = sender.tab && sender.tab.id;
      var text = msg.badge && msg.masked ? (msg.masked > 999 ? '999+' : String(msg.masked)) : '';
      if (tid) badgeCache[tid] = text;
      setBadge(tid, text, '#16a34a');
      break;
    }

    case 'MG_ADD_RULE':
      getConfig().then(function (c) {
        if (Core && c.rules.length >= Core.LIMITS.maxRules) {
          sendResponse({ ok: false, error: '规则数量已达上限' });
          return;
        }
        var rule = Core ? Core.normalizeRule(msg.rule || {}) : msg.rule;
        if (Core && rule.kind === 'regex' && Core.auditPattern(rule.pattern).length) {
          sendResponse({ ok: false, error: '正则存在回溯风险，已拒绝' });
          return;
        }
        if (Core && rule.kind === 'selector' && Core.isOverbroadSelector(rule.selector)) {
          sendResponse({ ok: false, error: '选择器范围过大，已拒绝' });
          return;
        }
        c.rules.push(rule);
        return setConfig(c).then(function () {
          chrome.storage.local.set({
            lastAction: { text: '已添加：' + (rule.name || '新规则'), at: Date.now() }
          });
          var tabId = sender.tab && sender.tab.id;
          setBadge(tabId, 'OK', '#0f172a');
          sendResponse({ ok: true, id: rule.id });
          setTimeout(function () { setBadge(tabId, badgeCache[tabId] || '', '#16a34a'); }, 1400);
        });
      });
      return true;

    case 'MG_OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      break;
  }
});
