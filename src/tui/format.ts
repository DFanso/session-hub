import type { MessageRow, SessionView } from "../store/db";
import { cleanText } from "./sanitize";

/** Short age: 45s, 4m, 3h, 2d. Negative input (clock skew) reads as 0s. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Local HH:MM of an ISO timestamp or epoch ms; "??:??" when unparseable. */
export function hhmm(ts: string | number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "??:??";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Name, or the first 8 characters of the sessionId. Both are cleaned here: the snapshot cleans
 * names but keeps sessionId raw, because it is the key for selection and send.
 */
export function sessionLabel(s: Pick<SessionView, "name" | "sessionId">): string {
  return s.name !== "" ? cleanText(s.name) : cleanText(s.sessionId).slice(0, 8);
}

export function stateLabel(s: Pick<SessionView, "state" | "endedAt">): string {
  if (s.endedAt !== null) return "ended";
  if (s.state === "waiting") return "needs you";
  return s.state;
}

export function profileHeader(profile: string): string {
  return `.${profile}`;
}

export function roleLabel(m: Pick<MessageRow, "role" | "fromName">): string {
  if (m.role === "owner") return "you";
  if (m.role === "peer") return `peer:${m.fromName ?? "?"}`;
  return "claude";
}

/**
 * Hard-wraps text to `width` columns (by code point), on spaces where possible.
 * Every output line, after the first of each paragraph, gets `indent`.
 */
export function wrap(text: string, width: number, indent = ""): string[] {
  const w = Math.max(4, width);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    let first = true;
    const push = () => {
      out.push(line);
      line = indent;
      first = false;
    };
    const room = () => w - [...line].length;
    if (para === "") {
      out.push("");
      continue;
    }
    for (const word of para.split(" ")) {
      let rest = [...word];
      const sep = line === "" || line === indent ? "" : " ";
      if (sep.length + rest.length <= room()) {
        line += sep + word;
        continue;
      }
      if (line !== "" && line !== indent) push();
      while (rest.length > room()) {
        const n = Math.max(1, room());
        line += rest.slice(0, n).join("");
        rest = rest.slice(n);
        push();
      }
      line += rest.join("");
    }
    if (first || (line !== "" && line !== indent)) out.push(line);
  }
  return out;
}
