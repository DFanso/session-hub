export interface WaitingItem {
  id: string | null;
  text: string;
  isNew: boolean;
  children: string[];
}

export interface Status {
  progressPct: number | null;
  phase: string | null;
  remaining: string[];
  waiting: WaitingItem[];
  recommendations: string[];
}

const PROGRESS_RE =
  /^\s*\*{0,2}Progress:\s*(?:about\s+)?(\d{1,3}(?:\.\d+)?)%\s+overall\.\s+Phase:\s*(.+?)\.?(?:\*\*|\s*$)/i;
const REMAINING_HASH = /^\s{0,3}#{2,4}\s*\**what['\u2019]s remaining:?\**:?\s*#*\s*$/i;
const WAITING_HASH = /^\s{0,3}#{2,4}\s*\**waiting on you:?\**:?\s*#*\s*$/i;
const REMAINING_BOLD = /^\s*\*\*what['\u2019]s remaining:?\*\*:?\s*(.*)$/i;
const WAITING_BOLD = /^\s*\*\*waiting on you:?\*\*:?\s*(.*)$/i;
const ANY_HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const THEMATIC_BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW = /^\s*\|/;
const BULLET_RE = /^(\s*)(?:\d+[.)]|[-*\u2022])\s+(.*)$/;
const NEW_RE = /^(\*{0,2})New:(\*{0,2})\s*/i;
/**
 * A question ID: segments of an upper-case letter and up to 7 upper-case letters or digits,
 * joined by single "-", ending in a digit (Q14, AUTH-Q1, AB2-Q3), followed by ":", whitespace,
 * ",", a dash or the end. At most MAX_ID_CHARS long.
 */
const ID_RE = /^((?:[A-Z][A-Z0-9]{0,7}-)*[A-Z][A-Z0-9]{0,6}\d)(?=[:\s,\u2013\u2014-]|$)/;
const MAX_ID_CHARS = 24;
const RANGE_RE = /^[\u2013\u2014-]\s*[A-Z][A-Z0-9]{0,7}(?:-[A-Z][A-Z0-9]{0,7})*\d/;
const RECOMMEND_RE = /recommend|my pick|\(recommended\)/i;
const MAX_RECOMMENDATIONS = 5;

type Kind = "remaining" | "waiting";

interface Heading {
  kind: Kind;
  rest: string;
}

