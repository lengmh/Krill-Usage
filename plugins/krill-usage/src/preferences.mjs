import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
export const preferenceSchema = z.object({
  refreshIntervalMinutes: z.number().int().min(1).max(60),
  showBalance: z.boolean(),
  lowQuotaWarningPercent: z.number().min(0).max(100),
  lowQuotaCriticalPercent: z.number().min(0).max(100)
}).strict();
export const defaults = Object.freeze({refreshIntervalMinutes:3, showBalance:true, lowQuotaWarningPercent:15, lowQuotaCriticalPercent:5});
const snapshotSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  values: preferenceSchema
}).strict();
export function createPreferences(stateDir) {
  const file = path.join(stateDir, 'preferences.json');
  const lockFile = path.join(stateDir, 'preferences.lock');
  function readSnapshot() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid preference snapshot.');
      // Legacy flat settings start at revision zero and migrate on their next
      // save. Read metadata and values together from one atomically replaced file.
      if (Object.hasOwn(saved, 'revision')) return snapshotSchema.parse(saved);
      return {revision:0, values:preferenceSchema.parse({...defaults, ...saved})};
    } catch (error) {
      if (error.code === 'ENOENT') return {revision:0, values:{...defaults}};
      throw new Error('Unable to load non-secret preferences.');
    }
  }
  function read() { return readSnapshot().values; }
  function update(set) {
    const patch = preferenceSchema.partial().parse(set);
    fs.mkdirSync(stateDir, {recursive:true, mode:0o700});
    let lock; const temp = `${file}.${randomUUID()}.tmp`;
    try {
      // Synchronous read-modify-write under an exclusive lock also protects
      // different MCP processes. Never replace an existing lock, even if stale:
      // checking its owner and then unlinking cannot be done atomically.
      lock = fs.openSync(lockFile,'wx',0o600);
      fs.writeFileSync(lock,String(process.pid));
      const current = readSnapshot();
      const next = preferenceSchema.parse({...current.values, ...patch});
      if (next.lowQuotaCriticalPercent > next.lowQuotaWarningPercent) throw new Error('Critical quota threshold must not exceed warning threshold.');
      const snapshot = snapshotSchema.parse({revision:current.revision + 1, values:next});
      fs.writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, {mode:0o600, flag:'wx'});
      fs.renameSync(temp,file);
      return {...next};
    } catch (error) {
      if (lock === undefined && error.code === 'EEXIST') {
        throw new Error('Preferences lock already exists. Retry after any active settings update. If it persists, stop all Krill MCP processes before manually removing preferences.lock; see the plugin README.');
      }
      throw new Error('Unable to save preferences. Check values or retry after another settings update.');
    }
    finally {
      try { fs.unlinkSync(temp); } catch {}
      if (lock !== undefined) { try { fs.closeSync(lock); } catch {} try { fs.unlinkSync(lockFile); } catch {} }
    }
  }
  return {read, readSnapshot, update};
}
