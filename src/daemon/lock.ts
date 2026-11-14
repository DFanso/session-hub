import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

export const LOCK_FILE = "daemon.lock";
// A lock file without a valid pid younger than this may still be mid-write by its creator.
const FRESH_MS = 5_000;
/** A recorded start time matches a live process's start time within this much. */
export const START_TIME_SLACK_MS = 2_000;

/**
 * What daemon.lock records: the daemon's pid and, since this version, its process start time (epoch
 * ms). A lock written by an older version has only the pid (`startedAt` null).
 */
export interface LockInfo {
  pid: number;
  startedAt: number | null;
}

/** Pure: `<pid>` (legacy) or `<pid> <startedAtMs>`; null for anything else. */
export function parseLock(text: string): LockInfo | null {
  const m = /^(\d+)(?: (\d+))?$/.exec(text.trim());
  if (m === null) return null;
  const pid = Number(m[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const startedAt = m[2] === undefined ? null : Number(m[2]);
  if (startedAt !== null && !Number.isSafeInteger(startedAt)) return null;
  return { pid, startedAt };
}

/** Pure: the lock file text for `info`. */
export function formatLock(info: LockInfo): string {
  return info.startedAt === null ? String(info.pid) : `${info.pid} ${info.startedAt}`;
}

/**
 * What the process named in daemon.lock is:
 * - "ours": the daemon that wrote the lock. With a recorded start time: the pid is alive and started
 *   at that time (within START_TIME_SLACK_MS), whatever its image (a daemon run from source is bun.exe).
 *   With a legacy pid-only lock: alive and running hubd.exe or hub.exe, or bun.exe when this process
 *   itself runs from source (`dev`).
 * - "foreign": dead, or alive but a different process: another start time, or (legacy lock) a readable
 *   image that is none of those. Only this is a stale lock.
 * - "unknown": alive but it cannot be queried (elevated, protected, gone mid-query), or (legacy lock)
 *   bun.exe while this process is compiled.
 * Start and lock decisions treat "ours" and "unknown" as held: never a second daemon, never a takeover.
 * Only "ours" may ever be killed (and only after isKillableImage).
 */
export type DaemonIdentity = "ours" | "foreign" | "unknown";

/** What can be learned about a live pid; each is null when it cannot be read. */
export interface ProcessProbe {
  alive: boolean;
  startedAt: number | null;
  image: string | null;
}

function imageName(image: string): string {
  return basename(image.replaceAll("\\", "/")).toLowerCase();
}

/** Pure: classifies the lock's process from what was probed about it. */
export function daemonIdentity(lock: LockInfo, probe: ProcessProbe, dev: boolean): DaemonIdentity {
  if (!probe.alive) return "foreign";
  if (lock.startedAt !== null) {
    if (probe.startedAt === null) return "unknown";
    return Math.abs(probe.startedAt - lock.startedAt) <= START_TIME_SLACK_MS ? "ours" : "foreign";
  }
  if (probe.image === null) return "unknown";
  const name = imageName(probe.image);
  if (name === "hubd.exe" || name === "hub.exe") return "ours";
  if (name === "bun.exe") return dev ? "ours" : "unknown";
  return "foreign";
}

/** True for an image a daemon can run as (hubd.exe, hub.exe, bun.exe): the last guard before a kill. */
export function isKillableImage(image: string | null): boolean {
  if (image === null) return false;
  const name = imageName(image);
  return name === "hubd.exe" || name === "hub.exe" || name === "bun.exe";
}

/** How identifyDaemon looks at a pid (the real ones query the process; tests fake them). */
export interface ProcessQueries {
  isAlive(pid: number): boolean;
  /** Process start time, epoch ms; null when it cannot be queried. */
  startTime(pid: number): number | null;
  imagePath(pid: number): string | null;
}

/**
 * daemonIdentity for a lock: queries a live process only, and only for what the lock format needs
 * (the start time, or the image for a legacy lock).
 */
export function identifyDaemon(lock: LockInfo, q: ProcessQueries, dev: boolean): DaemonIdentity {
  const alive = q.isAlive(lock.pid);
  if (!alive) return "foreign";
  const probe: ProcessProbe =
    lock.startedAt !== null
      ? { alive, startedAt: q.startTime(lock.pid), image: null }
      : { alive, startedAt: null, image: q.imagePath(lock.pid) };
  return daemonIdentity(lock, probe, dev);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreate(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * The text of a lock judged stale (dead holder, reused pid, or an empty old file), or null while it is
 * held. "" when the file vanished between create and read.
 */
function staleText(path: string, identify: (lock: LockInfo) => DaemonIdentity): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return ""; // vanished between create and read: stale
  }
  const lock = parseLock(text);
  if (lock !== null) return identify(lock) === "foreign" ? text : null;
  try {
    return Date.now() - statSync(path).mtimeMs < FRESH_MS ? null : text;
  } catch {
    return "";
  }
}

export interface LockOptions {
  /** Classifies the process of an existing lock. Default: a live pid is "unknown" (held). */
  identify?: (lock: LockInfo) => DaemonIdentity;
  /** This process's start time (epoch ms), written next to its pid; null writes the pid only. */
  startedAt?: number | null;
}

/**
 * Single-instance lock at `<dir>/daemon.lock`, holding `<pid> <startedAtMs>` (or `<pid>` when the start
 * time is unknown). Null while it is held. Only a "foreign" holder (dead, or a pid reused by another
 * process after an unclean exit) leaves a stale lock, taken over.
 */
export function acquireLock(dir: string, opts: LockOptions = {}): { release(): void } | null {
  const identify = opts.identify ?? ((l: LockInfo) => (isAlive(l.pid) ? "unknown" : "foreign"));
  const mine = formatLock({ pid: process.pid, startedAt: opts.startedAt ?? null });
  const path = join(dir, LOCK_FILE);
  if (!tryCreate(path, mine)) {
    const stale = staleText(path, identify);
    if (stale === null) return null;
    // Compare-and-delete: remove only the exact lock judged stale, so a rival that took it over
    // before this read keeps its fresh lock (RES-11). Read and unlink are two steps, so a rival
    // that takes over between them can still lose its lock; this narrows the window, it does not
    // close it. An exclusive handle held for the daemon's life would.
    try {
      if (readFileSync(path, "utf8") === stale) unlinkSync(path);
    } catch {
      // someone else removed it first
    }
    if (!tryCreate(path, mine)) return null;
  }
  return {
    release(): void {
      try {
        if (readFileSync(path, "utf8").trim() === mine) unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}
