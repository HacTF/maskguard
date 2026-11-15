/* Zero-dependency local server for test-page.html.
   Usage: node serve-test-page.js [port]   (default 8765, binds 127.0.0.1 only) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = parseInt(process.argv[2], 10) || 8765;
const root = __dirname;
const allow = {
  '/': ['test-page.html', 'text/html; charset=utf-8'],
  '/test-page.html': ['test-page.html', 'text/html; charset=utf-8'],
  '/test-config.json': ['test-config.json', 'application/json; charset=utf-8']
};

const server = http.createServer((req, res) => {
  const url = String(req.url || '/').split('?')[0];
  const hit = allow[url];
  if (!hit) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found. Open /test-page.html');
    return;
  }
  const file = path.join(root, hit[0]);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Cannot read ' + hit[0]);
      return;
    }
    res.writeHead(200, {
      'Content-Type': hit[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log('MaskGuard 自测页：http://127.0.0.1:' + port + '/test-page.html');
  console.log('配套配置：      http://127.0.0.1:' + port + '/test-config.json');
  console.log('按 Ctrl+C 停止。');
});
