import { Box } from "ink";
import { useEffect, useRef, useState } from "react";
import { isRefuseReason, refusalText } from "../send/refusals";
import { looksSecret } from "../send/relay";
import type { SendRow, SessionView, Store } from "../store/db";
import { hhmm, profileHeader, sessionLabel, wrap } from "./format";
import type { Register } from "./keys";
import { type Line, LineView } from "./StatusPane";
import { cleanInput, cleanText } from "./sanitize";

export interface SendRequest {
  sessionId: string;
  text: string;
  override?: boolean;
  allowSecret?: boolean;
}

export type SendFn = (req: SendRequest) => Promise<{ state: string; detail?: string | null }>;

type Phase =
  | { kind: "edit"; editing: boolean }
  | { kind: "preview"; open: SendRow | null; override: boolean; offset: number }
  | { kind: "sending" }
  | {
      kind: "done";
      state: string;
      detail: string | null;
      sendId: number | null;
      later: string | null;
      laterDetail: string | null;
    }
  | { kind: "refused"; message: string };

function errMessage(e: unknown): string {
  return cleanText(e instanceof Error ? e.message : String(e));
}

function errorText(e: unknown): string {
  if (e && typeof e === "object" && "reason" in e && typeof e.reason === "string") {
    const reason = e.reason;
    return `Not sent: ${isRefuseReason(reason) ? refusalText(reason) : cleanText(reason)}`;
  }
  return `Send failed: ${errMessage(e)}`;
}

function cleanRow(r: SendRow | null): SendRow | null {
  if (r === null) return null;
  return {
    ...r,
    state: cleanText(r.state) as SendRow["state"],
    detail: r.detail === null ? null : cleanText(r.detail),
  };
}

