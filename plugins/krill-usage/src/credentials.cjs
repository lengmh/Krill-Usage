"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { sanitizeJwt } = require("../../../src/jwt.js");
const { validateRawCredential } = require("./credential-prompt.cjs");

const SERVICE = "com.krill-usage.codex";
const ACCOUNT = "krill_jwt";
const REVISION_FILE = "credential-revision.json";
const LOCK_FILE = "credential-write.lock";
const MAX_CREDENTIAL_LENGTH = 16_384;
const READ_TIMEOUT_MS = 5_000;
const STORAGE_MESSAGE = "Secure credential storage is unavailable, locked, or changing. Unlock your OS vault and retry the owner-only credential command. No plaintext fallback is used.";

// AsyncEntry still connects to Secret Service synchronously in its constructor,
// and aborting a running native task cannot stop its libuv worker. Isolate the
// complete read in a disposable process; no secret goes through args or stdio.
const READ_SCRIPT = `
process.once("disconnect", () => process.exit(0));
async function read() {
  try {
    const { AsyncEntry } = require(process.argv[1]);
    const entry = new AsyncEntry(${JSON.stringify(SERVICE)}, ${JSON.stringify(ACCOUNT)}, { linux: { store: "secret-service" } });
    const value = await entry.getPassword();
    if (value != null && (typeof value !== "string" || value.length > ${MAX_CREDENTIAL_LENGTH})) throw new Error();
    process.send({ ok: true, value: value ?? null }, () => process.exit(0));
  } catch {
    process.send({ ok: false }, () => process.exit(0));
  }
}
void read();
`;

function storageError() {
  return Object.assign(new Error(STORAGE_MESSAGE), { code: "SECRET_STORAGE" });
}

function defaultStateDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "krill-usage-codex");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "krill-usage-codex");
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state");
  return path.join(base, "krill-usage-codex");
}

function normalizeCredential(raw) {
  validateRawCredential(raw);
  const value = sanitizeJwt(raw);
  if (!value || /^Bearer$/iu.test(value) || value.length > MAX_CREDENTIAL_LENGTH || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error("Enter one nonempty JWT in the secure credential window."), { code: "INVALID_JWT" });
  }
  return value;
}

/**
 * The vault is the only credential persistence. The local file contains only a
 * random revision and mutation phase, never a credential, account ID, or hash.
 * Entry/entryFactory injection is for synthetic tests; no fallback store exists.
 */
