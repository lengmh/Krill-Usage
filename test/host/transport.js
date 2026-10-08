"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

// A deliberately small replacement for the https.request boundary. Production
// api.js still handles HTTP statuses, headers, JSON, normalization, and errors.
// There is no pass-through, so this harness cannot send a Krill HTTP request.
class SyntheticTransport {
  constructor(apiUrl) {
    this.apiUrl = apiUrl;
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
      token, response, hold,
      started: new Promise((resolve) => { started = resolve; }),
      markStarted: () => started(),
      reply: null
    };
    this.queue.push(exchange);
    return exchange;
  }

  request(url, options, callback) {
    let exchange;
    try {
      assert.equal(String(url), this.apiUrl, "Unexpected production HTTP destination");
      assert.equal(options.method, "GET");
      exchange = this.queue.shift();
      assert.ok(exchange, "Unexpected production HTTP request; no fixture was queued");
      assert.equal(options.headers.Authorization, `Bearer ${exchange.token}`);
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
    request.end = () => {
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
