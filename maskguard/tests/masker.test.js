/* node tests/masker.test.js */
const assert = require('assert');
const C = require('../masker.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('  PASS  ' + name); }

t('默认规则遮盖手机号（中文上下文）', () => {
  const r = C.applyRules('联系人：13800138000。', C.makeDefaultRules());
  assert.ok(r.text.includes('138****8000'), r.text);
  assert.strictEqual(r.count, 1);
});
t('默认规则遮盖身份证、银行卡、邮箱', () => {
  const r = C.applyRules('证件 110101199001011234；卡 6222021234567890123；邮箱 a.b@corp.com', C.makeDefaultRules());
  assert.ok(r.text.includes('110101********1234'), r.text);
  assert.ok(r.text.includes('6222***********0123'), r.text);
  assert.ok(!r.text.includes('a.b@corp.com'), r.text);
});
t('7 种遮盖算法输出正确', () => {
  const v = '13800138000';
  assert.strictEqual(C.maskValue(v, { maskType: 'full', maskChar: '*' }), '***********');
  assert.strictEqual(C.maskValue(v, { maskType: 'partial', maskChar: '*', keepStart: 3, keepEnd: 4 }), '138****8000');
  assert.strictEqual(C.maskValue(v, { maskType: 'fixed', maskChar: '█', fixedLength: 6 }), '██████');
  assert.strictEqual(C.maskValue(v, { maskType: 'label', label: '[已脱敏]' }), '[已脱敏]');
  assert.match(C.maskValue(v, { maskType: 'hash' }), /^\[H:[0-9a-f]{8}\]$/);
  const p = C.maskValue(v, { maskType: 'pattern' });
  assert.match(p, /^\d{11}$/);
  assert.notStrictEqual(p, v);
  assert.strictEqual(C.maskValue('abc', { maskType: 'pattern' }), 'XXX');
  assert.strictEqual(C.maskValue(v, { maskType: 'custom', custom: '<REDACTED>' }), '<REDACTED>');
});
t('哈希与保格式打乱结果稳定', () => {
  const a = C.maskValue('6222021234567890123', { maskType: 'hash' });
  const b = C.maskValue('6222021234567890123', { maskType: 'hash' });
  assert.strictEqual(a, b);
  assert.strictEqual(C.maskValue('12345', { maskType: 'pattern' }), C.maskValue('12345', { maskType: 'pattern' }));
});
t('已遮盖片段不会被后续规则二次匹配', () => {
  const rules = [
    C.normalizeRule({ id: 'a', pattern: '1[3-9]\\d{9}', maskType: 'full', maskChar: '*' }),
    C.normalizeRule({ id: 'b', pattern: '\\*{11}', maskType: 'label', label: '[二次命中]' })
  ];
  assert.strictEqual(C.applyRules('13800138000', rules).text, '***********');
});
t('非全局 flags 自动补齐 g', () => {
  const rules = [C.normalizeRule({ pattern: '1[3-9]\\d{9}', flags: '', maskType: 'full', maskChar: '*' })];
  assert.strictEqual(C.applyRules('13800138000 / 13900139000', rules).text, '*********** / ***********');
});
t('非法正则与零宽匹配不崩溃', () => {
  assert.strictEqual(C.validateRegex('(', 'g').ok, false);
  assert.strictEqual(C.buildRegex({ pattern: '(', flags: 'g' }), null);
  const r = C.applyRules('abc', [C.normalizeRule({ pattern: '(?=a)', maskType: 'full', maskChar: '*' })]);
  assert.strictEqual(r.text, 'abc');
});
t('站点黑白名单匹配', () => {
  assert.strictEqual(C.hostMatches('a.example.com', 'example.com'), true);
  assert.strictEqual(C.hostMatches('a.example.com', '*.example.com'), true);
  assert.strictEqual(C.hostMatches('evil-example.com', 'example.com'), false);
  const cfg = C.defaultConfig();
  cfg.siteMode = 'blacklist'; cfg.siteList = ['example.com'];
  assert.strictEqual(C.siteAllowed(cfg, 'a.example.com'), false);
  assert.strictEqual(C.siteAllowed(cfg, 'other.com'), true);
  cfg.siteMode = 'whitelist';
  assert.strictEqual(C.siteAllowed(cfg, 'other.com'), false);
});
t('配置归一化兼容空/旧数据', () => {
  const c = C.normalizeConfig({});
  assert.ok(c.rules.length >= 5);
  assert.strictEqual(c.settings.debounceMs, 120);
  assert.strictEqual(c.siteMode, 'all');
  const old = C.normalizeConfig({ rules: [{ name: '旧规则', pattern: '\\d+' }] });
  assert.strictEqual(old.rules.length, 1);
  assert.strictEqual(old.rules[0].kind, 'regex');
  assert.strictEqual(old.rules[0].maskType, 'full');
});
t('转义与规则字段补齐', () => {
  assert.strictEqual(C.escapeRegExp('a.b(c)'), 'a\\.b\\(c\\)');
  const r = C.normalizeRule({ kind: 'selector', selector: '#a > .b', maskType: 'fixed', fixedLength: 8, maskChar: '█' });
  assert.strictEqual(r.kind, 'selector');
  assert.strictEqual(r.fixedLength, 8);
  assert.strictEqual(C.maskValue('任意内容', r), '████████');
});

t('安全：高危正则被识别，常用固定量词不误伤', () => {
  assert.ok(C.auditPattern('(a+)+').length > 0);
  assert.ok(C.auditPattern('(.*)*').length > 0);
  assert.ok(C.auditPattern('(a|aa)+').length > 0);
  assert.strictEqual(C.auditPattern('(?:\\d{3}-)+\\d{4}').length, 0);
  assert.strictEqual(C.auditPattern('(?<!\\d)1[3-9]\\d{9}(?!\\d)').length, 0);
  assert.ok(C.auditPattern('a'.repeat(2500)).length > 0);
});
t('安全：高危正则默认不执行，显式放行后才执行', () => {
  const r = C.normalizeRule({ pattern: '(a+)+', maskType: 'full', maskChar: '*' });
  assert.strictEqual(C.buildRegex(r), null);
  assert.ok(C.buildRegex(r, { allowUnsafe: true }) instanceof RegExp);
  assert.strictEqual(C.applyRules('aaaa', [r]).text, 'aaaa');
  assert.ok(C.applyRules('aaaa', [r], { allowUnsafe: true }).text.includes('*'));
});
t('安全：flags 白名单过滤 y/d/v 并强制 g', () => {
  assert.strictEqual(C.sanitizeFlags('gi'), 'gi');
  assert.strictEqual(C.sanitizeFlags('y'), 'g');
  assert.strictEqual(C.sanitizeFlags('gimsvd'), 'gims');
});
t('安全：整页选择器被识别为过宽', () => {
  ['body', 'html', '*', ':root', 'body,*', 'html > body', 'body > *'].forEach(s =>
    assert.strictEqual(C.isOverbroadSelector(s), true, s));
  ['#secret', '.card > span', 'table td:nth-of-type(2)'].forEach(s =>
    assert.strictEqual(C.isOverbroadSelector(s), false, s));
});
t('安全：规则数量与字段长度上限', () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ name: 'r' + i, pattern: '\\d+' + i }));
  assert.strictEqual(C.normalizeConfig({ rules: many }).rules.length, C.LIMITS.maxRules);
  const r = C.normalizeRule({ pattern: 'a'.repeat(5000), selector: '#'.repeat(3000), label: 'x'.repeat(500) });
  assert.strictEqual(r.pattern.length, C.LIMITS.maxPattern);
  assert.strictEqual(r.selector.length, C.LIMITS.maxSelector);
  assert.strictEqual(r.label.length, C.LIMITS.maxText);
});
t('安全：超长文本节点跳过', () => {
  const long = 'a'.repeat(9000);
  const r = C.applyRules(long, [C.normalizeRule({ pattern: 'a', maskType: 'full', maskChar: '*' })], { maxTextLength: 8000 });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.text, long);
});

console.log('\n' + n + ' tests passed.');
