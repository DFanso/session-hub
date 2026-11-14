import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type LogFields = Record<string, number | boolean | string>;

/**
 * Never pass message text, prompts, bodies or status text. Only counts, timings, ids, names and
 * error names/messages from our own code.
 */
export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_FIELD_CHARS = 200;
const FILE = "daemon.log";

function clip(s: string): string {
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s;
}

/** Fields for a caught error: its name and message, truncated. */
export function errFields(e: unknown): LogFields {
  if (e instanceof Error) return { err: clip(e.name), msg: clip(e.message) };
  return { err: "Error", msg: clip(String(e)) };
}

/** JSON lines to `<dir>/<file>` (default daemon.log), rotated at `maxBytes` keeping .1 and .2. */
export function createLogger(
  dir: string,
  maxBytes: number = LOG_MAX_BYTES,
  file: string = FILE,
): Logger {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    size = 0;
  }

  const rotate = () => {
    rmSync(`${path}.2`, { force: true });
    try {
      renameSync(`${path}.1`, `${path}.2`);
    } catch {
      // no .1 yet
    }
    renameSync(path, `${path}.1`);
    size = 0;
  };

  const write = (level: string, event: string, fields: LogFields = {}) => {
    const out: Record<string, number | boolean | string> = {};
    for (const [k, v] of Object.entries(fields)) out[k] = typeof v === "string" ? clip(v) : v;
    out.ts = new Date().toISOString();
    out.level = level;
    out.event = clip(event);
    const line = `${JSON.stringify(out)}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(path, line);
      size += bytes;
    } catch {
      // logging must never break the daemon
    }
  };

  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
