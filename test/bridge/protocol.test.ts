import { describe, expect, test } from "bun:test";
import {
  encode,
  HEARTBEAT_MS,
  MAX_LINE_BYTES,
  MIN_EMIT_GAP_MS,
  POLL_MS,
  parseRequest,
  readLines,
} from "../../src/bridge/protocol";

async function collect(chunks: (string | Uint8Array)[]): Promise<string[]> {
  const enc = new TextEncoder();
  async function* source() {
    for (const c of chunks) yield typeof c === "string" ? enc.encode(c) : c;
  }
  const out: string[] = [];
  for await (const line of readLines(source())) out.push(line);
  return out;
}

describe("constants", () => {
  test("values from the plan", () => {
    expect(MAX_LINE_BYTES).toBe(1_048_576);
    expect(POLL_MS).toBe(500); // 250 in the plan; raised for idle CPU (controller ruling B)
    expect(MIN_EMIT_GAP_MS).toBe(250);
    expect(HEARTBEAT_MS).toBe(15_000);
  });
});

describe("parseRequest", () => {
  test("valid requests parse", () => {
    expect(parseRequest('{"id":1,"type":"history","sessionId":"s1","limit":50}')).toEqual({
      id: 1,
      type: "history",
      sessionId: "s1",
      limit: 50,
    });
    expect(
      parseRequest(
        '{"id":2,"type":"history","sessionId":"s1","limit":50,"beforeTs":"2026-11-13T00:00:00Z"}',
      ),
    ).toEqual({
      id: 2,
      type: "history",
      sessionId: "s1",
      limit: 50,
      beforeTs: "2026-11-13T00:00:00Z",
    });
    expect(
      parseRequest(
        '{"id":4,"type":"history","sessionId":"s1","limit":5,"beforeTs":"2026-11-13T00:00:00Z","beforeUuid":"u9"}',
      ),
    ).toEqual({
      id: 4,
      type: "history",
      sessionId: "s1",
      limit: 5,
      beforeTs: "2026-11-13T00:00:00Z",
      beforeUuid: "u9",
    });
    expect(parseRequest('{"id":3,"type":"search","q":"deploy","limit":20}')).toEqual({
      id: 3,
      type: "search",
      q: "deploy",
      limit: 20,
    });
    expect(parseRequest('{"id":4,"type":"send","sessionId":"s1","text":"hi\\nthere"}')).toEqual({
      id: 4,
      type: "send",
      sessionId: "s1",
      text: "hi\nthere",
    });
    expect(
      parseRequest('{"id":5,"type":"send","sessionId":"s1","text":"x","override":true}'),
    ).toEqual({ id: 5, type: "send", sessionId: "s1", text: "x", override: true });
    expect(
      parseRequest('{"id":5,"type":"send","sessionId":"s1","text":"x","allowSecret":true}'),
    ).toEqual({ id: 5, type: "send", sessionId: "s1", text: "x", allowSecret: true });
    expect(parseRequest('{"id":6,"type":"startDaemon"}')).toEqual({ id: 6, type: "startDaemon" });
    expect(parseRequest('{"id":0,"type":"ping"}')).toEqual({ id: 0, type: "ping" });
    expect(parseRequest('{"type":"shutdown"}')).toEqual({ type: "shutdown" });
  });

  test("a limit above the cap is lowered to it", () => {
    expect(parseRequest('{"id":1,"type":"search","q":"a","limit":99999}')).toEqual({
      id: 1,
      type: "search",
      q: "a",
      limit: 500,
    });
  });

  test("unknown type", () => {
    expect(parseRequest('{"type":"focus","sessionId":"s1"}')).toEqual({ error: "unknown-type" });
    expect(parseRequest('{"id":9,"type":"focus","sessionId":"s1"}')).toEqual({
      error: "unknown-type",
      id: 9,
    });
    expect(parseRequest('{"id":9}')).toEqual({ error: "unknown-type", id: 9 });
  });

  test("non-JSON and non-object JSON", () => {
    expect(parseRequest("{nope")).toEqual({ error: "bad-json" });
    expect(parseRequest("[1,2]")).toEqual({ error: "bad-json" });
    expect(parseRequest("null")).toEqual({ error: "bad-json" });
    expect(parseRequest('"ping"')).toEqual({ error: "bad-json" });
  });

  test("a line over 1 MiB is too long; exactly 1 MiB is not", () => {
    const pad = (n: number) => `{"type":"shutdown","pad":"${"x".repeat(n - 28)}"}`;
    const ok = pad(MAX_LINE_BYTES);
    expect(Buffer.byteLength(ok)).toBe(MAX_LINE_BYTES);
    expect(parseRequest(ok)).toEqual({ type: "shutdown" });
    const long = pad(MAX_LINE_BYTES + 1);
    expect(Buffer.byteLength(long)).toBe(1_048_577);
    expect(parseRequest(long)).toEqual({ error: "too-long" });
  });

  test("bytes, not characters, count toward the limit", () => {
    const emoji = "😀".repeat(MAX_LINE_BYTES / 4); // 4 bytes each: the line is over 1 MiB
    expect(parseRequest(`{"type":"shutdown","p":"${emoji}"}`)).toEqual({ error: "too-long" });
  });

  test("missing id on a request that needs one", () => {
    for (const line of [
      '{"type":"ping"}',
      '{"type":"startDaemon"}',
      '{"type":"history","sessionId":"s1","limit":5}',
      '{"type":"search","q":"a","limit":5}',
      '{"type":"send","sessionId":"s1","text":"x"}',
    ]) {
      expect(parseRequest(line)).toEqual({ error: "bad-request" });
    }
  });

  test("wrong field types are bad requests and keep the id", () => {
    for (const line of [
      '{"id":"1","type":"ping"}',
      '{"id":-1,"type":"ping"}',
      '{"id":1.5,"type":"ping"}',
      '{"id":7,"type":"history","sessionId":1,"limit":5}',
      '{"id":7,"type":"history","sessionId":"s","limit":0}',
      '{"id":7,"type":"history","sessionId":"s","limit":2.5}',
      '{"id":7,"type":"history","sessionId":"s","limit":5,"beforeTs":5}',
      '{"id":7,"type":"history","sessionId":"s","limit":5,"beforeTs":"t","beforeUuid":5}',
      '{"id":7,"type":"history","sessionId":"s","limit":5,"beforeUuid":"u"}',
      '{"id":7,"type":"search","limit":5}',
      '{"id":7,"type":"send","sessionId":"s","text":null}',
      '{"id":7,"type":"send","sessionId":"s","text":"x","override":"yes"}',
      '{"id":7,"type":"send","sessionId":"s","text":"x","allowSecret":1}',
    ]) {
      const r = parseRequest(line);
      expect(r).toHaveProperty("error", "bad-request");
    }
    expect(parseRequest('{"id":7,"type":"search","limit":5}')).toEqual({
      error: "bad-request",
      id: 7,
    });
  });
});

