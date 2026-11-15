# MaskGuard · 浏览器敏感数据脱敏插件 + 纳管控制台

两个可独立使用、也可组合部署的工程：

| 目录 | 内容 |
|---|---|
| [`maskguard/`](maskguard/) | Edge / Chrome MV3 扩展：自动识别页面敏感数据并按规则遮盖，支持自定义正则与 8 种脱敏算法、手动指定位置 |
| [`plugin-console/`](plugin-console/) | 插件纳管 PoC：服务端监控插件安装/运行状态，统一下发策略并回收 ACK；含可行性验证报告 |

---

## 一、MaskGuard 插件

### 安装

1. 打开 `edge://extensions`（或 `chrome://extensions`）
2. 开启「开发人员模式」
3. 「加载解压缩的扩展」→ 选择 `maskguard/` 目录
4. 固定到工具栏，点图标打开配置面板

`file://` 页面需在扩展详情页额外开启「允许访问文件网址」。

### 能力

- **自动识别**：`document_start` 注入 + TreeWalker 遍历 + MutationObserver 增量监听，SPA / 懒加载 / 动态插入均生效
- **规则配置**：正则规则（`g/i/m/s`）与位置规则（CSS 选择器），可增删改、启停、排序、导入导出
- **脱敏算法 8 种**：全部遮盖、部分保留、固定长度、标签替换、哈希摘要、保格式打乱、自定义替换、视觉模糊
- **手动指定**：面板「框选页面位置」点选元素自动生成选择器；右键「将此位置加入脱敏」；选中文字右键临时规则（内存态，不落盘）
- **增强形态**：跨相邻文本节点拼接识别、open Shadow DOM 递归、iframe 子帧注入、SVG 文本、展示类属性（placeholder/title/alt/aria-label）、`document.title`
- **辅助**：按住 `Alt` 临时看原文、临时还原、重新扫描、badge 计数、站点黑白名单

### 测试

```bash
cd maskguard
node serve-test-page.js          # http://127.0.0.1:8765/test-page.html 形态覆盖矩阵
node tests/masker.test.js        # 算法单测
node tests/content.test.js       # 内容脚本 mock
BROWSER='C:\Users\<you>\AppData\Local\ms-playwright\chromium-1254\chrome-win64\chrome.exe' node tests/e2e.test.js
BROWSER=... node tests/testpage.test.js
BROWSER=... node tests/perf.test.js
```

`test-page.html` 按真实渲染形态分 A/B/C 三组共 37 个探针，每项标注「应遮盖 / 保持原样 / 不可达」，页面自检实时显示偏差数；导入 `test-config.json` 可得 20 条配套规则。

> Chrome 137+ / Edge 稳定版已移除 `--load-extension` 命令行开关，E2E 使用 Playwright 提供的非品牌 Chromium 构建；手动安装方式不受影响。

---

## 二、插件纳管控制台（PoC）

验证「服务端能否监控插件安装状态并统一下发策略」。

```bash
cd plugin-console
node server.js                   # http://127.0.0.1:8787
```

- 扩展侧：`extension/`（注册、30s 心跳、策略拉取与幂等应用、ACK 回执、断线退避）
- 服务端：`server.js`（HMAC 鉴权 + 防重放、策略版本、离线 TTL 判定、资产对账、事件流、持久化）
- 控制台：`public/index.html`（在线率、安装状态、策略一致性、下发/回滚、未安装主机对账）
- 结论与边界：`可行性验证报告.md`

测试：

```bash
node tests/api.test.js           # 控制面契约与安全
node tests/e2e.test.js           # 真实 Chromium + 真实 MV3 扩展
SCALE_N=5000 node tests/scale.test.js
```

**已知边界**：插件只能上报"自己还在"，**无法感知未安装/被卸载**；浏览器没有"卸载密码"，等效手段是 `ExtensionInstallForcelist` 企业策略强制安装（需 GPO/Intune）；MV3 Service Worker 会被回收，心跳走 `alarms`（≥30s），做不到秒级推送。

---

## 免责声明

仅修改当前页面文本节点的显示值，不上传数据、不修改服务器内容。使用者应确保符合所在组织的安全与合规要求。
