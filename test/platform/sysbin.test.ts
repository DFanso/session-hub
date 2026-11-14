import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sysbin } from "../../src/platform/windows/sysbin";

const saved = process.env.SystemRoot;
afterEach(() => {
  if (saved === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = saved;
});

describe("sysbin", () => {
  test("paths are built from SystemRoot", () => {
    process.env.SystemRoot = "X:\\Win";
    expect(sysbin.icacls()).toBe("X:\\Win\\System32\\icacls.exe");
    expect(sysbin.reg()).toBe("X:\\Win\\System32\\reg.exe");
    expect(sysbin.taskkill()).toBe("X:\\Win\\System32\\taskkill.exe");
    expect(sysbin.whoami()).toBe("X:\\Win\\System32\\whoami.exe");
    expect(sysbin.cmd()).toBe("X:\\Win\\System32\\cmd.exe");
    expect(sysbin.powershell()).toBe("X:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  test("SystemRoot unset falls back to C:\\Windows", () => {
    delete process.env.SystemRoot;
    expect(sysbin.reg()).toBe("C:\\Windows\\System32\\reg.exe");
  });

  test("no source file runs a Windows system tool by bare name", () => {
    const root = join(import.meta.dir, "..", "..", "src");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.tsx?$/.test(f),
    );
    const bare = /(?:\[|spawn\()\s*"(?:icacls|reg|powershell|taskkill|whoami|cmd)(?:\.exe)?"/i;
    const offenders = files.filter((f) => bare.test(readFileSync(join(root, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  test("only sysbin.ts builds a System32 path", () => {
    const root = join(import.meta.dir, "..", "..", "src");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.tsx?$/.test(f),
    );
    const offenders = files.filter(
      (f) => !f.endsWith("sysbin.ts") && /System32/i.test(readFileSync(join(root, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
