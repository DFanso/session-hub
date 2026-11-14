import { mkdirSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { RETENTION_MS, SAFETY_POLL_MS } from "../config.ts";
import { type ClaudeCli, isOwnRelay, type LiveSession } from "../discovery/agents.ts";
import { watchSessions } from "../discovery/watch.ts";
import type { Classified } from "../ingest/records.ts";
import type { Platform } from "../platform/types.ts";
import type { SessionRow, SessionView, Store } from "../store/db.ts";
import { type IngestCtx, ingestFile } from "./ingest-pass.ts";
import { acquireLock, type DaemonIdentity, type LockInfo, type LockOptions } from "./lock.ts";
import { createLogger, errFields, type Logger } from "./log.ts";
import { firstCwd, isSessionId, listTranscripts, transcriptIndex } from "./transcripts.ts";

export interface DaemonDeps {
  cli: ClaudeCli;
  store: Store;
  platform: Platform;
  now: () => number;
  profiles: readonly { id: string; dir: string }[];
  dataDir: string;
  relayDir: string;
  signal: AbortSignal;
  watch?: typeof watchSessions;
  onRecords?: (sessionId: string, records: Classified[]) => void;
  log?: Logger;
  /** Classifies the process an existing daemon.lock names (see acquireLock and DaemonIdentity). */
  daemonIdentity?: (lock: LockInfo) => DaemonIdentity;
}

export const TAIL_POLL_MS = 2_000;
export const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
const PURGE_EVERY_MS = 3_600_000;
const VACUUM_EVERY_MS = 86_400_000;
/** A purge or vacuum that failed with a non-busy error is retried at most this often. */
const MAINT_RETRY_MS = 300_000;

interface Request {
  liveness: boolean;
  scan: boolean;
}

interface ProfileState {
  failures: number;
  nextAt: number;
  retry: ReturnType<typeof setTimeout> | undefined;
}

interface Watcher {
  stop: () => void;
  /** False after onError: the watcher is dead and is re-armed once the folder exists. */
  armed: boolean;
  /** now() of the last re-arm; cleared once that watcher survived one SAFETY_POLL_MS. */
  rearmedAt: number | null;
  /**
   * watch_error / watch_rearmed already logged. Stays set until a re-armed watcher has survived
   * one SAFETY_POLL_MS, so a watcher that keeps dying cannot log every tick.
   */
  errorLogged: boolean;
  rearmLogged: boolean;
}

interface Counters {
  files: number;
  lines: number;
  messages: number;
  unknown: number;
  unrecognized: number;
  errors: number;
}

const zero = (): Counters => ({
  files: 0,
  lines: 0,
  messages: 0,
  unknown: 0,
  unrecognized: 0,
  errors: 0,
});

function toRow(v: SessionView): SessionRow {
  const { state, status: _status, latestReply: _latest, waitingCount: _count, ...rest } = v;
  return { ...rest, status: state };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isBusy(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

class Collector {
  private readonly sessions = new Map<string, SessionRow>();
  private readonly liveByProfile = new Map<string, Set<string>>();
  private readonly profileState = new Map<string, ProfileState>();
  /** Recent transcripts from the last scan: path -> sessionId. */
  private recent = new Map<string, string>();
  private readonly watchers = new Map<string, Watcher>();
  /** path -> "size:mtimeMs" of a file whose unread rest is only an incomplete last line. */
  private readonly partialAt = new Map<string, string>();
  /** now() before which a purge / vacuum that failed with a non-busy error is not retried. */
  private purgeRetryAt = 0;
  private vacuumRetryAt = 0;
  /** Sessions whose cached transcript vanished and was already logged. */
  private readonly missingLogged = new Set<string>();
  private req: Request | null = null;
  private draining = false;
  private drained: Promise<void> = Promise.resolve();
  private stopped = false;
  private counters = zero();
  private readonly ingestCtx: IngestCtx;

  constructor(
    private readonly deps: DaemonDeps,
    private readonly log: Logger,
  ) {
    this.reloadSessions();
    // Until a profile's first successful agents call, its last known live list is the store's.
    for (const row of this.sessions.values()) {
      if (row.endedAt !== null) continue;
      const set = this.liveByProfile.get(row.profile) ?? new Set<string>();
      set.add(row.sessionId);
      this.liveByProfile.set(row.profile, set);
    }
    this.ingestCtx = {
      store: deps.store,
      getRow: (id) => this.sessions.get(id),
      rowChanged: (row) => this.sessions.set(row.sessionId, row),
      now: deps.now,
      onRecords: deps.onRecords,
    };
  }

  async run(): Promise<void> {
    const { deps, log } = this;
    log.info("start", { profiles: deps.profiles.length, sessions: this.sessions.size });
    this.kick({ liveness: true, scan: true });
    for (const p of deps.profiles) this.arm(p);
    // The re-arm check costs one stat per dead watcher only, so it runs on every tick.
    const tail = setInterval(() => {
      this.rearm();
      this.kick({ liveness: false, scan: false });
    }, TAIL_POLL_MS);
    const safety = setInterval(() => {
      this.rearm();
      this.kick({ liveness: true, scan: true });
    }, SAFETY_POLL_MS);
    await new Promise<void>((resolve) => {
      if (deps.signal.aborted) resolve();
      else deps.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    this.stopped = true;
    clearInterval(tail);
    clearInterval(safety);
    for (const w of this.watchers.values()) w.stop();
    await this.drained;
    // After the in-flight pass: agentsFailed checks `stopped`, so no timer is re-armed now.
    for (const st of this.profileState.values()) clearTimeout(st.retry);
    log.info("stop");
  }

  /** Arms (or re-arms) a profile's watcher; log flags carry over from the previous one. */
  private arm(p: { id: string; dir: string }, rearmedAt: number | null = null): Watcher {
    const prev = this.watchers.get(p.id);
    prev?.stop();
    const w: Watcher = {
      stop: () => {},
      armed: true,
      rearmedAt,
      errorLogged: prev?.errorLogged ?? false,
      rearmLogged: prev?.rearmLogged ?? false,
    };
    this.watchers.set(p.id, w);
    const watch = this.deps.watch ?? watchSessions;
    w.stop = watch(
      p.dir,
      () => this.kick({ liveness: true, scan: false }),
      (e) => {
        w.armed = false;
        if (w.errorLogged) return;
        w.errorLogged = true;
        this.log.warn("watch_error", { profile: p.id, ...errFields(e) });
      },
    );
    return w;
  }

  /**
   * Every tick: re-arms dead watchers whose sessions folder now exists, and re-enables logging
   * for a re-armed watcher that stayed up for one SAFETY_POLL_MS.
   */
  private rearm(): void {
    if (this.stopped) return;
    const t = this.deps.now();
    for (const p of this.deps.profiles) {
      const w = this.watchers.get(p.id);
      if (!w) continue;
      if (w.armed) {
        if (w.rearmedAt !== null && t - w.rearmedAt >= SAFETY_POLL_MS) {
          w.rearmedAt = null;
          w.errorLogged = false;
          w.rearmLogged = false;
        }
        continue;
      }
      if (!isDir(join(p.dir, "sessions"))) continue;
      const fresh = this.arm(p, t);
      if (fresh.armed && !fresh.rearmLogged) {
        fresh.rearmLogged = true;
        this.log.info("watch_rearmed", { profile: p.id });
      }
    }
  }

  /** Single-flight: a trigger during a pass merges into exactly one follow-up pass. */
  private kick(r: Request): void {
    if (this.stopped) return;
    this.req = this.req
      ? { liveness: this.req.liveness || r.liveness, scan: this.req.scan || r.scan }
      : { ...r };
    if (this.draining) return;
    this.draining = true;
    this.drained = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.req && !this.stopped) {
        const next = this.req;
        this.req = null;
        await this.pass(next);
      }
    } finally {
      // Same microtask as the last loop check: no trigger can slip in between.
      this.draining = false;
    }
  }

  private async pass(r: Request): Promise<void> {
    const t0 = performance.now();
    let live = 0;
    let ended = 0;
    try {
      if (r.liveness) ({ live, ended } = await this.liveness());
      if (r.scan) await this.scanRecent();
      for (const id of this.liveIds()) {
        if (this.stopped) break;
        const row = this.sessions.get(id);
        if (row && row.transcriptPath !== "") await this.tailIfChanged(id, row.transcriptPath);
      }
      if (r.scan) {
        for (const [path, id] of this.recent) {
          if (this.stopped) break;
          const row = this.sessions.get(id);
          if (row && row.endedAt !== null && row.transcriptPath === path) {
            await this.tailIfChanged(id, path);
          }
        }
      }
      // Gated by meta last-run times; a busy database is retried on the next such pass.
      if (r.liveness || r.scan) this.maintenance();
    } catch (e) {
      this.counters.errors += 1;
      this.log.error("pass_failed", errFields(e));
    }
    if (r.liveness || r.scan) {
      const ms = Math.round(performance.now() - t0);
      this.log.info("pass", { ms, live, ended, ...this.counters });
      this.counters = zero();
    }
  }

  private liveIds(): Set<string> {
    const ids = new Set<string>();
    for (const set of this.liveByProfile.values()) for (const id of set) ids.add(id);
    return ids;
  }

  private stateOf(profileId: string): ProfileState {
    let st = this.profileState.get(profileId);
    if (!st) {
      st = { failures: 0, nextAt: 0, retry: undefined };
      this.profileState.set(profileId, st);
    }
    return st;
  }

  private async liveness(): Promise<{ live: number; ended: number }> {
    const { deps } = this;
    let live = 0;
    let ended = 0;
    for (const p of deps.profiles) {
      if (this.stopped) break;
      const st = this.stateOf(p.id);
      if (deps.now() < st.nextAt) continue;
      let list: LiveSession[];
      try {
        list = await deps.cli.agents(p.dir, deps.signal);
      } catch (e) {
        this.agentsFailed(p.id, st, e);
        continue;
      }
      list = list.filter((s) => !isOwnRelay(s, deps.relayDir));
      try {
        this.agentsOk(p.id, st);
        live += list.length;
        ended += await this.applyLive(p, list);
      } catch (e) {
        // A store error for one profile must not stop the others; retried next pass.
        this.counters.errors += 1;
        this.log.warn("live_apply_failed", { profile: p.id, ...errFields(e) });
      }
    }
    return { live, ended };
  }

  private agentsFailed(profileId: string, st: ProfileState, e: unknown): void {
    const { deps } = this;
    if (this.stopped) return; // shutting down: no meta write, no retry timer
    st.failures += 1;
    const delay = BACKOFF_MS[Math.min(st.failures, BACKOFF_MS.length) - 1] ?? 30_000;
    st.nextAt = deps.now() + delay;
    const key = `stale_since:${profileId}`;
    try {
      if (deps.store.getMeta(key) === null) deps.store.setMeta(key, String(deps.now()));
    } catch (err) {
      this.log.warn("meta_failed", errFields(err));
    }
    clearTimeout(st.retry);
    st.retry = setTimeout(() => this.kick({ liveness: true, scan: false }), delay);
    this.log.warn("agents_failed", {
      profile: profileId,
      failures: st.failures,
      backoffMs: delay,
      ...errFields(e),
    });
  }

  private agentsOk(profileId: string, st: ProfileState): void {
    const { store } = this.deps;
    if (st.failures > 0) this.log.info("agents_recovered", { profile: profileId });
    st.failures = 0;
    st.nextAt = 0;
    clearTimeout(st.retry);
    st.retry = undefined;
    const key = `stale_since:${profileId}`;
    if (store.getMeta(key) !== null) store.setMeta(key, null);
  }

  /** Upserts live sessions and marks this profile's missing ones ended. Returns ended count. */
  private async applyLive(p: { id: string; dir: string }, list: LiveSession[]): Promise<number> {
    const { store, now } = this.deps;
    const valid = list.filter((s) => isSessionId(s.sessionId));
    if (valid.length < list.length) {
      // Ids are joined into paths: never trust a non-uuid one. Count only, never the value.
      this.log.warn("invalid_session_ids", { profile: p.id, count: list.length - valid.length });
    }
    const rows: SessionRow[] = [];
    let index: Map<string, string> | null = null;
    for (const s of valid) {
      const existing = this.sessions.get(s.sessionId);
      let path = existing?.transcriptPath ?? "";
      if (path === "") {
        index ??= await transcriptIndex(p.dir);
        path = index.get(s.sessionId) ?? "";
        if (path !== "") this.missingLogged.delete(s.sessionId);
      }
      const row: SessionRow = {
        sessionId: s.sessionId,
        profile: p.id,
        name: s.name,
        cwd: s.cwd,
        pid: s.pid,
        kind: s.kind,
        status: s.status,
        startedAt: s.startedAt,
        updatedAt: now(),
        endedAt: null,
        transcriptPath: path,
        permissionMode: existing?.permissionMode ?? null,
      };
      // Nothing the UI shows changed: leave the stored row (and its updatedAt) alone.
      if (existing && sameSessionData(existing, row)) continue;
      rows.push(row);
    }
    const ids = new Set(valid.map((s) => s.sessionId));
    const at = now();
    const gone = [...this.sessions.values()].filter(
      (r) => r.profile === p.id && r.endedAt === null && !ids.has(r.sessionId),
    );
    if (rows.length > 0 || gone.length > 0) {
      store.tx(() => {
        for (const r of rows) store.upsertSession(r);
        for (const r of gone) store.markEnded(r.sessionId, at);
      });
    }
    for (const r of rows) this.sessions.set(r.sessionId, r);
    for (const r of gone) this.sessions.set(r.sessionId, { ...r, endedAt: at, updatedAt: at });
    this.liveByProfile.set(p.id, ids);
    return gone.length;
  }

  /** Indexes rows for recent transcripts not in the store; remembers them for tailing. */
  private async scanRecent(): Promise<void> {
    const { store, now } = this.deps;
    const recent = new Map<string, string>();
    for (const p of this.deps.profiles) {
      for (const path of await listTranscripts(p.dir)) {
        if (this.stopped) return;
        const sessionId = basename(path, ".jsonl");
        // Only uuid-named transcripts are sessions; the id is later joined into paths and queries.
        if (!isSessionId(sessionId)) continue;
        try {
          const st = await stat(path);
          if (now() - st.mtimeMs > RETENTION_MS) continue;
          recent.set(path, sessionId);
          const existing = this.sessions.get(sessionId);
          if (existing) {
            if (existing.transcriptPath === "") {
              const row = { ...existing, transcriptPath: path };
              store.upsertSession(row);
              this.sessions.set(sessionId, row);
              this.missingLogged.delete(sessionId);
            }
            continue;
          }
          const row: SessionRow = {
            sessionId,
            profile: p.id,
            name: "",
            cwd: await firstCwd(path),
            pid: 0,
            kind: "ended",
            status: "unknown",
            startedAt: Math.floor(st.birthtimeMs || st.mtimeMs),
            updatedAt: now(),
            endedAt: Math.floor(st.mtimeMs),
            transcriptPath: path,
            permissionMode: null,
          };
          store.upsertSession(row);
          this.sessions.set(sessionId, row);
        } catch (e) {
          this.counters.errors += 1;
          this.log.warn("scan_error", { session: sessionId, ...errFields(e) });
        }
      }
    }
    this.recent = recent;
  }

  private async tailIfChanged(sessionId: string, path: string): Promise<void> {
    try {
      const st = await stat(path);
      const stamp = `${st.size}:${st.mtimeMs}`;
      const tail = this.deps.store.getTail(path);
      if (tail && tail.size === st.size) {
        if (tail.offset === st.size) return;
        // offset < size is a budget-cut file (also after a restart: the map is empty then) or
        // a last line that is not complete yet. Only the latter is remembered, per size+mtime.
        if (this.partialAt.get(path) === stamp) return;
      }
      const r = await ingestFile(this.ingestCtx, sessionId, path, (e) => {
        this.counters.errors += 1;
        this.log.warn("on_records_failed", { session: sessionId, ...errFields(e) });
      });
      const after = this.deps.store.getTail(path);
      if (!r.more && after !== null && after.offset < after.size && after.size === st.size) {
        this.partialAt.set(path, stamp);
      } else {
        this.partialAt.delete(path);
      }
      this.counters.files += 1;
      this.counters.lines += r.lines;
      this.counters.messages += r.messages;
      this.counters.unknown += r.unknown;
      this.counters.unrecognized += r.unrecognized;
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        this.transcriptGone(sessionId, path);
        return;
      }
      this.counters.errors += 1;
      this.log.warn("tail_error", { session: sessionId, ...errFields(e) });
    }
  }

  /** Clears a vanished cached path so liveness or the scan finds the file again. Logs once. */
  private transcriptGone(sessionId: string, path: string): void {
    const row = this.sessions.get(sessionId);
    if (row && row.transcriptPath === path) {
      const next = { ...row, transcriptPath: "" };
      try {
        this.deps.store.upsertSession(next);
        this.sessions.set(sessionId, next);
      } catch (e) {
        this.counters.errors += 1;
        this.log.warn("store_error", errFields(e));
      }
    }
    if (this.missingLogged.has(sessionId)) return;
    this.missingLogged.add(sessionId);
    this.log.warn("transcript_missing", { session: sessionId });
  }

  private maintenance(): void {
    const { store, now } = this.deps;
    const t = now();
    const last = (key: string) => Number(store.getMeta(key) ?? "0") || 0;
    // Busy: retried on the next pass. Any other error: at most once per MAINT_RETRY_MS.
    if (t - last("last_purge") >= PURGE_EVERY_MS && t >= this.purgeRetryAt) {
      try {
        const n = store.purge(t);
        store.setMeta("last_purge", String(t));
        this.purgeRetryAt = 0;
        if (n > 0) this.reloadSessions();
        this.log.info("purge", { sessions: n });
      } catch (e) {
        const busy = isBusy(e);
        this.log.warn("purge_failed", { busy, ...errFields(e) });
        if (busy) return; // contended: the vacuum waits for the next tick too
        this.purgeRetryAt = t + MAINT_RETRY_MS;
      }
    }
    if (t - last("last_vacuum") >= VACUUM_EVERY_MS && t >= this.vacuumRetryAt) {
      try {
        const t0 = performance.now();
        store.vacuum();
        store.setMeta("last_vacuum", String(t));
        this.vacuumRetryAt = 0;
        this.log.info("vacuum", { ms: Math.round(performance.now() - t0) });
      } catch (e) {
        const busy = isBusy(e);
        this.log.warn("vacuum_failed", { busy, ...errFields(e) });
        if (!busy) this.vacuumRetryAt = t + MAINT_RETRY_MS;
      }
    }
  }

  private reloadSessions(): void {
    this.sessions.clear();
    for (const v of this.deps.store.listSessions()) this.sessions.set(v.sessionId, toRow(v));
  }
}

/** Every SessionRow field except updatedAt; adding a field to SessionRow fails to compile until listed. */
const COMPARED: Record<Exclude<keyof SessionRow, "updatedAt">, true> = {
  sessionId: true,
  profile: true,
  name: true,
  cwd: true,
  pid: true,
  kind: true,
  status: true,
  startedAt: true,
  endedAt: true,
  transcriptPath: true,
  permissionMode: true,
};

function sameSessionData(a: SessionRow, b: SessionRow): boolean {
  for (const key of Object.keys(COMPARED) as (keyof typeof COMPARED)[]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** This process's start time for daemon.lock; null (pid-only lock) when it cannot be read. */
function ownStartTime(platform: Platform): number | null {
  try {
    return platform.processStartTime(process.pid);
  } catch {
    return null;
  }
}

/**
 * The collector loop. Refuses to start when the data dir is not private or another daemon holds
 * the lock. Resolves after `signal` aborts and the in-flight pass finishes; the caller closes the
 * store.
 */
export async function runDaemon(deps: DaemonDeps): Promise<void> {
  if (!(await deps.platform.isPrivateDir(deps.dataDir))) throw new Error("data dir is not private");
  const runDir = join(deps.dataDir, "run");
  mkdirSync(runDir, { recursive: true });
  const lockOpts: LockOptions = { startedAt: ownStartTime(deps.platform) };
  if (deps.daemonIdentity !== undefined) lockOpts.identify = deps.daemonIdentity;
  const lock = acquireLock(runDir, lockOpts);
  if (!lock) throw new Error("daemon already running");
  try {
    await new Collector(deps, deps.log ?? createLogger(runDir)).run();
  } finally {
    lock.release();
  }
}
