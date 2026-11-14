import { describe, expect, test } from "bun:test";
import { DEFAULT_TIMEOUT_MS, run } from "../../src/platform/windows/exec";
import { FOCUS_TIMEOUT_MS } from "../../src/platform/windows/focus";

describe("run", () => {
  test("default timeout is 10 s; focus allows 15 s for a cold CIM query", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(FOCUS_TIMEOUT_MS).toBe(15_000);
  });

  test("a given timeout stops a slow child", async () => {
    const t0 = performance.now();
    const r = await run([process.execPath, "-e", "setTimeout(() => {}, 20000)"], undefined, 300);
    expect(r.code).not.toBe(0);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  test("a child that finishes in time returns its output and exit code", async () => {
    const r = await run(
      [process.execPath, "-e", "process.stdout.write(process.env.SH_X ?? ''); process.exit(3)"],
      { SH_X: "ok" },
      10_000,
    );
    expect(r).toEqual({ code: 3, stdout: "ok" });
  });
});
