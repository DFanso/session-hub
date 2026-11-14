/** Why a send was refused before anything was stored or spawned. The bridge sends it as the error code. */
export type RefuseReason =
  | "unknown-session"
  | "session-not-live"
  | "duplicate-name"
  | "unsafe-name"
  | "send-in-flight"
  | "empty-message"
  | "too-long"
  | "rate-limited"
  | "looks-secret";

/**
 * What the owner sees for each refusal, after "Not sent: ". The TUI and the tray
 * (gui/SessionHub.Core SendBoxViewModel, checked against the refusals.ndjson fixture) both show
 * "Not sent: <text>", except send-in-flight in the tray, which offers its own "Send anyway" button.
 */
const TEXTS: Readonly<Record<RefuseReason, string>> = {
  "unknown-session": "Session Hub doesn't know this session yet; try again in a few seconds.",
  "session-not-live": "That session isn't running any more.",
  "duplicate-name": "Two live sessions share this name; rename one (/rename) and try again.",
  "unsafe-name":
    "This session's name has characters Session Hub can't send to safely. Rename it in Claude Code (/rename) and try again.",
  "send-in-flight":
    "A message to this session is still pending. Check its state, or override it in the preview.",
  "empty-message": "The message is empty. Type something first.",
  "too-long": "The message is too long. Shorten it and try again.",
  "rate-limited": "Six messages went out in the last minute. Wait a minute and try again.",
  "looks-secret":
    "The message looks like it contains a secret or card number; it goes to the model provider. Send anyway?",
};

export const REFUSE_REASONS: readonly RefuseReason[] = Object.keys(TEXTS) as RefuseReason[];

export function isRefuseReason(v: string): v is RefuseReason {
  return Object.hasOwn(TEXTS, v);
}

export function refusalText(reason: RefuseReason): string {
  return TEXTS[reason];
}
