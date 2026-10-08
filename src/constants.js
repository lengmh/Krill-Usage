"use strict";

const API_URL = "https://www.krill-code.com/api/subscription";
const SECRET_KEY = "krill.jwt";
const DEFAULT_REFRESH_MINUTES = 3;
const UI_TICK_MS = 60_000;

module.exports = {
  API_URL,
  SECRET_KEY,
  DEFAULT_REFRESH_MINUTES,
  UI_TICK_MS
};
