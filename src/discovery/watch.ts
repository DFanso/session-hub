import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { DEBOUNCE_MS } from "../config.ts";
import { type LiveStatus, parseStatus } from "./agents.ts";

export interface SessionMeta {
  pid: number;
  sessionId: string;
  name: string;
  status: LiveStatus;
  updatedAt: number;
  cwd: string;
}

/** True when a change to this filename should trigger a refresh. Unknown (null) names fire. */
export function shouldFire(filename: string | null): boolean {
  return filename === null || filename.endsWith(".json");
}

/** Watches <profileDir>/sessions. Fires only for *.json or unknown filenames; never for *.key. */
export function watchSessions(
  profileDir: string,
  onChange: () => void,
  onError?: (e: Error) => void,
): () => void {
  const dir = join(profileDir, "sessions");
  const fail = (e: unknown) => onError?.(e instanceof Error ? e : new Error(String(e)));
  try {
    if (!statSync(dir).isDirectory()) throw new Error("sessions is not a directory");
  } catch (e) {
    fail(e);
    return () => {};
  }
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, (_event, filename) => {
      const name = filename === null || filename === undefined ? null : String(filename);
      if (closed || !shouldFire(name)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (closed) return;
        try {
          onChange();
        } catch (e) {
          fail(e);
        }
      }, DEBOUNCE_MS);
    });
  } catch (e) {
    fail(e);
    return () => {};
  }
  watcher.on("error", fail);
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    watcher.close();
  };
}

/** Reads only the six allowed fields. Never returns messagingSocketPath or anything else. */
const SESSION_ID = /^[0-9a-f-]{36}$/i;

export function readSessionMeta(file: string): SessionMeta | null {
  if (!file.endsWith(".json")) throw new Error("refusing non-json session file");
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof o.sessionId !== "string" || typeof o.pid !== "number") return null;
  // Same rule as the daemon: anything but a plain uuid is not a session we track.
  if (!SESSION_ID.test(o.sessionId)) return null;
  return {
    pid: o.pid,
    sessionId: o.sessionId,
    name: typeof o.name === "string" ? o.name : "",
    status: parseStatus(o.status),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
    cwd: typeof o.cwd === "string" ? o.cwd : "",
  };
}
