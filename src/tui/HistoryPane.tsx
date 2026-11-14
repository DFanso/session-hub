import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { MessageRow, SearchHit, SessionView, Store } from "../store/db";
import { hhmm, roleLabel, sessionLabel, wrap } from "./format";
import type { Register } from "./keys";
import { type Line, LineView } from "./StatusPane";
import { cleanInput, cleanText } from "./sanitize";

const PAGE = 50;
const SEARCH_LIMIT = 50;

type Search =
  | { mode: "off" }
  | { mode: "input"; query: string }
  | { mode: "results"; query: string; hits: SearchHit[] };

/** Scroll position: the top visible line is `offset` lines into message `uuid`; null follows the newest. */
type Anchor = { uuid: string; offset: number } | null;

function cleanMessage(m: MessageRow): MessageRow {
  return {
    ...m,
    text: cleanText(m.text),
    fromName: m.fromName === null ? null : cleanText(m.fromName),
  };
}

/** Keeps older pages already loaded and replaces the newest page with a fresh read. */
function mergeNewest(prev: MessageRow[], page: MessageRow[]): MessageRow[] {
  const first = page[0];
  if (!first) return prev;
  const fresh = new Set(page.map((m) => m.uuid));
  const older = prev.filter((m) => !fresh.has(m.uuid) && m.ts <= first.ts);
  return [...older, ...page];
}

function roleColor(role: MessageRow["role"]): string {
  if (role === "owner") return "green";
  if (role === "peer") return "magenta";
  return "cyan";
}

interface Layout {
  lines: Line[];
  /** uuid of the message each line belongs to. */
  owner: string[];
  start: Map<string, number>;
}

function layout(messages: MessageRow[], width: number): Layout {
  const lines: Line[] = [];
  const owner: string[] = [];
  const start = new Map<string, number>();
  for (const m of messages) {
    start.set(m.uuid, lines.length);
    const add = (l: Line) => {
      lines.push(l);
      owner.push(m.uuid);
    };
    add({ text: `${hhmm(m.ts)} ${roleLabel(m)}`, color: roleColor(m.role), bold: true });
    for (const t of wrap(m.text, width)) add({ text: t });
  }
  return { lines, owner, start };
}

/** Index of the top visible line for an anchor; null or an unknown uuid means the bottom. */
function topOf(lay: Layout, anchor: Anchor, h: number): number {
  const bottom = Math.max(0, lay.lines.length - h);
  if (anchor === null) return bottom;
  const s = lay.start.get(anchor.uuid);
  return s === undefined ? bottom : Math.min(bottom, s + anchor.offset);
}

function anchorAt(lay: Layout, top: number, h: number): Anchor {
  if (top >= Math.max(0, lay.lines.length - h)) return null;
  const uuid = lay.owner[top];
  if (uuid === undefined) return null;
  return { uuid, offset: top - (lay.start.get(uuid) ?? top) };
}

function hitLines(s: Extract<Search, { mode: "results" }>, names: Map<string, string>, w: number) {
  const n = s.hits.length;
  const out: Line[] = [
    { text: `Search "${s.query}": ${n} result${n === 1 ? "" : "s"} (Esc clears)`, bold: true },
  ];
  for (const hit of s.hits) {
    const who = names.get(hit.sessionId) ?? hit.sessionId.slice(0, 8);
    const role = roleLabel({ role: hit.role, fromName: null });
    const text = `${hhmm(hit.ts)} ${who} ${role}: ${cleanText(hit.snippet)}`;
    for (const t of wrap(text, w, "  ")) out.push({ text: t });
  }
  return out;
}

function errText(e: unknown): string {
  return cleanText(e instanceof Error ? e.message : String(e));
}

