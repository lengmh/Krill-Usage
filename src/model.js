"use strict";

/**
 * Normalize only what the UI needs. Billing rules remain server-authoritative.
 */
function numberOrNull(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function amount(value) {
  return numberOrNull(value) === null ? null : String(value).trim();
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, 160) : fallback;
}

function dateOrNull(value) {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function planType(plan = {}) {
  const days = numberOrNull(plan.duration_days);
  const name = text(plan.name);
  if (name.includes("月卡")) return "monthly";
  if (name.includes("周卡")) return "weekly";
  if (name.includes("天卡")) return "daily";
  if (days === 1) return "daily";
  if (days === 7) return "weekly";
  if (days !== null && days >= 28 && days <= 31) return "monthly";
  return "unknown";
}

function normalizeResponse(json) {
  if (
    json?.success !== true ||
    json?.code !== 0 ||
    !json?.data ||
    typeof json.data !== "object" ||
    Array.isArray(json.data)
  ) {
    throw new Error("INVALID_RESPONSE");
  }

  const data = json.data;
  if (!Array.isArray(data.subscriptions) || data.subscriptions.length > 500) {
    throw new Error("INVALID_RESPONSE");
  }

  // Keep server order exactly as returned.
  const subscriptions = data.subscriptions.map((sub) => {
    if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
      throw new Error("INVALID_RESPONSE");
    }
    const q = sub.quota ?? {};
    const plan = sub.plan ?? {};
    return {
      id: String(sub.subscription_id ?? ""),
      name: text(plan.name, "未知套餐"),
      type: planType(plan),
      status: text(sub.status, "unknown"),
      remaining: amount(q.remaining_usd),
      limit: amount(q.daily_limit_usd),
      resetAt: dateOrNull(q.window_reset_at),
      endAt: dateOrNull(sub.subscription_end_at)
    };
  });

  return {
    creditBalance: amount(data.credit_balance_usd),
    subscriptions
  };
}

function activeSubscription(subscriptions = []) {
  return subscriptions.find((s) => s.status === "active") ?? null;
}

/**
 * First active subscription that still has spendable quota, preserving
 * the server order. A zero/negative/missing remaining amount is not
 * useful for the status-bar headline; in that case the UI should fall
 * back to the account balance.
 */
function activeSubscriptionWithRemaining(subscriptions = []) {
  return subscriptions.find((s) => {
    if (s?.status !== "active") return false;
    const remaining = numberOrNull(s.remaining);
    return remaining !== null && remaining > 0;
  }) ?? null;
}

function topSubscription(subscriptions = []) {
  return activeSubscription(subscriptions) ?? subscriptions[0] ?? null;
}

function remainingPercent(remaining, limit) {
  const r = numberOrNull(remaining);
  const l = numberOrNull(limit);
  if (r === null || l === null || l <= 0) return null;
  const n = (r / l) * 100;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

module.exports = {
  numberOrNull,
  dateOrNull,
  planType,
  normalizeResponse,
  activeSubscription,
  activeSubscriptionWithRemaining,
  topSubscription,
  remainingPercent
};
