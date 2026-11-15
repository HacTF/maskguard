/* MaskGuard control panel (popup + options page share this file). */
(function () {
  'use strict';
  var Core = globalThis.MaskGuardCore;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var isFull = new URLSearchParams(location.search).has('full');
  if (isFull) document.body.classList.add('full');

  var config = Core.defaultConfig();
  var currentTab = null;
  var editingId = null;
  var formOpen = false;
  var formRule = null;

  function storageGet(k) { return new Promise(function (r) { chrome.storage.local.get(k, r); }); }
  function storageSet(o) { return new Promise(function (r) { chrome.storage.local.set(o, r); }); }
  function tabMsg(msg) {
    return new Promise(function (resolve) {
      if (!currentTab || !currentTab.id) return resolve(null);
      chrome.tabs.sendMessage(currentTab.id, msg, function (res) {
        resolve(chrome.runtime.lastError ? null : res);
      });
    });
  }
  function flash(t) {
    var e = $('#footHint'); e.textContent = t;
    setTimeout(function () { if (e.textContent === t) e.textContent = ''; }, 2600);
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function maskTypeName(id) {
    for (var i = 0; i < Core.MASK_TYPES.length; i++) if (Core.MASK_TYPES[i].id === id) return Core.MASK_TYPES[i].name;
    return id;
  }
  function maskSummary(r) {
    var s = maskTypeName(r.maskType);
    if (r.maskType === 'partial') s += '（前 ' + r.keepStart + ' / 后 ' + r.keepEnd + '）';
    if (r.maskType === 'fixed') s += '（' + r.fixedLength + ' 位）';
    if (r.maskType === 'label') s += '（' + r.label + '）';
    if (r.maskType === 'custom') s += '（' + r.custom + '）';
    if (['full', 'partial', 'fixed'].indexOf(r.maskType) >= 0) s += ' · ' + r.maskChar;
    return s;
  }
  async function saveConfig(msg) {
    await storageSet({ config: config });
    if (msg) flash(msg);
  }
  function mkBtn(text, cls, fn) {
    var b = el('button', cls || '', text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  /* ---------- rules list ---------- */

  function renderRules() {
    var host = $('#ruleList');
    host.innerHTML = '';
    if (!config.rules.length) {
      host.appendChild(el('div', 'empty', '暂无规则。点「新增规则」自定义正则，或用右键 / 框选添加。'));
      return;
    }
    config.rules.forEach(function (r, i) {
      var card = el('div', 'card' + (r.enabled ? '' : ' disabled'));
      var top = el('div', 'card-top');
      var sw = document.createElement('input');
      sw.type = 'checkbox'; sw.checked = r.enabled;
      sw.addEventListener('change', function () {
        r.enabled = sw.checked;
        saveConfig(r.enabled ? '已启用规则' : '已停用规则');
        renderRules();
      });
      top.appendChild(sw);
      top.appendChild(el('span', 'card-name', r.name));
      top.appendChild(el('span', 'tag' + (r.kind === 'selector' ? ' sel' : ''), r.kind === 'selector' ? '位置' : '正则'));
      card.appendChild(top);
      card.appendChild(el('div', 'card-expr', r.kind === 'selector' ? r.selector : '/' + r.pattern + '/' + r.flags));
      card.appendChild(el('div', 'card-meta', maskSummary(r) + (r.note ? ' · ' + r.note : '')));

      var acts = el('div', 'card-actions');
      acts.appendChild(mkBtn('编辑', '', function () { openForm(r); }));
      acts.appendChild(mkBtn('复制', '', function () {
        var copy = Object.assign({}, r, { id: Core.uid(), name: r.name + '（副本）' });
        config.rules.splice(i + 1, 0, copy);
        saveConfig('已复制规则'); renderRules();
      }));
      acts.appendChild(mkBtn('↑', '', function () {
        if (i === 0) return;
        config.rules.splice(i, 1); config.rules.splice(i - 1, 0, r);
        saveConfig(); renderRules();
      }));
      acts.appendChild(mkBtn('↓', '', function () {
        if (i >= config.rules.length - 1) return;
        config.rules.splice(i, 1); config.rules.splice(i + 1, 0, r);
        saveConfig(); renderRules();
      }));
      acts.appendChild(mkBtn('删除', 'del', function () {
        config.rules.splice(i, 1);
        saveConfig('已删除规则'); renderRules();
      }));
      card.appendChild(acts);
      host.appendChild(card);
    });
  }

  /* ---------- rule form ---------- */

  var FORM_HTML = '' +
    '<div class="form"><h4 id="f_title">新增规则</h4>' +
    '  <div class="grid">' +
    '    <label class="lbl">名称</label><input type="text" id="f_name" placeholder="如：客户合同号">' +
    '    <label class="lbl">类型</label><select id="f_kind"><option value="regex">正则识别（自动）</option><option value="selector">指定位置（CSS 选择器）</option></select>' +
    '    <label class="lbl">启用</label><div><input type="checkbox" id="f_enabled"></div>' +
    '  </div>' +
    '  <div class="subbox mt" id="grpRegex"><div class="grid">' +
    '    <label class="lbl">正则表达式</label><input type="text" id="f_pattern" spellcheck="false" placeholder="(?&lt;!\\d)1[3-9]\\d{9}(?!\\d)">' +
    '    <label class="lbl">标志</label><div class="flags" id="f_flags">' +
    '      <label><input type="checkbox" value="g" checked disabled> g</label>' +
    '      <label><input type="checkbox" value="i"> i 忽略大小写</label>' +
    '      <label><input type="checkbox" value="m"> m 多行</label>' +
    '      <label><input type="checkbox" value="s"> s 点匹配换行</label>' +
    '    </div>' +
    '    <label class="lbl">样例测试</label><textarea id="f_sample" rows="2" spellcheck="false" placeholder="粘贴一段含敏感数据的文本，下方实时预览"></textarea>' +
    '    <div class="preview" id="f_preview"></div>' +
    '    <div class="err" id="f_regexErr"></div>' +
    '  </div></div>' +
    '  <div class="subbox mt hidden" id="grpSelector"><div class="grid">' +
    '    <label class="lbl">CSS 选择器</label><input type="text" id="f_selector" spellcheck="false" placeholder="#userInfo > td:nth-of-type(3)">' +
    '    <div class="err" id="f_selInfo"></div>' +
    '  </div>' +
    '  <div class="row gap mt"><button class="btn" type="button" id="btnTestSel">在当前页验证</button><button class="btn ghost" type="button" id="btnUsePick">改用框选</button></div>' +
    '  <p class="hint">命中元素内的全部文本会被整块遮盖。可用「框选页面位置」自动生成选择器。</p></div>' +
    '  <div class="subbox mt"><div class="grid">' +
    '    <label class="lbl">遮盖算法</label><select id="f_maskType"></select>' +
    '  </div><div class="grid mt" id="f_dyn"></div></div>' +
    '  <div class="grid mt"><label class="lbl">备注</label><input type="text" id="f_note" placeholder="可选"></div>' +
    '  <div class="err mt" id="f_err"></div>' +
    '  <div class="form-actions"><button class="btn primary" type="button" id="btnSaveRule">保存规则</button><button class="btn" type="button" id="btnCancelRule">取消</button></div>' +
    '</div>';

  function val(id, fallback) {
    var e = $(id);
    return e ? e.value : (fallback === undefined ? '' : fallback);
  }
  function numVal(id, fallback) {
    var e = $(id);
    return e ? parseInt(e.value, 10) || 0 : fallback;
  }

  function collectForm() {
    var r = formRule || Core.normalizeRule({});
    var kind = val('#f_kind', r.kind);
    var flags = 'g';
    $$('#f_flags input').forEach(function (c) { if (c.checked && c.value !== 'g') flags += c.value; });
    var mc = val('#f_maskChar', '__preset');
    if (mc === '__custom') mc = val('#f_maskCharOther', r.maskChar) || '*';
    else if (mc === '__preset') mc = r.maskChar;
    return Core.normalizeRule({
      id: editingId || Core.uid(),
      name: val('#f_name', r.name),
      kind: kind,
      enabled: $('#f_enabled') ? $('#f_enabled').checked : r.enabled,
      pattern: val('#f_pattern', r.pattern),
      flags: flags,
      selector: val('#f_selector', r.selector),
      maskType: val('#f_maskType', r.maskType),
      maskChar: mc,
      keepStart: numVal('#f_keepStart', r.keepStart),
      keepEnd: numVal('#f_keepEnd', r.keepEnd),
      fixedLength: numVal('#f_fixedLength', r.fixedLength),
      label: val('#f_label', r.label),
      custom: val('#f_custom', r.custom),
      blurRadius: numVal('#f_blurRadius', r.blurRadius),
      note: val('#f_note', r.note)
    });
  }

  function updateDyn() {
    var r = collectForm();
    formRule = r;
    var t = r.maskType;
    var fields = [];
    for (var i = 0; i < Core.MASK_TYPES.length; i++) if (Core.MASK_TYPES[i].id === t) fields = Core.MASK_TYPES[i].fields;
    var html = '';
    if (fields.indexOf('maskChar') >= 0) {
      html += '<label class="lbl">遮盖符</label><select id="f_maskChar">';
      Core.MASK_CHARS.forEach(function (c) { html += '<option value="' + c.value + '">' + c.label + '</option>'; });
      html += '<option value="__custom">自定义…</option></select>';
      html += '<label class="lbl">自定义字符</label><input type="text" id="f_maskCharOther" maxlength="2" placeholder="单个字符">';
    }
    if (fields.indexOf('keepStart') >= 0) html += '<label class="lbl">保留前 N 位</label><input type="number" id="f_keepStart" min="0" max="100">';
    if (fields.indexOf('keepEnd') >= 0) html += '<label class="lbl">保留后 M 位</label><input type="number" id="f_keepEnd" min="0" max="100">';
    if (fields.indexOf('fixedLength') >= 0) html += '<label class="lbl">固定长度</label><input type="number" id="f_fixedLength" min="1" max="200">';
    if (fields.indexOf('label') >= 0) html += '<label class="lbl">替换文本</label><input type="text" id="f_label" placeholder="[已脱敏]">';
    if (fields.indexOf('custom') >= 0) html += '<label class="lbl">替换文本</label><input type="text" id="f_custom" placeholder="自定义内容">';
    if (fields.indexOf('blurRadius') >= 0) html += '<label class="lbl">模糊半径(px)</label><input type="number" id="f_blurRadius" min="1" max="40" step="1">';
    var dyn = $('#f_dyn');
    dyn.innerHTML = html;
    if ($('#f_maskChar')) {
      var preset = Core.MASK_CHARS.some(function (c) { return c.value === r.maskChar; });
      $('#f_maskChar').value = preset ? r.maskChar : '__custom';
      if ($('#f_maskCharOther')) $('#f_maskCharOther').value = preset ? '' : r.maskChar;
    }
    if ($('#f_keepStart')) $('#f_keepStart').value = r.keepStart;
    if ($('#f_keepEnd')) $('#f_keepEnd').value = r.keepEnd;
    if ($('#f_fixedLength')) $('#f_fixedLength').value = r.fixedLength;
    if ($('#f_label')) $('#f_label').value = r.label;
    if ($('#f_custom')) $('#f_custom').value = r.custom;
    if ($('#f_blurRadius')) $('#f_blurRadius').value = r.blurRadius;
    var desc = '';
    for (var j = 0; j < Core.MASK_TYPES.length; j++) if (Core.MASK_TYPES[j].id === t) desc = Core.MASK_TYPES[j].desc;
    var old = $('#f_dynDesc'); if (old) old.remove();
    var d = el('div', 'hint', desc);
    d.id = 'f_dynDesc'; d.style.gridColumn = '1 / -1';
    dyn.appendChild(d);
    $$('#f_dyn input, #f_dyn select').forEach(function (e) { e.addEventListener('input', runPreview); e.addEventListener('change', runPreview); });
    runPreview();
  }

  function runPreview() {
    if (!formOpen || !$('#f_preview')) return;
    var r = collectForm();
    var err = $('#f_regexErr');
    var sample = val('#f_sample', '') || '示例：手机 13800138000，证件 110101199001011234，邮箱 a.b@corp.com';
    if (r.kind !== 'regex') {
      $('#f_preview').textContent = r.maskType === 'blur'
        ? '位置规则：命中容器应用高斯模糊（半径 ' + r.blurRadius + 'px），用于 Canvas、扫描件、PDF 图层等无文本节点的内容'
        : '位置规则：命中元素整块遮盖 → ' + Core.maskValue('示例文本', r);
      return;
    }
    var v = Core.validateRegex(r.pattern || '(?!x)x', r.flags);
    if (!v.ok) {
      err.textContent = '正则错误：' + v.error;
      $('#f_preview').textContent = '—';
      return;
    }
    err.textContent = v.warnings.length
      ? '⚠ ' + v.warnings.join('；') + (config.settings.allowUnsafeRegex ? '（已放行）' : '（将被安全策略拦截）')
      : '';
    var out = Core.applyRules(sample, [r], {
      allowUnsafe: !!config.settings.allowUnsafeRegex,
      maxTextLength: 8000
    });
    $('#f_preview').textContent = out.text + '\n命中 ' + out.count + ' 处 · ' + maskTypeName(r.maskType) +
      (out.count === 0 && v.warnings.length ? '（规则被拦截）' : '');
  }

  function openForm(rule) {
    editingId = rule ? rule.id : null;
    formOpen = true;
    formRule = rule ? Object.assign({}, rule) : Core.normalizeRule({
      name: '', kind: 'regex', pattern: '', flags: 'g', maskType: 'partial',
      keepStart: 3, keepEnd: 4, fixedLength: 6, maskChar: '*', label: '[已脱敏]', custom: '', selector: ''
    });
    var host = $('#formHost');
    host.innerHTML = FORM_HTML;
    $('#f_title').textContent = rule ? '编辑规则' : '新增规则';
    $('#f_name').value = formRule.name;
    $('#f_kind').value = formRule.kind;
    $('#f_enabled').checked = formRule.enabled;
    $('#f_pattern').value = formRule.pattern;
    $('#f_selector').value = formRule.selector;
    $('#f_note').value = formRule.note;
    $$('#f_flags input').forEach(function (c) { if (c.value !== 'g') c.checked = (formRule.flags || 'g').indexOf(c.value) >= 0; });
    var sel = $('#f_maskType');
    Core.MASK_TYPES.forEach(function (t) {
      var o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.appendChild(o);
    });
    sel.value = formRule.maskType;

    function syncKind() {
      var k = $('#f_kind').value;
      $('#grpRegex').classList.toggle('hidden', k !== 'regex');
      $('#grpSelector').classList.toggle('hidden', k !== 'selector');
      runPreview();
    }
    $('#f_kind').addEventListener('change', function () { formRule = collectForm(); syncKind(); });
    ['#f_pattern', '#f_sample', '#f_maskType'].forEach(function (s) {
      $(s).addEventListener('input', function () { if (s === '#f_maskType') updateDyn(); else runPreview(); });
      $(s).addEventListener('change', function () { if (s === '#f_maskType') updateDyn(); else runPreview(); });
    });
    $$('#f_flags input').forEach(function (c) { c.addEventListener('change', runPreview); });
    $('#btnTestSel').addEventListener('click', async function () {
      var s = $('#f_selector').value.trim();
      var info = $('#f_selInfo');
      if (!s) { info.textContent = '请先填写选择器'; return; }
      var res = await tabMsg({ type: 'MG_TEST_SELECTOR', selector: s });
      if (!res) info.textContent = '当前页面不支持验证（内置页或扩展商店页）';
      else if (res.ok) info.textContent = '✓ 当前页匹配 ' + res.count + ' 个元素';
      else info.textContent = '选择器无效：' + res.error;
    });
    $('#btnUsePick').addEventListener('click', startPick);
    $('#btnSaveRule').addEventListener('click', saveForm);
    $('#btnCancelRule').addEventListener('click', closeForm);

    syncKind();
    updateDyn();
    host.scrollIntoView({ block: 'nearest' });
  }

  function saveForm() {
    var r = collectForm();
    var error = '';
    if (!r.name) error = '请填写规则名称';
    else if (r.maskType === 'blur' && r.kind !== 'selector') error = '「视觉模糊」仅适用于「指定位置」规则，请把类型改为 CSS 选择器';
    else if (!editingId && config.rules.length >= Core.LIMITS.maxRules) {
      error = '规则数量已达上限 ' + Core.LIMITS.maxRules + ' 条';
    } else if (r.kind === 'regex') {
      if (!r.pattern) error = '请填写正则表达式';
      else {
        var v = Core.validateRegex(r.pattern, r.flags);
        if (!v.ok) error = '正则错误：' + v.error;
        else if (v.warnings.length && !config.settings.allowUnsafeRegex) {
          error = '安全策略拦截：' + v.warnings.join('；') + '（如需放行见「高级」）';
        }
      }
    } else if (!r.selector) error = '请填写 CSS 选择器';
    else if (Core.isOverbroadSelector(r.selector)) error = '选择器范围过大，会遮盖整页，请改用具体元素';
    if (error) { $('#f_err').textContent = error; return; }
    if (editingId) {
      var idx = config.rules.findIndex(function (x) { return x.id === editingId; });
      if (idx >= 0) config.rules[idx] = r; else config.rules.push(r);
    } else config.rules.push(r);
    closeForm();
    renderRules();
    saveConfig('规则已保存，页面已自动刷新');
  }

  function closeForm() {
    formOpen = false; editingId = null; formRule = null;
    $('#formHost').innerHTML = '';
  }

  /* ---------- sites / advanced ---------- */

  function renderGlobal() { $('#globalSwitch').checked = config.enabled; }

  function renderSites() {
    $$('input[name="siteMode"]').forEach(function (r) { r.checked = r.value === config.siteMode; });
    $('#siteList').value = config.siteList.join('\n');
  }
  function saveSites() {
    var checked = $$('input[name="siteMode"]').filter(function (r) { return r.checked; })[0];
    config.siteMode = checked ? checked.value : 'all';
    config.siteList = $('#siteList').value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    saveConfig('站点设置已保存');
  }
  function currentHost() {
    if (!currentTab || !currentTab.url) return '';
    try { return new URL(currentTab.url).hostname; } catch (e) { return ''; }
  }
  function toggleCurrentSite() {
    var host = currentHost();
    if (!host) return;
    var idx = config.siteList.findIndex(function (e) { return Core.hostMatches(host, e); });
    if (config.siteMode === 'whitelist') {
      if (idx >= 0) config.siteList.splice(idx, 1); else config.siteList.push(host);
    } else {
      if (config.siteMode !== 'blacklist') config.siteMode = 'blacklist';
      if (idx >= 0) config.siteList.splice(idx, 1); else config.siteList.push(host);
    }
    saveConfig('本站点状态已切换');
    renderSites();
    refreshState();
  }

  function renderAdvanced() {
    var s = config.settings;
    $('#optDynamic').checked = !!s.observeDynamic;
    $('#optReveal').checked = !!s.revealOnAlt;
    $('#optBadge').checked = !!s.badge;
    $('#optUnsafe').checked = !!s.allowUnsafeRegex;
    $('#optJoin').checked = !!s.joinSplitText;
    $('#optShadow').checked = !!s.maskShadowDom;
    $('#optSvg').checked = !!s.maskSvgText;
    $('#optAttrs').checked = !!s.maskAttributes;
    $('#optTitle').checked = !!s.maskTitle;
    $('#optDebounce').value = s.debounceMs;
    $('#optMaxText').value = s.maxTextLength || 8000;
    $('#optSkip').value = s.skipSelectors;
  }
  function saveAdvanced() {
    config.settings.observeDynamic = $('#optDynamic').checked;
    config.settings.revealOnAlt = $('#optReveal').checked;
    config.settings.badge = $('#optBadge').checked;
    config.settings.allowUnsafeRegex = $('#optUnsafe').checked;
    config.settings.joinSplitText = $('#optJoin').checked;
    config.settings.maskShadowDom = $('#optShadow').checked;
    config.settings.maskSvgText = $('#optSvg').checked;
    config.settings.maskAttributes = $('#optAttrs').checked;
    config.settings.maskTitle = $('#optTitle').checked;
    config.settings.debounceMs = Math.min(600, Math.max(30, parseInt($('#optDebounce').value, 10) || 120));
    config.settings.maxTextLength = Math.min(50000, Math.max(1000, parseInt($('#optMaxText').value, 10) || 8000));
    config.settings.skipSelectors = $('#optSkip').value;
    saveConfig('高级设置已保存');
  }

  /* ---------- status ---------- */

  async function refreshState() {
    var res = await tabMsg({ type: 'MG_GET_STATE' });
    var dot = $('#statusDot'), text = $('#statusText'), btn = $('#btnSiteToggle');
    if (!res) {
      dot.className = 'dot off';
      text.textContent = '当前页不支持注入（浏览器内置页 / 扩展商店）';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    var on = config.enabled && res.siteAllowed;
    dot.className = 'dot ' + (on ? 'on' : 'off');
    text.textContent = res.host + ' · ' + (on ? '已遮盖 ' + res.masked + ' 处' : '已停用') +
      ' · 规则 ' + (res.regexRules + res.selectorRules) + ' 条';
    btn.textContent = res.siteAllowed ? '停用本站' : '启用本站';
  }

  async function showNotice() {
    var d = await storageGet('lastAction');
    var a = d && d.lastAction;
    if (!a || Date.now() - a.at > 120000) return;
    $('#notice').textContent = a.text + ' —— 可在「规则」页编辑或删除';
    $('#notice').classList.remove('hidden');
    chrome.storage.local.remove('lastAction');
  }

  async function startPick() {
    var res = await tabMsg({ type: 'MG_START_PICK' });
    if (!res || !res.ok) { flash('当前页无法启动框选'); return; }
    flash('已启动：在页面单击要遮盖的区域，Esc 取消');
    if (!isFull) setTimeout(function () { window.close(); }, 900);
  }

  /* ---------- import / export ---------- */

  function exportConfig() {
    var blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'maskguard-config.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    flash('配置已导出');
  }
  function importConfig(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(String(reader.result));
        config = Core.normalizeConfig(obj && obj.config ? obj.config : obj);
        renderRules(); renderSites(); renderAdvanced(); renderGlobal(); refreshState();
        saveConfig('配置已导入');
      } catch (e) { flash('导入失败：JSON 格式错误'); }
    };
    reader.readAsText(file);
  }

  /* ---------- events ---------- */

  function bindEvents() {
    $$('#tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        $$('section[data-panel]').forEach(function (s) { s.classList.toggle('on', s.getAttribute('data-panel') === b.getAttribute('data-tab')); });
      });
    });
    $('#globalSwitch').addEventListener('change', function () {
      config.enabled = $('#globalSwitch').checked;
      saveConfig(config.enabled ? '已全局启用' : '已全局停用');
      refreshState();
    });
    $('#btnSiteToggle').addEventListener('click', toggleCurrentSite);
    $('#btnAdd').addEventListener('click', function () { openForm(null); });
    $('#btnPick').addEventListener('click', startPick);
    $('#btnReapply').addEventListener('click', async function () {
      await tabMsg({ type: 'MG_REAPPLY' }); flash('已按最新规则重新扫描'); refreshState();
    });
    $('#btnRestore').addEventListener('click', async function () {
      await tabMsg({ type: 'MG_RESTORE' }); flash('本页已临时还原'); refreshState();
    });
    $('#btnDemo').addEventListener('click', async function () {
      var res = await tabMsg({ type: 'MG_INSERT_DEMO' });
      flash(res && res.ok ? '演示数据已插入，观察右上角遮盖效果' : '当前页不支持注入');
      setTimeout(refreshState, 500);
    });
    $$('input[name="siteMode"]').forEach(function (r) { r.addEventListener('change', saveSites); });
    $('#btnSaveSites').addEventListener('click', saveSites);
    $('#btnAddSite').addEventListener('click', function () {
      var h = currentHost();
      if (!h) { flash('无法获取当前站点'); return; }
      var lines = $('#siteList').value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (lines.indexOf(h) < 0) lines.push(h);
      $('#siteList').value = lines.join('\n');
      saveSites();
    });
    $('#btnSaveAdvanced').addEventListener('click', saveAdvanced);
    $('#btnExport').addEventListener('click', exportConfig);
    $('#btnImport').addEventListener('click', function () { $('#fileImport').click(); });
    $('#fileImport').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importConfig(e.target.files[0]);
      e.target.value = '';
    });
    $('#btnDefaults').addEventListener('click', function () {
      if (!confirm('恢复内置规则将覆盖当前全部规则，继续？')) return;
      config.rules = Core.makeDefaultRules();
      renderRules(); saveConfig('已恢复内置规则');
    });
    $('#btnClear').addEventListener('click', function () {
      if (!confirm('清空全部规则？可通过「导入 JSON」恢复。')) return;
      config.rules = [];
      renderRules(); saveConfig('已清空规则');
    });
    $('#btnFull').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.config) return;
    config = Core.normalizeConfig(changes.config.newValue);
    var focused = document.activeElement ? document.activeElement.id : '';
    renderRules();
    renderGlobal();
    if (focused !== 'siteList') renderSites();
    if (['optSkip', 'optDebounce', 'optMaxText'].indexOf(focused) < 0) renderAdvanced();
    refreshState();
  });

  async function init() {
    var d = await storageGet('config');
    config = Core.normalizeConfig(d && d.config);
    if (!d || !d.config) await storageSet({ config: config });
    var tabs = await new Promise(function (r) { chrome.tabs.query({ active: true, currentWindow: true }, r); });
    currentTab = tabs && tabs[0];
    bindEvents();
    renderRules(); renderSites(); renderAdvanced(); renderGlobal();
    showNotice();
    refreshState();
  }
  init();
})();