describe("encode", () => {
  test("never puts a raw line break inside a string; text round-trips", () => {
    const text = 'line one\nline two\r\n"quoted"  tab\t end 😀 ‮rtl';
    const line = encode({
      type: "send",
      send: { id: 1, sessionId: "s\n1", state: "pending", detail: text },
    });
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    const back = JSON.parse(line) as { send: { detail: string; sessionId: string } };
    expect(back.send.detail).toBe(text);
    expect(back.send.sessionId).toBe("s\n1");
  });
});

describe("readLines", () => {
  test("splits on LF, drops a trailing CR, joins chunks, keeps a final unterminated line", async () => {
    expect(await collect(['{"a":1}\r\n{"b"', ':2}\n\n{"c":3}'])).toEqual([
      '{"a":1}',
      '{"b":2}',
      "",
      '{"c":3}',
    ]);
  });

  test("multi-byte characters split across chunks decode intact", async () => {
    const bytes = new TextEncoder().encode("é😀\n");
    expect(await collect([bytes.slice(0, 1), bytes.slice(1, 3), bytes.slice(3)])).toEqual(["é😀"]);
  });

  test("an oversized line is cut so it parses as too-long, and the next line survives", async () => {
    const huge = "x".repeat(2 * MAX_LINE_BYTES);
    const lines = await collect([
      huge.slice(0, MAX_LINE_BYTES),
      huge.slice(MAX_LINE_BYTES),
      "\n",
      '{"type":"shutdown"}\n',
    ]);
    expect(lines).toHaveLength(2);
    expect(Buffer.byteLength(lines[0] as string)).toBeGreaterThan(MAX_LINE_BYTES);
    expect(Buffer.byteLength(lines[0] as string)).toBeLessThan(MAX_LINE_BYTES + 8);
    expect(parseRequest(lines[0] as string)).toEqual({ error: "too-long" });
    expect(lines[1]).toBe('{"type":"shutdown"}');
  });
});
