import { FIRST_INDEX_BYTES } from "../config.ts";
import { type Classified, classify } from "../ingest/records.ts";
import { initialState, readNew, type TailState } from "../ingest/tail.ts";
import { maskSecrets } from "../security/mask.ts";
import { extractStatus, type Status } from "../status/extract.ts";
import type { MessageRow, SessionRow, Store } from "../store/db.ts";

export const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Floor per read, so a long line is never crawled in tiny chunks near the budget's end. */
export const MIN_READ_BYTES = 64 * 1024;
export const MAX_BYTES_PER_PASS = 8 * 1024 * 1024;

export interface IngestCtx {
  store: Store;
  /** Cached session row (the daemon is the only writer of sessions). */
  getRow(sessionId: string): SessionRow | undefined;
  /** Called after a committed batch changed the row (permission mode). */
  rowChanged(row: SessionRow): void;
  /** Clock for `updatedAt`. */
  now: () => number;
  onRecords?: (sessionId: string, records: Classified[]) => void;
}

export interface IngestResult {
  lines: number;
  messages: number;
  unknown: number;
  /** Records of a type this build does not know (diagnostics only, never the banner). */
  unrecognized: number;
  /** Byte budget hit: more complete lines may be waiting. */
  more: boolean;
}

/** Masks every string in a status; numbers and flags are kept. */
export function maskStatus(st: Status): Status {
  return {
    progressPct: st.progressPct,
    phase: st.phase === null ? null : maskSecrets(st.phase),
    remaining: st.remaining.map(maskSecrets),
    waiting: st.waiting.map((w) => ({
      id: w.id === null ? null : maskSecrets(w.id),
      text: maskSecrets(w.text),
      isNew: w.isNew,
      children: w.children.map(maskSecrets),
    })),
    recommendations: st.recommendations.map(maskSecrets),
  };
}

const VERSION_RE = /^[\w.+-]{1,32}$/;
/** Record type names kept for diagnostics: short, plain names only. */
const TYPE_NAME_RE = /^[\w.-]{1,40}$/;
export const MAX_UNRECOGNIZED_TYPES = 10;

/** The record's version is untrusted text: store it only when it looks like a version. */
export function safeVersion(v: string): string {
  return VERSION_RE.test(v) ? v : "invalid";
}

interface Batch {
  records: Classified[];
  messages: MessageRow[];
  mode: string | null;
  newest: { uuid: string; ts: string; text: string } | null;
  unknown: number;
  /** Version of the newest unknown record that had one ("" when none did). */
  unknownVersion: string;
  unrecognized: number;
  /** Distinct safe names of unrecognised types, in first-seen order. */
  unrecognizedTypes: string[];
}

function collect(sessionId: string, lines: string[]): Batch {
  const b: Batch = {
    records: [],
    messages: [],
    mode: null,
    newest: null,
    unknown: 0,
    unknownVersion: "",
    unrecognized: 0,
    unrecognizedTypes: [],
  };
  for (const line of lines) {
    const r = classify(line);
    b.records.push(r);
    switch (r.kind) {
      case "owner-prompt":
        if (r.uuid !== "") {
          b.messages.push({
            uuid: r.uuid,
            sessionId,
            ts: r.ts,
            role: "owner",
            fromName: null,
            text: maskSecrets(r.text),
          });
        }
        break;
      case "peer-message":
        if (r.uuid !== "") {
          b.messages.push({
            uuid: r.uuid,
            sessionId,
            ts: r.ts,
            role: "peer",
            fromName: r.fromName === null ? null : maskSecrets(r.fromName),
            text: maskSecrets(r.body),
          });
        }
        break;
      case "assistant-text":
        if (r.uuid !== "") {
          b.messages.push({
            uuid: r.uuid,
            sessionId,
            ts: r.ts,
            role: "assistant",
            fromName: null,
            text: maskSecrets(r.text),
          });
          b.newest = { uuid: r.uuid, ts: r.ts, text: r.text };
        }
        break;
      case "permission-mode":
        b.mode = r.mode;
        break;
      case "unknown":
        b.unknown += 1;
        if (r.version) b.unknownVersion = r.version;
        break;
      case "ignored":
        if (r.reason === "unrecognized-type") {
          b.unrecognized += 1;
          const t = r.type ?? "";
          if (TYPE_NAME_RE.test(t) && !b.unrecognizedTypes.includes(t)) {
            b.unrecognizedTypes.push(t);
          }
        }
        break;
      default:
        break;
    }
  }
  return b;
}

