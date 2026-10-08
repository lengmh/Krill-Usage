import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const log = (event, details = {}) => process.stderr.write(JSON.stringify({ diagnostic: 'credential-read-runner', event, ...details }) + '\n');
// Run directly so a stalled test file cannot hide its diagnostics behind the
// aggregate test runner's ordered per-file output.
const child = spawn(process.execPath, [
  '--require', path.resolve('test/fixtures/credential-read-diagnostics.cjs'),
  path.resolve('test/credential-read.test.mjs')
], { stdio: 'inherit', shell: false, windowsHide: true });
let timedOut = false;
const deadline = setTimeout(() => {
  timedOut = true;
  log('deadline', { childPid: child.pid, milliseconds: 90_000 });
  if (process.platform === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
    // Only this runner's synthetic test process and its descendants are targets.
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, error => {
      log('tree-cleanup', { code: error?.code ?? 0 });
      try { child.kill('SIGKILL'); } catch {}
    });
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}, 90_000);
child.once('error', error => {
  clearTimeout(deadline);
  log('spawn-error', { code: error.code });
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  clearTimeout(deadline);
  log('complete', { childPid: child.pid, code, signal, timedOut });
  process.exitCode = timedOut || code !== 0 ? 1 : 0;
});
