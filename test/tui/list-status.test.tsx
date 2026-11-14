import { afterEach, describe, expect, test } from "bun:test";
import type { Store } from "../../src/store/db";
import { hhmm } from "../../src/tui/format";
import { cleanupDirs, type Harness, iso, KEY, mount, seed, session, tempStore } from "./harness";

let h: Harness | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
  cleanupDirs();
});

function seeded(): Store {
  const s = tempStore();
  seed(s);
  return s;
}

describe("session list", () => {
  test("groups by profile with name, cwd tail, state label and waiting badge", async () => {
    h = mount({ store: seeded() });
    const f = await h.until((x) => x.includes(".claude-personal"));
    // Only the left column (30% of 80): the right pane may repeat names.
    const lines = f.split("\n").map((l) => [...l].slice(0, 24).join(""));
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    const claude = lines.findIndex((l) => /^\.claude\s/.test(l));
    // .claude group: live sessions first (by name), ended last; then .claude-personal.
    expect(claude).toBeGreaterThanOrEqual(0);
    expect(at("abcdef12")).toBeGreaterThan(claude);
    expect(at("alpha")).toBeGreaterThan(at("abcdef12"));
    expect(at("delta")).toBeGreaterThan(at("alpha"));
    expect(at(".claude-personal")).toBeGreaterThan(at("delta"));
    expect(at("gamma")).toBeGreaterThan(at(".claude-personal"));
    const row = (needle: string) => lines[at(needle)] ?? "";
    expect(row("alpha")).toContain("needs you");
    expect(row("alpha")).toContain("[2]");
    expect(row("abcdef12")).toContain("busy");
    expect(row("abcdef12")).not.toContain("abcdef123");
    expect(row("abcdef12")).not.toContain("[");
    expect(row("gamma")).toContain("idle");
    expect(row("delta")).toContain("ended");
    // cwd tail on the line under the name.
    expect(lines[at("alpha") + 1]).toContain("alpha-repo");
    expect(lines[at("abcdef12") + 1]).toContain("C:/work/beta");
  });

  test("fits 80x24: no line wider than 80 columns, at most 24 lines, long text truncated", async () => {
    const s = seeded();
    s.upsertSession(
      session({
        sessionId: "s-long",
        name: "a-really-long-session-name-that-cannot-fit",
        cwd: "D:/very/deep/path/that/goes/on/and/on/to/project-tail",
      }),
    );
    for (let i = 0; i < 12; i++) {
      s.upsertSession(session({ sessionId: `s-many-${i}`, name: `many-${i}` }));
    }
    h = mount({ store: s });
    const f = await h.until((x) => x.includes("abcdef12"));
    const lines = f.replace(/\n$/, "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(24);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(80);
    expect(f).toContain("…");
  });

  test("arrow keys move the selection; the window follows it", async () => {
    const s = seeded();
    for (let i = 0; i < 12; i++) {
      s.upsertSession(
        session({ sessionId: `s-many-${i}`, name: `many-${String(i).padStart(2, "0")}` }),
      );
    }
    h = mount({ store: s });
    await h.until((x) => x.includes("abcdef12"));
    for (let i = 0; i < 13; i++) await h.press(KEY.down);
    const f = h.frame();
    expect(f).toContain("> many-11");
    expect(f).not.toContain("abcdef12");
  });
});

describe("status pane", () => {
  test("progress, remaining, waiting with ID and NEW, recommendations, age and banners", async () => {
    h = mount({ store: seeded() });
    await h.until((x) => x.includes("abcdef12"));
    await h.press(KEY.down);
    const f = await h.until((x) => x.includes("Pick the region"));
    expect(f).toContain("40% overall");
    expect(f).toContain("Phase: Build");
    expect(f).toContain("What's remaining");
    expect(f).toContain("Wire the relay");
    expect(f).toContain("Waiting on you");
    expect(f).toMatch(/Q15 NEW Pick the region/);
    expect(f).toMatch(/Q9 Approve plan/);
    expect(f).not.toMatch(/Q9 NEW/);
    expect(f).toContain("sub point");
    expect(f).toContain("Recommendations");
    expect(f).toContain("Use the EU region");
    expect(f).toContain("status from 4m ago");
    expect(f).toContain(`newer reply at ${hhmm(iso(60_000))} has no status block`);
    expect(f).toContain("format changed: 3 unknown records");
    expect(f).toContain("stale: .claude-personal list not updated for 2m");
  });

  test("no newer-reply banner when the latest reply is the status reply", async () => {
    const s = seeded();
    s.setLatestReply("s-alpha", "r1", iso(4 * 60_000), true);
    s.setMeta("unknown_count", null);
    s.setMeta("stale_since:claude-personal", null);
    h = mount({ store: s });
    await h.until((x) => x.includes("abcdef12"));
    await h.press(KEY.down);
    const f = await h.until((x) => x.includes("Pick the region"));
    expect(f).not.toContain("newer reply");
    expect(f).not.toContain("format changed");
    expect(f).not.toContain("stale:");
  });

  test("no status reply yet", async () => {
    h = mount({ store: seeded() });
    const f = await h.until((x) => x.includes("no status reply yet"));
    expect(f).not.toContain("Waiting on you");
  });

  test("refresh picks up store changes made by another writer", async () => {
    const s = seeded();
    h = mount({ store: s });
    await h.until((x) => x.includes("no status reply yet"));
    s.setStatus(
      "abcdef1234567890",
      { progressPct: 75, phase: "Ship", remaining: [], waiting: [], recommendations: [] },
      "rb",
      iso(30_000),
    );
    const f = await h.until((x) => x.includes("75% overall"));
    expect(f).toContain("status from 30s ago");
  });
});
