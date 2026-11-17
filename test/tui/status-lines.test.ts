import { describe, expect, test } from "bun:test";
import type { SessionView } from "../../src/store/db";
import { type HubMeta, statusLines } from "../../src/tui/StatusPane";

const META: HubMeta = { unknownCount: 0, unknownVersion: null, stale: [], relayStrayCount: 0 };
const NOW = Date.parse("2026-11-14T10:10:00.000Z");

function view(): SessionView {
  return {
    sessionId: "s1",
    profile: "claude",
    name: "alpha",
    cwd: "C:/x",
    pid: 1,
    kind: "interactive",
    state: "idle",
    startedAt: 0,
    updatedAt: 0,
    endedAt: null,
    transcriptPath: "C:/x/s1.jsonl",
    permissionMode: null,
    latestReply: null,
    waitingCount: 1,
    status: {
      progressPct: null,
      phase: null,
      remaining: [],
      waiting: [
        { id: "Q1", text: "open one", isNew: false, children: [], answered: false },
        { id: "Q2", text: "done one", isNew: true, children: ["detail"], answered: true },
      ],
      recommendations: [],
      replyUuid: "r1",
      replyTs: "2026-11-14T10:00:00.000Z",
    },
  };
}

describe("statusLines", () => {
  test("an answered item is left out, an open one is shown", () => {
    const lines = statusLines(view(), META, NOW, 120);
    const open = lines.find((l) => l.text.includes("open one"));
    expect(open?.text).toBe("Q1 open one");
    expect(open?.dim).toBeUndefined();
    expect(lines.some((l) => l.text.includes("done one") || l.text.includes("detail"))).toBe(false);
  });

  test("when every item is answered the list says nothing", () => {
    const v = view();
    const st = v.status as NonNullable<typeof v.status>;
    v.status = { ...st, waiting: st.waiting.map((w) => ({ ...w, answered: true })) };
    const lines = statusLines(v, META, NOW, 120);
    const at = lines.findIndex((l) => l.text === "Waiting on you");
    expect(lines[at + 1]?.text).toBe("nothing");
    expect(lines[at + 1]?.dim).toBe(true);
  });

  test("relay messages that reached the wrong session are flagged", () => {
    expect(statusLines(view(), META, NOW, 120).some((l) => l.text.includes("wrong session"))).toBe(
      false,
    );
    const warn = statusLines(view(), { ...META, relayStrayCount: 2 }, NOW, 120).find((l) =>
      l.text.includes("wrong session"),
    );
    expect(warn?.text).toBe("relay: 2 messages reached the wrong session (see run\\relay.log)");
    expect(warn?.color).toBe("red");
  });
});
