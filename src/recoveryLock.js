"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// The UI extension host uses a shared per-extension globalStorage directory.
// A local exclusive file prevents two VS Code windows from password-login at
// the same time. The holder MUST reread SecretStorage after acquiring it.
async function withRecoveryLock(directory, action) {
  if (typeof directory !== "string" || !directory) return action();
  await fs.mkdir(directory, { recursive: true });
  const name = path.join(directory, "krill-login.lock");
  const owner = randomUUID();
  const start = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(name, "wx", 0o600);
      await handle.writeFile(owner, "utf8");
    } catch (error) {
      if (handle) { await handle.close(); handle = null; }
      if (error?.code !== "EEXIST") throw error;
      // Crashed extension hosts can leave a lock; only reclaim a demonstrably
      // old lock. Never forcibly steal a lock still within the request budget.
      try {
        const stat = await fs.stat(name);
        if (Date.now() - stat.mtimeMs > 60_000) {
          await fs.unlink(name).catch(() => {});
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      if (Date.now() - start > 25_000) {
        const busy = new Error("另一个 VS Code 窗口正在登录，请稍后重试");
        busy.code = "RECOVERY_BUSY";
        throw busy;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  try { return await action(); }
  finally {
    await handle.close();
    // Check our identity so a former holder cannot unlink a replaced lock.
    const current = await fs.readFile(name, "utf8").catch(() => null);
    if (current === owner) await fs.unlink(name).catch(() => {});
  }
}

module.exports = { withRecoveryLock };
