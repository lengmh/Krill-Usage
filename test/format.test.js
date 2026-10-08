"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { money, countdown, timeText, statusText } = require("../src/format");

test("money formatting", () => {
  assert.equal(money("42.123456"), "$42.1");
  assert.equal(money("123.450000", true), "$123.45");
});

test("countdown never becomes negative", () => {
  assert.equal(countdown("2020-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:00Z")), "0m");
});

test("monthly has refresh and total remaining", () => {
  const sub = {
    type: "monthly",
    resetAt: "2026-09-19T00:00:00Z",
    endAt: "2026-09-28T00:00:00Z"
  };
  const text = timeText(sub, false, Date.parse("2026-09-18T00:00:00Z"));
  assert.match(text, /^刷新 /);
  assert.match(text, /\/ 剩余 /);
});

test("frozen status label", () => {
  assert.equal(statusText("frozen"), "冻结");
});