function createCredentialStore({ Entry, entryFactory, stateDir = defaultStateDir(), platform = process.platform } = {}) {
  const revisionPath = path.join(stateDir, REVISION_FILE);
  const lockPath = path.join(stateDir, LOCK_FILE);
  let entry;
  let writes = Promise.resolve();
  let activeRead;
  let disposed = false;

  function checkPrivate(stat, isDirectory) {
    if (isDirectory ? !stat.isDirectory() : !stat.isFile()) throw storageError();
    if (platform !== "win32") {
      if ((stat.mode & 0o077) !== 0) throw storageError();
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw storageError();
    }
  }

  function checkDirectory(create = false) {
    if (create) fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try { checkPrivate(fs.lstatSync(stateDir), true); }
    catch (error) {
      if (!create && error?.code === "ENOENT") return false;
      throw storageError();
    }
    return true;
  }

  function readMarker() {
    if (!checkDirectory()) return { revision: "absent", phase: "ready" };
    let fd;
    try {
      const stat = fs.lstatSync(revisionPath);
      checkPrivate(stat, false);
      fd = fs.openSync(revisionPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      checkPrivate(opened, false);
      if (opened.size > 256 || stat.ino !== opened.ino || stat.dev !== opened.dev) throw storageError();
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (value?.version !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.revision) ||
          !["changing", "ready"].includes(value.phase)) throw storageError();
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return { revision: "absent", phase: "ready" };
      throw storageError();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  function writeMarker(phase) {
    const temporary = path.join(stateDir, `.credential-revision-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, revision: randomUUID(), phase }) + "\n");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, revisionPath);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch {}
    }
  }

  function getEntry() {
    if (!entry) {
      if (entryFactory) entry = entryFactory(SERVICE, ACCOUNT, { linux: { store: "secret-service" } });
      else {
        // Lazy loading keeps --help, tests, and module import away from the vault.
        const KeyringEntry = Entry || require("@napi-rs/keyring").Entry;
        entry = new KeyringEntry(SERVICE, ACCOUNT, { linux: { store: "secret-service" } });
      }
      if (!entry || typeof entry.getPassword !== "function" || typeof entry.setPassword !== "function" || typeof entry.deletePassword !== "function") {
        throw storageError();
      }
    }
    return entry;
  }

  function readVault(revision) {
    if (disposed) return Promise.reject(storageError());
    // Do not reuse an old-account read or start more helpers before the previous
    // one has exited. The service already coalesces refreshes above this layer.
    if (activeRead) return activeRead.revision === revision && !activeRead.settled
      ? activeRead.promise : Promise.reject(storageError());
    const operation = { revision, settled: false, promise: null, cancel: null };
    activeRead = operation;
    operation.promise = new Promise((resolve, reject) => {
      let child, timer, received = false, value;
      const kill = () => { try { child?.kill("SIGKILL"); } catch {} };
      const fail = () => {
        value = undefined;
        if (!operation.settled) {
          operation.settled = true;
          clearTimeout(timer);
          reject(storageError());
        }
        kill();
      };
      operation.cancel = fail;
      timer = setTimeout(fail, READ_TIMEOUT_MS);
      try {
        // Resolve from this module, including the packaged bundle, not the cwd.
        // Do not inherit execArgv (test runners, inspectors, or preloads).
        child = spawn(process.execPath, ["-e", READ_SCRIPT, require.resolve("@napi-rs/keyring")], {
          shell: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"]
        });
      } catch {
        activeRead = null;
        fail();
        return;
      }
      child.on("error", fail);
      child.on("message", message => {
        if (operation.settled) return;
        if (received || message?.ok !== true ||
            (message.value !== null && (typeof message.value !== "string" || message.value.length > MAX_CREDENTIAL_LENGTH))) {
          fail(); return;
        }
        received = true;
        value = message.value;
      });
      child.once("close", (code, signal) => {
        if (activeRead === operation) activeRead = null;
        if (!operation.settled) {
          if (code !== 0 || signal || !received) { fail(); return; }
          operation.settled = true;
          clearTimeout(timer);
          resolve(value);
        }
        value = undefined;
      });
    });
    return operation.promise;
  }

  function dispose() {
    disposed = true;
    activeRead?.cancel();
  }

  async function readRevision() {
    try {
      const marker = readMarker();
      if (marker.phase !== "ready") throw storageError();
      return marker.revision;
    } catch { throw storageError(); }
  }

  async function read() {
    try {
      const before = await readRevision();
      const value = Entry || entryFactory ? await getEntry().getPassword() : await readVault(before);
      if (before !== await readRevision()) throw storageError();
      if (value === null || value === undefined) return null;
      return normalizeCredential(value);
    } catch { throw storageError(); }
  }

  function mutate(value) {
    const operation = writes.catch(() => {}).then(async () => {
      let lock;
      try {
        checkDirectory(true);
        // Fail closed rather than attempting unsafe stale-lock takeover. After a
        // hard crash, the owner can remove this nonsecret lock once no setup runs.
        lock = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(lock, `${process.pid}\n`);
        writeMarker("changing");
        if (value === null) await getEntry().deletePassword();
        else await getEntry().setPassword(value);
        writeMarker("ready");
      } catch { throw storageError(); }
      finally {
        if (lock !== undefined) {
          try { fs.closeSync(lock); } catch {}
          try { fs.unlinkSync(lockPath); } catch {}
        }
      }
    });
    writes = operation.catch(() => {});
    return operation;
  }

  function replace(raw) {
    let value;
    try { value = normalizeCredential(raw); }
    catch (error) { return Promise.reject(error); }
    return mutate(value);
  }

  function clear() { return mutate(null); }

  function onDidChange(callback) {
    if (typeof callback !== "function") throw new TypeError("A change callback is required.");
    const listener = () => { try { callback(); } catch {} };
    // No vault polling. Services also recheck the revision before every result;
    // this watcher only clears retained in-memory state promptly between calls.
    fs.watchFile(revisionPath, { persistent: false, interval: 100 }, listener);
    return { dispose() { fs.unwatchFile(revisionPath, listener); } };
  }

  function recoverInterruptedWrite({ manual = false } = {}) {
    // Only called by the owner's explicitly confirmed recovery command. Never
    // break a live writer's lock. Manual recovery permits an UNKNOWN owner only
    // after the owner confirms all other writers are stopped until completion.
    // Snapshot checks detect changes; they cannot make check-then-unlink atomic.
    // Recovery never reads the revision marker or initializes the vault.
    let fd;
    const refused = (code = "RECOVERY_FAILED") => Object.assign(new Error("Credential lock recovery was refused. No secret details are printed."), { code });
    const unchanged = (before, after) => ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeMs", "ctimeMs"].every(key => before[key] === after[key]);
    try {
      if (!checkDirectory()) return false;
      const directory = fs.lstatSync(stateDir);
      checkPrivate(directory, true);
      let stat;
      try { stat = fs.lstatSync(lockPath); }
      catch (error) { if (error?.code === "ENOENT") return false; throw error; }
      checkPrivate(stat, false);
      if (stat.size > 32 || stat.nlink !== 1) throw refused();
      fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const opened = fs.fstatSync(fd);
      checkPrivate(opened, false);
      if (!unchanged(stat, opened)) throw refused();
      const contents = Buffer.alloc(33);
      const bytes = fs.readSync(fd, contents, 0, contents.length, 0);
      if (bytes !== stat.size || !unchanged(stat, fs.fstatSync(fd))) throw refused();
      const pidText = contents.toString("utf8", 0, bytes).trim();
      const pid = Number(pidText);
      const validPid = /^[1-9][0-9]*$/u.test(pidText) && Number.isSafeInteger(pid);
      if (validPid) {
        try { process.kill(pid, 0); throw refused("RECOVERY_LIVE_LOCK"); }
        catch (error) { if (error?.code !== "ESRCH") throw refused("RECOVERY_LIVE_LOCK"); }
      } else if (manual !== true) throw refused("RECOVERY_MANUAL_REQUIRED");
      fs.closeSync(fd);
      fd = undefined;
      const current = fs.lstatSync(lockPath);
      checkPrivate(current, false);
      const currentDirectory = fs.lstatSync(stateDir);
      checkPrivate(currentDirectory, true);
      if (!unchanged(stat, current) || !unchanged(directory, currentDirectory)) throw refused();
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      throw refused(["RECOVERY_MANUAL_REQUIRED", "RECOVERY_LIVE_LOCK"].includes(error?.code) ? error.code : "RECOVERY_FAILED");
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  return { read, replace, clear, readRevision, onDidChange, revision: readRevision, onChange: onDidChange, recoverInterruptedWrite, dispose };
}

module.exports = { createCredentialStore, defaultStateDir, normalizeCredential, storageError, SERVICE, ACCOUNT, REVISION_FILE, LOCK_FILE, MAX_CREDENTIAL_LENGTH, READ_TIMEOUT_MS };
