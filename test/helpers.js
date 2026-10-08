"use strict";

const Module = require("node:module");

function loadWithMocks(modulePath, mocks) {
  const resolved = require.resolve(modulePath);
  const original = Module._load;
  delete require.cache[resolved];
  Module._load = function(request, parent, isMain) {
    if (Object.hasOwn(mocks, request)) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(resolved); }
  finally { Module._load = original; }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { loadWithMocks, deferred, tick };
