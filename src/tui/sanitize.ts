// Terminal-safe text. Everything the TUI prints from the store (transcript text, peer names,
// session names, cwd, status items) and everything typed or pasted into the Send pane passes
// through here, so no stored or pasted byte can move the cursor, set the window title, write the
// clipboard (OSC 52) or draw a fake "Preview" / "y send" line.

/* biome-ignore-start lint/suspicious/noControlCharactersInRegex: these patterns match control characters on purpose */
// OSC plus the other string controls (DCS, SOS, PM, APC), ended by BEL or ST.
const STRING_SEQ = /\u001B[\]PX^_][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
// Any other ESC-introduced pair, or a lone ESC at the end.
const OTHER_ESC = /\u001B[\s\S]?/g;
const C0_EXCEPT_NL = /[\u0000-\u0009\u000B-\u001F\u007F]/g;
const C1 = /[\u0080-\u009F]/g;
/* biome-ignore-end lint/suspicious/noControlCharactersInRegex: end */
// Bidi embeddings, overrides and isolates can reorder what a line appears to say.
const BIDI = /[‪-‮⁦-⁩]/g;
// What Ink leaves of an unrecognised escape sequence after it drops the ESC: "[200~", "[31m".
const CSI_TAIL = /^\[[0-?]+[ -/]*[@-~]$/;

/** Strips terminal control sequences and control characters; keeps `\n`, maps `\t` to two spaces. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(STRING_SEQ, "")
    .replace(CSI, "")
    .replace(OTHER_ESC, "")
    .replace(/\t/g, "  ")
    .replace(C0_EXCEPT_NL, "")
    .replace(C1, "")
    .replace(BIDI, "");
}

/**
 * One typed or pasted chunk for a text input. `meta` is Ink's flag for ESC-prefixed input
 * (Alt+key and unrecognised escape tails); those never become text. A lone or CRLF line break
 * inside a pasted chunk becomes `\n`.
 */
export function cleanInput(chunk: string, meta = false): string {
  if (meta || CSI_TAIL.test(chunk)) return "";
  return cleanText(chunk.replace(/\r\n?/g, "\n"));
}
