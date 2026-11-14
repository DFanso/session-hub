import { describe, expect, test } from "bun:test";
import { clearAutostart, getAutostart } from "../../src/platform/windows/autostart";
import type { ExecResult } from "../../src/platform/windows/exec";
import { runChecked } from "../../src/platform/windows/exec";

const PARENT = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion";
const RUN = `${PARENT}\\Run`;
// Never a real value name: if the runner were ever ignored, a real reg call must not touch the hub's value.
const NAME = "SessionHubUnitTestNoSuchValue";

const runListing = (lines: string[]): string =>
  ["", "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", ...lines, ""].join(
    "\r\n",
  );
const parentListing = (subkeys: string[]): string =>
  [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion",
    "    ProgramFilesDir    REG_SZ    C:\\Program Files",
    "",
    ...subkeys.map((k) => `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\${k}`),
    "",
  ].join("\r\n");

/** Fake runner: answers by verb and key, records every argv. Tool path is ignored. */
function fake(answers: { delete?: ExecResult; run?: ExecResult; parent?: ExecResult }): {
  exec: (argv: string[]) => Promise<ExecResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec = async (argv: string[]): Promise<ExecResult> => {
    calls.push(argv);
    const [, verb, key] = argv;
    if (verb === "delete") return answers.delete ?? { code: 0, stdout: "" };
    if (verb === "query" && key === RUN && answers.run) return answers.run;
    if (verb === "query" && key === PARENT && answers.parent) return answers.parent;
    throw new Error(`unexpected call: ${argv.join(" ")}`);
  };
  return { exec, calls };
}

describe("getAutostart", () => {
  test("returns the value's data from the Run key listing", async () => {
    const { exec, calls } = fake({
      run: {
        code: 0,
        stdout: runListing([
          "    OneDrive    REG_SZ    other.exe",
          `    ${NAME}    REG_SZ    "C:\\Users\\u\\AppData\\Local\\SessionHub\\bin\\hubd.exe"`,
        ]),
      },
    });
    expect(await getAutostart(NAME, exec)).toBe(
      '"C:\\Users\\u\\AppData\\Local\\SessionHub\\bin\\hubd.exe"',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatch(/\\System32\\reg\.exe$/i);
  });

  test("value not in the listing: null", async () => {
    const { exec } = fake({
      run: { code: 0, stdout: runListing(["    OneDrive    REG_SZ    other.exe"]) },
    });
    expect(await getAutostart(NAME, exec)).toBeNull();
  });

  test("a longer name that starts with ours is not ours", async () => {
    const { exec } = fake({
      run: { code: 0, stdout: runListing([`    ${NAME}Old    REG_SZ    x.exe`]) },
    });
    expect(await getAutostart(NAME, exec)).toBeNull();
  });

  test("a REG_EXPAND_SZ value of the same name is read too", async () => {
    const { exec } = fake({
      run: {
        code: 0,
        stdout: runListing([
          "    OneDrive    REG_SZ    other.exe",
          `    ${NAME}    REG_EXPAND_SZ    "%LOCALAPPDATA%\\SessionHub\\bin\\hubd.exe"`,
        ]),
      },
    });
    expect(await getAutostart(NAME, exec)).toBe('"%LOCALAPPDATA%\\SessionHub\\bin\\hubd.exe"');
  });

  test("other value types of the same name are not read", async () => {
    const { exec } = fake({
      run: { code: 0, stdout: runListing([`    ${NAME}    REG_DWORD    0x1`]) },
    });
    expect(await getAutostart(NAME, exec)).toBeNull();
  });

  test("Run key missing (its parent lists no Run subkey): null", async () => {
    const { exec } = fake({
      run: { code: 1, stdout: "" },
      parent: { code: 0, stdout: parentListing(["RunOnce", "Explorer"]) },
    });
    expect(await getAutostart(NAME, exec)).toBeNull();
  });

  test("Run key present but the query failed: throws reg failed with exit code", async () => {
    const { exec } = fake({
      run: { code: 1, stdout: "" },
      parent: { code: 0, stdout: parentListing(["Run", "RunOnce"]) },
    });
    await expect(getAutostart(NAME, exec)).rejects.toThrow("reg failed with exit code 1");
  });

  test("parent query fails too: throws with the Run query's exit code", async () => {
    const { exec } = fake({ run: { code: 5, stdout: "" }, parent: { code: 1, stdout: "" } });
    await expect(getAutostart(NAME, exec)).rejects.toThrow("reg failed with exit code 5");
  });
});

describe("clearAutostart", () => {
  test("delete succeeds: no query needed", async () => {
    const { exec, calls } = fake({ delete: { code: 0, stdout: "" } });
    await clearAutostart(NAME, exec);
    expect(calls.map((c) => c[1])).toEqual(["delete"]);
  });

  test("delete fails because the value is not there: ok", async () => {
    const { exec } = fake({
      delete: { code: 1, stdout: "" },
      run: { code: 0, stdout: runListing(["    OneDrive    REG_SZ    other.exe"]) },
    });
    await clearAutostart(NAME, exec);
  });

  test("delete fails and the value is still there: throws", async () => {
    const { exec } = fake({
      delete: { code: 1, stdout: "" },
      run: { code: 0, stdout: runListing([`    ${NAME}    REG_SZ    x.exe`]) },
    });
    await expect(clearAutostart(NAME, exec)).rejects.toThrow("reg failed with exit code 1");
  });

  test("delete fails and the follow-up query fails for another reason: throws", async () => {
    const { exec } = fake({
      delete: { code: 1, stdout: "" },
      run: { code: 1, stdout: "" },
      parent: { code: 0, stdout: parentListing(["Run"]) },
    });
    await expect(clearAutostart(NAME, exec)).rejects.toThrow("reg failed with exit code 1");
  });
});

describe("runChecked", () => {
  test("names the tool by base name, not by its absolute path", async () => {
    await expect(runChecked([process.execPath, "-e", "process.exit(4)"])).rejects.toThrow(
      /^(bun|node)[^\\/]* failed with exit code 4$/,
    );
  });
});
