"use strict";

const { numberOrNull } = require("./model");

function money(value, balance = false) {
  const n = numberOrNull(value);
  if (n === null) return "--";
  if (balance) return `$${n.toFixed(2)}`;
  if (n > 0 && n < 0.05) return "<$0.1";
  return `$${n.toFixed(1).replace(/\.0$/, "")}`;
}

function percentText(value) {
  if (value === null || !Number.isFinite(value)) return "--";
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}

function countdown(targetIso, now = Date.now(), compact = false) {
  const target = typeof targetIso === "string" ? Date.parse(targetIso) : NaN;
  if (!Number.isFinite(target)) return "--";
  const delta = Math.max(0, target - now);
  if (delta > 0 && delta < 60_000) return "<1m";

  const total = Math.floor(delta / 60_000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const space = compact ? "" : " ";

  if (days) return `${days}d${space}${pad(hours)}h`;
  if (hours) return `${pad(hours)}h${space}${pad(minutes)}m`;
  return `${minutes}m`;
}

function timeText(sub, compact = false, now = Date.now()) {
  if (!sub) return "暂无套餐";
  if (sub.type === "monthly") {
    const refresh = countdown(sub.resetAt, now, compact);
    return compact
      ? `刷新 ${refresh}`
      : `刷新 ${refresh} / 剩余 ${countdown(sub.endAt, now)}`;
  }
  return `剩余 ${countdown(sub.endAt, now, compact)}`;
}

function statusText(status) {
  return (
    {
      active: "",
      frozen: "冻结",
      expired: "已结束",
      cancelled: "已取消",
      canceled: "已取消"
    }[status] ?? (status === "unknown" ? "未知" : status)
  );
}

function updateAge(lastSuccessAt, now = Date.now()) {
  if (!lastSuccessAt) return "尚未更新";
  const elapsed = Math.max(0, now - lastSuccessAt);
  return elapsed < 60_000 ? "刚刚更新" : `${Math.floor(elapsed / 60_000)} 分钟前更新`;
}

module.exports = {
  money,
  percentText,
  countdown,
  timeText,
  statusText,
  updateAge
};