function stripMarkdown(s: string): string {
  const codes: string[] = [];
  const mark = "";
  const holder = /\uE000(\d+)\uE000/g;
  const masked = s.replace(/`([^`\n]*)`/g, (_m, code: string) => {
    codes.push(code);
    return `${mark}${codes.length - 1}${mark}`;
  });
  return masked
    .replace(/\*{1,3}(?=\S)([^*\n]*?\S)\*{1,3}/g, "$1")
    .replace(/(^|\W)(_{1,2})(?=\S)([^_\n]*?\S)\2(?!\w)/g, "$1$3")
    .replace(/\s+/g, " ")
    .trim()
    .replace(holder, (_m, i: string) => codes[Number(i)] ?? "");
}

function matchHeading(line: string): Heading | null {
  if (REMAINING_HASH.test(line)) return { kind: "remaining", rest: "" };
  if (WAITING_HASH.test(line)) return { kind: "waiting", rest: "" };
  const r = REMAINING_BOLD.exec(line);
  if (r) return { kind: "remaining", rest: (r[1] ?? "").trim() };
  const w = WAITING_BOLD.exec(line);
  if (w) return { kind: "waiting", rest: (w[1] ?? "").trim() };
  return null;
}

/** Lines outside ``` fences. */
function unfenced(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

interface RawItem {
  text: string;
  children: string[];
}

function indentOf(ws: string): number {
  return ws.replace(/\t/g, "    ").length;
}

function parseItems(lines: string[]): RawItem[] {
  const items: RawItem[] = [];
  const hasBullets = lines.some((l) => BULLET_RE.test(l));
  let topIndent: number | null = null;
  let lastIsChild = false;
  let lastIndent = 0;
  let blankSeen = false;
  for (const line of lines) {
    if (line.trim() === "") {
      blankSeen = true;
      continue;
    }
    const m = BULLET_RE.exec(line);
    if (m) {
      const indent = indentOf(m[1] ?? "");
      const body = (m[2] ?? "").trim();
      if (topIndent === null) topIndent = indent;
      const last = items[items.length - 1];
      if (indent <= topIndent || !last) {
        items.push({ text: body, children: [] });
        lastIsChild = false;
      } else {
        last.children.push(body);
        lastIsChild = true;
      }
      lastIndent = indent;
      blankSeen = false;
      continue;
    }
    const last = items[items.length - 1];
    const indent = indentOf(/^\s*/.exec(line)?.[0] ?? "");
    if (!last) {
      if (hasBullets) continue;
      items.push({ text: line.trim(), children: [] });
      lastIsChild = false;
      lastIndent = indent;
      blankSeen = false;
      continue;
    }
    if (blankSeen && indent <= lastIndent) break;
    blankSeen = false;
    if (lastIsChild && last.children.length > 0) {
      const i = last.children.length - 1;
      last.children[i] = `${last.children[i]} ${line.trim()}`;
    } else {
      last.text = `${last.text} ${line.trim()}`;
    }
  }
  if (items.length === 1) {
    const only = items[0];
    if (only && only.children.length === 0 && /^nothing\.?$/i.test(stripMarkdown(only.text)))
      return [];
  }
  return items;
}

const stem = (id: string): string => id.replace(/\d+$/, "");
/** Same stem, or the second's stem is the first's last segments ("AUTH-Q1-Q3": Q is the tail of AUTH-Q). */
const sameStem = (first: string, second: string): boolean =>
  stem(first) === stem(second) || stem(first).endsWith(`-${stem(second)}`);
const num = (id: string): number => Number(/\d+$/.exec(id)?.[0] ?? Number.NaN);

/**
 * The ID at the start of the text, or null. "Q1-Q3", "AUTH-Q1-AUTH-Q3" and "AUTH-Q1-Q3" are
 * ranges (the second ID has the first one's stem or its tail, and a higher number): the ID is the
 * first one. "AB2-Q3" is one ID.
 */
function idAt(text: string): string | null {
  const id = ID_RE.exec(text)?.[1];
  if (id === undefined || id.length > MAX_ID_CHARS) return null;
  for (let i = id.indexOf("-"); i !== -1; i = id.indexOf("-", i + 1)) {
    const first = id.slice(0, i);
    const second = id.slice(i + 1);
    if (/\d$/.test(first) && sameStem(first, second) && num(second) > num(first)) {
      return first;
    }
  }
  return id;
}

function toWaiting(raw: RawItem): WaitingItem {
  let text = raw.text;
  const nm = NEW_RE.exec(text);
  const isNew = nm !== null;
  if (nm) {
    // "**New: SH9** foo": the opening ** has no closing one in the prefix, keep it for the body.
    const reopen = nm[1] !== "" && nm[2] === "" ? nm[1] : "";
    text = reopen + text.slice(nm[0].length);
  }
  const children = raw.children.map(stripMarkdown);
  const full = stripMarkdown(text);
  // An item that opens with a code span is quoted code, never an ID.
  if (/^[*_\s]*`/.test(text)) return { id: null, text: full, isNew, children };
  const id = idAt(full);
  if (id === null) return { id: null, text: full, isNew, children };
  const rest = full.slice(id.length);
  if (RANGE_RE.test(rest)) return { id, text: full, isNew, children };
  const body = rest
    .replace(/^\s*:\s*/, "")
    .replace(/^\s*[,\u2013\u2014-]\s+(?=\S)/, "")
    .replace(/^\s+/, "");
  return { id, text: body === "" ? full : body, isNew, children };
}

function toRemaining(raw: RawItem): string {
  const head = stripMarkdown(raw.text);
  const kids = raw.children.map(stripMarkdown).filter((c) => c !== "");
  if (kids.length === 0) return head;
  const sep = head.endsWith(":") ? " " : ": ";
  return `${head}${sep}${kids.join("; ")}`;
}

/** The last section of this kind that has items; empty when none do. */
function pickItems(sections: string[][] | undefined): RawItem[] {
  let picked: RawItem[] = [];
  for (const lines of sections ?? []) {
    const items = parseItems(lines);
    if (items.length > 0) picked = items;
  }
  return picked;
}

export function extractStatus(markdown: string): Status | null {
  const lines = unfenced(markdown);

  let progressPct: number | null = null;
  let phase: string | null = null;
  for (const line of lines) {
    const m = PROGRESS_RE.exec(line);
    if (m?.[1] && m[2]) {
      progressPct = Math.min(100, Math.max(0, Math.round(Number(m[1]))));
      phase = stripMarkdown(m[2]);
      break;
    }
  }

  const sections: Record<Kind, string[][]> = { remaining: [], waiting: [] };
  let current: string[] | null = null;
  for (const line of lines) {
    const heading = matchHeading(line);
    if (heading) {
      current = [];
      sections[heading.kind].push(current);
      if (heading.rest !== "") current.push(`- ${heading.rest}`);
      continue;
    }
    if (ANY_HEADING.test(line) || THEMATIC_BREAK.test(line) || TABLE_ROW.test(line)) {
      current = null;
      continue;
    }
    current?.push(line);
  }

  const hasSection = sections.remaining.length > 0 || sections.waiting.length > 0;
  if (progressPct === null && !hasSection) return null;

  const recommendations: string[] = [];
  for (const line of lines) {
    if (!RECOMMEND_RE.test(line)) continue;
    const text = stripMarkdown(line.replace(/^\s*(?:\d+[.)]|[-*\u2022]|#{1,6})\s+/, ""));
    if (text && !recommendations.includes(text)) recommendations.push(text);
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;
  }

  return {
    progressPct,
    phase,
    remaining: pickItems(sections.remaining).map(toRemaining),
    waiting: pickItems(sections.waiting).map(toWaiting),
    recommendations,
  };
}
