import { closeSync, openSync } from "node:fs";

/**
 * The relay's PreToolUse guard (`hub relay-guard`, run by Claude Code before each tool call of the
 * relay). The relay model may be steered by the text it carries; the prompt alone cannot stop it from
 * making a second SendMessage call, or one to another session. The guard allows exactly one
 * SendMessage, to the session the hub chose, and blocks everything else. It fails closed: a missing
 * recipient or marker, unreadable input or any other tool is blocked.
 */

/** Environment variables the hub sets for the relay; the hook inherits them from `claude`. */
export const GUARD_TO_ENV = "SESSION_HUB_RELAY_TO";
export const GUARD_MARKER_ENV = "SESSION_HUB_RELAY_MARKER";

/** Claude Code's exit code for a PreToolUse hook that blocks the call (stderr goes to the model). */
export const GUARD_BLOCK_EXIT = 2;

export type GuardDecision = { allow: true } | { allow: false; reason: string };

export interface GuardDeps {
  env: Record<string, string | undefined>;
  /**
   * Creates the marker file and returns true, or returns false when it already exists (a send was
   * already allowed for this relay run). Exclusive create, so two calls can never both pass.
   */
  claimMarker(path: string): boolean;
}

/** Decides one tool call from the hook's JSON input. Pure apart from the marker claim. */
export function guardDecision(input: string, deps: GuardDeps): GuardDecision {
  const to = deps.env[GUARD_TO_ENV];
  const marker = deps.env[GUARD_MARKER_ENV];
  if (!to || !marker) return { allow: false, reason: "relay guard: no recipient set" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { allow: false, reason: "relay guard: unreadable tool call" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { allow: false, reason: "relay guard: unreadable tool call" };
  }
  const call = parsed as { tool_name?: unknown; tool_input?: unknown };
  if (call.tool_name !== "SendMessage") {
    return { allow: false, reason: "relay guard: only SendMessage is allowed" };
  }
  const toolInput = call.tool_input as { to?: unknown } | null | undefined;
  if (toolInput === null || typeof toolInput !== "object" || toolInput.to !== to) {
    return { allow: false, reason: `relay guard: SendMessage may only go to "${to}"` };
  }
  if (!deps.claimMarker(marker)) {
    return { allow: false, reason: "relay guard: the message was already sent once" };
  }
  return { allow: true };
}

/** Exclusive create of the marker: true when this call created it. */
export function claimMarkerFile(path: string): boolean {
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    return false;
  }
}

/** Runs the guard on one hook input; returns the process exit code (0 allow, 2 block). */
export function runGuard(input: string, deps: GuardDeps & { err(line: string): void }): number {
  const d = guardDecision(input, deps);
  if (d.allow) return 0;
  deps.err(d.reason);
  return GUARD_BLOCK_EXIT;
}

/**
 * The hook command line: the running hub executable with `relay-guard` (in dev, bun with the CLI
 * entry). Paths use forward slashes and quotes, which both shells Claude Code may run hooks with accept.
 */
export function guardCommand(argv: readonly string[]): string {
  return argv.map((a) => `"${a.replaceAll("\\", "/")}"`).join(" ");
}

/** The relay's `--settings` JSON: one PreToolUse hook on every tool, running the guard. */
export function guardSettings(argv: readonly string[]): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: guardCommand(argv) }] }],
    },
  });
}
