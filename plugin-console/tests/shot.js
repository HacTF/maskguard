/* Dashboard smoke shot: seeds a few plugins, then screenshots the console page.
   node tests/shot.js  -> writes data/dashboard.png */
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server.js');
const { request, signedRequest } = require('../lib/proto.js');

const BROWSER = process.env.BROWSER || 'C:\\Users\\11375\\AppData\\Local\\ms-playwright\\chromium-1254\\chrome-win64\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function fetchJson(port, p) {
  const r = await fetch('http://127.0.0.1:' + port + p);
  return r.json();
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const t = pending.get(m.id); pending.delete(m.id); m.error ? t.rej(new Error(m.error.message)) : t.res(m.result); }
  });
  return {
    ready,
    send(method, params) {
      return new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    }
  };
}

(async function main() {
  const srv = await start({ port: 0, enrollToken: 'shot', dataFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-shot-')), 's.json') });
  const base = 'http://127.0.0.1:' + srv.port;
  try {
    const hosts = [
      { host: 'ws-hr-01', label: '人事-01', installType: 'admin', mayDisable: false },
      { host: 'ws-fin-02', label: '财务-02', installType: 'admin', mayDisable: false },
      { host: 'ws-dev-07', label: '研发-07', installType: 'development', mayDisable: true }
    ];
    for (const h of hosts) {
      const r = await request(base, 'POST', '/api/plugin/enroll', Object.assign({
        enrollToken: 'shot', deviceKey: h.host, extVersion: '1.0.0', enabled: true
      }, h));
      await signedRequest(base, r.body.pluginId, r.body.secret, 'POST', '/api/plugin/heartbeat', { masked: 12 });
    }
    await request(base, 'POST', '/api/admin/assets', {
      assets: [{ host: 'ws-hr-01' }, { host: 'ws-fin-02' }, { host: 'ws-dev-07' }, { host: 'ws-ops-05' }, { host: 'ws-legal-03' }]
    });
    await request(base, 'POST', '/api/admin/policy', {
      rules: [{ id: 'phone', name: '手机号', kind: 'regex', enabled: true, pattern: '1[3-9]\\d{9}', flags: 'g', maskType: 'partial', maskChar: '*', keepStart: 3, keepEnd: 4 }],
      note: '补充邮箱规则'
    });
    await sleep(300);

    const cdpPort = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-prof-'));
    const proc = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--user-data-dir=' + profile, '--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*',
      '--window-size=1280,1400', 'about:blank'], { stdio: 'ignore', windowsHide: true });

    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) { try { ver = await fetchJson(cdpPort, '/json/version'); } catch (e) { await sleep(250); } }
    const list = await fetchJson(cdpPort, '/json/list');
    const target = list.find(t => t.type === 'page');
    const page = await connect(target.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 2, mobile: false });
    await page.send('Page.navigate', { url: base + '/' });
    await sleep(1800);
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const out = path.join(__dirname, '..', 'data', 'dashboard.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('saved', out);
    proc.kill();
  } finally {
    await srv.close();
  }
})();
