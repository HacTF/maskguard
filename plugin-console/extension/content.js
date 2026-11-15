/* Applies server-pushed rules to the page. Deliberately small: the point of the
   PoC is the control plane, not a second MaskGuard. */
'use strict';
(function () {
  const Core = globalThis.MaskGuardCore;
  if (!Core) return;

  const SKIP = 'script, style, noscript, textarea, input, select, option, svg, canvas, iframe, [contenteditable="true"]';
  const originals = new WeakMap();
  let rules = [];
  let timer = null;

  function applyNode(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) return 0;
    const prev = originals.get(node);
    if (prev !== undefined && prev === node.nodeValue) return 0; // our own output
    const current = prev !== undefined ? prev : node.nodeValue;
    const out = Core.applyRules(current, rules, { maxTextLength: 8000 });
    if (!out.count || out.text === current) return 0;
    originals.set(node, current);
    node.nodeValue = out.text;
    return out.count;
  }

  function scan() {
    if (!rules.length) return 0;
    let hits = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) hits += applyNode(n);
    return hits;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const hits = scan();
      if (hits) chrome.runtime.sendMessage({ type: 'masked-count', count: hits }, () => void chrome.runtime.lastError);
    }, 120);
  }

  function load() {
    chrome.storage.local.get(['rules'], s => {
      rules = Array.isArray(s.rules) ? s.rules.filter(r => r && r.enabled !== false) : [];
      schedule();
    });
  }

  chrome.storage.onChanged.addListener(ch => { if (ch.rules) load(); });
  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'mg-policy-updated') load();
  });

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  load();
  chrome.runtime.sendMessage({ type: 'sync-now', reason: 'page-load' }, () => void chrome.runtime.lastError);
})();