export function HistoryPane(props: {
  store: Store;
  session: SessionView;
  sessions: SessionView[];
  tick: number;
  width: number;
  height: number;
  /** Polls the store only while the History tab is shown. */
  active: boolean;
  searchNonce: number;
  register: Register;
  onError: (message: string) => void;
}) {
  const { store, onError, register, active, width } = props;
  const sid = props.session.sessionId;
  const h = Math.max(1, props.height);

  // State drives rendering; the refs are what key handlers read, so keys in one tick chain.
  const [messages, setMessagesState] = useState<MessageRow[]>([]);
  const messagesRef = useRef<MessageRow[]>([]);
  const [exhausted, setExhaustedState] = useState(false);
  const exhaustedRef = useRef(false);
  const [anchor, setAnchorState] = useState<Anchor>(null);
  const anchorRef = useRef<Anchor>(null);
  const [search, setSearchState] = useState<Search>({ mode: "off" });
  const searchRef = useRef<Search>({ mode: "off" });
  const setMessages = (m: MessageRow[]) => {
    messagesRef.current = m;
    setMessagesState(m);
  };
  const setExhausted = (b: boolean) => {
    exhaustedRef.current = b;
    setExhaustedState(b);
  };
  const setAnchor = (a: Anchor) => {
    anchorRef.current = a;
    setAnchorState(a);
  };
  const setSearch = (s: Search) => {
    searchRef.current = s;
    setSearchState(s);
  };

  // Poll the newest page while shown; tick changes on every refresh.
  useEffect(() => {
    void props.tick;
    if (!active) return;
    try {
      const page = store.history(sid, PAGE).map(cleanMessage);
      const merged = mergeNewest(messagesRef.current, page);
      messagesRef.current = merged;
      setMessagesState(merged);
    } catch (e) {
      onError(errText(e));
    }
  }, [store, sid, props.tick, active, onError]);

  // Fallback for a "/" that arrived while this pane was not yet registered.
  useEffect(() => {
    if (props.searchNonce > 0) {
      searchRef.current = { mode: "input", query: "" };
      setSearchState(searchRef.current);
    }
  }, [props.searchNonce]);

  const moreOlder = () => !exhaustedRef.current && messagesRef.current.length >= PAGE;

  const pageUp = () => {
    const lay = layout(messagesRef.current, width);
    let top = topOf(lay, anchorRef.current, h);
    let target = top - (h - 1);
    const oldest = messagesRef.current[0];
    if (target < 0 && moreOlder() && oldest) {
      const page = store.history(sid, PAGE, oldest.ts, oldest.uuid).map(cleanMessage);
      if (page.length < PAGE) setExhausted(true);
      const have = new Set(messagesRef.current.map((m) => m.uuid));
      const next = [...page.filter((m) => !have.has(m.uuid)), ...messagesRef.current];
      setMessages(next);
      const grown = layout(next, width);
      top += grown.start.get(oldest.uuid) ?? 0;
      target = top - (h - 1);
      setAnchor(anchorAt(grown, Math.max(0, target), h));
      return;
    }
    setAnchor(anchorAt(lay, Math.max(0, target), h));
  };

  const pageDown = () => {
    const lay = layout(messagesRef.current, width);
    setAnchor(anchorAt(lay, topOf(lay, anchorRef.current, h) + (h - 1), h));
  };

  useEffect(() => {
    register({
      sessionId: sid,
      captures: () => searchRef.current.mode === "input",
      openSearch: () => setSearch({ mode: "input", query: "" }),
      paste: (text) => {
        const s = searchRef.current;
        if (s.mode === "input") {
          setSearch({ mode: "input", query: s.query + cleanInput(text).replace(/\n/g, " ") });
        }
      },
      handle: (input, key) => {
        const s = searchRef.current;
        if (s.mode === "input") {
          if (key.escape) setSearch({ mode: "off" });
          else if (key.return) {
            try {
              setSearch({
                mode: "results",
                query: s.query,
                hits: store.search(s.query, SEARCH_LIMIT),
              });
            } catch (e) {
              onError(errText(e));
            }
          } else if (key.backspace || key.delete) {
            setSearch({ mode: "input", query: [...s.query].slice(0, -1).join("") });
          } else if (input && !key.ctrl) {
            const add = cleanInput(input, key.meta).replace(/\n/g, " ");
            setSearch({ mode: "input", query: s.query + add });
          }
          return;
        }
        if (s.mode === "results") {
          if (key.escape) setSearch({ mode: "off" });
          return;
        }
        try {
          if (key.pageUp) pageUp();
          else if (key.pageDown) pageDown();
          else if (key.end) setAnchor(null);
        } catch (e) {
          onError(errText(e));
        }
      },
    });
  });
  useEffect(() => () => register(null), [register]);

  if (search.mode !== "off") {
    const names = new Map(props.sessions.map((s) => [s.sessionId, sessionLabel(s)]));
    const body: Line[] =
      search.mode === "input"
        ? [
            { text: `Search: ${search.query}_`, bold: true },
            { text: "Enter runs the search; words match as whole terms. Esc cancels.", dim: true },
          ]
        : hitLines(search, names, width);
    return (
      <Box flexDirection="column" width={width} height={h} overflow="hidden">
        {body.slice(0, h).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          <LineView key={i} line={l} />
        ))}
      </Box>
    );
  }

  if (messages.length === 0) {
    return (
      <Box width={width} height={h}>
        <Text dimColor>no messages yet</Text>
      </Box>
    );
  }
  const lay = layout(messages, width);
  const top = topOf(lay, anchor, h);
  const hint = top === 0 && !exhausted && messages.length >= PAGE;
  const rows = hint ? h - 1 : h;
  const shown: Line[] = lay.lines.slice(top, top + rows);
  if (hint) shown.unshift({ text: "... PgUp loads older messages", dim: true });
  return (
    <Box flexDirection="column" width={width} height={h} overflow="hidden">
      {shown.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
        <LineView key={i} line={l} />
      ))}
    </Box>
  );
}
