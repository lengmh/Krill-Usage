"use strict";

function sanitizeJwt(value) {
  if (typeof value !== "string") return "";
  let jwt = value.trim();
  if (/^Bearer\s+/i.test(jwt)) jwt = jwt.replace(/^Bearer\s+/i, "").trim();
  if ((jwt.startsWith('"') && jwt.endsWith('"')) || (jwt.startsWith("'") && jwt.endsWith("'"))) {
    jwt = jwt.slice(1, -1).trim();
  }
  return jwt;
}

module.exports = { sanitizeJwt };
