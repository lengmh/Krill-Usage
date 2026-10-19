"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

// A deliberately small replacement for the https.request boundary. Production
// api.js still handles HTTP statuses, headers, JSON, normalization, and errors.
// There is no pass-through, so this harness cannot send a Krill HTTP request.
class SyntheticTransport {
  constructor(apiUrl, loginUrl) {
    this.apiUrl = apiUrl;
    this.loginUrl = loginUrl;
    this.queue = [];
    this.requests = [];
    this.unexpected = [];
    this.pending = new Set();
    this.https = { request: this.request.bind(this) };
  }

  expect(token, response, { hold = false } = {}) {
    assert.match(token, /^synthetic-host-account-/);
    let started;
    const exchange = {
      token, response, hold, method: "GET", url: this.apiUrl,
      started: new Promise((resolve) => { started = resolve; }),
      markStarted: () => started(),
      reply: null
    };
    this.queue.push(exchange);
    return exchange;
  }

  expectLogin(email, password, response, options = {}) {
    assert.match(email, /^synthetic-host-.*@example\.invalid$/);
    assert.match(password, /^synthetic-host-password-/);
    const exchange = this.expect("synthetic-host-account-login-fixture", response, options);
    Object.assign(exchange, { method: "POST", url: this.loginUrl, email, password });
    return exchange;
  }

  request(url, options, callback) {
    let exchange;
    try {
      exchange = this.queue.shift();
      assert.ok(exchange, "Unexpected production HTTP request; no fixture was queued");
      assert.equal(String(url), exchange.url, "Unexpected production HTTP destination");
      assert.equal(options.method, exchange.method);
      if (exchange.method === "GET") {
        assert.equal(options.headers.Authorization, `Bearer ${exchange.token}`);
      } else {
        assert.equal(options.headers.Authorization, undefined, "Login must not transmit a previous JWT");
        assert.equal(options.headers["Content-Type"], "application/json");
      }
    } catch (error) {
      this.unexpected.push(error);
      throw error;
    }

    const request = new EventEmitter();
    let settled = false;
    request.setTimeout = () => request;
    request.destroy = (error) => {
      if (settled) return request;
      settled = true;
      this.pending.delete(exchange);
      if (error) queueMicrotask(() => request.emit("error", error));
      return request;
    };
    exchange.abort = () => request.destroy(new Error("Synthetic test cleanup"));
    exchange.reply = (response = exchange.response) => {
      assert.equal(settled, false, "An exchange can only complete once");
      settled = true;
      this.pending.delete(exchange);
      queueMicrotask(() => {
        if (response.networkError) {
          request.emit("error", new Error(response.networkError));
          return;
        }
        const incoming = new EventEmitter();
        incoming.statusCode = response.status ?? 200;
        incoming.headers = response.headers ?? { "content-type": "application/json" };
        callback(incoming);
        incoming.emit("data", Buffer.from(response.text ?? JSON.stringify(response.json)));
        incoming.emit("end");
      });
    };
    const chunks = [];
    request.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
    request.end = () => {
      try {
        const body = Buffer.concat(chunks);
        if (exchange.method === "POST") {
          assert.deepEqual(JSON.parse(body.toString("utf8")), {
            email: exchange.email, password: exchange.password
          }, "Only the exact synthetic email/password may be posted");
          assert.equal(options.headers["Content-Length"], String(body.length));
        } else {
          assert.equal(body.length, 0, "Subscription GET must have no request body");
        }
      } catch (error) { this.unexpected.push(error); throw error; }
      this.requests.push(exchange);
      this.pending.add(exchange);
      exchange.markStarted();
      if (!exchange.hold) exchange.reply();
      return request;
    };
    return request;
  }

  assertIdle() {
    assert.equal(this.unexpected.length, 0, this.unexpected[0]?.message);
    assert.equal(this.queue.length, 0, "Unused HTTP fixture");
    assert.equal(this.pending.size, 0, "Unfinished synthetic HTTP request");
  }

  dispose() {
    for (const exchange of [...this.pending]) exchange.abort();
    this.queue.length = 0;
  }
}

module.exports = { SyntheticTransport };
