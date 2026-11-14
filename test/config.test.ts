import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DATA_DIR, MESSAGE_HEADER, PROFILES, RELAY_NAME, resolveConfig } from "../src/config.ts";

describe("resolveConfig", () => {
  const env = { USERPROFILE: "C:/Users/tester", LOCALAPPDATA: "C:/Users/tester/AppData/Local" };

  test("returns both profiles under USERPROFILE", () => {
    const c = resolveConfig(env);
    expect(c.profiles).toEqual([
      { id: "claude", dir: join("C:/Users/tester", ".claude") },
      { id: "claude-personal", dir: join("C:/Users/tester", ".claude-personal") },
    ]);
  });

  test("never includes .tclaude", () => {
    const c = resolveConfig(env);
    for (const p of c.profiles) expect(p.dir).not.toContain("tclaude");
  });

  test("data dir is SessionHub under LOCALAPPDATA", () => {
    expect(resolveConfig(env).dataDir).toBe(join(env.LOCALAPPDATA, "SessionHub"));
  });

  test("throws when USERPROFILE or LOCALAPPDATA missing", () => {
    expect(() => resolveConfig({ LOCALAPPDATA: "x" })).toThrow();
    expect(() => resolveConfig({ USERPROFILE: "x" })).toThrow();
  });
});

describe("constants", () => {
  test("exports", () => {
    expect(PROFILES.length).toBe(2);
    expect(typeof DATA_DIR).toBe("string");
    expect(RELAY_NAME).toBe("session-hub-relay");
    expect(MESSAGE_HEADER).toBe(
      "[Session Hub: message from the owner. Reply in your normal terminal reply; do not SendMessage back, the sender has exited.]",
    );
  });
});
