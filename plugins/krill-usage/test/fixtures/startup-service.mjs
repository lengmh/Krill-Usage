import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCredentialStore, REVISION_FILE } from '../../src/credentials.cjs';
import { createPreferences } from '../../src/preferences.mjs';
import { UsageService } from '../../src/service.mjs';

// The production adapter reads a real private marker synchronously inside its
// async method. Only the native vault entry and network request are synthetic.
export function startupFixture() {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'krill-startup-'));
  const calls = { vaultReads: 0, requests: [] };
  const account = { jwt: 'synthetic-account-a' };
  class FakeEntry {
    getPassword() { calls.vaultReads++; return account.jwt; }
    setPassword(value) { account.jwt = value; }
    deletePassword() { account.jwt = null; return true; }
  }
  function setAccount(jwt, phase = 'ready') {
    account.jwt = jwt;
    writeFileSync(path.join(stateDir, REVISION_FILE), JSON.stringify({ version: 1, revision: randomUUID(), phase }), { mode: 0o600 });
  }
  setAccount(account.jwt);
  const credentials = createCredentialStore({ Entry: FakeEntry, stateDir });
  const preferences = createPreferences(stateDir);
  const service = new UsageService({ credentials, preferences, now: () => 1_000_000,
    fetchUsage: async jwt => {
      calls.requests.push(jwt);
      return { creditBalance: jwt === 'synthetic-account-b' ? '200' : '100', subscriptions: [] };
    }
  });
  return { service, credentials, preferences, calls, account, setAccount,
    close() { service.dispose(); rmSync(stateDir, { recursive: true, force: true }); }
  };
}
