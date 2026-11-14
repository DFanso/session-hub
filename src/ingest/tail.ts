import { stat } from "node:fs/promises";

export interface TailState {
  path: string;
  offset: number;
  size: number;
  firstUuid: string | null;
}

const NL = 0x0a;
const HEAD_BYTES = 64 * 1024;
const decoder = new TextDecoder("utf-8");

async function readRange(path: string, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).slice(start, end).arrayBuffer());
}

/** uuid of the first complete JSON line (within the first 64 KB) that has one. */
async function headUuid(path: string, size: number): Promise<string | null> {
  const buf = await readRange(path, 0, Math.min(size, HEAD_BYTES));
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(NL, start);
    if (nl === -1) return null;
    const text = decoder.decode(buf.subarray(start, nl)).trim();
    start = nl + 1;
    if (text === "") continue;
    try {
      const obj: unknown = JSON.parse(text);
      if (obj !== null && typeof obj === "object" && "uuid" in obj) {
        const u = (obj as { uuid: unknown }).uuid;
        if (typeof u === "string") return u;
      }
    } catch {
      // not JSON: keep looking
    }
  }
  return null;
}

export async function initialState(path: string, maxFirstBytes: number): Promise<TailState> {
  const { size } = await stat(path);
  return { path, offset: Math.max(0, size - maxFirstBytes), size, firstUuid: null };
}

/**
 * Reads complete new lines after `state.offset`, at most about `maxBytes` per call (more only to
 * finish a single longer line). After `reset: true` (truncation or replaced file) the result has no
 * lines and offset 0: the caller must call again to read from 0. Replaced-file detection is skipped
 * when no line with a `uuid` exists in the first 64 KB.
 */
export async function readNew(
  state: TailState,
  maxBytes: number,
): Promise<{ lines: string[]; next: TailState; reset: boolean }> {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a finite number >= 1");
  }
  const { path } = state;
  const { size } = await stat(path);
  const resetState = (): TailState => ({ path, offset: 0, size, firstUuid: null });

  if (size < state.offset) return { lines: [], next: resetState(), reset: true };

  const head = await headUuid(path, size);
  if (state.offset > 0 && state.firstUuid !== null && head !== null && head !== state.firstUuid) {
    return { lines: [], next: resetState(), reset: true };
  }
  const firstUuid = head ?? state.firstUuid;

  let pos = state.offset;
  // Offsets we produce always follow a newline. Anything else (initial tail start) is aligned.
  if (pos > 0 && pos < size) {
    const prev = await readRange(path, pos - 1, pos);
    if (prev[0] !== NL) {
      let scan = pos;
      let found = -1;
      while (scan < size) {
        const end = Math.min(scan + maxBytes, size);
        const chunk = await readRange(path, scan, end);
        const i = chunk.indexOf(NL);
        if (i !== -1) {
          found = scan + i + 1;
          break;
        }
        scan = end;
      }
      if (found === -1) {
        // Offset size: the next call sees a non-newline byte before it and drops the rest of the line.
        return { lines: [], next: { path, offset: size, size, firstUuid }, reset: false };
      }
      pos = found;
    }
  }

  const chunks: Uint8Array[] = [];
  let readEnd = pos;
  let lastNl = -1; // index within the concatenated bytes
  let total = 0;
  while (readEnd < size) {
    const end = Math.min(readEnd + maxBytes, size);
    const chunk = await readRange(path, readEnd, end);
    if (chunk.length === 0) break;
    const short = chunk.length < end - readEnd;
    const i = chunk.lastIndexOf(NL);
    chunks.push(chunk);
    if (i !== -1) lastNl = total + i;
    total += chunk.length;
    readEnd += chunk.length;
    if (lastNl !== -1 || short) break;
  }

  if (lastNl === -1) {
    return { lines: [], next: { path, offset: pos, size, firstUuid }, reset: false };
  }

  const joined = chunks.length === 1 ? (chunks[0] as Uint8Array) : Buffer.concat(chunks);
  const text = decoder.decode(joined.subarray(0, lastNl));
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line !== "") lines.push(line);
  }
  return {
    lines,
    next: { path, offset: pos + lastNl + 1, size, firstUuid },
    reset: false,
  };
}
