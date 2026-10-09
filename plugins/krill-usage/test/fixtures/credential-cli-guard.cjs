"use strict";

// Preloaded only by synthetic CLI subprocess tests. Refuse all terminal access,
// default store creation, and native keyring loads before the CLI can use them.
const fail = () => { throw new Error("Synthetic CLI guard violation"); };
Object.defineProperty(process, "stdin", { get: fail });
require("node:os").homedir = fail;
const Module = require("node:module");
const load = Module._load;
Module._load = function(request, ...args) {
  if (request.includes("@napi-rs/keyring") || request.endsWith(".node")) fail();
  return load.call(this, request, ...args);
};
