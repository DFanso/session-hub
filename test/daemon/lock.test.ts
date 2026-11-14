import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  daemonIdentity,
  formatLock,
  identifyDaemon,
  isKillableImage,
  type LockInfo,
  type ProcessQueries,
  parseLock,
} from "../../src/daemon/lock.ts";
import { processImagePath, processStartTime } from "../../src/platform/windows/process.ts";

const win = process.platform === "win32";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-lock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function deadPid(): Promise<number> {
  const p = Bun.spawn(["bun", "-e", "0"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await p.exited;
  return p.pid;
}

const T0 = 1_763_000_000_000;
const alive = { alive: true, startedAt: null, image: null };

describe("lock format", () => {
  test("pid and start time, and the legacy pid-only form; garbage is null", () => {
    expect(parseLock("4242 1763000000000")).toEqual({ pid: 4242, startedAt: T0 });
    expect(parseLock(" 4242\n")).toEqual({ pid: 4242, startedAt: null });
    for (const bad of ["", "x", "0", "-1", "4242 x", "4242  1", "4242 1 2"]) {
      expect(parseLock(bad)).toBeNull();
    }
    expect(formatLock({ pid: 4242, startedAt: T0 })).toBe("4242 1763000000000");
    expect(formatLock({ pid: 4242, startedAt: null })).toBe("4242");
  });
});

describe("daemonIdentity", () => {
  const withStart: LockInfo = { pid: 7, startedAt: T0 };
  const legacy: LockInfo = { pid: 7, startedAt: null };

  test("with a recorded start time: same start (within 2 s) is ours whatever the image", () => {
    const at = (startedAt: number | null, image: string | null = null) => ({
      alive: true,
      startedAt,
      image,
    });
    expect(daemonIdentity(withStart, at(T0), false)).toBe("ours");
    expect(daemonIdentity(withStart, at(T0 + 2_000, "C:\\bun\\bun.exe"), false)).toBe("ours");
    expect(daemonIdentity(withStart, at(T0 - 2_000), false)).toBe("ours");
    // A pid reused by another process (any image, bun.exe included) started later: stale.
    expect(daemonIdentity(withStart, at(T0 + 60_000, "C:\\bun\\bun.exe"), false)).toBe("foreign");
    expect(daemonIdentity(withStart, at(T0 + 2_001), false)).toBe("foreign");
    // Alive but its start time cannot be read (elevated, protected): held, never killed.
    expect(daemonIdentity(withStart, at(null), false)).toBe("unknown");
    expect(daemonIdentity(withStart, { ...alive, alive: false }, false)).toBe("foreign");
  });

  test("a legacy pid-only lock falls back to the image rule", () => {
    const img = (image: string | null) => ({ alive: true, startedAt: null, image });
    expect(daemonIdentity(legacy, img("C:\\L\\SessionHub\\bin\\hubd.exe"), false)).toBe("ours");
    expect(daemonIdentity(legacy, img("D:\\dist\\HUB.EXE"), false)).toBe("ours");
    expect(daemonIdentity(legacy, img("C:\\bun\\bun.exe"), true)).toBe("ours");
    expect(daemonIdentity(legacy, img("C:\\bun\\bun.exe"), false)).toBe("unknown");
    expect(daemonIdentity(legacy, img(null), false)).toBe("unknown");
    expect(daemonIdentity(legacy, img("C:\\Windows\\System32\\notepad.exe"), true)).toBe("foreign");
    expect(daemonIdentity(legacy, img("C:\\x\\hubd.exe.bak"), false)).toBe("foreign");
    expect(daemonIdentity(legacy, { ...alive, alive: false }, false)).toBe("foreign");
  });

  test("identifyDaemon queries a live pid only, and only what the lock format needs", () => {
    const asked: string[] = [];
    const q = (live: boolean): ProcessQueries => ({
      isAlive: () => live,
      startTime: (p) => {
        asked.push(`start ${p}`);
        return T0;
      },
      imagePath: (p) => {
        asked.push(`image ${p}`);
        return "C:\\b\\hubd.exe";
      },
    });
    expect(identifyDaemon({ pid: 5, startedAt: T0 }, q(false), false)).toBe("foreign");
    expect(identifyDaemon({ pid: 6, startedAt: T0 }, q(true), false)).toBe("ours");
    expect(identifyDaemon({ pid: 8, startedAt: null }, q(true), false)).toBe("ours");
    expect(asked).toEqual(["start 6", "image 8"]);
  });

  test("only hubd.exe, hub.exe or bun.exe may be killed", () => {
    expect(isKillableImage("C:\\b\\hubd.exe")).toBe(true);
    expect(isKillableImage("C:\\b\\HUB.EXE")).toBe(true);
    expect(isKillableImage("C:\\bun\\bun.exe")).toBe(true);
    expect(isKillableImage("C:\\Windows\\System32\\notepad.exe")).toBe(false);
    expect(isKillableImage(null)).toBe(false);
  });
});

describe("acquireLock", () => {
  test("creates daemon.lock holding our pid and start time; release deletes it", () => {
    const lock = acquireLock(dir, { startedAt: T0 });
    expect(lock).not.toBeNull();
    const file = join(dir, "daemon.lock");
    expect(readFileSync(file, "utf8")).toBe(`${process.pid} ${T0}`);
    lock?.release();
    expect(existsSync(file)).toBe(false);
  });

  test("without a start time it writes the pid only", () => {
    const lock = acquireLock(dir);
    expect(readFileSync(join(dir, "daemon.lock"), "utf8")).toBe(String(process.pid));
    lock?.release();
  });

  test("refused while a live process holds it", () => {
    const first = acquireLock(dir);
    expect(first).not.toBeNull();
    expect(acquireLock(dir)).toBeNull();
    first?.release();
    const again = acquireLock(dir);
    expect(again).not.toBeNull();
    again?.release();
  });

  test("a stale lock from a dead pid is taken over", async () => {
    const file = join(dir, "daemon.lock");
    writeFileSync(file, String(await deadPid()));
    const lock = acquireLock(dir);
    expect(lock).not.toBeNull();
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    lock?.release();
  });

  test("a lock naming a foreign process is stale and taken over; the identity sees the parsed lock", () => {
    const file = join(dir, "daemon.lock");
    writeFileSync(file, `1234 ${T0}`);
    const seen: LockInfo[] = [];
    const lock = acquireLock(dir, {
      identify: (l) => {
        seen.push(l);
        return "foreign";
      },
      startedAt: T0 + 5,
    });
    expect(lock).not.toBeNull();
    expect(seen).toEqual([{ pid: 1234, startedAt: T0 }]);
    expect(readFileSync(file, "utf8")).toBe(`${process.pid} ${T0 + 5}`);
    lock?.release();
  });

  test("two starts racing for a stale lock: the loser never deletes the winner's fresh lock (RES-11)", () => {
    const file = join(dir, "daemon.lock");
    writeFileSync(file, `1234 ${T0}`);
    const rival = "777 1763000000999";
    // While this process judges the stale lock, a rival takes it over (unlink + create).
    const lock = acquireLock(dir, {
      identify: () => {
        rmSync(file);
        writeFileSync(file, rival);
        return "foreign";
      },
      startedAt: T0 + 5,
    });
    expect(lock).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(rival);
  });

  test("a lock held by our daemon or by a process that cannot be verified is refused", () => {
    const file = join(dir, "daemon.lock");
    writeFileSync(file, `1234 ${T0}`);
    expect(acquireLock(dir, { identify: () => "ours" })).toBeNull();
    expect(acquireLock(dir, { identify: () => "unknown" })).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(`1234 ${T0}`);
  });

  test.skipIf(!win)("processStartTime: this process's start, stable, null for a bad pid", () => {
    const t = processStartTime(process.pid);
    expect(t).not.toBeNull();
    const expected = Date.now() - process.uptime() * 1000;
    expect(Math.abs((t as number) - expected)).toBeLessThan(2_000);
    expect(processStartTime(process.pid)).toBe(t);
    expect(processStartTime(0x7fff_fff1)).toBeNull();
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 33]) expect(processStartTime(bad)).toBeNull();
  });

  const real: ProcessQueries = {
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    startTime: processStartTime,
    imagePath: processImagePath,
  };

  test.skipIf(!win)(
    "real check: a live bun.exe with the recorded start time is ours; another start time is stale",
    () => {
      const file = join(dir, "daemon.lock");
      const started = processStartTime(process.pid) as number;
      writeFileSync(file, formatLock({ pid: process.pid, startedAt: started }));
      // The compiled daemon recognises a daemon run from source: same pid, same start.
      expect(acquireLock(dir, { identify: (l) => identifyDaemon(l, real, false) })).toBeNull();
      // The same pid recorded with another start time: the pid was reused, by a bun.exe here.
      writeFileSync(file, formatLock({ pid: process.pid, startedAt: started - 60_000 }));
      const lock = acquireLock(dir, { identify: (l) => identifyDaemon(l, real, false) });
      expect(lock).not.toBeNull();
      lock?.release();
    },
  );

  test.skipIf(!win)("real check: a legacy lock naming another program is stale", async () => {
    const ping = Bun.spawn(["ping", "-n", "30", "127.0.0.1"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      writeFileSync(join(dir, "daemon.lock"), String(ping.pid));
      const lock = acquireLock(dir, { identify: (l) => identifyDaemon(l, real, false) });
      expect(lock).not.toBeNull();
      lock?.release();
    } finally {
      ping.kill();
      await ping.exited;
    }
  });

  test("release leaves a lock that another pid now holds", async () => {
    const lock = acquireLock(dir);
    const file = join(dir, "daemon.lock");
    writeFileSync(file, "424242");
    lock?.release();
    expect(readFileSync(file, "utf8")).toBe("424242");
  });

  test("garbage content in an old lock file is treated as stale", () => {
    const file = join(dir, "daemon.lock");
    writeFileSync(file, "not-a-pid");
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const lock = acquireLock(dir);
    expect(lock).not.toBeNull();
    lock?.release();
  });
});
