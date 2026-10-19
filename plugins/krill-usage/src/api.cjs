'use strict';
const https = require('node:https');
const { normalizeResponse } = require('../../../src/model.js');
const API_URL = 'https://www.krill-code.com/api/subscription';
const LOGIN_URL = 'https://www.krill-code.com/api/auth/login';
const { normalizeCredential } = require('./credentials.cjs');
const error = (code) => Object.assign(new Error(code), { code });

function requestText(jwt, request = https.request, credentials = null) {
  return new Promise((resolve, reject) => {
    let req, settled = false;
    // Socket inactivity alone does not bound connection setup or trickling data.
    const deadline = setTimeout(() => abort('TIMEOUT'), 12000);
    function settle(err, response) {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err); else resolve(response);
      return true;
    }
    function abort(code) {
      const err = error(code);
      // Preserve our cause before destroy can emit response aborted/error events.
      if (settle(err)) req?.destroy(err);
    }
    try {
      const body = credentials ? Buffer.from(JSON.stringify(credentials), 'utf8') : null;
      req = request(credentials ? LOGIN_URL : API_URL, { method: credentials ? 'POST' : 'GET', headers: {
        Accept: 'application/json', ...(jwt ? {Authorization: `Bearer ${jwt}`} : {}),
        ...(body ? {'Content-Type':'application/json', 'Content-Length':String(body.length)} : {}),
        'User-Agent': 'Krill-Usage-Codex/0.1.5'
      } }, (res) => {
        const chunks = []; let bytes = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { abort('TOO_LARGE'); return; }
          chunks.push(chunk);
        });
        res.on('aborted', () => settle(error('NETWORK')));
        res.on('error', () => settle(error('NETWORK')));
        res.on('end', () => settle(null, {status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8')}));
      });
      req.setTimeout(12000, () => abort('TIMEOUT'));
      req.on('error', (err) => settle(error(['TIMEOUT', 'TOO_LARGE'].includes(err?.code) ? err.code : 'NETWORK')));
      if (body) req.write(body);
      req.end();
    } catch { settle(error('NETWORK')); }
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
  if (json?.code === 401 || json?.code === '401') throw error('UNAUTHORIZED');
  try { return normalizeResponse(json); } catch { throw error('INVALID_RESPONSE'); }
}
async function loginWithPassword(account, password, request) {
  if (typeof account !== 'string' || !account.trim() || account.trim().length > 320 ||
      typeof password !== 'string' || !password || password.length > 4096 ||
      !account.isWellFormed() || !password.isWellFormed() ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(account + password)) throw error('INVALID_CREDENTIALS');
  const response = await requestText(null, request, {email:account.trim(),password});
  if (String(response.headers['cf-mitigated'] || '').toLowerCase() === 'challenge') throw error('CF_CHALLENGE');
  if (response.status < 200 || response.status >= 300) throw error('LOGIN_FAILED');
  let json;
  try { json = JSON.parse(response.text); } catch { throw error('INVALID_JSON'); }
  if (json?.requires_totp || json?.data?.requires_totp) throw error('INTERACTIVE_LOGIN');
  if (json?.success !== true || json?.code !== 0) throw error('LOGIN_FAILED');
  try { return normalizeCredential(json.data?.token); } catch { throw error('INVALID_LOGIN_RESPONSE'); }
}
module.exports = { fetchSubscription, loginWithPassword, API_URL, LOGIN_URL };