function metaCount(store: Store, key: string): number {
  const n = Number(store.getMeta(key) ?? "0");
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Stored list merged with the batch's names: safe names only, at most MAX_UNRECOGNIZED_TYPES. */
function mergeTypes(stored: string | null, add: string[]): string[] {
  let prev: unknown = [];
  try {
    prev = JSON.parse(stored ?? "[]");
  } catch {
    // corrupt: start over
  }
  const out: string[] = [];
  for (const t of [...(Array.isArray(prev) ? prev : []), ...add]) {
    if (out.length >= MAX_UNRECOGNIZED_TYPES) break;
    if (typeof t === "string" && TYPE_NAME_RE.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * When the batch's messages happened: the newest message timestamp, capped at `now` (a clock ahead
 * of ours never dates a session in the future). `now` when no timestamp parses.
 */
function batchTime(messages: MessageRow[], now: number): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const m of messages) {
    const t = Date.parse(m.ts);
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return Number.isFinite(newest) ? Math.min(newest, now) : now;
}

/**
 * Stored timestamps are ISO UTC with milliseconds, because history order, paging and retention
 * compare them as text (DATA-07). A missing or unparseable one takes the batch time.
 */
function normalizeTimes(messages: MessageRow[], now: number): MessageRow[] {
  const fallback = new Date(batchTime(messages, now)).toISOString();
  return messages.map((m) => {
    const t = Date.parse(m.ts);
    const ts = Number.isFinite(t) ? new Date(t).toISOString() : fallback;
    return ts === m.ts ? m : { ...m, ts };
  });
}

/** Writes one batch and its tail position in a single transaction. */
function commit(ctx: IngestCtx, sessionId: string, b: Batch, next: TailState): void {
  const { store } = ctx;
  b.messages = normalizeTimes(b.messages, ctx.now());
  // The status row is dated by its reply, in the same ISO form, so retention can compare it.
  if (b.newest !== null) {
    const uuid = b.newest.uuid;
    const m = b.messages.find((x) => x.uuid === uuid);
    if (m !== undefined) b.newest = { ...b.newest, ts: m.ts };
  }
  // Status is parsed from the unmasked text; every stored string is masked.
  const raw = b.newest === null ? null : extractStatus(b.newest.text);
  const status = raw === null ? null : maskStatus(raw);
  const row = ctx.getRow(sessionId);
  const modeChanged = b.mode !== null && row !== undefined && row.permissionMode !== b.mode;
  // updatedAt means "last time this session's data changed": any committed message (owner, peer
  // or assistant) is such a change, dated by the message itself. A replayed or backfilled batch of
  // old messages therefore never marks a session as just updated, and updatedAt never moves back.
  const updatedAt =
    row !== undefined && b.messages.length > 0
      ? Math.max(row.updatedAt, batchTime(b.messages, ctx.now()))
      : row?.updatedAt;
  const changed: SessionRow | null =
    row !== undefined && (modeChanged || updatedAt !== row.updatedAt)
      ? {
          ...row,
          permissionMode: modeChanged ? (b.mode as string) : row.permissionMode,
          updatedAt: updatedAt as number,
        }
      : null;
  store.tx(() => {
    if (b.messages.length > 0) store.addMessages(sessionId, b.messages);
    if (changed !== null) store.upsertSession(changed);
    if (b.newest !== null) {
      if (status !== null) store.setStatus(sessionId, status, b.newest.uuid, b.newest.ts);
      store.setLatestReply(sessionId, b.newest.uuid, b.newest.ts, status !== null);
    }
    if (b.unknown > 0) {
      store.setMeta("unknown_count", String(metaCount(store, "unknown_count") + b.unknown));
      if (b.unknownVersion !== "") store.setMeta("unknown_version", safeVersion(b.unknownVersion));
      else if (store.getMeta("unknown_version") === null) store.setMeta("unknown_version", "");
    }
    if (b.unrecognized > 0) {
      store.setMeta(
        "unrecognized_count",
        String(metaCount(store, "unrecognized_count") + b.unrecognized),
      );
      const stored = store.getMeta("unrecognized_types");
      const types = JSON.stringify(mergeTypes(stored, b.unrecognizedTypes));
      if (types !== stored) store.setMeta("unrecognized_types", types);
    }
    store.saveTail(next);
  });
  if (changed !== null) ctx.rowChanged(changed);
}

/**
 * Reads new complete lines of one transcript (at most about MAX_BYTES_PER_PASS per call) and
 * stores them. Records are handed to onRecords after each committed batch.
 */
export async function ingestFile(
  ctx: IngestCtx,
  sessionId: string,
  path: string,
  onRecordsError: (e: unknown) => void,
): Promise<IngestResult> {
  const res: IngestResult = { lines: 0, messages: 0, unknown: 0, unrecognized: 0, more: false };
  let state = ctx.store.getTail(path) ?? (await initialState(path, FIRST_INDEX_BYTES));
  let consumed = 0;
  for (;;) {
    // At most the budget left, but never below the floor (readNew may finish one longer line).
    const want = Math.min(READ_CHUNK_BYTES, MAX_BYTES_PER_PASS - consumed);
    const r = await readNew(state, Math.max(MIN_READ_BYTES, want));
    if (r.reset) {
      // Truncated or replaced: read again from 0. A read from offset 0 never resets.
      state = r.next;
      continue;
    }
    const same =
      r.next.offset === state.offset &&
      r.next.size === state.size &&
      r.next.firstUuid === state.firstUuid;
    // Nothing new (e.g. only a partial last line): no write transaction for it.
    if (r.lines.length === 0 && same && ctx.store.getTail(path) !== null) return res;
    const b = collect(sessionId, r.lines);
    commit(ctx, sessionId, b, r.next);
    consumed += Math.max(0, r.next.offset - state.offset);
    state = r.next;
    res.lines += r.lines.length;
    res.messages += b.messages.length;
    res.unknown += b.unknown;
    res.unrecognized += b.unrecognized;
    // On a first index this replays historical records; delivery checks ignore records older
    // than the send's createdAt, so the replay is harmless.
    if (b.records.length > 0 && ctx.onRecords) {
      try {
        ctx.onRecords(sessionId, b.records);
      } catch (e) {
        onRecordsError(e);
      }
    }
    if (r.lines.length === 0) return res;
    if (consumed >= MAX_BYTES_PER_PASS) {
      res.more = true;
      return res;
    }
  }
}
