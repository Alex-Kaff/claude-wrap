// Tiny on-disk registry of running claude-wrap instances so that an
// `inject` invoked from any shell can discover which pipe to talk to.
//
// Stored as a single JSON file in the OS temp dir. Each entry matches
// InstanceEntry below: { pipe, pid, cwd, title?, label?, httpPort?, startedAt }.
// Entries whose pid is no longer alive are treated as stale and pruned
// on every read/write.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface InstanceEntry {
  pipe: string;
  pid: number;
  cwd: string;
  title?: string;
  /** Short human label (usually the cwd basename) for UX selection. */
  label?: string;
  /** Loopback HTTP bridge port, if one is running for this instance. */
  httpPort?: number;
  startedAt: string;
}

const REGISTRY_PATH = path.join(os.tmpdir(), "claude-wrap-instances.json");
const LOCK_PATH = `${REGISTRY_PATH}.lock`;

/**
 * Acquire an exclusive cross-process lock on the registry by creating
 * a lock file with O_EXCL. Retries with a short backoff up to ~2s.
 * Stale locks (> LOCK_TTL_MS old) are stolen so a crashed process
 * doesn't wedge the registry forever.
 */
const LOCK_TTL_MS = 5_000;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;

function acquireLock(): number | null {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      return fd;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
      // Steal stale lock files from crashed processes.
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > LOCK_TTL_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        /* ignore — another process probably already released */
      }
      const waitUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < waitUntil) {
        /* busy wait — locks are short */
      }
    }
  }
  return null;
}

function releaseLock(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

/**
 * Run `fn` while holding the registry lock. If the lock cannot be
 * acquired in time, fall through and run `fn` anyway — losing one
 * concurrent registration is strictly better than blocking startup.
 */
function withLock<T>(fn: () => T): T {
  const fd = acquireLock();
  try {
    return fn();
  } finally {
    if (fd !== null) releaseLock(fd);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRaw(): InstanceEntry[] {
  try {
    const txt = fs.readFileSync(REGISTRY_PATH, "utf8");
    const data = JSON.parse(txt) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(
      (e): e is InstanceEntry =>
        !!e &&
        typeof (e as InstanceEntry).pipe === "string" &&
        typeof (e as InstanceEntry).pid === "number",
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: InstanceEntry[]): void {
  // Write-to-temp + rename is as close to atomic as POSIX and Windows
  // both get. A concurrent reader sees either the old or new complete
  // file, never a half-written one. Combined with the cross-process
  // lock in withLock(), two wrappers starting simultaneously can't
  // clobber each other's entries.
  try {
    const tmp = `${REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    fs.renameSync(tmp, REGISTRY_PATH);
  } catch {
    /* best effort */
  }
}

/** Return all instances whose pid is still alive. */
export function listInstances(): InstanceEntry[] {
  // Read once — a second readRaw() would race with concurrent
  // register/unregister from other processes and could wipe
  // just-added entries.
  return withLock(() => {
    const raw = readRaw();
    const live = raw.filter((e) => isAlive(e.pid));
    if (live.length !== raw.length) writeRaw(live);
    return live;
  });
}

export function registerInstance(entry: InstanceEntry): void {
  withLock(() => {
    const live = readRaw()
      .filter((e) => isAlive(e.pid))
      .filter((e) => e.pipe !== entry.pipe && e.pid !== entry.pid);
    live.push(entry);
    writeRaw(live);
  });
}

export function unregisterInstance(pipe: string): void {
  withLock(() => {
    const live = readRaw()
      .filter((e) => isAlive(e.pid))
      .filter((e) => e.pipe !== pipe);
    writeRaw(live);
  });
}

/** Build a short, unique pipe name for a new instance. */
export function makePipeName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `claude-wrap-${process.pid}-${rand}`;
}

/**
 * Resolve a user-supplied selector to a live instance. Matches in this
 * order: exact pipe name, exact label, unique pipe prefix, unique label
 * prefix. Returns null if nothing (or more than one thing) matches.
 */
export function findInstance(selector: string): InstanceEntry | null {
  const live = listInstances();
  const exact = live.find((e) => e.pipe === selector || e.label === selector);
  if (exact) return exact;
  const prefix = live.filter(
    (e) => e.pipe.startsWith(selector) || (e.label ?? "").startsWith(selector),
  );
  return prefix.length === 1 ? prefix[0]! : null;
}
