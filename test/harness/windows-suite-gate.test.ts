import { expect, test } from "bun:test";
import { join } from "node:path";

// Plain `bun test` collects test/windows too (bunfig root "."). That suite writes HKCU Run values
// and focuses windows, so it must run only through `bun run test:windows`, which sets
// SESSION_HUB_WINDOWS_SUITE=1. This runs one harmless test of that suite (an invalid-pid focus
// call) without the variable and expects it to be skipped.
test("test/windows does nothing unless SESSION_HUB_WINDOWS_SUITE=1", async () => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SESSION_HUB_WINDOWS_SUITE;
  const p = Bun.spawn(
    [
      process.execPath,
      "test",
      join("test", "windows", "platform.test.ts"),
      "--test-name-pattern",
      "invalid pid",
    ],
    { cwd: join(import.meta.dir, "..", ".."), env, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  const all = `${out}\n${err}`;
  // The one selected test ran and was skipped: not filtered away, not failing to load.
  expect(all).toMatch(/^\s*0 pass\s*$/m);
  expect(all).toMatch(/^\s*1 skip\s*$/m);
  expect(all).toMatch(/^\s*0 fail\s*$/m);
  expect(code).toBe(0);
}, 30_000);
