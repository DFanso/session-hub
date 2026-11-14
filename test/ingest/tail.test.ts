import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState, readNew, type TailState } from "../../src/ingest/tail";

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tail-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(content: string | Uint8Array): string {
  const p = join(dir, `f${n++}.jsonl`);
  writeFileSync(p, content);
  return p;
}
const fresh = (path: string): TailState => ({ path, offset: 0, size: 0, firstUuid: null });

describe("readNew", () => {
  test("returns only complete lines", async () => {
    const p = file('{"uuid":"a"}\n{"uuid":"b"}\n{"uuid":"c"');
    const r = await readNew(fresh(p), 1024);
    expect(r.lines).toEqual(['{"uuid":"a"}', '{"uuid":"b"}']);
    expect(r.reset).toBe(false);
    expect(r.next.firstUuid).toBe("a");
  });

  test("keeps partial line for next read", async () => {
    const p = file('{"uuid":"a"}\n{"uuid":"b"');
    const r1 = await readNew(fresh(p), 1024);
    expect(r1.lines).toEqual(['{"uuid":"a"}']);
    appendFileSync(p, '}\n{"uuid":"c"}\n');
    const r2 = await readNew(r1.next, 1024);
    expect(r2.lines).toEqual(['{"uuid":"b"}', '{"uuid":"c"}']);
    expect(r2.reset).toBe(false);
    const r3 = await readNew(r2.next, 1024);
    expect(r3.lines).toEqual([]);
    expect(r3.next.offset).toBe(r2.next.offset);
  });

  test("detects truncation and resets", async () => {
    const p = file('{"uuid":"a"}\n{"uuid":"b"}\n');
    const r1 = await readNew(fresh(p), 1024);
    writeFileSync(p, '{"uuid":"a"}\n');
    const r2 = await readNew(r1.next, 1024);
    expect(r2.reset).toBe(true);
    expect(r2.next.offset).toBe(0);
    const r3 = await readNew(r2.next, 1024);
    expect(r3.lines).toEqual(['{"uuid":"a"}']);
    expect(r3.reset).toBe(false);
  });

  test("detects replaced file by firstUuid", async () => {
    const p = file('{"uuid":"a"}\n{"uuid":"b"}\n');
    const r1 = await readNew(fresh(p), 1024);
    writeFileSync(p, '{"uuid":"x"}\n{"uuid":"y"}\n{"uuid":"z"}\n');
    const r2 = await readNew(r1.next, 1024);
    expect(r2.reset).toBe(true);
    expect(r2.next.offset).toBe(0);
    expect(r2.next.firstUuid).toBeNull();
  });

  test("skips leading lines without uuid when finding firstUuid", async () => {
    const p = file('{"type":"x"}\nnot json\n{"uuid":"q"}\n');
    const r = await readNew(fresh(p), 1024);
    expect(r.next.firstUuid).toBe("q");
    expect(r.lines.length).toBe(3);
  });

  test("starts at last N bytes on a large file and aligns to newline", async () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `{"uuid":"u${i}","pad":"${"x".repeat(40)}"}`,
    );
    const p = file(`${lines.join("\n")}\n`);
    const st = await initialState(p, 1000);
    expect(st.offset).toBeGreaterThan(0);
    const r = await readNew(st, 4096);
    expect(r.reset).toBe(false);
    expect(r.lines.length).toBeGreaterThan(5);
    expect(r.lines.length).toBeLessThan(200);
    for (const l of r.lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(r.lines.at(-1)).toBe(lines[199]);
    expect(r.next.firstUuid).toBe("u0");
  });

  test("initialState offset is 0 for small file", async () => {
    const p = file('{"uuid":"a"}\n');
    expect((await initialState(p, 1000)).offset).toBe(0);
  });

  test("handles CRLF and UTF-8 split across chunk boundary", async () => {
    const p = file('{"uuid":"a","t":"héllo €😀"}\r\n\r\n{"uuid":"b","t":"ü"}\r\n');
    const all = await readNew(fresh(p), 4096);
    expect(all.lines).toEqual(['{"uuid":"a","t":"héllo €😀"}', '{"uuid":"b","t":"ü"}']);
    for (const max of [1, 2, 3, 5, 7]) {
      let st = fresh(p);
      const got: string[] = [];
      for (let i = 0; i < 500; i++) {
        const r = await readNew(st, max);
        got.push(...r.lines);
        if (r.next.offset === r.next.size) break;
        st = r.next;
      }
      expect(got).toEqual(all.lines);
    }
  });

  test("single line longer than maxBytes is returned once", async () => {
    const big = `{"uuid":"a","p":"${"y".repeat(10 * 1024 * 1024)}"}`;
    const p = file(`${big}\n{"uuid":"b"}\n`);
    const r1 = await readNew(fresh(p), 1024 * 1024);
    expect(r1.lines[0]).toBe(big);
    const r2 = await readNew(r1.next, 1024 * 1024);
    expect([...r1.lines, ...r2.lines]).toEqual([big, '{"uuid":"b"}']);
  });

  test("rejects invalid maxBytes", async () => {
    const p = file('{"uuid":"a"}\n');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(readNew(fresh(p), bad)).rejects.toThrow(RangeError);
    }
  });

  test("unaligned start with no newline yet drops only the rest of that line", async () => {
    const p = file('{"uuid":"a","pad":"0123456789"}\npartial-no-newline');
    const st = await initialState(p, 10);
    const r1 = await readNew(st, 4);
    expect(r1.lines).toEqual([]);
    expect(r1.next.offset).toBe(r1.next.size);
    appendFileSync(p, "rest\nnext\n");
    const r2 = await readNew(r1.next, 4);
    expect(r2.lines).toEqual(["next"]);
  });

  test("replaced-file detection is skipped when no uuid in the head", async () => {
    const p = file('{"type":"x"}\n{"type":"y"}\n');
    const r1 = await readNew(fresh(p), 1024);
    expect(r1.next.firstUuid).toBeNull();
    writeFileSync(p, '{"type":"p"}\n{"type":"q"}\n{"type":"r"}\n');
    const r2 = await readNew(r1.next, 1024);
    expect(r2.reset).toBe(false);
    expect(r2.lines).toEqual(['{"type":"r"}']);
  });

  test("offset exactly at a line start drops no line", async () => {
    const first = '{"uuid":"a"}\n';
    const p = file(`${first}{"uuid":"b"}\n{"uuid":"c"}\n`);
    const r = await readNew({ path: p, offset: first.length, size: 0, firstUuid: "a" }, 1024);
    expect(r.lines).toEqual(['{"uuid":"b"}', '{"uuid":"c"}']);
  });

  test("300 MB file read keeps RSS growth under 64 MB", async () => {
    const p = join(dir, "huge.jsonl");
    const line = `${JSON.stringify({ uuid: "u", pad: "z".repeat(1000) })}\n`;
    const block = Buffer.from(line.repeat(1000));
    const fd = openSync(p, "w");
    const count = Math.ceil((300 * 1024 * 1024) / block.length);
    for (let i = 0; i < count; i++) writeSync(fd, block);
    closeSync(fd);
    try {
      // Measures retention (forced GC each loop), not the transient peak of one 8 MB chunk.
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      let peak = before;
      let st = fresh(p);
      let total = 0;
      for (let i = 0; i < 1000; i++) {
        const r = await readNew(st, 8 * 1024 * 1024);
        total += r.lines.length;
        Bun.gc(true);
        peak = Math.max(peak, process.memoryUsage().rss);
        if (r.next.offset >= r.next.size) break;
        st = r.next;
      }
      expect(total).toBe(count * 1000);
      expect(peak - before).toBeLessThan(64 * 1024 * 1024);
    } finally {
      rmSync(p, { force: true });
    }
  }, 120_000);
});
