"use strict";

const API_URL = "https://www.krill-code.com/api/subscription";
const LOGIN_URL = "https://www.krill-code.com/api/auth/login";
const SECRET_KEY = "krill.jwt";
const AUTH_SECRET_KEY = "krill.auth.v1";
const EMAIL_SECRET_KEY = "krill.login.email";
const PASSWORD_SECRET_KEY = "krill.login.password";
const DEFAULT_REFRESH_MINUTES = 3;
const UI_TICK_MS = 60_000;

module.exports = {
  API_URL,
  LOGIN_URL,
  SECRET_KEY,
  AUTH_SECRET_KEY,
  EMAIL_SECRET_KEY,
  PASSWORD_SECRET_KEY,
  DEFAULT_REFRESH_MINUTES,
  UI_TICK_MS
};
