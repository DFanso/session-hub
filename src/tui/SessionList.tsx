import { Box, Text } from "ink";
import type { SessionView } from "../store/db";
import { profileHeader, sessionLabel, stateLabel } from "./format";

const PROFILE_ORDER = ["claude", "claude-personal"];

export interface Group {
  profile: string;
  sessions: SessionView[];
}

/** Known profiles first in a fixed order, others alphabetically; store order kept inside a group. */
export function groupSessions(sessions: SessionView[]): Group[] {
  const by = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const list = by.get(s.profile) ?? [];
    list.push(s);
    by.set(s.profile, list);
  }
  const rank = (p: string) => {
    const i = PROFILE_ORDER.indexOf(p);
    return i === -1 ? PROFILE_ORDER.length : i;
  };
  return [...by.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((profile) => ({ profile, sessions: by.get(profile) ?? [] }));
}

type Row =
  | { kind: "header"; key: string; profile: string }
  | { kind: "name"; key: string; s: SessionView; selected: boolean }
  | { kind: "cwd"; key: string; s: SessionView };

function stateColor(label: string): string | undefined {
  if (label === "needs you") return "yellow";
  if (label === "busy") return "cyan";
  if (label === "ended") return "gray";
  return undefined;
}

export function SessionList(props: {
  groups: Group[];
  selectedId: string | null;
  width: number;
  height: number;
  /** Shown when there are no groups ("" while the first read is pending). */
  emptyText: string;
}) {
  const rows: Row[] = [];
  let selectedRow = 0;
  for (const g of props.groups) {
    rows.push({ kind: "header", key: `h:${g.profile}`, profile: g.profile });
    for (const s of g.sessions) {
      const selected = s.sessionId === props.selectedId;
      if (selected) selectedRow = rows.length;
      rows.push({ kind: "name", key: `n:${s.sessionId}`, s, selected });
      rows.push({ kind: "cwd", key: `c:${s.sessionId}`, s });
    }
  }
  const h = Math.max(1, props.height);
  const maxStart = Math.max(0, rows.length - h);
  const start = Math.min(maxStart, Math.max(0, selectedRow - Math.floor(h / 2)));
  const visible = rows.slice(start, start + h);

  return (
    <Box flexDirection="column" width={props.width} height={h} overflow="hidden">
      {rows.length === 0 ? <Text dimColor>{props.emptyText}</Text> : null}
      {visible.map((r) => {
        if (r.kind === "header") {
          return (
            <Text key={r.key} bold wrap="truncate-end">
              {profileHeader(r.profile)}
            </Text>
          );
        }
        if (r.kind === "cwd") {
          return (
            <Box key={r.key} paddingLeft={2} width={props.width}>
              <Text dimColor wrap="truncate-start">
                {r.s.cwd}
              </Text>
            </Box>
          );
        }
        const label = stateLabel(r.s);
        const badge = r.s.waitingCount > 0 ? ` [${r.s.waitingCount}]` : "";
        return (
          <Box key={r.key} width={props.width}>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate-end" inverse={r.selected} bold={r.selected}>
                {r.selected ? "> " : "  "}
                {sessionLabel(r.s)}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color="yellow">{badge}</Text>
              <Text color={stateColor(label)}> {label}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
