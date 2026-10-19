"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const {
  loginWithPassword, fetchSubscription, parseLoginResponse,
  validateCredentials, isBusinessUnauthorized
} = require("../src/api");

function fakeNetwork(entries, run) {
  const original = https.request;
  const captured = [];
  https.request = (url, options, onResponse) => {
    const entry = entries.shift();
    assert.ok(entry, "unexpected request");
    const req = new EventEmitter();
    let body = "";
    req.setTimeout = () => {};
    req.write = (chunk) => { body += chunk.toString(); };
    req.end = () => queueMicrotask(() => {
      captured.push({ url, options, body });
      const res = new EventEmitter();
      res.statusCode = entry.status ?? 200;
      res.headers = entry.headers ?? { "content-type": "application/json" };
      onResponse(res);
      res.emit("data", Buffer.from(entry.body ?? ""));
      res.emit("end");
    });
    req.destroy = (error) => { queueMicrotask(() => req.emit("error", error)); };
    return req;
  };
  return Promise.resolve().then(() => run(captured)).finally(() => { https.request = original; });
}

test("password login POSTs only to official Krill HTTPS endpoint and extracts data.token", async () => {
  await fakeNetwork([{ body: JSON.stringify({ success: true, code: 0, data: { token: "jwt-123" } }) }], async (calls) => {
    assert.equal(await loginWithPassword(" user@example.com ", "p@ss word"), "jwt-123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://www.krill-code.com/api/auth/login");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body), { email: "user@example.com", password: "p@ss word" });
    assert.equal(calls[0].options.headers.Authorization, undefined);
  });
});

test("login rejects redirects, incorrect response, TOTP and Cloudflare challenge", async () => {
  const scenarios = [
    [{ status: 302, body: "{}", headers: { location: "https://evil.example/" } }, "LOGIN_FAILED"],
    [{ body: JSON.stringify({ success: true, code: 0, data: {} }) }, "INVALID_LOGIN_RESPONSE"],
    [{ body: JSON.stringify({ requires_totp: true }) }, "INTERACTIVE_LOGIN"],
    [{ status: 403, headers: { "cf-mitigated": "challenge" }, body: "<html>" }, "CF_CHALLENGE"],
    [{ body: JSON.stringify({ success: false, code: 401 }) }, "LOGIN_FAILED"]
  ];
  for (const [response, code] of scenarios) {
    await fakeNetwork([response], async (calls) => {
      await assert.rejects(loginWithPassword("me@example.com", "pass"), e => e.code === code);
      assert.equal(calls.length, 1);
    });
  }
});

test("subscription business code 401 explicitly reports expired JWT", async () => {
  await fakeNetwork([{ body: JSON.stringify({ success: false, code: "401" }) }], async () => {
    await assert.rejects(fetchSubscription("jwt"), e => e.code === "UNAUTHORIZED");
  });
});

test("subscription 403/CF and 500 do not masquerade as JWT expiration", async () => {
  for (const [response, code] of [
    [{ status: 403, body: "forbidden" }, "INVALID_JSON"],
    [{ status: 403, headers: { "cf-mitigated": "challenge" }, body: "<html>" }, "CF_CHALLENGE"],
    [{ status: 500, body: "{}" }, "HTTP"],
    [{ status: 500, body: '{"code":401}' }, "HTTP"],
    [{ status: 403, body: '{"code":401}' }, "HTTP"]
  ]) {
    await fakeNetwork([response], async () => {
      await assert.rejects(fetchSubscription("jwt"), e => e.code === code);
    });
  }
});

test("credential validation and business code matching", () => {
  assert.throws(() => validateCredentials("", "password"));
  assert.throws(() => validateCredentials("me@example.com", ""));
  assert.deepEqual(validateCredentials(" me@example.com ", " pass "), { email: "me@example.com", password: " pass " });
  assert.equal(isBusinessUnauthorized({ code: 401 }), true);
  assert.equal(isBusinessUnauthorized({ code: "401" }), true);
  assert.equal(isBusinessUnauthorized({ code: 403 }), false);
  assert.equal(parseLoginResponse({ status: 200, headers: {}, text: JSON.stringify({ success: true, code: 0, data: { token: "abc" } }) }), "abc");
});
