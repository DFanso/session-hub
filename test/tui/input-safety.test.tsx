import { afterEach, describe, expect, test } from "bun:test";
import type { Store } from "../../src/store/db";
import type { AppProps } from "../../src/tui/App";
import {
  cleanupDirs,
  type Harness,
  iso,
  KEY,
  mount,
  type SendCall,
  seed,
  session,
  tempStore,
} from "./harness";

const ESC = "\u001B";
const BEL = "\u0007";

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

/** Counts listSessions calls so a test can tell whether `r` (refresh) ran. */
function counting(store: Store): { store: Store; reads: () => number } {
  let n = 0;
  const proxy = new Proxy(store, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === "listSessions") {
        return () => {
          n += 1;
          return target.listSessions();
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { store: proxy, reads: () => n };
}

function recordingSend(calls: SendCall[]): AppProps["send"] {
  return async (req) => {
    calls.push(req);
    return { state: "pending" };
  };
}

function exitFlag(x: Harness): () => boolean {
  let exited = false;
  void x.app.waitUntilExit().then(() => {
    exited = true;
  });
  return () => exited;
}

async function selectAlpha(x: Harness): Promise<void> {
  await x.until((f) => f.includes("abcdef12"));
  await x.press(KEY.down);
}

describe("terminal output is sanitized", () => {
  test("the sessionId fallback label is cleaned in the list and the header", async () => {
    const s = tempStore();
    // Name "" makes the label fall back to the sessionId; sorts first so it is selected.
    s.upsertSession(session({ sessionId: `ab${ESC}]0;x${BEL}cd${ESC}[2J123456`, name: "" }));
    h = mount({ store: s });
    const f = await h.until((x) => x.includes("abcd1234"));
    const lines = f.split("\n");
    expect(lines[0]).toContain("abcd1234");
    expect(lines.slice(1).some((l) => l.includes("> abcd1234"))).toBe(true);
    const raw = h.out.frames.join("");
    expect(raw).not.toContain(`${ESC}]`);
    expect(raw).not.toContain(BEL);
    expect(raw).not.toContain(`${ESC}[2J`);
  });

  test("escape sequences in a name, cwd, message and status render as plain text", async () => {
    const s = seeded();
    s.upsertSession(
      session({
        sessionId: "s-alpha",
        name: `al${ESC}]52;c;ZXZpbA==${BEL}pha`,
        cwd: `D:/x${ESC}[2J${ESC}[1;1H/y`,
        status: "waiting",
        pid: 4242,
      }),
    );
    s.setStatus(
      "s-alpha",
      {
        progressPct: 40,
        phase: `Bu${ESC}]0;pwned${ESC}\\ild`,
        remaining: [`wire${ESC}[1A relay`],
        waiting: [{ id: "Q1", text: `pick${ESC}[2K region`, isNew: true, children: [] }],
        recommendations: [],
      },
      "r1",
      iso(60_000),
    );
    s.addMessages("s-alpha", [
      {
        uuid: "m1",
        sessionId: "s-alpha",
        ts: iso(30_000),
        role: "peer",
        fromName: `bo${ESC}[31mb`,
        text: `hi ${ESC}]0;title${BEL}there${ESC}[?25l\tok`,
      },
    ]);
    h = mount({ store: s });
    await selectAlpha(h);
    await h.until((f) => f.includes("pick region"));
    await h.press("2");
    await h.until((f) => f.includes("hi there  ok"));
    const raw = h.out.frames.join("");
    expect(raw).not.toContain(`${ESC}]`);
    expect(raw).not.toContain(BEL);
    expect(raw).not.toContain(`${ESC}[2J`);
    expect(raw).not.toContain(`${ESC}[1A`);
    expect(raw).not.toContain(`${ESC}[2K`);
    expect(raw).not.toContain(`${ESC}[?25l`);
    const f = h.frame();
    expect(f).toContain("alpha");
    expect(f).toContain("peer:bob");
    await h.press("1");
    const st = await h.until((x) => x.includes("Phase: Build"));
    expect(st).toContain("wire relay");
  });

  test("a bracketed paste with OSC 52 and colour codes enters the draft cleaned", async () => {
    const calls: SendCall[] = [];
    h = mount({ store: seeded(), send: recordingSend(calls) });
    await selectAlpha(h);
    await h.press("3");
    await h.until((f) => f.includes("Ctrl+S"));
    await h.press(`${ESC}[200~abc${ESC}]52;c;ZXZpbA==${BEL}def${ESC}[31mred${ESC}[0m${ESC}[201~`);
    await h.until((f) => f.includes("abcdefred_"));
    await h.press(KEY.ctrlS);
    await h.until((f) => f.includes("Preview"));
    await h.press("y");
    await h.until((f) => f.includes("sent: pending"));
    expect(calls).toEqual([{ sessionId: "s-alpha", text: "abcdefred" }]);
  });

  test("escape tails (colour, Ctrl+arrow, F1, Home, Alt+key) never become draft text", async () => {
    h = mount({ store: seeded() });
    await selectAlpha(h);
    await h.press("3");
    await h.until((f) => f.includes("Ctrl+S"));
    for (const k of [
      "a",
      `${ESC}[31m`,
      "b",
      `${ESC}[1;5C`,
      "c",
      `${ESC}OP`,
      "d",
      `${ESC}[H`,
      "e",
    ]) {
      await h.press(k);
    }
    await h.press(`${ESC}x`);
    await h.press(`${ESC}[99X`);
    await h.press("f");
    const f = await h.until((x) => x.includes("abcdef_"));
    expect(f).not.toContain("[31m");
    expect(f).not.toContain("[99X");
  });
});

describe("input capture is synchronous", () => {
  test("3 then q j r 1 / in the same tick all go into the draft", async () => {
    const c = counting(seeded());
    h = mount({ store: c.store, refreshMs: 60_000 });
    const exited = exitFlag(h);
    await selectAlpha(h);
    const before = c.reads();
    h.inp.press("3");
    for (const ch of "qjr1/") h.inp.press(ch);
    const f = await h.until((x) => x.includes("qjr1/_"));
    expect(exited()).toBe(false);
    expect(h.focuses).toEqual([]);
    expect(c.reads()).toBe(before);
    expect(f).toContain("Ctrl+S");
  });

  test("/ then q j r 3 in the same tick all go into the search query", async () => {
    const c = counting(seeded());
    h = mount({ store: c.store, refreshMs: 60_000 });
    const exited = exitFlag(h);
    await selectAlpha(h);
    const before = c.reads();
    h.inp.press("/");
    for (const ch of "qjr3") h.inp.press(ch);
    await h.until((x) => x.includes("Search: qjr3_"));
    expect(exited()).toBe(false);
    expect(h.focuses).toEqual([]);
    expect(c.reads()).toBe(before);
  });

  test("Ctrl+S and y in the same tick do not send: y needs a rendered preview", async () => {
    const calls: SendCall[] = [];
    h = mount({ store: seeded(), send: recordingSend(calls) });
    await selectAlpha(h);
    await h.press("3");
    await h.type("hi");
    h.inp.press(KEY.ctrlS);
    h.inp.press("y");
    await h.until((f) => f.includes("Preview"));
    expect(calls).toHaveLength(0);
    await h.press("y");
    await h.until((f) => f.includes("sent: pending"));
    expect(calls).toHaveLength(1);
  });

  test("a pasted chunk containing Ctrl+S and y is text, not a send", async () => {
    const calls: SendCall[] = [];
    h = mount({ store: seeded(), send: recordingSend(calls) });
    await selectAlpha(h);
    await h.press("3");
    await h.press("x\u0013y");
    await h.until((f) => f.includes("xy_"));
    expect(calls).toHaveLength(0);
  });
});

describe("quit and the Send pane", () => {
  test("q with a draft asks first; n keeps it, y quits", async () => {
    h = mount({ store: seeded() });
    const exited = exitFlag(h);
    await selectAlpha(h);
    await h.press("3");
    await h.type("keep me");
    await h.press(KEY.esc);
    await h.press("q");
    await h.until((f) => f.includes("quit and discard draft? y/n"));
    await h.press("j");
    expect(h.focuses).toEqual([]);
    await h.press("n");
    const f = await h.until((x) => !x.includes("discard draft"));
    expect(f).toContain("keep me");
    expect(exited()).toBe(false);
    await h.press("1");
    await h.press("q");
    await h.until((x) => x.includes("quit and discard draft? y/n"));
    await h.press("y");
    await h.app.waitUntilExit();
  });

  test("after a send, keys stay in the pane until Esc returns to the list", async () => {
    const calls: SendCall[] = [];
    h = mount({ store: seeded(), send: recordingSend(calls) });
    const exited = exitFlag(h);
    await selectAlpha(h);
    await h.press("3");
    await h.type("hello");
    await h.press(KEY.ctrlS);
    await h.until((f) => f.includes("Preview"));
    await h.press("y");
    await h.until((f) => f.includes("sent: pending"));
    await h.press("q");
    await h.press("j");
    await h.press("1");
    expect(exited()).toBe(false);
    expect(h.focuses).toEqual([]);
    expect(h.frame()).toContain("sent: pending");
    await h.press(KEY.esc);
    await h.press("j");
    await h.until((f) => f.includes("focused: Windows Terminal"));
    await h.press("q");
    await h.app.waitUntilExit();
  });

  test("after a refusal, Enter returns to the kept draft", async () => {
    h = mount({
      store: seeded(),
      send: async () => {
        throw Object.assign(new Error("x"), { reason: "session is gone" });
      },
    });
    await selectAlpha(h);
    await h.press("3");
    await h.type("draft text");
    await h.press(KEY.ctrlS);
    await h.until((f) => f.includes("Preview"));
    await h.press("y");
    await h.until((f) => f.includes("Not sent: session is gone"));
    await h.press("q");
    expect(h.frame()).toContain("Not sent");
    await h.press(KEY.enter);
    await h.until((f) => f.includes("draft text_"));
  });

  test("the status age names local time", async () => {
    h = mount({ store: seeded() });
    await selectAlpha(h);
    const f = await h.until((x) => x.includes("status from 4m ago"));
    expect(f).toMatch(/reply at \d\d:\d\d local/);
  });
});
