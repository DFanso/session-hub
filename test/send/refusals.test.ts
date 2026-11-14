import { describe, expect, test } from "bun:test";
import { isRefuseReason, REFUSE_REASONS, refusalText } from "../../src/send/refusals.ts";

describe("refusal texts", () => {
  test("every reason has a plain-English sentence that never shows the code", () => {
    expect([...REFUSE_REASONS].sort() as string[]).toEqual(
      [
        "duplicate-name",
        "empty-message",
        "looks-secret",
        "rate-limited",
        "send-in-flight",
        "session-not-live",
        "too-long",
        "unknown-session",
        "unsafe-name",
      ].sort(),
    );
    for (const reason of REFUSE_REASONS) {
      const text = refusalText(reason);
      expect(text).toMatch(/^[A-Z].*[.?]$/);
      expect(text).not.toContain(reason);
    }
  });

  test("the owner is told what to do", () => {
    expect(refusalText("unsafe-name")).toBe(
      "This session's name has characters Session Hub can't send to safely. Rename it in Claude Code (/rename) and try again.",
    );
    expect(refusalText("session-not-live")).toBe("That session isn't running any more.");
    expect(refusalText("duplicate-name")).toBe(
      "Two live sessions share this name; rename one (/rename) and try again.",
    );
    expect(refusalText("unknown-session")).toBe(
      "Session Hub doesn't know this session yet; try again in a few seconds.",
    );
    expect(refusalText("empty-message")).toBe("The message is empty. Type something first.");
    expect(refusalText("too-long")).toBe("The message is too long. Shorten it and try again.");
  });

  test("isRefuseReason accepts only the known codes", () => {
    for (const reason of REFUSE_REASONS) expect(isRefuseReason(reason)).toBe(true);
    for (const v of ["", "send-error", "Unsafe-name", "toString", "constructor"]) {
      expect(isRefuseReason(v)).toBe(false);
    }
  });
});
