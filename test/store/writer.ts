// Child process for the cross-process concurrency test: acts as the collector daemon.
import { RETENTION_MS } from "../../src/config";
import { Store } from "../../src/store/db";

const path = process.argv[2];
if (!path) throw new Error("usage: writer.ts <db path>");
const store = Store.open(path);
const base = {
  profile: "work",
  name: "alpha",
  cwd: "C:/x",
  pid: 1,
  kind: "interactive",
  status: "idle" as const,
  startedAt: 1,
  updatedAt: 1,
  permissionMode: null,
};
store.upsertSession({ ...base, sessionId: "s1", endedAt: null, transcriptPath: "s1.jsonl" });
store.upsertSession({ ...base, sessionId: "old", endedAt: 1, transcriptPath: "old.jsonl" });
store.addMessages("old", [
  { uuid: "old-1", sessionId: "old", ts: "t", role: "owner", fromName: null, text: "ancient" },
]);
let n = 0;
for (let batch = 0; batch < 200; batch++) {
  const rows = [];
  for (let i = 0; i < 10; i++, n++) {
    rows.push({
      uuid: `u${n}`,
      sessionId: "s1",
      ts: `2026-01-01T00:00:00.${String(n).padStart(4, "0")}Z`,
      role: "assistant" as const,
      fromName: null,
      text: `word${n} common`,
    });
  }
  store.addMessages("s1", rows);
  if (batch === 100) {
    store.purge(RETENTION_MS * 10);
    store.vacuum();
  }
}
store.close();
