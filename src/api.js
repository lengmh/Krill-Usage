"use strict";

const https = require("node:https");
const { API_URL, LOGIN_URL } = require("./constants");
const { normalizeResponse } = require("./model");
const { sanitizeJwt } = require("./jwt");

class KrillApiError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "KrillApiError";
    this.code = code;
    this.status = status;
  }
}

// Fixed first-party HTTPS endpoints only. Node https does not follow redirects.
function requestText(url, { method = "GET", jwt = null, body = null, timeoutMs = 12_000 } = {}) {
  if (url !== API_URL && url !== LOGIN_URL) {
    return Promise.reject(new KrillApiError("UNTRUSTED_ENDPOINT", "不支持的请求地址"));
  }
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
    const req = https.request(url, { method, headers }, (response) => {
      const chunks = [];
      let bytes = 0;
      const maxBytes = 2 * 1024 * 1024;
      response.on("error", () => reject(new KrillApiError("NETWORK", "网络连接中断")));
      response.on("aborted", () => reject(new KrillApiError("NETWORK", "网络连接中断")));
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy(new KrillApiError("TOO_LARGE", "服务器响应过大"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new KrillApiError("TIMEOUT", "请求超时")));
    req.on("error", (error) => reject(error instanceof KrillApiError
      ? error : new KrillApiError("NETWORK", "网络连接失败")));
    if (encoded) req.write(encoded);
    req.end();
  });
}

function parseJson(response) {
  if (String(response.headers?.["cf-mitigated"] ?? "").toLowerCase() === "challenge") {
    throw new KrillApiError("CF_CHALLENGE", "Krill 要求进行 Cloudflare 验证，请先在浏览器中验证", response.status);
  }
  let json;
  try { json = JSON.parse(response.text); } catch {
    if (response.status === 401) {
      throw new KrillApiError("UNAUTHORIZED", "Krill 登录状态已失效", response.status);
    }
    throw new KrillApiError("INVALID_JSON", "Krill 返回了无法解析的数据", response.status);
  }
  return json;
}

function isBusinessUnauthorized(json) {
  return json?.code === 401 || json?.code === "401";
}

function validateCredentials(email, password) {
  if (typeof email !== "string" || !email.trim() || email.trim().length > 320 ||
      typeof password !== "string" || !password || password.length > 4096) {
    throw new KrillApiError("INVALID_CREDENTIALS", "请输入有效的 Krill 邮箱和密码");
  }
  return { email: email.trim(), password };
}

function parseLoginResponse(response) {
  const json = parseJson(response);
  if (response.status === 401 || (response.status >= 200 && response.status < 300 && isBusinessUnauthorized(json))) {
    throw new KrillApiError("LOGIN_FAILED", "Krill 账号或密码错误，或登录状态需要重新验证", response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new KrillApiError("LOGIN_FAILED", `Krill 登录失败（HTTP ${response.status}）`, response.status);
  }
  if (json?.requires_totp || json?.data?.requires_totp) {
    throw new KrillApiError("INTERACTIVE_LOGIN", "Krill 需要额外身份验证，请改用网页登录后手动设置 JWT");
  }
  if (json?.success !== true || json?.code !== 0) {
    throw new KrillApiError("LOGIN_FAILED", "Krill 登录未成功，请检查账号密码或所需验证码");
  }
  const token = sanitizeJwt(json.data?.token);
  if (!token || token.length > 16_384 || /\s/.test(token)) {
    throw new KrillApiError("INVALID_LOGIN_RESPONSE", "Krill 登录响应中没有有效 JWT");
  }
  return token;
}

async function loginWithPassword(email, password) {
  const credentials = validateCredentials(email, password);
  const response = await requestText(LOGIN_URL, { method: "POST", body: credentials });
  return parseLoginResponse(response);
}

async function fetchSubscription(jwt) {
  if (typeof jwt !== "string" || !jwt.trim()) {
    throw new KrillApiError("NO_JWT", "尚未设置 krill_jwt");
  }
  const response = await requestText(API_URL, { jwt: jwt.trim() });
  const json = parseJson(response);
  if (response.status === 401 || (response.status >= 200 && response.status < 300 && isBusinessUnauthorized(json))) {
    throw new KrillApiError("UNAUTHORIZED", "krill_jwt 无效或已过期", 401);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new KrillApiError("HTTP", `Krill 请求失败：HTTP ${response.status}`, response.status);
  }
  try { return normalizeResponse(json); } catch {
    throw new KrillApiError("INVALID_RESPONSE", "Krill API 返回结构无法识别", response.status);
  }
}

module.exports = {
  KrillApiError,
  requestText,
  parseLoginResponse,
  isBusinessUnauthorized,
  validateCredentials,
  loginWithPassword,
  fetchSubscription
};
