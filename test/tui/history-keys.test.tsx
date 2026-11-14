import { afterEach, describe, expect, test } from "bun:test";
import type { MessageRow, Store } from "../../src/store/db";
import { cleanupDirs, type Harness, iso, KEY, mount, seed, tempStore } from "./harness";

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

function msg(n: number, over: Partial<MessageRow> = {}): MessageRow {
  return {
    uuid: `m${n}`,
    sessionId: "s-alpha",
    ts: iso((1000 - n) * 60_000),
    role: "assistant",
    fromName: null,
    text: `message number ${n}`,
    ...over,
  };
}

async function selectAlpha(x: Harness): Promise<void> {
  await x.until((f) => f.includes("abcdef12"));
  await x.press(KEY.down);
}

describe("history pane", () => {
  test("newest last with role labels you / peer:<name> / claude", async () => {
    const s = seeded();
    s.addMessages("s-alpha", [
      msg(1, { role: "owner", text: "please check" }),
      msg(2, { role: "peer", fromName: "other-app", text: "from a peer" }),
      msg(3, { role: "assistant", text: "checked it" }),
    ]);
    h = mount({ store: s });
    await selectAlpha(h);
    await h.press("2");
    const f = await h.until((x) => x.includes("checked it"));
    const lines = f.split("\n");
    const at = (n: string) => lines.findIndex((l) => l.includes(n));
    expect(at("please check")).toBeLessThan(at("from a peer"));
    expect(at("from a peer")).toBeLessThan(at("checked it"));
    expect(lines[at("please check") - 1]).toContain("you");
    expect(lines[at("from a peer") - 1]).toContain("peer:other-app");
    expect(lines[at("checked it") - 1]).toContain("claude");
  });

  test("PgUp pages to older messages", async () => {
    const s = seeded();
    s.addMessages(
      "s-alpha",
      Array.from({ length: 120 }, (_, i) => msg(i)),
    );
    h = mount({ store: s });
    await selectAlpha(h);
    await h.press("2");
    await h.until((x) => x.includes("message number 119"));
    for (let i = 0; i < 12; i++) await h.press(KEY.pgUp);
    const f = await h.until((x) => /message number [0-9]\b/.test(x));
    expect(f).not.toContain("message number 119");
  });

  test("/ opens search, Enter shows hits across sessions, Esc clears", async () => {
    const s = seeded();
    s.addMessages("s-alpha", [msg(1, { text: "the hidden needle is here" })]);
    s.addMessages("s-gamma", [
      msg(2, { sessionId: "s-gamma", uuid: "g1", text: "another needle" }),
    ]);
    h = mount({ store: s });
    await h.until((x) => x.includes("abcdef12"));
    await h.press("/");
    await h.until((x) => x.includes("Search:"));
    await h.type("needle");
    await h.press(KEY.enter);
    const f = await h.until((x) => x.includes("2 results"));
    expect(f).toContain("[needle]");
    expect(f).toContain("alpha");
    expect(f).toContain("gamma");
    await h.press(KEY.esc);
    const g = await h.until((x) => !x.includes("results"));
    expect(g).not.toContain("[needle]");
  });
});

describe("global keys", () => {
  test("j focuses a live session's window and shows a toast", async () => {
    h = mount({ store: seeded() });
    await selectAlpha(h);
    await h.press("j");
    await h.until((x) => x.includes("focused: Windows Terminal"));
    expect(h.focuses).toEqual([4242]);
  });

  test("j reports a focus failure", async () => {
    h = mount({ store: seeded(), focus: async () => ({ ok: false, reason: "no window" }) });
    await selectAlpha(h);
    await h.press("j");
    await h.until((x) => x.includes("could not focus: no window"));
  });

  test("j on an ended session does not call focus", async () => {
    h = mount({ store: seeded() });
    await h.until((x) => x.includes("delta"));
    await h.press(KEY.down);
    await h.press(KEY.down);
    await h.press("j");
    await h.until((x) => x.includes("could not focus: session ended"));
    expect(h.focuses).toEqual([]);
  });

  test("store errors show in the footer instead of crashing", async () => {
    const real = seeded();
    let fail = false;
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === "listSessions" && fail) {
          return () => {
            throw new Error("database is locked");
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    h = mount({ store: flaky });
    await h.until((x) => x.includes("abcdef12"));
    fail = true;
    const f = await h.until((x) => x.includes("store error: database is locked"));
    expect(f).toContain("abcdef12");
    fail = false;
    await h.until((x) => !x.includes("store error"));
  });

  test("q quits and unmounts", async () => {
    h = mount({ store: seeded() });
    await h.until((x) => x.includes("abcdef12"));
    await h.press("q");
    await h.app.waitUntilExit();
  });
});

describe("history polling and scroll anchor", () => {
  test("history is read only while the History tab is shown", async () => {
    const real = seeded();
    let reads = 0;
    const store = new Proxy(real, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop === "history") {
          return (...a: Parameters<Store["history"]>) => {
            reads += 1;
            return target.history(...a);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    h = mount({ store });
    await selectAlpha(h);
    await new Promise((r) => setTimeout(r, 200));
    expect(reads).toBe(0);
    await h.press("2");
    await h.until(() => reads > 0);
  });

  test("a new message does not move a view scrolled up; End returns to the newest", async () => {
    const s = seeded();
    s.addMessages(
      "s-alpha",
      Array.from({ length: 30 }, (_, i) => msg(i)),
    );
    h = mount({ store: s });
    await selectAlpha(h);
    await h.press("2");
    await h.until((x) => x.includes("message number 29"));
    await h.press(KEY.pgUp);
    const before = await h.until((x) => !x.includes("message number 29"));
    const firstBefore = before.match(/message number \d+/)?.[0];
    s.addMessages("s-alpha", [msg(500, { text: "brand new reply" })]);
    await new Promise((r) => setTimeout(r, 200));
    const after = h.frame();
    expect(after.match(/message number \d+/)?.[0]).toBe(firstBefore);
    expect(after).not.toContain("brand new reply");
    await h.press("\u001B[F");
    await h.until((x) => x.includes("brand new reply"));
  });
});
