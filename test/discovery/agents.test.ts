import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_NAME } from "../../src/config.ts";
import {
  isOwnRelay,
  MAX_AGENTS_STDOUT_BYTES,
  parseAgents,
  realClaudeCli,
} from "../../src/discovery/agents.ts";

const tmp = mkdtempSync(join(tmpdir(), "hub-agents-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const FAKE = ["bun", join(import.meta.dir, "..", "fakes", "fake-claude.ts")];

function jsonFile(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
};

describe("parseAgents", () => {
  test("parses real-shape entries", () => {
    const entry = {
      pid: 1,
      cwd: "D:\\x",
      kind: "interactive",
      startedAt: 5,
      sessionId: "s1",
      name: "n",
      status: "idle" as const,
    };
    expect(parseAgents([entry])).toEqual([entry]);
  });
  test("missing fields get defaults, bad status is unknown", () => {
    const r = parseAgents([
      { pid: 2, sessionId: "s2" },
      { pid: 3, sessionId: "s3", status: "weird" },
    ]);
    expect(r[0]).toEqual({
      pid: 2,
      cwd: "",
      kind: "unknown",
      startedAt: 0,
      sessionId: "s2",
      name: "",
      status: "unknown",
    });
    expect(r[1]?.status).toBe("unknown");
  });
  test("skips entries without sessionId or numeric pid, and non-arrays", () => {
    expect(
      parseAgents([{ pid: 1 }, { sessionId: "a" }, { pid: "1", sessionId: "a" }, null, 3]),
    ).toEqual([]);
    expect(parseAgents({})).toEqual([]);
  });
});

describe("realClaudeCli with fake", () => {
  test("reads agents json", async () => {
    const f = jsonFile("ok.json", JSON.stringify([{ pid: 9, sessionId: "z", status: "busy" }]));
    const r = await withEnv({ FAKE_AGENTS_JSON: f }, () => realClaudeCli(FAKE).agents(tmp));
    expect(r.map((s) => [s.pid, s.status])).toEqual([[9, "busy"]]);
  });
  test("non-zero exit throws exact message, no output text", async () => {
    const f = jsonFile("x.json", "[]");
    const err = await withEnv(
      { FAKE_AGENTS_JSON: f, FAKE_AGENTS_EXIT: "3", FAKE_AGENTS_MARKER: "SECRETMARK" },
      () => realClaudeCli(FAKE).agents(tmp),
    ).then(
      () => new Error("did not throw"),
      (e: Error) => e,
    );
    expect(err.message).toBe("claude agents exited 3");
    expect(err.message).not.toContain("SECRETMARK");
  });
  test("child gets CLAUDE_CONFIG_DIR=profileDir", async () => {
    const r = await withEnv({ FAKE_AGENTS_ECHO_CONFIG: "1" }, () =>
      realClaudeCli(FAKE).agents(tmp),
    );
    expect(r.map((s) => s.cwd)).toEqual([tmp]);
  });
  test("output over 4 MiB is refused, not buffered", async () => {
    // Valid JSON (an empty array padded with spaces), so only the size cap can refuse it.
    const f = jsonFile("huge.json", `[${" ".repeat(MAX_AGENTS_STDOUT_BYTES)}]`);
    await expect(
      withEnv({ FAKE_AGENTS_JSON: f }, () => realClaudeCli(FAKE).agents(tmp)),
    ).rejects.toThrow("claude agents output is over 4 MiB");
  });
  test("an abort (daemon stop) kills the child and rejects at once (RES-06)", async () => {
    const f = jsonFile("slow2.json", "[]");
    const ac = new AbortController();
    const t0 = Date.now();
    const p = withEnv({ FAKE_AGENTS_JSON: f, FAKE_AGENTS_DELAY_MS: "30000" }, () =>
      realClaudeCli(FAKE, 20_000).agents(tmp, ac.signal),
    );
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toThrow("claude agents aborted");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  test("an already-aborted signal spawns nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(realClaudeCli(["no-such-binary-xyz"]).agents(tmp, ac.signal)).rejects.toThrow(
      "claude agents aborted",
    );
  });
  test("bad json and non-array throw", async () => {
    const f = jsonFile("bad.json", "not json");
    await expect(
      withEnv({ FAKE_AGENTS_JSON: f }, () => realClaudeCli(FAKE).agents(tmp)),
    ).rejects.toThrow("claude agents returned invalid JSON");
    const g = jsonFile("obj.json", "{}");
    await expect(
      withEnv({ FAKE_AGENTS_JSON: g }, () => realClaudeCli(FAKE).agents(tmp)),
    ).rejects.toThrow("claude agents returned invalid JSON");
  });
  test("a child that outlives the timeout is killed and the call rejects", async () => {
    const f = jsonFile("slow3.json", "[]");
    const t0 = Date.now();
    await expect(
      withEnv({ FAKE_AGENTS_JSON: f, FAKE_AGENTS_DELAY_MS: "30000" }, () =>
        realClaudeCli(FAKE, 500).agents(tmp),
      ),
    ).rejects.toThrow("claude agents timed out");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  // The tree kill is taskkill /T (the app is Windows-only); elsewhere only the child is killed.
  test.if(process.platform === "win32")(
    "timeout rejects promptly even if a grandchild holds stdout, and kills it",
    async () => {
      const f = jsonFile("slow.json", "[]");
      const pidFile = join(tmp, "gc.pid");
      const t0 = Date.now();
      await expect(
        withEnv(
          {
            FAKE_AGENTS_JSON: f,
            FAKE_AGENTS_DELAY_MS: "30000",
            FAKE_AGENTS_GRANDCHILD_PID_FILE: pidFile,
          },
          () => realClaudeCli(FAKE, 4000).agents(tmp),
        ),
      ).rejects.toThrow("claude agents timed out");
      expect(Date.now() - t0).toBeLessThan(6000);
      let gc = 0;
      for (let i = 0; i < 30 && gc === 0; i++) {
        try {
          gc = Number(readFileSync(pidFile, "utf8"));
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(gc).toBeGreaterThan(0);
      let alive = true;
      for (let i = 0; i < 30 && alive; i++) {
        try {
          process.kill(gc, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    },
    10_000,
  ); // 4 s CLI timeout plus up to 6 s of polling for the grandchild; the 5 s default is too tight under load
});

describe("fake relay", () => {
  const run = async (env: Record<string, string>) => {
    const p = Bun.spawn([...FAKE, "-p", "-n", "x"], {
      env: { ...process.env, ...env },
      stdin: new Blob(["hello \n"]),
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(p.stdout).text();
    return { out, code: await p.exited };
  };
  test("delivers a record and prints result", async () => {
    const t = join(tmp, "t1.jsonl");
    const r = await run({ FAKE_TARGET_TRANSCRIPT: t });
    expect(JSON.parse(r.out)).toEqual({ result: "DONE", is_error: false });
    expect(JSON.parse(readFileSync(t, "utf8")).attachment.origin.body).toBe("hello");
  });
  test("NO_DELIVERY suppresses the record but keeps result and exit", async () => {
    const t = join(tmp, "t2.jsonl");
    const r = await run({
      FAKE_TARGET_TRANSCRIPT: t,
      FAKE_RELAY_NO_DELIVERY: "1",
      FAKE_RELAY_RESULT: "OK2",
      FAKE_RELAY_EXIT: "4",
    });
    expect(existsSync(t)).toBe(false);
    expect(JSON.parse(r.out)).toEqual({ result: "OK2", is_error: false });
    expect(r.code).toBe(4);
  });
});

describe("isOwnRelay", () => {
  const base = { pid: 1, kind: "x", startedAt: 0, sessionId: "s", status: "idle" as const };
  const dir = join(tmp, "relay");
  test("matches name and cwd", () => {
    expect(isOwnRelay({ ...base, name: RELAY_NAME, cwd: dir }, dir)).toBe(true);
    expect(isOwnRelay({ ...base, name: RELAY_NAME, cwd: `${dir}/` }, dir)).toBe(true);
  });
  test("other name or cwd does not match", () => {
    expect(isOwnRelay({ ...base, name: "other", cwd: dir }, dir)).toBe(false);
    expect(isOwnRelay({ ...base, name: RELAY_NAME, cwd: join(tmp, "elsewhere") }, dir)).toBe(false);
    expect(isOwnRelay({ ...base, name: RELAY_NAME, cwd: "" }, dir)).toBe(false);
  });
  test.if(process.platform === "win32")("case-insensitive on windows", () => {
    expect(isOwnRelay({ ...base, name: RELAY_NAME, cwd: dir.toUpperCase() }, dir)).toBe(true);
  });
});
