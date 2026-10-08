"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadWithMocks, deferred, tick } = require("./helpers");

// All credential labels and account snapshots in these tests are synthetic.
function fixture(secretOverrides = {}) {
  let stored = "synthetic-account-a";
  const requests = [];
  const errors = [];
  const secrets = {
    async get() { return stored; },
    async store(_key, value) { stored = value; },
    async delete() { stored = undefined; },
    ...secretOverrides
  };
  const { KrillUsageService } = loadWithMocks("../src/service", {
    vscode: {
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
      window: { showErrorMessage: (message) => errors.push(message) }
    },
    "./api": { fetchSubscription: (jwt) => {
      const request = { jwt, ...deferred() };
      requests.push(request);
      return request.promise;
    } }
  });
  const service = new KrillUsageService({ secrets });
  return { service, requests, errors, getStored: () => stored };
}

const account = (balance) => ({ creditBalance: balance, subscriptions: [] });

test("switching accounts starts the new request and rejects the old success", async () => {
  const { service, requests } = fixture();
  const old = service.refresh();
  await tick();
  const switched = service.setJwt("synthetic-account-b");
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].jwt, "synthetic-account-b");
  requests[0].resolve(account("10"));
  assert.equal(await old, null);
  assert.equal(service.getView().snapshot, null);
  assert.equal(service.getView().refreshing, true, "old finally cannot finish new request");
  requests[1].resolve(account("20"));
  assert.deepEqual(await switched, account("20"));
  assert.deepEqual(service.getView().snapshot, account("20"));
  service.dispose();
});

test("clearing credentials blocks late success and late error without a toast", async (t) => {
  for (const outcome of ["success", "error"]) {
    await t.test(outcome, async () => {
      const { service, requests, errors, getStored } = fixture();
      const pending = service.refresh();
      await tick();
      await service.clearJwt();
      if (outcome === "success") requests[0].resolve(account("10"));
      else requests[0].reject(Object.assign(new Error("old account error"), { code: "UNAUTHORIZED" }));
      assert.equal(await pending, null);
      assert.equal(getStored(), undefined);
      assert.equal(service.getView().authenticated, false);
      assert.equal(service.getView().snapshot, null);
      assert.equal(service.getView().error, null);
      assert.equal(service.getView().lastSuccessAt, 0);
      assert.equal(service.getView().refreshing, false);
      assert.deepEqual(errors, []);
      service.dispose();
    });
  }
});

test("simultaneous refreshes share one request even while SecretStorage is pending", async () => {
  const read = deferred();
  const { service, requests } = fixture({ get: () => read.promise });
  const first = service.refresh();
  const second = service.refresh();
  read.resolve("synthetic-account-a");
  await tick();
  assert.equal(requests.length, 1);
  requests[0].resolve(account("10"));
  assert.deepEqual(await first, account("10"));
  assert.deepEqual(await second, account("10"));
  service.dispose();
});

test("clear invalidates a pending SecretStorage read before it can send a request", async () => {
  const read = deferred();
  const { service, requests } = fixture({ get: () => read.promise });
  const pending = service.refresh();
  await tick();
  await service.clearJwt();
  read.resolve("synthetic-account-a");
  assert.equal(await pending, null);
  assert.equal(requests.length, 0);
  assert.equal(service.getView().authenticated, false);
  service.dispose();
});

test("rapid set then clear persists in intent order and never fetches the superseded account", async () => {
  const write = deferred();
  let stored;
  const { service, requests } = fixture({
    store: async (_key, value) => { await write.promise; stored = value; },
    delete: async () => { stored = undefined; }
  });
  const setting = service.setJwt("synthetic-account-b");
  const clearing = service.clearJwt();
  write.resolve();
  await Promise.all([setting, clearing]);
  assert.equal(stored, undefined);
  assert.equal(requests.length, 0);
  assert.equal(service.getView().authenticated, false);
  service.dispose();
});

test("dispose prevents pending work from publishing state", async () => {
  const { service, requests } = fixture();
  const pending = service.refresh();
  await tick();
  service.dispose();
  requests[0].resolve(account("10"));
  assert.equal(await pending, null);
  assert.equal(service.getView().snapshot, null);
});

test("a failed credential write does not poison later refresh or clear", async () => {
  const { service, requests } = fixture({ store: async () => { throw new Error("Synthetic storage failure"); } });
  assert.equal(await service.setJwt("synthetic-account-b"), null);
  assert.equal(service.getView().error.code, "SECRET_STORAGE");
  const retry = service.refresh();
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].jwt, "synthetic-account-a", "failed save retains the actual previously stored credential");
  requests[0].resolve(account("10"));
  assert.deepEqual(await retry, account("10"));
  assert.equal(await service.clearJwt(), true);
  assert.equal(service.getView().authenticated, false);
  service.dispose();
});

test("failed refresh retains marked last data until a retry succeeds", async () => {
  const { service, requests } = fixture();
  const first = service.refresh();
  await tick();
  requests[0].resolve(account("10"));
  await first;
  const successAt = service.getView().lastSuccessAt;
  const failing = service.refresh("auto", { silent: true });
  await tick();
  requests[1].reject(Object.assign(new Error("Synthetic offline"), { code: "NETWORK" }));
  assert.equal(await failing, null);
  assert.deepEqual(service.getView().snapshot, account("10"));
  assert.equal(service.getView().lastSuccessAt, successAt);
  const retry = service.refresh();
  assert.equal(service.getView().error.code, "NETWORK", "failed data remains marked during retry");
  await tick();
  requests[2].resolve(account("20"));
  await retry;
  assert.equal(service.getView().error, null);
  assert.deepEqual(service.getView().snapshot, account("20"));
  service.dispose();
});