export function SendPane(props: {
  store: Store;
  session: SessionView;
  tick: number;
  send: SendFn;
  buildMessage: (text: string) => string;
  width: number;
  height: number;
  /** Drafts by sessionId, owned by the App so a draft outlives a remount and `q` can see it. */
  drafts: Map<string, string>;
  register: Register;
  onError: (message: string) => void;
}) {
  const { store, session, send, onError, register, drafts } = props;
  const sid = session.sessionId;
  const ended = session.endedAt !== null;
  const [text, setTextState] = useState(() => drafts.get(sid) ?? "");
  const [phase, setPhaseState] = useState<Phase>({ kind: "edit", editing: true });
  // Refs are the source of truth for key handling: two keys that arrive before a re-render
  // (a double "y") must see the first key's effect, so a send can never start twice.
  const phaseRef = useRef(phase);
  const textRef = useRef(text);
  // The phase object last committed to the screen. "y" confirms only a preview the owner has
  // been shown: Ctrl+S and y in the same tick, or in one burst of input, never send.
  const shownRef = useRef<Phase | null>(null);
  useEffect(() => {
    shownRef.current = phase;
  }, [phase]);
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };
  const setText = (t: string) => {
    textRef.current = t;
    if (t === "") drafts.delete(sid);
    else drafts.set(sid, t);
    setTextState(t);
  };
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // On each refresh: follow a finished send's later state, and keep a preview's open-send check current.
  useEffect(() => {
    void props.tick;
    const p = phaseRef.current;
    try {
      if (p.kind === "done" && p.sendId !== null) {
        const row = cleanRow(store.getSend(p.sendId));
        if (row && row.state !== p.later) {
          phaseRef.current = { ...p, later: row.state, laterDetail: row.detail };
          setPhaseState(phaseRef.current);
        }
      } else if (p.kind === "preview") {
        const open = cleanRow(store.openSendFor(sid));
        if (open?.id !== p.open?.id || open?.state !== p.open?.state) {
          const same = open !== null && p.open !== null && open.id === p.open.id;
          phaseRef.current = { ...p, open, override: same ? p.override : false };
          setPhaseState(phaseRef.current);
        }
      }
    } catch (e) {
      onError(errMessage(e));
    }
  }, [props.tick, store, sid, onError]);

  const confirm = (override: boolean) => {
    const body = textRef.current;
    const req: SendRequest = override
      ? { sessionId: sid, text: body, override: true }
      : { sessionId: sid, text: body };
    // y confirms a preview that showed the secret warning (LLM-03).
    if (looksSecret(body)) req.allowSecret = true;
    setPhase({ kind: "sending" });
    send(req).then(
      (res) => {
        if (!mounted.current) return;
        const raw = (res as { id?: unknown }).id;
        let sendId: number | null = typeof raw === "number" ? raw : null;
        if (sendId === null) {
          try {
            sendId = store.openSendFor(sid)?.id ?? null;
          } catch (e) {
            onError(errMessage(e));
          }
        }
        const state = cleanText(res.state);
        const detail = res.detail ? cleanText(res.detail) : null;
        setText("");
        setPhase({ kind: "done", state, detail, sendId, later: state, laterDetail: detail });
      },
      (e: unknown) => {
        if (!mounted.current) return;
        setPhase({ kind: "refused", message: errorText(e) });
      },
    );
  };

  const h = Math.max(1, props.height);
  const recipient = `${sessionLabel(session)} (${profileHeader(session.profile)})`;
  const previewBody = wrap(props.buildMessage(text), props.width);

  useEffect(() => {
    const append = (chunk: string) => {
      if (chunk !== "") setText(textRef.current + chunk);
    };
    register({
      sessionId: sid,
      captures: () => {
        if (ended) return false;
        const p = phaseRef.current;
        return p.kind !== "edit" || p.editing;
      },
      paste: (pasted) => {
        const p = phaseRef.current;
        if (!ended && p.kind === "edit" && p.editing) append(cleanInput(pasted));
      },
      handle: (input, key) => {
        if (ended) return;
        const p = phaseRef.current;
        if (p.kind === "edit") {
          if (!p.editing) {
            if (key.return || input === "e") setPhase({ kind: "edit", editing: true });
            return;
          }
          if (key.ctrl && input === "s") {
            if (textRef.current.trim() === "") return;
            try {
              const open = cleanRow(store.openSendFor(sid));
              setPhase({ kind: "preview", open, override: false, offset: 0 });
            } catch (e) {
              onError(errMessage(e));
            }
          } else if (key.escape) {
            setPhase({ kind: "edit", editing: false });
          } else if (key.return) {
            append("\n");
          } else if (key.backspace || key.delete) {
            setText([...textRef.current].slice(0, -1).join(""));
          } else if (input && !key.ctrl) {
            append(cleanInput(input, key.meta));
          }
          return;
        }
        if (p.kind === "preview") {
          const shown = shownRef.current === p;
          if (input === "n" || key.escape) setPhase({ kind: "edit", editing: true });
          else if (input === "o" && p.open !== null) setPhase({ ...p, override: true });
          else if (input === "y" && shown && (p.open === null || p.override)) confirm(p.override);
          else if (key.pageDown) setPhase({ ...p, offset: p.offset + (h - 1) });
          else if (key.pageUp) setPhase({ ...p, offset: Math.max(0, p.offset - (h - 1)) });
          return;
        }
        if (p.kind === "done" || p.kind === "refused") {
          // Keys stay here until the owner goes back to the editor or out to the list.
          if (key.return || input === "e") setPhase({ kind: "edit", editing: true });
          else if (key.escape) setPhase({ kind: "edit", editing: false });
        }
      },
    });
  });
  useEffect(() => () => register(null), [register]);

  let lines: Line[];
  if (ended) {
    lines = [
      { text: `Cannot send: ${recipient} ended at ${hhmm(session.endedAt ?? 0)}.`, color: "red" },
      { text: "Messages go only to live sessions.", dim: true },
    ];
  } else if (phase.kind === "edit") {
    const help = phase.editing
      ? "Enter newline · Ctrl+S preview · Esc leave editor"
      : "Enter or e to edit · Ctrl+S preview from the editor";
    lines = [
      { text: `To: ${recipient}`, bold: true },
      { text: help, dim: true },
      { text: "" },
      ...wrap(phase.editing ? `${text}_` : text, props.width).map((t) => ({ text: t })),
    ];
    // Keep the end of a long draft (where typing happens) in view.
    if (lines.length > h) lines = [...lines.slice(0, 3), ...lines.slice(lines.length - (h - 3))];
  } else if (phase.kind === "preview") {
    // Recipient and cwd wrap rather than truncate: the owner must see exactly where this goes.
    const head: Line[] = [
      { text: "Preview: check before sending", bold: true, color: "yellow" },
      ...wrap(`To: ${recipient}`, props.width, "    ").map((t) => ({ text: t, bold: true })),
      ...wrap(`cwd: ${session.cwd}`, props.width, "     ").map((t) => ({ text: t })),
    ];
    if (looksSecret(text)) {
      head.push(
        ...wrap(
          "Warning: this message looks like a secret or card number. It goes to the model provider as typed.",
          props.width,
        ).map((t) => ({ text: t, color: "red", bold: true })),
      );
    }
    if (phase.open !== null) {
      head.push({
        text: `open send: ${phase.open.state} since ${hhmm(phase.open.createdAt)} local`,
        color: "red",
      });
      head.push(
        phase.override
          ? { text: "override on: y sends anyway · n/Esc cancels", color: "red" }
          : { text: "press o to override, then y · n/Esc cancels", color: "red" },
      );
    } else {
      head.push({ text: "y send · n/Esc cancel · PgUp/PgDn scroll", color: "yellow" });
    }
    head.push({ text: "-".repeat(Math.min(props.width, 40)), dim: true });
    const room = Math.max(1, h - head.length - 1);
    const off = Math.min(phase.offset, Math.max(0, previewBody.length - room));
    const body = previewBody.slice(off, off + room).map((t) => ({ text: t }));
    const range =
      previewBody.length > room
        ? [
            {
              text: `lines ${off + 1}-${off + body.length} of ${previewBody.length} (PgUp/PgDn)`,
              dim: true,
            },
          ]
        : [];
    lines = [...head, ...body, ...range];
  } else if (phase.kind === "sending") {
    lines = [{ text: `Sending to ${recipient}...`, color: "yellow" }];
  } else if (phase.kind === "done") {
    lines = [
      { text: `sent: ${phase.state}${phase.detail ? ` (${phase.detail})` : ""}`, bold: true },
    ];
    if (phase.later !== null && phase.later !== phase.state) {
      lines.push({
        text: `now: ${phase.later}${phase.laterDetail ? ` (${phase.laterDetail})` : ""}`,
        bold: true,
        color: phase.later === "delivered" ? "green" : "yellow",
      });
    }
    lines.push({ text: "Enter or e: new message · Esc: back to the list", dim: true });
  } else {
    lines = [
      ...wrap(phase.message, props.width).map((t): Line => ({ text: t, color: "red", bold: true })),
      { text: "Enter or e: back to the draft · Esc: back to the list", dim: true },
    ];
  }

  return (
    <Box flexDirection="column" width={props.width} height={h} overflow="hidden">
      {lines.slice(0, h).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
        <LineView key={i} line={l} />
      ))}
    </Box>
  );
}
