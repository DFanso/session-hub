import { afterEach, describe, expect, test } from "bun:test";
import { SendRefused } from "../../src/send/relay";
import type { Store } from "../../src/store/db";
import type { AppProps } from "../../src/tui/App";
import {
  cleanupDirs,
  type Harness,
  KEY,
  mount,
  NOW,
  type SendCall,
  seed,
  tempStore,
} from "./harness";

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

/** Selects alpha (second row) and opens the Send pane. */
async function openAlphaSend(x: Harness): Promise<void> {
  await x.until((f) => f.includes("abcdef12"));
  await x.press(KEY.down);
  await x.press("3");
  await x.until((f) => f.includes("Ctrl+S"));
}

/** A send that records the request and creates the send row the way the relay sender does. */
function recordingSend(store: Store, calls: SendCall[]): AppProps["send"] {
  return async (req) => {
    calls.push(req);
    const id = store.createSend({
      sessionId: req.sessionId,
      profile: "claude",
      name: "alpha",
      sha256: "h",
      createdAt: NOW,
      state: "pending",
      detail: null,
    });
    return { state: "pending", detail: null, id } as { state: string; detail: string | null };
  };
}

describe("send pane", () => {
  test("a message that looks like it holds a secret is flagged in the preview; y then sends it (LLM-03)", async () => {
    const store = seeded();
    const calls: SendCall[] = [];
    h = mount({ store, send: recordingSend(store, calls) });
    await openAlphaSend(h);
    await h.type("card 4111111111111111");
    await h.press(KEY.ctrlS);
    const p = await h.until((f) => f.includes("Preview"));
    expect(p).toContain("Warning: this message looks like a secret or card");
    await h.press("y");
    await h.until(() => calls.length === 1);
    expect(calls).toEqual([
      { sessionId: "s-alpha", text: "card 4111111111111111", allowSecret: true },
    ]);
  });

  test("Ctrl+S shows the full preview; nothing is sent before y; y sends; later state shows", async () => {
    const store = seeded();
    const calls: SendCall[] = [];
    h = mount({ store, send: recordingSend(store, calls) });
    await openAlphaSend(h);
    await h.type("hello there");
    await h.press(KEY.enter);
    await h.type("line two");
    expect(calls).toHaveLength(0);
    await h.press(KEY.ctrlS);
    const p = await h.until((f) => f.includes("Preview"));
    expect(p).toContain("To: alpha");
    expect(p).toContain(".claude");
    expect(p).toContain("D:/work/alpha-repo");
    expect(p).toContain("[Session Hub: message from the owner.");
    expect(p).toContain("hello there");
    expect(p).toContain("line two");
    expect(p).toContain("y send");
    expect(calls).toHaveLength(0);
    await h.press("x");
    await h.press(KEY.enter);
    expect(calls).toHaveLength(0);
    await h.press("y");
    await h.until((f) => f.includes("sent: pending"));
    expect(calls).toEqual([{ sessionId: "s-alpha", text: "hello there\nline two" }]);
    const id = store.openSendFor("s-alpha")?.id ?? -1;
    store.transitionSend(id, "delivered", "seen in transcript");
    await h.until((f) => f.includes("now: delivered"));
  });

  test("y pressed twice before a re-render sends once", async () => {
    const store = seeded();
    const calls: SendCall[] = [];
    h = mount({ store, send: recordingSend(store, calls) });
    await openAlphaSend(h);
    await h.type("once");
    await h.press(KEY.ctrlS);
    await h.until((f) => f.includes("Preview"));
    h.inp.press("y");
    h.inp.press("y");
    await h.until((f) => f.includes("sent: pending"));
    await h.press("y");
    expect(calls).toHaveLength(1);
  });

  test("n cancels the preview and keeps the draft; nothing is sent", async () => {
    const calls: SendCall[] = [];
    const store = seeded();
    h = mount({ store, send: recordingSend(store, calls) });
    await openAlphaSend(h);
    await h.type("draft");
    await h.press(KEY.ctrlS);
    await h.until((f) => f.includes("Preview"));
    await h.press("n");
    const f = await h.until((x) => !x.includes("Preview"));
    expect(f).toContain("draft");
    expect(calls).toHaveLength(0);
  });

  test("an open send shows its state and needs o before y", async () => {
    const store = seeded();
    store.createSend({
      sessionId: "s-alpha",
      profile: "claude",
      name: "alpha",
      sha256: "old",
      createdAt: NOW - 90_000,
      state: "held",
      detail: null,
    });
    const calls: SendCall[] = [];
    h = mount({ store, send: recordingSend(store, calls) });
    await openAlphaSend(h);
    await h.type("again");
    await h.press(KEY.ctrlS);
    const p = await h.until((f) => f.includes("Preview"));
    expect(p).toContain("open send: held");
    expect(p).toContain("press o to override");
    await h.press("y");
    expect(calls).toHaveLength(0);
    await h.press("o");
    await h.until((f) => f.includes("override on"));
    await h.press("y");
    await h.until((f) => f.includes("sent: pending"));
    expect(calls).toEqual([{ sessionId: "s-alpha", text: "again", override: true }]);
  });

  test("a refusal is shown as Not sent: <reason>", async () => {
    h = mount({
      store: seeded(),
      send: async () => {
        throw Object.assign(new Error("refused"), {
          reason: "name shared by another live session",
        });
      },
    });
    await openAlphaSend(h);
    await h.type("hi");
    await h.press(KEY.ctrlS);
    await h.until((f) => f.includes("Preview"));
    await h.press("y");
    await h.until((f) => f.includes("Not sent: name shared by another live session"));
  });

  test("a relay refusal code is shown as plain English, wrapped, never as the code", async () => {
    h = mount({
      store: seeded(),
      send: async () => {
        throw new SendRefused("unsafe-name");
      },
    });
    await openAlphaSend(h);
    await h.type("hi");
    await h.press(KEY.ctrlS);
    await h.until((f) => f.includes("Preview"));
    await h.press("y");
    await h.until((f) => f.includes("Not sent: This session's name"));
    const frame = h.frame();
    // Wrapped across lines, all of it in view.
    expect(frame).toContain("Not sent: This session's name has characters Session\n");
    expect(frame).toContain("Hub can't send to safely. Rename it in Claude Code\n");
    expect(frame).toContain("(/rename) and try again.\n");
    expect(frame).not.toContain("unsafe-name");
  });

  test("an ended session cannot be sent to", async () => {
    const calls: SendCall[] = [];
    const store = seeded();
    h = mount({ store, send: recordingSend(store, calls) });
    await h.until((f) => f.includes("delta"));
    await h.press(KEY.down);
    await h.press(KEY.down);
    await h.press("3");
    const f = await h.until((x) => x.includes("Cannot send"));
    expect(f).toContain("ended");
    await h.type("hello");
    await h.press(KEY.ctrlS);
    await h.press("y");
    expect(h.frame()).not.toContain("Preview");
    expect(calls).toHaveLength(0);
  });
});
