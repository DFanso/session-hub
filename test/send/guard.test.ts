import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimMarkerFile,
  GUARD_BLOCK_EXIT,
  GUARD_MARKER_ENV,
  GUARD_TO_ENV,
  guardCommand,
  guardDecision,
  guardSettings,
  runGuard,
} from "../../src/send/guard.ts";

let dir: string;
let marker: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sh-guard-"));
  marker = join(dir, "guard-1.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = () => ({ [GUARD_TO_ENV]: "alpha", [GUARD_MARKER_ENV]: marker });
const deps = (e: Record<string, string | undefined> = env()) => ({
  env: e,
  claimMarker: claimMarkerFile,
});
const call = (toolName: string, toolInput: unknown) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput });

describe("guardDecision", () => {
  test("allows one SendMessage to the chosen session and claims the marker", () => {
    expect(guardDecision(call("SendMessage", { to: "alpha", message: "hi" }), deps())).toEqual({
      allow: true,
    });
    expect(existsSync(marker)).toBe(true);
  });

  test("blocks a second SendMessage, even to the chosen session", () => {
    guardDecision(call("SendMessage", { to: "alpha", message: "hi" }), deps());
    const d = guardDecision(call("SendMessage", { to: "alpha", message: "again" }), deps());
    expect(d).toEqual({ allow: false, reason: "relay guard: the message was already sent once" });
  });

  test("blocks a SendMessage to any other session and does not use up the one send", () => {
    for (const to of ["beta", "Alpha", "alpha ", "", null, 1]) {
      const d = guardDecision(call("SendMessage", { to, message: "hi" }), deps());
      expect(d.allow).toBe(false);
    }
    expect(existsSync(marker)).toBe(false);
    expect(guardDecision(call("SendMessage", { to: "alpha" }), deps()).allow).toBe(true);
  });

  test("blocks every other tool", () => {
    for (const tool of ["Bash", "Write", "Read", "Agent", "sendmessage", ""]) {
      expect(guardDecision(call(tool, { to: "alpha" }), deps())).toEqual({
        allow: false,
        reason: "relay guard: only SendMessage is allowed",
      });
    }
  });

  test("fails closed without a recipient or marker, or on unreadable input", () => {
    expect(guardDecision(call("SendMessage", { to: "alpha" }), deps({})).allow).toBe(false);
    expect(
      guardDecision(call("SendMessage", { to: "alpha" }), deps({ [GUARD_TO_ENV]: "alpha" })).allow,
    ).toBe(false);
    expect(
      guardDecision(call("SendMessage", { to: "alpha" }), deps({ [GUARD_MARKER_ENV]: marker }))
        .allow,
    ).toBe(false);
    for (const input of ["", "not json", "null", "[]", "42", '"x"']) {
      expect(guardDecision(input, deps()).allow).toBe(false);
    }
    expect(guardDecision(call("SendMessage", null), deps()).allow).toBe(false);
    expect(guardDecision(call("SendMessage", "alpha"), deps()).allow).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test("a marker that cannot be created blocks the send", () => {
    const d = guardDecision(call("SendMessage", { to: "alpha" }), {
      env: { [GUARD_TO_ENV]: "alpha", [GUARD_MARKER_ENV]: join(dir, "missing", "x.lock") },
      claimMarker: claimMarkerFile,
    });
    expect(d.allow).toBe(false);
  });
});

describe("runGuard", () => {
  test("exit 0 to allow, 2 with the reason on stderr to block", () => {
    const errs: string[] = [];
    const d = { ...deps(), err: (l: string) => errs.push(l) };
    expect(runGuard(call("SendMessage", { to: "alpha" }), d)).toBe(0);
    expect(errs).toEqual([]);
    expect(runGuard(call("SendMessage", { to: "beta" }), d)).toBe(GUARD_BLOCK_EXIT);
    expect(GUARD_BLOCK_EXIT).toBe(2);
    expect(errs).toEqual(['relay guard: SendMessage may only go to "alpha"']);
  });
});

describe("hook settings", () => {
  test("quotes each part with forward slashes", () => {
    expect(guardCommand(["C:\\Users\\a b\\hub.exe", "relay-guard"])).toBe(
      '"C:/Users/a b/hub.exe" "relay-guard"',
    );
  });

  test("one PreToolUse hook on every tool", () => {
    expect(JSON.parse(guardSettings(["hub.exe", "relay-guard"]))).toEqual({
      hooks: {
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: '"hub.exe" "relay-guard"' }] },
        ],
      },
    });
  });
});

describe("the real CLI entry", () => {
  test("hub relay-guard blocks a send to another session (exit 2) and allows the chosen one", async () => {
    const entry = join(import.meta.dir, "..", "..", "src", "cli.ts");
    const run = async (input: string) => {
      const p = Bun.spawn(["bun", entry, "relay-guard"], {
        stdin: new TextEncoder().encode(input),
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, ...env() },
      });
      return { code: await p.exited, err: await new Response(p.stderr).text() };
    };
    const blocked = await run(call("SendMessage", { to: "beta" }));
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain('may only go to "alpha"');
    expect((await run(call("SendMessage", { to: "alpha" }))).code).toBe(0);
    expect((await run(call("SendMessage", { to: "alpha" }))).code).toBe(2);
  }, 30_000);
});
