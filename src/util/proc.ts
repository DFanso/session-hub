import { taskkillTree } from "./taskkill.ts";

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface RunOptions {
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: string;
  timeoutMs: number;
}

/** Stdout kept beyond this is dropped, so a runaway child cannot grow memory without bound. */
const MAX_STDOUT_BYTES = 1024 * 1024;
const TASKKILL_WAIT_MS = 2000;

type Killable = { pid: number; kill(sig?: number | NodeJS.Signals): void };

/** Kills the process and its children. On Windows taskkill /T, awaited at most 2 s. */
async function killTree(proc: Killable): Promise<void> {
  if (process.platform === "win32") await taskkillTree(proc.pid, TASKKILL_WAIT_MS);
  try {
    proc.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * Spawns argv, writes stdin, collects stdout (stderr is discarded). On timeout the process tree
 * is killed and the call returns at once with what stdout had so far; it never waits for the
 * pipes to drain after a timeout. Throws only if the process cannot be spawned.
 */
export async function runWithTimeout(argv: string[], opts: RunOptions): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    env: opts.env,
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  const text = (): string => Buffer.concat(chunks).toString("utf8");

  // Writing may block if the child never reads; it runs inside the timeout, never awaited alone.
  (async () => {
    try {
      proc.stdin.write(opts.stdin);
      await proc.stdin.end();
    } catch {
      // child closed stdin early; its exit code tells the story
    }
  })();

  const reader = proc.stdout.getReader();
  const run = (async (): Promise<number> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size < MAX_STDOUT_BYTES) {
        chunks.push(value);
        size += value.length;
      }
    }
    return await proc.exited;
  })();
  run.catch(() => {}); // a late failure after timeout must not be unhandled

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), opts.timeoutMs);
  });
  try {
    const outcome = await Promise.race([run, timeout]);
    if (outcome === "timeout") {
      await killTree(proc);
      reader.cancel().catch(() => {});
      return { exitCode: null, stdout: text(), timedOut: true };
    }
    return { exitCode: outcome, stdout: text(), timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}
