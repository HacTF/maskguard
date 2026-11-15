/* MaskGuard core - pure logic, no DOM. Loaded by content script, popup and Node tests. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MaskGuardCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MASK_TYPES = [
    { id: 'full', name: '全部遮盖', desc: '按原文长度逐字符替换', fields: ['maskChar'] },
    { id: 'partial', name: '部分保留', desc: '保留前 N 位与后 M 位', fields: ['keepStart', 'keepEnd', 'maskChar'] },
    { id: 'fixed', name: '固定长度', desc: '统一替换为定长遮盖符', fields: ['fixedLength', 'maskChar'] },
    { id: 'label', name: '标签替换', desc: '替换为 [已脱敏] 等说明文字', fields: ['label'] },
    { id: 'hash', name: '哈希摘要', desc: '不可逆摘要，同一原文结果一致', fields: [] },
    { id: 'pattern', name: '保格式打乱', desc: '数字换随机数字、字母换 X，格式不变', fields: [] },
    { id: 'custom', name: '自定义替换', desc: '直接替换为指定文本', fields: ['custom'] },
    { id: 'blur', name: '视觉模糊（图片 / Canvas）', desc: '仅用于「指定位置」规则：对容器加高斯模糊，遮盖无文本节点的内容', fields: ['blurRadius'] }
  ];

  var MASK_CHARS = [
    { value: '*', label: '星号 *' },
    { value: '█', label: '黑条 █' },
    { value: '●', label: '圆点 ●' },
    { value: '·', label: '中点 ·' },
    { value: '#', label: '井号 #' },
    { value: 'x', label: '小写 x' }
  ];

  var LIMITS = {
    maxRules: 100,
    maxPattern: 2000,
    maxSelector: 1000,
    maxTextLength: 8000,
    maxName: 100,
    maxText: 200,
    maxNote: 200
  };

  function uid(prefix) {
    return (prefix || 'r') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* Only allow deterministic, global-friendly flags. Sticky (y) breaks the
     "replace all matches" contract; unknown flags are dropped. */
  function sanitizeFlags(f) {
    var s = String(f || '').replace(/[^gimsu]/g, '');
    if (s.indexOf('g') === -1) s += 'g';
    return s;
  }

  /* Heuristic ReDoS guard. Catches classic exponential-backtracking shapes
     such as (a+)+, (.*)*, (a|aa)+. Fixed-length inner quantifiers ({3}) are
     intentionally NOT flagged so common patterns like (?:\d{3}-)+ still work. */
  function auditPattern(pattern) {
    var s = String(pattern || '');
    var issues = [];
    if (s.length > LIMITS.maxPattern) issues.push('表达式超过 ' + LIMITS.maxPattern + ' 字符上限');
    if (/\((?:\\.|[^()\\])*[+*](?:\\.|[^()\\])*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(s)) {
      issues.push('嵌套量词（如 (a+)+）可能引发灾难性回溯');
    }
    if (/\((?:\\.|[^()\\])*\|(?:\\.|[^()\\])*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(s)) {
      issues.push('交替分组叠加量词可能引发灾难性回溯');
    }
    return issues;
  }

  /* A selector matching the whole document would blank the entire page. */
  function isOverbroadSelector(sel) {
    var s = String(sel || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return true;
    return s.split(',').some(function (part) {
      return ['html', 'body', ':root', '*', 'html>body', 'body*', 'htmlbody',
        'body>*', 'html>*', 'html*', 'body>div*'].indexOf(part) >= 0;
    });
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  /* Deterministic pseudo-random digits: same input always yields same masked output. */
  function seededDigits(str, count) {
    var seed = fnv1a(str) || 1;
    var out = '';
    for (var i = 0; i < count; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      out += String(seed % 10);
    }
    return out;
  }

  function buildRegex(rule, opts) {
    if (!rule || !rule.pattern) return null;
    if (auditPattern(rule.pattern).length && !(opts && opts.allowUnsafe)) return null;
    try {
      return new RegExp(rule.pattern, sanitizeFlags(rule.flags));
    } catch (e) {
      return null;
    }
  }

  function validateRegex(pattern, flags) {
    var warnings = auditPattern(pattern);
    try {
      new RegExp(pattern, sanitizeFlags(flags));
      return { ok: true, error: '', warnings: warnings };
    } catch (e) {
      return { ok: false, error: e.message, warnings: warnings };
    }
  }

  function clampInt(v, fallback, min, max) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = fallback;
    return Math.min(max, Math.max(min, n));
  }

  /* Generate the replacement for ONE matched value. */
  function maskValue(value, rule) {
    var c = (rule.maskChar !== undefined && rule.maskChar !== null && rule.maskChar !== '')
      ? String(rule.maskChar) : '*';
    var len = value.length;
    switch (rule.maskType) {
      case 'partial': {
        var s = clampInt(rule.keepStart, 3, 0, 100);
        var e = clampInt(rule.keepEnd, 4, 0, 100);
        if (s + e >= len) return repeat(c, len);
        return value.slice(0, s) + repeat(c, len - s - e) + value.slice(len - e);
      }
      case 'fixed':
        return repeat(c, clampInt(rule.fixedLength, 6, 1, 200));
      case 'label':
        return String(rule.label || '[已脱敏]');
      case 'hash':
        return '[H:' + fnv1a(value).toString(16).padStart(8, '0').slice(0, 8) + ']';
      case 'pattern': {
        var digits = seededDigits(value, len);
        var di = 0;
        return value.replace(/[0-9]/g, function () { return digits[di++]; })
          .replace(/[A-Za-z]/g, 'X');
      }
      case 'custom':
        return String(rule.custom === undefined || rule.custom === '' ? repeat(c, len) : rule.custom);
      case 'blur':
        // Visual blur is element-level (no text node to replace); fall back to
        // full masking if a regex rule is somehow configured with it.
        return repeat(c, len);
      case 'full':
      default:
        return repeat(c, len);
    }
  }

  function repeat(c, n) {
    if (n <= 0) return '';
    if (c.length > 1) c = c.charAt(0);
    return c.repeat(n);
  }

  /* Apply regex rules in order. Already-masked segments are locked out so later
     rules never re-match a replacement string. */
  function applyRules(input, rules, opts) {
    var text = String(input == null ? '' : input);
    var limit = (opts && opts.maxTextLength) || LIMITS.maxTextLength;
    if (text.length > limit) return { text: text, hits: [], count: 0, skipped: true };
    var segments = [{ text: text, locked: false }];
    var hits = [];
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule || rule.enabled === false || rule.kind !== 'regex') continue;
      var re = buildRegex(rule, opts);
      if (!re) continue;
      var next = [];
      var count = 0;
      for (var j = 0; j < segments.length; j++) {
        var seg = segments[j];
        if (seg.locked || !seg.text) { next.push(seg); continue; }
        var pieces = [];
        var last = 0, m, n = 0;
        re.lastIndex = 0;
        while ((m = re.exec(seg.text)) !== null) {
          if (m[0].length === 0) {
            if (!re.global) break;
            re.lastIndex++;
            continue;
          }
          if (m.index > last) pieces.push({ text: seg.text.slice(last, m.index), locked: false });
          pieces.push({ text: maskValue(m[0], rule), locked: true });
          count++; n++;
          last = m.index + m[0].length;
          if (!re.global) break;
        }
        if (n === 0) {
          next.push(seg);
        } else {
          next = next.concat(pieces);
          if (last < seg.text.length) next.push({ text: seg.text.slice(last), locked: false });
        }
      }
      segments = next;
      if (count) hits.push({ ruleId: rule.id, name: rule.name, count: count });
    }
    var out = '';
    for (var k = 0; k < segments.length; k++) out += segments[k].text;
    return { text: out, hits: hits, count: hits.reduce(function (a, b) { return a + b.count; }, 0) };
  }

  /* Return match ranges against the ORIGINAL string, so the content script can
     mask values split across several adjacent text nodes (formatter / syntax
     highlighting). Already-matched ranges are locked out, matching applyRules'
     semantics. Offsets always refer to the input string, never to replacements. */
  function matchRanges(input, rules, opts) {
    var text = String(input == null ? '' : input);
    var limit = (opts && opts.maxTextLength) || LIMITS.maxTextLength;
    if (text.length > limit) return [];
    var taken = [];
    var ranges = [];
    function overlaps(s, e) {
      for (var k = 0; k < taken.length; k++) {
        if (s < taken[k].end && e > taken[k].start) return true;
      }
      return false;
    }
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule || rule.enabled === false || rule.kind !== 'regex' || rule.maskType === 'blur') continue;
      var re = buildRegex(rule, opts);
      if (!re) continue;
      re.lastIndex = 0;
      var m, guard = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { if (!re.global) break; re.lastIndex++; continue; }
        var s = m.index, e = s + m[0].length;
        if (!overlaps(s, e)) {
          ranges.push({ start: s, end: e, replacement: maskValue(m[0], rule) });
          taken.push({ start: s, end: e });
        }
        if (!re.global || ++guard > 2000) break;
      }
    }
    ranges.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return ranges;
  }

  function normalizeHost(entry) {
    var s = String(entry || '').trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z]+:\/\//, '').replace(/^\/\//, '');
    s = s.split(/[/\s]/)[0].replace(/:\d+$/, '');
    s = s.replace(/^\*?\./, function (m) { return m; });
    return s.replace(/^\.+/, '');
  }

  function hostMatches(host, entry) {
    var h = normalizeHost(host);
    var e = normalizeHost(entry);
    if (!h || !e) return false;
    var wildcard = e.charAt(0) === '*';
    if (wildcard) e = e.replace(/^\*\.?/, '');
    if (!e) return false;
    if (h === e) return true;
    if (wildcard) return h.endsWith('.' + e);
    return h.endsWith('.' + e);
  }

  function siteAllowed(config, host) {
    var list = (config && config.siteList) || [];
    var mode = (config && config.siteMode) || 'all';
    if (mode === 'all') return true;
    var matched = list.some(function (e) { return hostMatches(host, e); });
    return mode === 'whitelist' ? matched : !matched;
  }

  function makeDefaultRules() {
    return [
      {
        id: 'builtin_idcard', name: '身份证号', kind: 'regex', enabled: true,
        pattern: '(?<!\\d)\\d{17}[\\dXx](?!\\d)', flags: 'g',
        maskType: 'partial', maskChar: '*', keepStart: 6, keepEnd: 4,
        fixedLength: 6, label: '[证件号已脱敏]', custom: '', note: '18 位居民身份证'
      },
      {
        id: 'builtin_bankcard', name: '银行卡号', kind: 'regex', enabled: true,
        pattern: '(?<!\\d)\\d{16,19}(?!\\d)', flags: 'g',
        maskType: 'partial', maskChar: '*', keepStart: 4, keepEnd: 4,
        fixedLength: 6, label: '[卡号已脱敏]', custom: '', note: '16-19 位卡号'
      },
      {
        id: 'builtin_phone', name: '手机号', kind: 'regex', enabled: true,
        pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', flags: 'g',
        maskType: 'partial', maskChar: '*', keepStart: 3, keepEnd: 4,
        fixedLength: 6, label: '[手机号已脱敏]', custom: '', note: '中国大陆 11 位手机号'
      },
      {
        id: 'builtin_email', name: '邮箱地址', kind: 'regex', enabled: true,
        pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', flags: 'g',
        maskType: 'partial', maskChar: '*', keepStart: 2, keepEnd: 0,
        fixedLength: 8, label: '[邮箱已脱敏]', custom: '', note: ''
      },
      {
        id: 'builtin_ip', name: 'IP 地址', kind: 'regex', enabled: false,
        pattern: '(?<!\\d)(?:\\d{1,3}\\.){3}\\d{1,3}(?!\\d)', flags: 'g',
        maskType: 'fixed', maskChar: '*', keepStart: 0, keepEnd: 0,
        fixedLength: 8, label: '[IP 已脱敏]', custom: '', note: '默认关闭，避免误伤版本号'
      }
    ];
  }

  function defaultConfig() {
    return {
      version: 1,
      enabled: true,
      siteMode: 'all',
      siteList: [],
      settings: {
        observeDynamic: true,
        debounceMs: 120,
        revealOnAlt: true,
        badge: true,
        allowUnsafeRegex: false,
        maxTextLength: 8000,
        joinSplitText: true,
        maskShadowDom: true,
        maskSvgText: false,
        maskAttributes: false,
        maskTitle: false,
        skipSelectors: 'script, style, noscript, textarea, input, select, option, svg, math, canvas, iframe, object, embed, [contenteditable="true"], [data-mg-skip]'
      },
      rules: makeDefaultRules()
    };
  }

  /* Fill in missing fields so old / imported rules never break the content script. */
  function normalizeRule(r) {
    return {
      id: r.id || uid(),
      name: String(r.name || '未命名规则').slice(0, LIMITS.maxName),
      kind: r.kind === 'selector' ? 'selector' : 'regex',
      enabled: r.enabled !== false,
      pattern: String(r.pattern || '').slice(0, LIMITS.maxPattern),
      flags: sanitizeFlags(r.flags),
      selector: String(r.selector || '').slice(0, LIMITS.maxSelector),
      maskType: r.maskType || 'full',
      maskChar: r.maskChar === undefined ? '*' : String(r.maskChar).slice(0, 2),
      keepStart: clampInt(r.keepStart, 3, 0, 100),
      keepEnd: clampInt(r.keepEnd, 4, 0, 100),
      fixedLength: clampInt(r.fixedLength, 6, 1, 200),
      blurRadius: clampInt(r.blurRadius, 8, 1, 40),
      label: r.label === undefined ? '[已脱敏]' : String(r.label).slice(0, LIMITS.maxText),
      custom: r.custom === undefined ? '' : String(r.custom).slice(0, LIMITS.maxText),
      note: String(r.note || '').slice(0, LIMITS.maxNote)
    };
  }

  function normalizeConfig(raw) {
    var d = defaultConfig();
    var c = raw && typeof raw === 'object' ? raw : {};
    return {
      version: 1,
      enabled: c.enabled !== false,
      siteMode: ['all', 'whitelist', 'blacklist'].indexOf(c.siteMode) >= 0 ? c.siteMode : 'all',
      siteList: Array.isArray(c.siteList) ? c.siteList.filter(function (x) { return !!String(x).trim(); }) : [],
      settings: Object.assign({}, d.settings, (c.settings && typeof c.settings === 'object') ? c.settings : {}),
      rules: (Array.isArray(c.rules) ? c.rules : d.rules).slice(0, LIMITS.maxRules).map(normalizeRule)
    };
  }

  return {
    MASK_TYPES: MASK_TYPES,
    MASK_CHARS: MASK_CHARS,
    LIMITS: LIMITS,
    uid: uid,
    sanitizeFlags: sanitizeFlags,
    auditPattern: auditPattern,
    isOverbroadSelector: isOverbroadSelector,
    escapeRegExp: escapeRegExp,
    fnv1a: fnv1a,
    buildRegex: buildRegex,
    validateRegex: validateRegex,
    maskValue: maskValue,
    applyRules: applyRules,
    matchRanges: matchRanges,
    normalizeHost: normalizeHost,
    hostMatches: hostMatches,
    siteAllowed: siteAllowed,
    defaultConfig: defaultConfig,
    makeDefaultRules: makeDefaultRules,
    normalizeRule: normalizeRule,
    normalizeConfig: normalizeConfig
  };
});
