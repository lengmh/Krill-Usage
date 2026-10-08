'use strict';
const https = require('node:https');
const { normalizeResponse } = require('../../../src/model.js');
const API_URL = 'https://www.krill-code.com/api/subscription';
const error = (code) => Object.assign(new Error(code), { code });

function requestText(jwt, request = https.request) {
  return new Promise((resolve, reject) => {
    const req = request(API_URL, { method: 'GET', headers: {
      Accept: 'application/json', Authorization: `Bearer ${jwt}`,
      'User-Agent': 'Krill-Usage-Codex/0.1.0'
    } }, (res) => {
      const chunks = []; let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { req.destroy(error('TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      res.on('error', () => reject(error('NETWORK')));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8')}));
    });
    req.setTimeout(12000, () => req.destroy(error('TIMEOUT')));
    req.on('error', (err) => reject(error(['TIMEOUT', 'TOO_LARGE'].includes(err?.code) ? err.code : 'NETWORK')));
    req.end();
  });
}
async function fetchSubscription(jwt, request) {
  if (!jwt) throw error('NO_JWT');
  const response = await requestText(jwt, request);
  if (String(response.headers['cf-mitigated'] || '').toLowerCase() === 'challenge') throw error('CF_CHALLENGE');
  if (response.status === 401) throw error('UNAUTHORIZED');
  if (response.status < 200 || response.status >= 300) throw error('HTTP');
  let json;
  try { json = JSON.parse(response.text); } catch { throw error('INVALID_JSON'); }
  try { return normalizeResponse(json); } catch { throw error('INVALID_RESPONSE'); }
}
module.exports = { fetchSubscription, API_URL };
