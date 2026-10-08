"use strict";

const https = require("node:https");
const { API_URL } = require("./constants");
const { normalizeResponse } = require("./model");

class KrillApiError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "KrillApiError";
    this.code = code;
    this.status = status;
  }
}

function requestText(url, jwt, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${jwt}`,
          "User-Agent": `Krill-Usage-VSCode/${require("../package.json").version}`
        }
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        const maxBytes = 2 * 1024 * 1024;

        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            request.destroy(new KrillApiError("TOO_LARGE", "服务器响应过大"));
            return;
          }
          chunks.push(chunk);
        });

        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new KrillApiError("TIMEOUT", "请求超时"));
    });

    request.on("error", (error) => {
      if (error instanceof KrillApiError) reject(error);
      else reject(new KrillApiError("NETWORK", `网络错误：${error.message}`));
    });

    request.end();
  });
}

async function fetchSubscription(jwt) {
  if (typeof jwt !== "string" || !jwt.trim()) {
    throw new KrillApiError("NO_JWT", "尚未设置 krill_jwt");
  }

  const response = await requestText(API_URL, jwt.trim());

  if (String(response.headers["cf-mitigated"] ?? "").toLowerCase() === "challenge") {
    throw new KrillApiError("CF_CHALLENGE", "Krill 返回了 Cloudflare 验证", response.status);
  }

  if (response.status === 401) {
    throw new KrillApiError("UNAUTHORIZED", "krill_jwt 无效或已过期", 401);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new KrillApiError("HTTP", `Krill 请求失败：HTTP ${response.status}`, response.status);
  }

  let json;
  try {
    json = JSON.parse(response.text);
  } catch {
    throw new KrillApiError("INVALID_JSON", "Krill 返回了无法解析的数据", response.status);
  }

  try {
    return normalizeResponse(json);
  } catch {
    throw new KrillApiError("INVALID_RESPONSE", "Krill API 返回结构无法识别", response.status);
  }
}

module.exports = {
  KrillApiError,
  fetchSubscription
};
