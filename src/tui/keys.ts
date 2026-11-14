import type { Key } from "ink";

/**
 * A pane's key handling, registered with the App after every commit. The App has the only
 * useInput and asks the active pane synchronously, so a pane that starts capturing on one key
 * receives the very next key even when both arrive before React re-renders. Every method reads
 * the pane's refs, never values captured at render time that a key in the same tick could change.
 */
export interface PaneKeys {
  sessionId: string;
  /** True while the pane takes every key (editor, preview, search input, send result). */
  captures(): boolean;
  handle(input: string, key: Key): void;
  paste?(text: string): void;
  openSearch?(): void;
}

export type Register = (keys: PaneKeys | null) => void;
