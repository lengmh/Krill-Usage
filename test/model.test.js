"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeResponse, activeSubscription, activeSubscriptionWithRemaining, topSubscription, remainingPercent } = require("../src/model");

// Synthetic account data, not copied from a live account.
const sample = {
  success: true,
  code: 0,
  data: {
    credit_balance_usd: "123.450000",
    subscriptions: [
      {
        subscription_id: 1001,
        status: "active",
        plan: { name: "轻享月卡", duration_days: 30 },
        subscription_end_at: "2030-02-01T00:00:00Z",
        quota: {
          daily_limit_usd: "600.000000",
          remaining_usd: "240.000000",
          window_reset_at: "2030-01-08T00:00:00Z"
        }
      },
      {
        subscription_id: 1002,
        status: "frozen",
        plan: { name: "轻享周卡", duration_days: 7 },
        subscription_end_at: "2030-01-01T00:00:00Z",
        quota: { daily_limit_usd: "560.000000", remaining_usd: "0" }
      }
    ]
  }
};

test("normalizes sample and preserves order", () => {
  const state = normalizeResponse(sample);
  assert.equal(state.creditBalance, "123.450000");
  assert.deepEqual(state.subscriptions.map((x) => x.name), ["轻享月卡", "轻享周卡"]);
  assert.equal(state.subscriptions[0].type, "monthly");
  assert.equal(state.subscriptions[1].type, "weekly");
});

test("top subscription chooses first active", () => {
  const state = normalizeResponse(sample);
  assert.equal(topSubscription(state.subscriptions).id, "1001");
});


test("active subscription does not fall back to frozen plans", () => {
  const subscriptions = [
    { id: "frozen", status: "frozen" },
    { id: "expired", status: "expired" }
  ];
  assert.equal(activeSubscription(subscriptions), null);
  assert.equal(topSubscription(subscriptions).id, "frozen");
});


test("status headline uses only active subscriptions with remaining quota", () => {
  const zeroOnly = [
    { id: "a", status: "active", remaining: "0", limit: "600" },
    { id: "b", status: "active", remaining: "0.000000", limit: "560" },
    { id: "c", status: "frozen", remaining: "99", limit: "100" }
  ];
  assert.equal(activeSubscription(zeroOnly).id, "a");
  assert.equal(activeSubscriptionWithRemaining(zeroOnly), null);

  const mixed = [
    { id: "a", status: "active", remaining: "0", limit: "600" },
    { id: "b", status: "active", remaining: "12.5", limit: "560" }
  ];
  assert.equal(activeSubscriptionWithRemaining(mixed).id, "b");
});

test("remaining percentage is server amounts only", () => {
  assert.ok(Math.abs(remainingPercent("240.000000", "600") - 40) < 0.000001);
});
