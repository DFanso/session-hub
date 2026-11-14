import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEBOUNCE_MS } from "../../src/config.ts";
import { readSessionMeta, shouldFire, watchSessions } from "../../src/discovery/watch.ts";

let root: string;
let sessions: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hub-watch-"));
  sessions = join(root, "sessions");
  mkdirSync(sessions);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const ID = "0b6f3c2e-8a1d-4c5e-9f00-123456789abc";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watchSessions", () => {
  test("one call per burst of json writes", async () => {
    let n = 0;
    const stop = watchSessions(root, () => n++);
    for (let i = 0; i < 5; i++) writeFileSync(join(sessions, `${i}.json`), "{}");
    await wait(DEBOUNCE_MS + 400);
    stop();
    expect(n).toBe(1);
  });
  test("ignores .key and other files", async () => {
    let n = 0;
    const stop = watchSessions(root, () => n++);
    writeFileSync(join(sessions, "12.abcd.key"), "x");
    writeFileSync(join(sessions, "notes.txt"), "x");
    await wait(DEBOUNCE_MS + 400);
    expect(n).toBe(0);
    writeFileSync(join(sessions, "13.json"), "{}");
    await wait(DEBOUNCE_MS + 400);
    stop();
    expect(n).toBe(1);
  });
  test("disposer cancels pending call", async () => {
    let n = 0;
    const stop = watchSessions(root, () => n++);
    writeFileSync(join(sessions, "1.json"), "{}");
    await wait(100);
    stop();
    await wait(DEBOUNCE_MS + 300);
    expect(n).toBe(0);
  });
  test("missing folder: no-op disposer and one onError", () => {
    const errs: Error[] = [];
    const stop = watchSessions(
      join(root, "nope"),
      () => {},
      (e) => errs.push(e),
    );
    expect(errs.length).toBe(1);
    expect(() => stop()).not.toThrow();
  });
});

describe("shouldFire", () => {
  test("null and .json fire, others do not", () => {
    expect(shouldFire(null)).toBe(true);
    expect(shouldFire("1.json")).toBe(true);
    expect(shouldFire("1.abc.key")).toBe(false);
  });
});

describe("onChange throwing", () => {
  test("routed to onError, not thrown", async () => {
    const errs: Error[] = [];
    const stop = watchSessions(
      root,
      () => {
        throw new Error("boom");
      },
      (e) => errs.push(e),
    );
    writeFileSync(join(sessions, "1.json"), "{}");
    await wait(DEBOUNCE_MS + 400);
    stop();
    expect(errs.map((e) => e.message)).toEqual(["boom"]);
  });
});

describe("readSessionMeta", () => {
  test("returns only the six fields", () => {
    const f = join(sessions, "7.json");
    writeFileSync(
      f,
      JSON.stringify({
        pid: 7,
        sessionId: ID,
        name: "n",
        status: "busy",
        updatedAt: 99,
        cwd: "D:\\x",
        messagingSocketPath: "\\\\.\\pipe\\secret",
        version: "2.1.323",
      }),
    );
    const m = readSessionMeta(f);
    expect(m).toEqual({
      pid: 7,
      sessionId: ID,
      name: "n",
      status: "busy",
      updatedAt: 99,
      cwd: "D:\\x",
    });
    expect(Object.keys(m ?? {}).sort()).toEqual([
      "cwd",
      "name",
      "pid",
      "sessionId",
      "status",
      "updatedAt",
    ]);
    expect(JSON.stringify(m)).not.toContain("secret");
  });
  test("tolerates missing status", () => {
    const f = join(sessions, "8.json");
    writeFileSync(f, JSON.stringify({ pid: 8, sessionId: ID }));
    expect(readSessionMeta(f)?.status).toBe("unknown");
  });
  test("null on bad json or missing file", () => {
    const f = join(sessions, "9.json");
    writeFileSync(f, "{oops");
    expect(readSessionMeta(f)).toBeNull();
    expect(readSessionMeta(join(sessions, "none.json"))).toBeNull();
  });
  test("null when sessionId is not a 36-char uuid", () => {
    for (const [i, sessionId] of [
      "abc",
      `${ID.slice(0, 35)}\u001B`,
      `${ID}0`,
      "../../../../windows/system32/x",
      "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
    ].entries()) {
      const f = join(sessions, `${20 + i}.json`);
      writeFileSync(f, JSON.stringify({ pid: 20 + i, sessionId }));
      expect(readSessionMeta(f)).toBeNull();
    }
    const ok = join(sessions, "30.json");
    writeFileSync(ok, JSON.stringify({ pid: 30, sessionId: ID.toUpperCase() }));
    expect(readSessionMeta(ok)?.sessionId).toBe(ID.toUpperCase());
  });
  test("refuses non-json paths", () => {
    expect(() => readSessionMeta(join(sessions, "7.abc.key"))).toThrow(
      "refusing non-json session file",
    );
  });
});
