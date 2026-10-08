"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { sanitizeJwt } = require("../../../src/jwt.js");

const SERVICE = "com.krill-usage.codex";
const ACCOUNT = "krill_jwt";
const REVISION_FILE = "credential-revision.json";
const LOCK_FILE = "credential-write.lock";
const MAX_CREDENTIAL_LENGTH = 16_384;
const STORAGE_MESSAGE = "Secure credential storage is unavailable, locked, or changing. Unlock your OS vault and retry the owner-only credential command. No plaintext fallback is used.";

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
  const value = sanitizeJwt(raw);
  if (!value || /^Bearer$/iu.test(value) || value.length > MAX_CREDENTIAL_LENGTH || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error("Enter one nonempty JWT in the hidden terminal prompt."), { code: "INVALID_JWT" });
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
      const value = await getEntry().getPassword();
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

  function recoverInterruptedWrite() {
    // Only called by the owner's explicitly confirmed recovery command. Never
    // break a live writer's lock; interrupted changes remain unreadable until
    // the owner successfully sets or clears the credential again.
    try {
      if (!checkDirectory()) return false;
      let stat;
      try { stat = fs.lstatSync(lockPath); }
      catch (error) { if (error?.code === "ENOENT") return false; throw error; }
      checkPrivate(stat, false);
      if (stat.size > 32) throw storageError();
      const pidText = fs.readFileSync(lockPath, "utf8").trim();
      if (!/^[1-9][0-9]*$/u.test(pidText)) throw storageError();
      const pid = Number(pidText);
      if (!Number.isSafeInteger(pid)) throw storageError();
      try { process.kill(pid, 0); throw storageError(); }
      catch (error) { if (error?.code !== "ESRCH") throw storageError(); }
      const current = fs.lstatSync(lockPath);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.mtimeMs !== stat.mtimeMs) throw storageError();
      fs.unlinkSync(lockPath);
      return true;
    } catch { throw storageError(); }
  }

  return { read, replace, clear, readRevision, onDidChange, revision: readRevision, onChange: onDidChange, recoverInterruptedWrite };
}

module.exports = { createCredentialStore, defaultStateDir, normalizeCredential, storageError, SERVICE, ACCOUNT, REVISION_FILE, LOCK_FILE, MAX_CREDENTIAL_LENGTH };
