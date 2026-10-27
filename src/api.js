"use strict";

const https = require("node:https");
const { API_URL, LOGIN_URL } = require("./constants");
const { normalizeResponse } = require("./model");
const { sanitizeJwt } = require("./jwt");

// Only these codes are copied from Node errors into diagnostics. Never log
// exception messages, response bodies, Authorization headers or credentials.
const SAFE_NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "EPROTO",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"
]);

class KrillApiError extends Error {
  constructor(code, message, status = null, details = {}) {
    super(message);
    this.name = "KrillApiError";
    this.code = code;
    this.status = status;
    this.phase = details.phase ?? "subscription";
    this.networkCode = details.networkCode ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

function retryAfterMs(headers, now = Date.now()) {
  const header = headers?.["retry-after"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const raw = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(raw) ? Math.max(0, Math.min(60 * 60_000, raw)) : null;
}

function isChallenge(response) {
  return String(response.headers?.["cf-mitigated"] ?? "").toLowerCase() === "challenge";
}

function httpFailure(response, phase) {
  if (isChallenge(response)) {
    return new KrillApiError("CF_CHALLENGE", "Krill 要求 Cloudflare 验证，请先在浏览器中验证", response.status, { phase });
  }
  if (response.status === 429) {
    return new KrillApiError("RATE_LIMIT", "Krill 请求频率受限（HTTP 429）", 429,
      { phase, retryAfterMs: retryAfterMs(response.headers) });
  }
  return new KrillApiError("HTTP", `Krill 服务返回 HTTP ${response.status}`, response.status,
    { phase, retryAfterMs: retryAfterMs(response.headers) });
}

// Fixed first-party HTTPS endpoints only; Node https does not follow redirects.
// The deadline is absolute, not socket-idle-based: a trickling response cannot
// keep a refresh pending forever.
function requestText(url, { method = "GET", jwt = null, body = null, timeoutMs = 12_000 } = {}) {
  if (url !== API_URL && url !== LOGIN_URL) {
    return Promise.reject(new KrillApiError("UNTRUSTED_ENDPOINT", "不支持的请求地址"));
  }
  const phase = url === LOGIN_URL ? "login" : "subscription";
  return new Promise((resolve, reject) => {
    const encoded = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers = {
      Accept: "application/json",
      "User-Agent": `Krill-Usage-VSCode/${require("../package.json").version}`
    };
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
    if (encoded) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(encoded.length);
    }
    let settled = false;
    let deadline;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(response);
    };
    let req;
    try {
      req = https.request(url, { method, headers }, (response) => {
        const chunks = [];
        let bytes = 0;
        const maxBytes = 2 * 1024 * 1024;
        response.on("error", () => finish(new KrillApiError("NETWORK", "网络连接中断", null, { phase })));
        response.on("aborted", () => finish(new KrillApiError("NETWORK", "网络连接中断", null, { phase })));
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            const error = new KrillApiError("TOO_LARGE", "Krill 响应过大", response.statusCode ?? null, { phase });
            finish(error);
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish(null, {
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8")
        }));
      });
    } catch {
      finish(new KrillApiError("NETWORK", "无法建立 Krill 网络连接", null, { phase }));
      return;
    }
    req.on("error", (error) => {
      if (error instanceof KrillApiError) return finish(error);
      const code = SAFE_NETWORK_CODES.has(error?.code) ? error.code : null;
      finish(new KrillApiError("NETWORK", "Krill 网络连接失败", null, { phase, networkCode: code }));
    });
    const limit = Math.max(1, Math.min(60_000, Number(timeoutMs) || 12_000));
    deadline = setTimeout(() => {
      const error = new KrillApiError("TIMEOUT", "Krill 请求超时", null, { phase });
      finish(error);
      req.destroy();
    }, limit);
    if (encoded) req.write(encoded);
    req.end();
  });
}

function parseJson(response, phase) {
  if (isChallenge(response)) throw httpFailure(response, phase);
  try { return JSON.parse(response.text); }
  catch { throw new KrillApiError("INVALID_JSON", "Krill 返回非 JSON 数据", response.status, { phase }); }
}

function isBusinessUnauthorized(json) {
  return json?.code === 401 || json?.code === "401";
}

function validateCredentials(email, password) {
  if (typeof email !== "string" || !email.trim() || email.trim().length > 320 ||
      typeof password !== "string" || !password || password.length > 4096) {
    throw new KrillApiError("INVALID_CREDENTIALS", "请输入有效的 Krill 邮箱和密码", null, { phase: "login" });
  }
  return { email: email.trim(), password };
}

function parseLoginResponse(response) {
  if (isChallenge(response)) throw httpFailure(response, "login");
  // Login errors can be HTML or empty; retain the status rather than reporting JSON parsing.
  if (response.status === 401 || response.status === 403) {
    throw new KrillApiError("LOGIN_FAILED", "Krill 登录凭据无效或需要人工验证", response.status, { phase: "login" });
  }
  if (response.status < 200 || response.status >= 300) throw httpFailure(response, "login");
  const json = parseJson(response, "login");
  if (isBusinessUnauthorized(json)) {
    throw new KrillApiError("LOGIN_FAILED", "Krill 登录凭据无效或需要人工验证", response.status, { phase: "login" });
  }
  if (json?.requires_totp || json?.data?.requires_totp) {
    throw new KrillApiError("INTERACTIVE_LOGIN", "Krill 需要额外验证，请在网页登录后手动设置 JWT", null, { phase: "login" });
  }
  if (json?.success !== true || json?.code !== 0) {
    throw new KrillApiError("LOGIN_FAILED", "Krill 登录未成功，请检查凭据或验证码", response.status, { phase: "login" });
  }
  const token = sanitizeJwt(json.data?.token);
  if (!token || token.length > 16_384 || /\s/.test(token)) {
    throw new KrillApiError("INVALID_LOGIN_RESPONSE", "Krill 登录响应中没有有效 JWT", response.status, { phase: "login" });
  }
  return token;
}

async function loginWithPassword(email, password) {
  const response = await requestText(LOGIN_URL, { method: "POST", body: validateCredentials(email, password) });
  return parseLoginResponse(response);
}

async function fetchSubscription(jwt) {
  if (typeof jwt !== "string" || !jwt.trim()) {
    throw new KrillApiError("NO_JWT", "尚未设置 krill_jwt", null, { phase: "subscription" });
  }
  const response = await requestText(API_URL, { jwt: jwt.trim() });
  if (isChallenge(response)) throw httpFailure(response, "subscription");
  if (response.status === 401) {
    throw new KrillApiError("UNAUTHORIZED", "krill_jwt 无效或已过期", 401, { phase: "subscription" });
  }
  if (response.status < 200 || response.status >= 300) throw httpFailure(response, "subscription");
  const json = parseJson(response, "subscription");
  if (isBusinessUnauthorized(json)) {
    throw new KrillApiError("UNAUTHORIZED", "krill_jwt 无效或已过期", 401, { phase: "subscription" });
  }
  try { return normalizeResponse(json); }
  catch { throw new KrillApiError("INVALID_RESPONSE", "Krill API 返回结构无法识别", response.status, { phase: "subscription" }); }
}

module.exports = {
  KrillApiError, requestText, retryAfterMs, parseLoginResponse,
  isBusinessUnauthorized, validateCredentials, loginWithPassword, fetchSubscription
};
