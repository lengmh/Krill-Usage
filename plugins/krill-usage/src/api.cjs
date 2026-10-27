'use strict';
const https = require('node:https');
const { normalizeResponse } = require('../../../src/model.js');
const API_URL = 'https://www.krill-code.com/api/subscription';
const LOGIN_URL = 'https://www.krill-code.com/api/auth/login';
const { normalizeCredential } = require('./credentials.cjs');
const error = (code, fields = {}) => Object.assign(new Error(code), { code, ...fields });
const RETRYABLE_GET_STATUS = new Set([408, 502, 503, 504]);
const SAFE_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);
function safeNetworkCode(value) {
  return SAFE_NETWORK_CODES.has(value) ? value : undefined;
}
// Retry-After is advisory but must never create unbounded client-side delays.
function retryAfterMs(value, now = Date.now()) {
  const input = Array.isArray(value) ? value[0] : value;
  if (typeof input !== 'string' || input.length > 128) return null;
  const trimmed = input.trim();
  const delay = /^\d+$/.test(trimmed)
    ? Number(trimmed) * 1000
    : Date.parse(trimmed) - now;
  return Number.isFinite(delay) ? Math.max(1000, Math.min(300000, delay)) : null;
}

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
        'User-Agent': 'Krill-Usage-Codex/0.1.7'
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
      req.on('error', (err) => settle(['TIMEOUT', 'TOO_LARGE'].includes(err?.code)
        ? error(err.code)
        : error('NETWORK', { networkCode: safeNetworkCode(err?.code) })));
      if (body) req.write(body);
      req.end();
    } catch { settle(error('NETWORK')); }
  });
}
async function fetchSubscription(jwt, request) {
  if (!jwt) throw error('NO_JWT');
  const response = await requestText(jwt, request);
  if (String(response.headers['cf-mitigated'] || '').toLowerCase() === 'challenge') throw error('CF_CHALLENGE');
  if (response.status === 401) throw error('UNAUTHORIZED', { status: 401 });
  if (response.status === 429) throw error('RATE_LIMIT', {
    status: 429, retryAfterMs: retryAfterMs(response.headers['retry-after'])
  });
  if (response.status < 200 || response.status >= 300) throw error('HTTP', { status: response.status });
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
  if (response.status === 429) throw error('RATE_LIMIT', {
    status: 429, retryAfterMs: retryAfterMs(response.headers['retry-after'])
  });
  if (response.status >= 500) throw error('HTTP', { status: response.status });
  if (response.status < 200 || response.status >= 300) throw error('LOGIN_FAILED', { status: response.status });
  let json;
  try { json = JSON.parse(response.text); } catch { throw error('INVALID_JSON'); }
  if (json?.requires_totp || json?.data?.requires_totp) throw error('INTERACTIVE_LOGIN');
  if (json?.success !== true || json?.code !== 0) throw error('LOGIN_FAILED');
  try { return normalizeCredential(json.data?.token); } catch { throw error('INVALID_LOGIN_RESPONSE'); }
}
// Only quota GETs can be retried. A login POST is never automatically duplicated.
async function fetchSubscriptionWithRetry(jwt, request, { delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await fetchSubscription(jwt, request); }
    catch (cause) {
      const retryable = cause?.code === 'NETWORK' || cause?.code === 'TIMEOUT' ||
        (cause?.code === 'HTTP' && RETRYABLE_GET_STATUS.has(cause.status));
      if (attempt === 1 && retryable) {
        await delay(200);
        continue;
      }
      // Copy only sanitized diagnostic fields; response bodies and headers are discarded.
      throw error(cause?.code || 'NETWORK', {
        status: Number.isInteger(cause?.status) ? cause.status : undefined,
        retryAfterMs: cause?.retryAfterMs ?? null,
        networkCode: safeNetworkCode(cause?.networkCode),
        attempts: attempt,
        elapsedMs: Math.max(0, Date.now() - started)
      });
    }
  }
}
module.exports = { fetchSubscription, fetchSubscriptionWithRetry, loginWithPassword, retryAfterMs, API_URL, LOGIN_URL };
