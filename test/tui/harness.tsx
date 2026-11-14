import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Instance, render } from "ink";
import { MESSAGE_HEADER } from "../../src/config";
import type { SessionRow } from "../../src/store/db";
import { Store } from "../../src/store/db";
import { App, type AppProps } from "../../src/tui/App";

export const NOW = Date.parse("2026-11-13T10:00:00.000Z");
export const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

/** Minimal TTY-like stdin: Ink pulls chunks with read() after a 'readable' event. */
export class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  press(chunk: string): void {
    this.queue.push(chunk);
    this.emit("readable");
  }
}

/** Non-TTY stdout that records every frame Ink writes in debug mode. */
export class FakeStdout extends EventEmitter {
  columns: number;
  rows: number;
  isTTY = false;
  writable = true;
  destroyed = false;
  writableEnded = false;
  frames: string[] = [];
  constructor(columns = 80, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write(chunk: string, ...rest: unknown[]): boolean {
    this.frames.push(chunk);
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    cb?.();
    return true;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

export function lastFrame(out: FakeStdout): string {
  for (let i = out.frames.length - 1; i >= 0; i--) {
    const f = (out.frames[i] ?? "").replace(ANSI, "");
    if (f.trim() !== "") return f;
  }
  return "";
}

export async function waitFor(
  out: FakeStdout,
  pred: (frame: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const f = lastFrame(out);
    if (pred(f)) return f;
    if (Date.now() > end) throw new Error(`timed out; last frame:\n${f}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const KEY = {
  up: "\u001B[A",
  down: "\u001B[B",
  enter: "\r",
  esc: "\u001B",
  ctrlS: "\u0013",
  pgUp: "\u001B[5~",
  backspace: "\u007F",
};

export interface SendCall {
  sessionId: string;
  text: string;
  override?: boolean;
  allowSecret?: boolean;
}

export interface Harness {
  store: Store;
  out: FakeStdout;
  inp: FakeStdin;
  app: Instance;
  sends: SendCall[];
  focuses: number[];
  type(text: string): Promise<void>;
  press(chunk: string): Promise<void>;
  frame(): string;
  until(pred: (f: string) => boolean): Promise<string>;
  dispose(): void;
}

const dirs: string[] = [];
const stores: Store[] = [];

export function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "hub-tui-"));
  dirs.push(dir);
  const s = Store.open(join(dir, "hub.db"));
  stores.push(s);
  return s;
}

export function cleanupDirs(): void {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function session(over: Partial<SessionRow>): SessionRow {
  return {
    sessionId: "s1",
    profile: "claude",
    name: "alpha",
    cwd: "D:/work/alpha-repo",
    pid: 100,
    kind: "interactive",
    status: "idle",
    startedAt: NOW - 3_600_000,
    updatedAt: NOW,
    endedAt: null,
    transcriptPath: "x.jsonl",
    permissionMode: null,
    ...over,
  };
}

/** Standard seed: two profiles, one waiting session with a full status, one ended. */
export function seed(store: Store): void {
  store.upsertSession(
    session({ sessionId: "s-alpha", name: "alpha", status: "waiting", pid: 4242 }),
  );
  store.upsertSession(
    session({ sessionId: "abcdef1234567890", name: "", status: "busy", cwd: "C:/work/beta" }),
  );
  store.upsertSession(
    session({ sessionId: "s-gamma", profile: "claude-personal", name: "gamma", cwd: "D:/g" }),
  );
  store.upsertSession(session({ sessionId: "s-delta", name: "delta", endedAt: NOW - 600_000 }));
  store.setStatus(
    "s-alpha",
    {
      progressPct: 40,
      phase: "Build",
      remaining: ["Wire the relay"],
      waiting: [
        { id: "Q15", text: "Pick the region", isNew: true, children: [] },
        { id: "Q9", text: "Approve plan", isNew: false, children: ["sub point"] },
      ],
      recommendations: ["Use the EU region"],
    },
    "r1",
    iso(4 * 60_000),
  );
  store.setLatestReply("s-alpha", "r2", iso(60_000), false);
  store.setMeta("unknown_count", "3");
  store.setMeta("stale_since:claude-personal", String(NOW - 120_000));
}

export interface MountOptions {
  store?: Store;
  send?: AppProps["send"];
  focus?: AppProps["focus"];
  columns?: number;
  rows?: number;
  refreshMs?: number;
}

export function mount(opts: MountOptions = {}): Harness {
  const store = opts.store ?? tempStore();
  const out = new FakeStdout(opts.columns, opts.rows);
  const inp = new FakeStdin();
  const sends: SendCall[] = [];
  const focuses: number[] = [];
  const send: AppProps["send"] =
    opts.send ??
    (async (req) => {
      sends.push(req);
      return { state: "pending" };
    });
  const focus: AppProps["focus"] =
    opts.focus ??
    (async (pid) => {
      focuses.push(pid);
      return { ok: true, title: "Windows Terminal" };
    });
  const app = render(
    <App
      store={store}
      send={send}
      focus={focus}
      buildMessage={(t) => `${MESSAGE_HEADER}\n\n${t}`}
      now={() => NOW}
      refreshMs={opts.refreshMs ?? 40}
    />,
    {
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: inp as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  const h: Harness = {
    store,
    out,
    inp,
    app,
    sends,
    focuses,
    async type(text) {
      for (const ch of text) {
        inp.press(ch);
        await tick(5);
      }
      await tick();
    },
    async press(chunk) {
      inp.press(chunk);
      await tick(chunk === KEY.esc ? 120 : 30);
    },
    frame: () => lastFrame(out),
    until: (pred) => waitFor(out, pred),
    dispose() {
      app.unmount();
      app.cleanup();
    },
  };
  return h;
}
