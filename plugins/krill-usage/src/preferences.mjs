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
export function createPreferences(stateDir) {
  const file = path.join(stateDir, 'preferences.json');
  const lockFile = path.join(stateDir, 'preferences.lock');
  function read() {
    try { return preferenceSchema.parse({...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8'))}); }
    catch (error) { if (error.code === 'ENOENT') return {...defaults}; throw new Error('Unable to load non-secret preferences.'); }
  }
  function update(set) {
    const patch = preferenceSchema.partial().parse(set);
    fs.mkdirSync(stateDir, {recursive:true, mode:0o700});
    let lock; const temp = `${file}.${randomUUID()}.tmp`;
    try {
      // Synchronous read-modify-write under an exclusive lock also protects
      // different MCP processes. A simultaneous writer can retry its update.
      try { lock = fs.openSync(lockFile,'wx',0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = fs.lstatSync(lockFile);
        if (!stat.isFile() || stat.size > 32) throw error;
        const pid = Number(fs.readFileSync(lockFile,'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw error;
        try { process.kill(pid,0); throw error; }
        catch (status) { if (status.code !== 'ESRCH') throw error; }
        const current = fs.lstatSync(lockFile);
        if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) throw error;
        fs.unlinkSync(lockFile); lock = fs.openSync(lockFile,'wx',0o600);
      }
      fs.writeFileSync(lock,String(process.pid));
      const next = preferenceSchema.parse({...read(), ...patch});
      if (next.lowQuotaCriticalPercent > next.lowQuotaWarningPercent) throw new Error('Critical quota threshold must not exceed warning threshold.');
      fs.writeFileSync(temp, `${JSON.stringify(next)}\n`, {mode:0o600, flag:'wx'});
      fs.renameSync(temp,file);
      return {...next};
    } catch { throw new Error('Unable to save preferences. Check values or retry after another settings update.'); }
    finally {
      try { fs.unlinkSync(temp); } catch {}
      if (lock !== undefined) { try { fs.closeSync(lock); } catch {} try { fs.unlinkSync(lockFile); } catch {} }
    }
  }
  return {read, update};
}
