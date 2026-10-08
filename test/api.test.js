"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { loadWithMocks } = require("./helpers");

function mockApi({ status = 200, headers = {}, text = "{}", networkError } = {}) {
  let seen;
  const api = loadWithMocks("../src/api", {
    "node:https": { request(url, options, callback) {
      seen = { url, options };
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = (error) => request.emit("error", error);
      request.end = () => queueMicrotask(() => {
        if (networkError) return request.emit("error", new Error(networkError));
        const response = new EventEmitter();
        response.statusCode = status;
        response.headers = headers;
        callback(response);
        response.emit("data", Buffer.from(text));
        response.emit("end");
      });
      return request;
    } }
  });
  return { ...api, getSeen: () => seen };
}

test("API sends only fixed-host GET authentication and normalizes synthetic quota", async () => {
  const { fetchSubscription, getSeen } = mockApi({ text: JSON.stringify({
    success: true, code: 0, data: { credit_balance_usd: "123.45", subscriptions: [] }
  }) });
  assert.deepEqual(await fetchSubscription("synthetic-token"), { creditBalance: "123.45", subscriptions: [] });
  assert.equal(getSeen().url, "https://www.krill-code.com/api/subscription");
  assert.equal(getSeen().options.method, "GET");
  assert.equal(getSeen().options.headers.Authorization, "Bearer synthetic-token");
});

test("expired token, network and Cloudflare errors retain distinct error codes", async () => {
  for (const [response, code] of [
    [{ status: 401 }, "UNAUTHORIZED"],
    [{ networkError: "Synthetic offline" }, "NETWORK"],
    [{ status: 403, headers: { "cf-mitigated": "challenge" } }, "CF_CHALLENGE"]
  ]) {
    const { fetchSubscription } = mockApi(response);
    await assert.rejects(fetchSubscription("synthetic-token"), { code });
  }
});
