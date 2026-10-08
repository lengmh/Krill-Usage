"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeJwt } = require("../src/jwt");

test("sanitizeJwt strips Bearer prefix and quotes", () => {
  assert.equal(sanitizeJwt("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(sanitizeJwt('"abc.def.ghi"'), "abc.def.ghi");
});
