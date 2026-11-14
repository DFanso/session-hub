import { isAbsolute, parse, resolve } from "node:path";
import { AGENTS_TIMEOUT_MS, RELAY_NAME } from "../config.ts";
import { taskkillTree } from "../util/taskkill.ts";

export type LiveStatus = "busy" | "idle" | "waiting" | "unknown";

export interface LiveSession {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name: string;
  status: LiveStatus;
}

export interface ClaudeCli {
  /** `signal` (the daemon's stop) kills a running child and rejects with "claude agents aborted". */
  agents(profileDir: string, signal?: AbortSignal): Promise<LiveSession[]>;
}

export function parseStatus(v: unknown): LiveStatus {
  return v === "busy" || v === "idle" || v === "waiting" ? v : "unknown";
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Tolerant: entries without a string sessionId or numeric pid are skipped. */
export function parseAgents(json: unknown): LiveSession[] {
  if (!Array.isArray(json)) return [];
  const out: LiveSession[] = [];
  for (const e of json) {
    if (e === null || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.sessionId !== "string" || typeof o.pid !== "number") continue;
    out.push({
      pid: o.pid,
      cwd: str(o.cwd, ""),
      kind: str(o.kind, "unknown"),
      startedAt: typeof o.startedAt === "number" ? o.startedAt : 0,
      sessionId: o.sessionId,
      name: str(o.name, ""),
      status: parseStatus(o.status),
    });
  }
  return out;
}

const TASKKILL_BOUND_MS = 2000;
/** `claude agents` output beyond this is refused (and the child killed): memory stays bounded. */
export const MAX_AGENTS_STDOUT_BYTES = 4 * 1024 * 1024;

/** Runs in the background: never throws, never rejects. On win32 taskkill /T runs first and is awaited. */
async function killTree(proc: {
  pid: number;
  kill(sig?: number | NodeJS.Signals): void;
}): Promise<void> {
  const plainKill = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  if (process.platform !== "win32" || !(await taskkillTree(proc.pid, TASKKILL_BOUND_MS))) {
    plainKill();
  }
}

export function realClaudeCli(
  cmd: string[] = ["claude"],
  timeoutMs: number = AGENTS_TIMEOUT_MS,
): ClaudeCli {
  return {
    async agents(profileDir: string, signal?: AbortSignal): Promise<LiveSession[]> {
      if (signal?.aborted) throw new Error("claude agents aborted");
      const proc = Bun.spawn([...cmd, "agents", "--json"], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: profileDir },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
      });
      const reader = proc.stdout.getReader();
      const run = (async (): Promise<LiveSession[]> => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_AGENTS_STDOUT_BYTES) {
            void killTree(proc).catch(() => {});
            reader.cancel().catch(() => {});
            throw new Error("claude agents output is over 4 MiB");
          }
          chunks.push(value);
        }
        const code = await proc.exited;
        if (code !== 0) throw new Error(`claude agents exited ${code}`);
        let json: unknown;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new Error("claude agents returned invalid JSON");
        }
        if (!Array.isArray(json)) throw new Error("claude agents returned invalid JSON");
        return parseAgents(json);
      })();
      run.catch(() => {}); // a late failure after timeout must not be unhandled
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stopChild = () => {
        void killTree(proc).catch(() => {});
        reader.cancel().catch(() => {});
      };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stopChild();
          reject(new Error("claude agents timed out"));
        }, timeoutMs);
        onAbort = () => {
          stopChild();
          reject(new Error("claude agents aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([run, timeout]);
      } finally {
        clearTimeout(timer);
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function normalizePath(p: string): string {
  let n = resolve(p);
  const rootLen = parse(n).root.length;
  while (n.length > rootLen && /[\\/]$/.test(n)) n = n.slice(0, -1);
  return process.platform === "win32" ? n.toLowerCase() : n;
}

export function isOwnRelay(s: LiveSession, relayDir: string): boolean {
  if (s.name !== RELAY_NAME) return false;
  if (!s.cwd || !isAbsolute(s.cwd)) return false;
  return normalizePath(s.cwd) === normalizePath(relayDir);
}
