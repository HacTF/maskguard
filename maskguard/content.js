/* MaskGuard content script: detect + mask text, observe DOM changes, pick elements. */
(function () {
  'use strict';
  if (window.__maskGuardLoaded) return;
  window.__maskGuardLoaded = true;

  var Core = globalThis.MaskGuardCore;
  if (!Core || !chrome || !chrome.storage) return;

  var FALLBACK_SKIP = 'script, style, noscript, textarea, input, select, option, svg, math, canvas, iframe, object, embed, [contenteditable="true"], [data-mg-skip]';
  /* Only inline elements may be joined when reconstructing a value split by
     table formatters / syntax highlighters. Block tags are hard boundaries so
     two independent fields are never concatenated into a false positive. */
  var BLOCK_TAGS = /^(DIV|P|LI|TR|TD|TH|SECTION|ARTICLE|H[1-6]|PRE|TABLE|THEAD|TBODY|UL|OL|HEADER|FOOTER|ASIDE|NAV|MAIN|FORM|BLOCKQUOTE|HR|BR|FIGURE|FIGCAPTION|DETAILS|SUMMARY)$/;
  var ATTR_NAMES = ['placeholder', 'title', 'alt', 'aria-label', 'aria-valuetext'];
  var IS_TOP = false;
  try { IS_TOP = window.top === window; } catch (e) { IS_TOP = false; }

  var config = Core.defaultConfig();
  var activeRegexRules = [];
  var activeSelectorRules = [];
  var sessionRules = []; // transient rules from "mask selected text" - never persisted
  var maskOptions = {};
  var originals = new WeakMap();   // Text node -> original text
  var outputs = new WeakMap();     // Text node -> masked text we wrote
  var attrOriginals = [];           // [{ el, values }] - original display attributes
  var visualNodes = new Set();     // Elements blurred by a selector rule
  var titleOriginal = null;
  var titleOutput = null;
  var maskedCount = 0;
  var hitTotal = 0;
  var observer = null;
  var applying = false;
  var scanTimer = null;
  var pendingNodes = null;
  var needFull = false;
  var firstPendingAt = 0;
  var pick = null;
  var lastContextEl = null;
  var altShown = false;
  var cachedSkipRaw = null;
  var cachedSkipSel = null;
  var reportTimer = null;

  /* ---------- helpers ---------- */

  function safeRuntime(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, function (res) {
        if (chrome.runtime.lastError) return;
        if (cb) cb(res);
      });
    } catch (e) { /* service worker restarting */ }
  }

  function skipSelector() {
    var raw = (config.settings && config.settings.skipSelectors) || '';
    var svgOn = !!config.settings.maskSvgText;
    var key = raw + '|' + svgOn;
    if (key === cachedSkipRaw) return cachedSkipSel;
    cachedSkipRaw = key;
    if (svgOn) {
      // Allow SVG <text> nodes: strip a standalone "svg" entry from the list.
      raw = raw.replace(/(^|,)\s*svg\s*(?=,|$)/g, '$1')
        .replace(/,\s*,/g, ',').replace(/^\s*,+|,+\s*$/g, '').trim();
    }
    if (!raw.trim()) { cachedSkipSel = ''; return ''; }
    try { document.querySelectorAll(raw); cachedSkipSel = raw; }
    catch (e) { cachedSkipSel = FALLBACK_SKIP; }
    return cachedSkipSel;
  }

  function hostSkipped(p, sel) {
    try {
      var r = p.getRootNode ? p.getRootNode() : null;
      var guard = 0;
      while (r && r.host && guard++ < 8) {
        var h = r.host;
        if (h.closest && h.closest(sel)) return true;
        r = h.getRootNode ? h.getRootNode() : null;
      }
    } catch (e) { /* cross-origin / closed shadow */ }
    return false;
  }

  function collectTextNodes(root) {
    var out = [];
    if (!root) return out;
    if (root.nodeType === 3) { out.push(root); return out; }
    var sel = skipSelector();
    if (root.querySelectorAll && sel) {
      try {
        // Is the root itself a skipped container? (shadow host / nested root)
        if (root.host && hostSkipped(root.host, sel)) return out;
      } catch (e) {}
    }
    var walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          var p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.id === 'mg-picker-tip' || p.id === 'mg-toast' || p.closest('#mg-picker-tip, #mg-toast')) {
            return NodeFilter.FILTER_REJECT;
          }
          if (sel) {
            try {
              if (p.closest(sel) || hostSkipped(p, sel)) return NodeFilter.FILTER_REJECT;
            } catch (e) { /* invalid selector already handled */ }
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
    } catch (e) { return out; }
    var node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
  }

  /* Web Components keep their text in a shadow tree that a TreeWalker rooted
     at document.body never enters. Collect open shadow roots recursively. */
  function shadowRoots(root) {
    var out = [];
    if (!root) return out;
    var queue = [root], guard = 0;
    while (queue.length && guard++ < 8) {
      var r = queue.shift();
      var list = [];
      try { list = r.querySelectorAll ? Array.prototype.slice.call(r.querySelectorAll('*')) : []; }
      catch (e) { list = []; }
      for (var i = 0; i < list.length; i++) {
        var sr = list[i].shadowRoot;
        if (sr && out.indexOf(sr) < 0) { out.push(sr); queue.push(sr); }
      }
    }
    return out;
  }

  function allRoots() {
    var base = document.body || document.documentElement;
    var roots = base ? [base] : [];
    if (config.settings.maskShadowDom && base) roots = roots.concat(shadowRoots(base));
    return roots;
  }

  function collectAllTextNodes() {
    var roots = allRoots(), out = [];
    for (var i = 0; i < roots.length; i++) out = out.concat(collectTextNodes(roots[i]));
    return out;
  }

  function eachTextNode(fn) {
    var roots = allRoots();
    for (var i = 0; i < roots.length; i++) {
      var walker;
      try { walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_TEXT); }
      catch (e) { continue; }
      var n;
      while ((n = walker.nextNode())) fn(n);
    }
  }

  function hostList() {
    var hosts = [location.hostname];
    try {
      var top = window.top.location.hostname;
      if (top && hosts.indexOf(top) === -1) hosts.push(top);
    } catch (e) { /* cross-origin frame */ }
    return hosts;
  }

  function siteOk() {
    var hosts = hostList();
    for (var i = 0; i < hosts.length; i++) {
      if (Core.siteAllowed(config, hosts[i])) return true;
    }
    return false;
  }

  function shouldRun() {
    return config.enabled && siteOk() && (activeRegexRules.length > 0 || activeSelectorRules.length > 0);
  }

  function refreshActiveRules() {
    var all = config.rules.concat(sessionRules);
    activeRegexRules = all.filter(function (r) { return r.enabled && r.kind === 'regex' && r.pattern; });
    activeSelectorRules = all.filter(function (r) {
      return r.enabled && r.kind === 'selector' && r.selector && !Core.isOverbroadSelector(r.selector);
    });
    maskOptions = {
      allowUnsafe: !!config.settings.allowUnsafeRegex,
      maxTextLength: Math.min(50000, Math.max(1000, parseInt(config.settings.maxTextLength, 10) || 8000))
    };
  }

  function selectorRuleFor(node) {
    if (!activeSelectorRules.length) return null;
    var el = node.parentElement;
    if (!el) return null;
    for (var i = 0; i < activeSelectorRules.length; i++) {
      var r = activeSelectorRules[i];
      try { if (el.closest(r.selector)) return r; } catch (e) { /* invalid selector */ }
    }
    return null;
  }

  /* ---------- masking ---------- */

  function logicalText(node) {
    var out = outputs.get(node);
    if (out !== undefined && node.nodeValue === out) {
      var orig = originals.get(node);
      return orig !== undefined ? orig : node.nodeValue;
    }
    return node.nodeValue;
  }

  function writeNode(node, target) {
    var logical = logicalText(node);
    if (target === logical) {
      if (originals.has(node)) {
        if (node.nodeValue !== logical) node.nodeValue = logical;
        originals.delete(node); outputs.delete(node);
        maskedCount = Math.max(0, maskedCount - 1);
      }
      return 0;
    }
    if (!originals.has(node)) maskedCount++;
    originals.set(node, logical);
    outputs.set(node, target);
    if (node.nodeValue !== target) node.nodeValue = target;
    return 1;
  }

  function processNode(node) {
    if (!node || node.nodeType !== 3 || !node.parentNode) return 0;
    if (altShown) return 0;
    var current = node.nodeValue;
    var out = outputs.get(node);
    if (out !== undefined && out === current) return 0; // our own output, unchanged
    var logical = logicalText(node);
    if (logical === current && originals.has(node)) {
      // the page itself restored the original text (framework re-render)
      originals.delete(node); outputs.delete(node);
      maskedCount = Math.max(0, maskedCount - 1);
    }
    var elRule = selectorRuleFor(node);
    if (elRule && elRule.maskType === 'blur') return 0; // element-level, see applyVisualRules
    var result = elRule
      ? Core.maskValue(logical, elRule)
      : Core.applyRules(logical, activeRegexRules, maskOptions).text;
    return writeNode(node, result);
  }

  /* Real pages often split one value across adjacent text nodes (table
     formatter, syntax highlighting, React fragments). Rebuild the inline text
     of a container, match against the ORIGINAL string, then write the masked
     pieces back without changing the DOM structure. */
  function inlineTexts(el, allowed, out, depth, state) {
    if (depth > 6 || !el || !el.childNodes) return out;
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) {
        if (allowed.has(c) && String(c.nodeValue || '').trim()) out.push(c);
      } else if (c.nodeType === 1) {
        // SVG / MathML labels are independent data items; joining two chart
        // labels would create a bogus 18-digit "ID" and cause a false hit.
        var ns = c.namespaceURI;
        if ((ns && ns !== 'http://www.w3.org/1999/xhtml') ||
            BLOCK_TAGS.test(String(c.tagName || '').toUpperCase())) {
          state.blocked = true; continue;
        }
        inlineTexts(c, allowed, out, depth + 1, state);
      }
    }
    return out;
  }

  function applyJoinScan(nodes) {
    var result = { writes: new Map(), handled: new Set() };
    if (!config.settings.joinSplitText || !activeRegexRules.length || !nodes.length) return result;
    var allowed = new Set(nodes);
    var groups = new Map();
    for (var i = 0; i < nodes.length; i++) {
      if (selectorRuleFor(nodes[i])) continue;
      var el = nodes[i].parentElement, depth = 0;
      while (el && depth < 4) {
        var state = { blocked: false }, texts = [];
        try { texts = inlineTexts(el, allowed, [], 0, state); } catch (e) { break; }
        if (!state.blocked && texts.length >= 2) { groups.set(el, texts); break; }
        el = el.parentElement; depth++;
      }
    }
    groups.forEach(function (list) {
      if (!list || list.length < 2 || list.length > 16) return;
      var pieces = [], joined = '';
      for (var k = 0; k < list.length; k++) {
        var t = logicalText(list[k]) || '';
        pieces.push({ node: list[k], text: t, start: joined.length });
        joined += t;
      }
      /* Only a genuine "one value split into pieces" qualifies. A table row of
         separate fields is much longer, and a greedy rule (e.g. an email local
         part) would then swallow neighbouring cells and redistribute text across
         them. Cap the group length and require the hits to cover most of it. */
      if (joined.length < 8 || joined.length > 40) return;
      var ranges;
      try { ranges = Core.matchRanges(joined, activeRegexRules, maskOptions); } catch (e) { return; }
      if (!ranges.length) return;
      function idxAt(pos) {
        for (var q = 0; q < pieces.length; q++) {
          var s = pieces[q].start, e = s + pieces[q].text.length;
          if (pos >= s && (pos < e || (q === pieces.length - 1 && pos === e))) return q;
        }
        return pieces.length - 1;
      }
      var cross = [], r;
      for (r = 0; r < ranges.length; r++) {
        if (idxAt(ranges[r].start) < idxAt(Math.max(ranges[r].start, ranges[r].end - 1))) cross.push(ranges[r]);
      }
      /* Token alignment. Adjacent cells are concatenated without separators, so a
         row like "13800138000 | 110101199001011000" would otherwise yield a fake
         18-digit ID (phone tail + ID head). A real split value is never embedded
         inside a longer digit run, so drop matches with digits on either side. */
      var isNum = function (ch) { return ch >= '0' && ch <= '9'; };
      cross = cross.filter(function (rg) {
        var before = rg.start > 0 ? joined.charAt(rg.start - 1) : '';
        var after = rg.end < joined.length ? joined.charAt(rg.end) : '';
        var first = joined.charAt(rg.start), last = joined.charAt(rg.end - 1);
        if (isNum(before) && isNum(first)) return false;
        if (isNum(after) && isNum(last)) return false;
        return true;
      });
      if (!cross.length) return; // single-node hits are handled by processNode
      var covered = 0;
      for (r = 0; r < cross.length; r++) covered += cross[r].end - cross[r].start;
      if (covered / joined.length < 0.7) return; // several values, not one split value
      var out = pieces.map(function () { return ''; });
      var cursor = 0;
      function appendOriginal(from, to) {
        for (var q = 0; q < pieces.length; q++) {
          var s = Math.max(from, pieces[q].start);
          var e = Math.min(to, pieces[q].start + pieces[q].text.length);
          if (e > s) out[q] += pieces[q].text.slice(s - pieces[q].start, e - pieces[q].start);
        }
      }
      for (var c = 0; c < cross.length; c++) {
        var rg = cross[c];
        if (rg.start < cursor) continue;
        appendOriginal(cursor, rg.start);
        out[idxAt(rg.start)] += rg.replacement;
        cursor = rg.end;
      }
      appendOriginal(cursor, joined.length);
      for (var w = 0; w < pieces.length; w++) {
        if (out[w] !== pieces[w].text) {
          result.writes.set(pieces[w].node, out[w]);
          result.handled.add(pieces[w].node);
        }
      }
    });
    return result;
  }

  /* Canvas / image / PDF-canvas content has no text node at all. A selector
     rule with maskType=blur covers it visually instead. */
  function applyVisualRules() {
    var rules = activeSelectorRules.filter(function (r) { return r.maskType === 'blur'; });
    var keep = new Set(), roots = allRoots();
    for (var i = 0; i < rules.length; i++) {
      for (var j = 0; j < roots.length; j++) {
        var list = [];
        try { list = roots[j].querySelectorAll ? Array.prototype.slice.call(roots[j].querySelectorAll(rules[i].selector)) : []; }
        catch (e) { list = []; }
        for (var k = 0; k < list.length; k++) {
          var el = list[k];
          if (keep.has(el)) continue;
          keep.add(el);
          try {
            el.setAttribute('data-mg-blur', '1');
            if (el.style && el.style.setProperty) el.style.setProperty('--mg-blur', rules[i].blurRadius + 'px');
          } catch (e) {}
        }
      }
    }
    visualNodes.forEach(function (el) {
      if (!keep.has(el)) clearVisual(el);
    });
    visualNodes = keep;
    return keep.size;
  }

  function clearVisual(el) {
    try {
      if (el.removeAttribute) el.removeAttribute('data-mg-blur');
      else el.setAttribute('data-mg-blur', '');
      if (el.style && el.style.setProperty) el.style.setProperty('--mg-blur', '');
    } catch (e) {}
  }

  /* Display-only attributes. input.value / data-* / href / src are NEVER
     touched: changing them would break form submission and navigation. */
  function savedAttrs(el) {
    for (var i = 0; i < attrOriginals.length; i++) if (attrOriginals[i].el === el) return attrOriginals[i].values;
    var item = { el: el, values: {} };
    attrOriginals.push(item);
    return item.values;
  }

  function applyAttributeRules() {
    if (!config.settings.maskAttributes || !activeRegexRules.length) { restoreAttributes(); return 0; }
    var roots = allRoots(), count = 0;
    for (var i = 0; i < roots.length; i++) {
      var list = [];
      try { list = roots[i].querySelectorAll ? Array.prototype.slice.call(roots[i].querySelectorAll('[placeholder], [title], [alt], [aria-label], [aria-valuetext]')) : []; }
      catch (e) { list = []; }
      for (var j = 0; j < list.length; j++) {
        var el = list[j], saved = savedAttrs(el);
        for (var a = 0; a < ATTR_NAMES.length; a++) {
          var name = ATTR_NAMES[a];
          var raw = el.getAttribute ? el.getAttribute(name) : null;
          if (raw === null || raw === undefined) continue;
          if (saved[name] === undefined) saved[name] = raw;
          var out = Core.applyRules(saved[name], activeRegexRules, maskOptions).text;
          if (out !== saved[name] && el.getAttribute(name) !== out) { el.setAttribute(name, out); count++; }
        }
      }
    }
    return count;
  }

  function restoreAttributes() {
    for (var i = 0; i < attrOriginals.length; i++) {
      var item = attrOriginals[i];
      for (var a = 0; a < ATTR_NAMES.length; a++) {
        var name = ATTR_NAMES[a];
        if (item.values[name] === undefined) continue;
        try { if (item.el.getAttribute(name) !== item.values[name]) item.el.setAttribute(name, item.values[name]); } catch (e) {}
      }
    }
    attrOriginals = [];
  }

  function applyTitleRule() {
    if (typeof document.title !== 'string') return 0;
    if (!config.settings.maskTitle || !activeRegexRules.length) { restoreTitle(); return 0; }
    var cur = document.title;
    var logical = (titleOutput !== null && cur === titleOutput && titleOriginal !== null) ? titleOriginal : cur;
    titleOriginal = logical;
    var out = Core.applyRules(logical, activeRegexRules, maskOptions).text;
    titleOutput = out;
    if (out !== cur) { try { document.title = out; } catch (e) {} }
    return out !== logical ? 1 : 0;
  }

  function restoreTitle() {
    if (titleOriginal !== null && typeof document.title === 'string') {
      try { document.title = titleOriginal; } catch (e) {}
    }
    titleOriginal = null; titleOutput = null;
  }

  function wrapApply(fn) {
    if (applying) { schedule([], true); return 0; }
    applying = true;
    var hits = 0;
    try { hits = fn(); }
    finally {
      applying = false;
      if (observer) { try { observer.takeRecords(); } catch (e) {} }
    }
    if (hits) { hitTotal += hits; report(); }
    else report();
    return hits;
  }

  function fullScan() {
    if (!shouldRun()) { restoreAll(); return 0; }
    if (!document.body) return 0;
    return wrapApply(function () {
      var hits = 0;
      var nodes = collectAllTextNodes();
      var join = applyJoinScan(nodes);
      for (var i = 0; i < nodes.length; i++) {
        if (join.handled.has(nodes[i])) hits += writeNode(nodes[i], join.writes.get(nodes[i]));
        else hits += processNode(nodes[i]);
      }
      hits += applyVisualRules();
      hits += applyAttributeRules();
      hits += applyTitleRule();
      return hits;
    });
  }

  function scanGiven(set) {
    if (!shouldRun()) { restoreAll(); return 0; }
    return wrapApply(function () {
      var hits = 0;
      set.forEach(function (n) { hits += processNode(n); });
      hits += applyVisualRules();
      return hits;
    });
  }

  function restoreAll() {
    if (altShown) { reveal(false); altShown = false; }
    if (!document.documentElement) return;
    applying = true;
    try {
      eachTextNode(function (n) {
        var orig = originals.get(n);
        var out = outputs.get(n);
        if (orig !== undefined && out !== undefined && n.nodeValue === out) n.nodeValue = orig;
        originals.delete(n);
        outputs.delete(n);
      });
      maskedCount = 0;
      visualNodes.forEach(function (el) { clearVisual(el); });
      visualNodes = new Set();
      restoreAttributes();
      restoreTitle();
      if (observer) { try { observer.takeRecords(); } catch (e) {} }
    } finally { applying = false; }
    report();
  }

  function reveal(on) {
    if (!config.settings.revealOnAlt && on) return;
    applying = true;
    try {
      eachTextNode(function (n) {
        var orig = originals.get(n);
        var out = outputs.get(n);
        if (orig === undefined || out === undefined) return;
        if (on && n.nodeValue === out) n.nodeValue = orig;
        else if (!on && n.nodeValue === orig) n.nodeValue = out;
      });
      if (on) {
        visualNodes.forEach(function (el) { clearVisual(el); });
      } else if (visualNodes.size) {
        applyVisualRules();
      }
      if (observer) { try { observer.takeRecords(); } catch (e) {} }
    } finally { applying = false; }
  }

  /* ---------- dynamic DOM ---------- */

  function schedule(nodes, full) {
    if (full) needFull = true;
    if (!pendingNodes) pendingNodes = new Set();
    if (nodes && nodes.length) nodes.forEach(function (n) { pendingNodes.add(n); });
    clearTimeout(scanTimer);
    // Guarantee a scan even on pages with continuous DOM churn: never let
    // debounce resets postpone masking indefinitely (hard cap 600 ms).
    if (!firstPendingAt) firstPendingAt = Date.now();
    var delay = Math.min(600, Math.max(30, parseInt(config.settings.debounceMs, 10) || 120));
    var elapsed = Date.now() - firstPendingAt;
    scanTimer = setTimeout(runScheduled, Math.max(0, Math.min(delay, 600 - elapsed)));
  }

  function runScheduled() {
    firstPendingAt = 0;
    var full = needFull || !pendingNodes || pendingNodes.size > 400;
    var set = pendingNodes;
    pendingNodes = null;
    needFull = false;
    if (full) fullScan();
    else if (set && set.size) scanGiven(set);
  }

  var observedShadowRoots = new Set();

  /* A MutationObserver watching the main document does NOT see changes inside
     a shadow root; each root has to be observed separately. */
  function syncShadowObservers() {
    if (!observer || !config.settings.maskShadowDom || !config.settings.observeDynamic) return;
    var roots = shadowRoots(document.body || document.documentElement);
    for (var i = 0; i < roots.length; i++) {
      if (observedShadowRoots.has(roots[i])) continue;
      try {
        observer.observe(roots[i], {
          childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ATTR_NAMES
        });
        observedShadowRoots.add(roots[i]);
      } catch (e) {}
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function (records) {
      if (applying || !shouldRun() || !config.settings.observeDynamic) return;
      var nodes = [];
      var hasSelector = activeSelectorRules.length > 0;
      var full = false;
      for (var i = 0; i < records.length; i++) {
        var m = records[i];
        if (m.type === 'characterData') {
          nodes.push(m.target);
        } else if (m.type === 'attributes') {
          if (config.settings.maskAttributes) full = true;
        } else if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j];
            if (n.nodeType === 3) nodes.push(n);
            else if (n.nodeType === 1) {
              nodes = nodes.concat(collectTextNodes(n));
              full = true; // structural insertion: full scan is the safety net
            }
          }
          if (hasSelector) full = true;
        }
      }
      syncShadowObservers();
      if (full || nodes.length) schedule(nodes, full);
    });
    // Observe the Document node itself: works at document_start when <html> may not exist yet.
    observer.observe(document, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTR_NAMES
    });
    syncShadowObservers();
  }

  /* ---------- reporting ---------- */

  function state() {
    return {
      enabled: config.enabled,
      siteAllowed: siteOk(),
      siteMode: config.siteMode,
      host: location.hostname,
      masked: maskedCount,
      hits: hitTotal,
      regexRules: activeRegexRules.length,
      selectorRules: activeSelectorRules.length,
      sessionRules: sessionRules.length,
      picking: !!pick
    };
  }

  function report() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(function () {
      safeRuntime({
        type: 'MG_REPORT',
        masked: maskedCount,
        hits: hitTotal,
        badge: !!config.settings.badge
      });
    }, 120);
  }

  /* ---------- config sync ---------- */

  function loadConfig(cb) {
    chrome.storage.local.get('config', function (data) {
      config = Core.normalizeConfig(data && data.config);
      refreshActiveRules();
      if (cb) cb();
    });
  }

  function applyConfigChange() {
    refreshActiveRules();
    if (!shouldRun()) { restoreAll(); return; }
    // Recompute from original text: restore first, then scan against the new rules.
    restoreAll();
    fullScan();
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.config) return;
    config = Core.normalizeConfig(changes.config.newValue);
    applyConfigChange();
  });

  /* ---------- element picker ---------- */

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (/^(html|body)$/i.test(el.tagName)) return ''; // would blank the whole page
    if (el.id && /^[A-Za-z][\w:-]*$/.test(el.id)) {
      var idSel = '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
      try { if (document.querySelectorAll(idSel).length === 1) return idSel; } catch (e) {}
    }
    var parts = [];
    var cur = el;
    var esc = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : s; };
    while (cur && cur.nodeType === 1 && parts.length < 7) {
      var part = cur.tagName.toLowerCase();
      var cls = [];
      try {
        cls = Array.prototype.slice.call(cur.classList)
          .filter(function (c) { return !/^(is-|has-|active|hover|focus|selected|ng-|css-|_)/.test(c) && /^[A-Za-z][\w-]*$/.test(c); })
          .slice(0, 2);
      } catch (e) {}
      if (cls.length) part += '.' + cls.map(esc).join('.');
      if (cur.parentElement) {
        var same = Array.prototype.filter.call(cur.parentElement.children, function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      var candidate = parts.join(' > ');
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (e) {}
      if (cur === document.documentElement) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function elementLabel(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return t || el.tagName.toLowerCase();
  }

  function showToast(text) {
    var old = document.getElementById('mg-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'mg-toast';
    el.textContent = text;
    (document.body || document.documentElement).appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 3200);
  }

  function commitRule(rule, text) {
    safeRuntime({ type: 'MG_ADD_RULE', rule: rule }, function (res) {
      showToast(res && res.ok ? text : '规则保存失败，请在设置页查看');
    });
  }

  function startPick() {
    if (!IS_TOP || pick) return false;
    var box = document.createElement('div');
    box.id = 'mg-picker-box';
    var tip = document.createElement('div');
    tip.id = 'mg-picker-tip';
    tip.textContent = 'MaskGuard 选择模式：移动鼠标定位，单击选择要遮盖的区域，Esc 取消';
    (document.body || document.documentElement).appendChild(box);
    (document.body || document.documentElement).appendChild(tip);
    pick = { box: box, tip: tip, target: null };
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
    document.addEventListener('scroll', onPickScroll, true);
    return true;
  }

  function stopPick(silent) {
    if (!pick) return;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    document.removeEventListener('scroll', onPickScroll, true);
    if (pick.box.parentNode) pick.box.remove();
    if (pick.tip.parentNode) pick.tip.remove();
    pick = null;
    if (!silent) showToast('已取消选择');
    report();
  }

  function highlight(el) {
    if (!pick || !el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    var s = pick.box.style;
    s.display = 'block';
    s.left = r.left + 'px';
    s.top = r.top + 'px';
    s.width = r.width + 'px';
    s.height = r.height + 'px';
  }

  function onPickMove(e) {
    if (!pick) return;
    var el = e.target;
    if (el && el.nodeType === 3) el = el.parentElement;
    if (!el || el.nodeType !== 1 || el.closest('#mg-picker-tip, #mg-toast')) return;
    pick.target = el;
    highlight(el);
  }

  function onPickScroll() { if (pick && pick.target) highlight(pick.target); }

  function onPickKey(e) {
    if (!pick) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      stopPick(false);
    }
  }

  function onPickClick(e) {
    if (!pick) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (el && el.nodeType === 3) el = el.parentElement;
    if (!el || el.nodeType !== 1) { stopPick(false); return; }
    var selector = cssPath(el);
    var label = elementLabel(el);
    stopPick(true);
    if (!selector || Core.isOverbroadSelector(selector)) {
      showToast('该区域范围过大，请选择更具体的元素');
      return;
    }
    commitRule({
      id: Core.uid(), name: '手动位置 · ' + label, kind: 'selector', enabled: true,
      selector: selector, maskType: 'fixed', maskChar: '█', fixedLength: 8,
      note: location.hostname + ' · ' + (location.pathname || '/')
    }, '已添加位置规则：' + selector.slice(0, 46));
  }

  document.addEventListener('contextmenu', function (e) {
    var el = e.target;
    if (el && el.nodeType === 3) el = el.parentElement;
    lastContextEl = el && el.nodeType === 1 ? el : null;
  }, true);

  /* ---------- messages ---------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (sender && sender.id && sender.id !== chrome.runtime.id) return; // same-extension only
    switch (msg.type) {
      case 'MG_GET_STATE':
        sendResponse(state());
        break;
      case 'MG_REFRESH':
        loadConfig(function () { applyConfigChange(); sendResponse({ ok: true, state: state() }); });
        return true;
      case 'MG_RESTORE':
        restoreAll(); sendResponse({ ok: true });
        break;
      case 'MG_REAPPLY':
        applyConfigChange(); sendResponse({ ok: true });
        break;
      case 'MG_START_PICK':
        sendResponse({ ok: startPick() });
        break;
      case 'MG_STOP_PICK':
        stopPick(true); sendResponse({ ok: true });
        break;
      case 'MG_PICK_ELEMENT':
        if (lastContextEl) {
          var selector = cssPath(lastContextEl);
          if (selector) {
            commitRule({
              id: Core.uid(), name: '手动位置 · ' + elementLabel(lastContextEl),
              kind: 'selector', enabled: true, selector: selector,
              maskType: 'fixed', maskChar: '█', fixedLength: 8,
              note: location.hostname + ' · ' + (location.pathname || '/')
            }, '已添加位置规则：' + selector.slice(0, 46));
          }
          sendResponse({ ok: !!selector, selector: selector });
        } else sendResponse({ ok: false });
        break;
      case 'MG_MASK_SELECTION': {
        var sel = String(window.getSelection ? window.getSelection().toString() : '').trim();
        if (sel) {
          // Keep the literal in memory only: persisting it would store the
          // sensitive value itself in chrome.storage.
          var snippet = sel.length > 160 ? sel.slice(0, 160) : sel;
          sessionRules.push(Core.normalizeRule({
            id: Core.uid(), name: '临时选中文本', kind: 'regex', enabled: true,
            pattern: Core.escapeRegExp(snippet), flags: 'g',
            maskType: 'full', maskChar: '█', note: '仅本次页面生效'
          }));
          refreshActiveRules();
          restoreAll();
          fullScan();
          showToast('已遮盖选中文本（仅本页生效，原文不写入本地存储）');
        }
        sendResponse({ ok: !!sel, transient: true });
        break;
      }
      case 'MG_TEST_SELECTOR':
        var count = 0, err = '';
        try { count = document.querySelectorAll(msg.selector).length; }
        catch (e2) { err = e2.message; }
        sendResponse({ ok: !err, count: count, error: err });
        break;
      case 'MG_INSERT_DEMO': {
        var box = document.createElement('div');
        box.setAttribute('data-mg-demo', '1');
        var h = document.createElement('div');
        h.textContent = 'MaskGuard 演示数据 · 15 秒后自动移除';
        var p1 = document.createElement('p');
        p1.textContent = '手机号：13800138000　证件号：110101199001011234';
        var p2 = document.createElement('p');
        p2.textContent = '银行卡：6222021234567890123　邮箱：zhangsan@example.com';
        box.appendChild(h); box.appendChild(p1); box.appendChild(p2);
        (document.body || document.documentElement).appendChild(box);
        schedule([], true); // apply rules immediately, not only via observer
        setTimeout(function () { if (box.parentNode) box.remove(); }, 15000);
        sendResponse({ ok: true });
        break;
      }
    }
  });

  /* ---------- boot ---------- */

  function boot() {
    loadConfig(function () {
      chrome.storage.local.set({ config: config }); // ensure full config is persisted
      startObserver();
      fullScan();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { fullScan(); }, { once: true });
      }
      if (config.settings.revealOnAlt) {
        document.addEventListener('keydown', function (e) {
          if ((e.key === 'Alt' || e.altKey) && !altShown) { altShown = true; reveal(true); }
        }, true);
        document.addEventListener('keyup', function (e) {
          if (!e.altKey && altShown) { altShown = false; reveal(false); }
        }, true);
        window.addEventListener('blur', function () {
          if (altShown) { altShown = false; reveal(false); }
        });
      }
    });
  }

  boot();
})();
