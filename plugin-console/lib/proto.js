/* Shared wire protocol helpers for the plugin/agent fleet PoC.
   Both the real agent and the load simulator use this, so the signature scheme
   that is verified in production-like tests is the one actually shipped. */
'use strict';
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function hmac(secret, data) {
  return crypto.createHmac('sha256', String(secret)).update(String(data)).digest('hex');
}

function request(baseUrl, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, baseUrl);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const mod = u.protocol === 'https:' ? https : http;
    const h = Object.assign({
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    }, headers || {});
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET', headers: h
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/* Signature binds timestamp + raw body, so a captured request cannot be replayed
   outside the server's clock window nor edited in flight. */
function signedRequest(baseUrl, pluginId, secret, method, pathname, body) {
  const ts = Date.now();
  const payload = body === undefined ? '' : JSON.stringify(body);
  return request(baseUrl, method, pathname, body, {
    'x-plugin-id': pluginId,
    'x-plugin-ts': String(ts),
    'x-plugin-sign': hmac(secret, ts + '.' + payload)
  });
}

module.exports = { hmac, request, signedRequest };
