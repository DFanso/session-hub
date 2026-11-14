import { describe, expect, test } from "bun:test";
import { cleanInput, cleanText } from "../../src/tui/sanitize";

const ESC = "\u001B";
const BEL = "\u0007";

describe("cleanText", () => {
  test("strips OSC 52 clipboard, title and hyperlink sequences (BEL and ST forms)", () => {
    expect(cleanText(`a${ESC}]52;c;ZXZpbA==${BEL}b`)).toBe("ab");
    expect(cleanText(`a${ESC}]0;fake title${ESC}\\b`)).toBe("ab");
    expect(cleanText(`${ESC}]8;;http://x${BEL}link${ESC}]8;;${BEL}`)).toBe("link");
    expect(cleanText(`a${ESC}P1$r${ESC}\\b`)).toBe("ab");
  });

  test("strips CSI cursor moves, colours and erase", () => {
    expect(cleanText(`${ESC}[2J${ESC}[1;1H${ESC}[31mred${ESC}[0m ${ESC}[?25l`)).toBe("red ");
  });

  test("strips other ESC pairs, a trailing ESC, C1 and C0 controls; keeps newlines", () => {
    expect(cleanText(`a${ESC}7b${ESC}c${ESC}`)).toBe("ab");
    expect(cleanText("a\u009B31mb\u0085c")).toBe("a31mbc");
    expect(cleanText("a\u0000b\u0008c\u007Fd\ne")).toBe("abcd\ne");
  });

  test("tab becomes two spaces; CRLF becomes LF; a lone CR is dropped", () => {
    expect(cleanText("a\tb\r\nc\rd")).toBe("a  b\ncd");
  });

  test("drops bidi overrides", () => {
    expect(cleanText("abc\u202Edef\u2066g")).toBe("abcdefg");
  });

  test("plain text is unchanged and cleaning is idempotent", () => {
    const s = "Q15 NEW: pick [x] region, 100% (C:\\work)";
    expect(cleanText(s)).toBe(s);
    const dirty = `x${ESC}]52;c;AA${BEL}${ESC}[1Ay\tz`;
    expect(cleanText(cleanText(dirty))).toBe(cleanText(dirty));
  });
});

describe("cleanInput", () => {
  test("drops ESC-prefixed input and escape tails Ink leaves behind", () => {
    expect(cleanInput("]", true)).toBe("");
    expect(cleanInput("[200~")).toBe("");
    expect(cleanInput("[201~")).toBe("");
    expect(cleanInput("[31m")).toBe("");
    expect(cleanInput("[1;5C")).toBe("");
  });

  test("keeps ordinary text, including bracket text with no parameters", () => {
    expect(cleanInput("[x")).toBe("[x");
    expect(cleanInput("hello")).toBe("hello");
  });

  test("line breaks inside a pasted chunk become LF; controls go", () => {
    expect(cleanInput("a\rb\r\nc\u0013d")).toBe("a\nb\ncd");
  });
});
