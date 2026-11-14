import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_LINE_BYTES } from "../../src/bridge/protocol";
import { REFUSE_REASONS } from "../../src/send/refusals";
import { FIXTURE_DIR, generateFixtures } from "./make-fixtures";

describe("protocol fixtures for the .NET tests", () => {
  test("committed files equal what make-fixtures.ts produces now", async () => {
    const files = await generateFixtures();
    expect(readdirSync(FIXTURE_DIR).sort()).toEqual(Object.keys(files).sort());
    for (const [name, text] of Object.entries(files)) {
      expect(readFileSync(join(FIXTURE_DIR, name), "utf8").replace(/\r\n/g, "\n")).toBe(text);
    }
  });

  test("every line is one JSON object within the line limit", async () => {
    const files = await generateFixtures();
    for (const text of Object.values(files)) {
      const lines = text.split("\n").slice(0, -1);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
        const v = JSON.parse(line) as unknown;
        expect(typeof v === "object" && v !== null && !Array.isArray(v)).toBe(true);
      }
    }
  });

  test("the fixtures cover every event, reply outcome and send state the tray handles", async () => {
    const files = await generateFixtures();
    const parse = (name: string) =>
      (files[name] ?? "")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parse("snapshot.ndjson")).toHaveLength(2);
    expect(files["snapshot.ndjson"]).not.toContain("transcriptPath");
    expect(parse("heartbeat.ndjson")).toEqual([{ type: "heartbeat", seq: 1 }]);
    const states = parse("send-events.ndjson").map((e) => (e.send as { state: string }).state);
    expect(states).toEqual(["held", "delivered", "failed"]);
    const codes = parse("replies.ndjson")
      .filter((r) => r.ok === false)
      .map((r) => (r.error as { code: string }).code);
    expect(codes).toEqual(["send-in-flight", "empty-message"]);
    expect(parse("errors.ndjson").map((e) => e.code)).toEqual(["bad-json", "unknown-type"]);
    const pages = parse("replies.ndjson")
      .filter((r) => r.ok === true && "messages" in (r.result as object))
      .map((r) => r.result as { messages: { textTruncated?: boolean }[]; more: boolean });
    expect(pages.map((p) => p.more)).toEqual([false, false, true, false, false]);
    expect(pages.at(-2)?.messages[0]?.textTruncated).toBe(true);
    // The (beforeTs, beforeUuid) page: the same rows as the beforeTs page (no tie in the fixture).
    expect(pages.at(-1)?.messages).toEqual(pages[1]?.messages);
    expect(parse("refusals.ndjson").map((r) => r.code)).toEqual([...REFUSE_REASONS]);
    expect(files["snapshot.ndjson"]).not.toContain("hunter22");
    expect(files["replies.ndjson"]).not.toContain("hunter22");
    expect(files["replies.ndjson"]).not.toContain("\\u001b");
  });
});
