import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const CWD_HEAD_BYTES = 256 * 1024;

/** cwd of the first record in the file's head that has one, else "". */
export async function firstCwd(path: string): Promise<string> {
  const text = await Bun.file(path).slice(0, CWD_HEAD_BYTES).text();
  const lines = text.split("\n");
  if (lines.length > 1) lines.pop(); // possibly cut mid-line
  for (const line of lines) {
    try {
      const o: unknown = JSON.parse(line);
      if (o !== null && typeof o === "object" && "cwd" in o) {
        const cwd = (o as { cwd: unknown }).cwd;
        if (typeof cwd === "string") return cwd;
      }
    } catch {
      // not JSON
    }
  }
  return "";
}

/** `<profile>/projects/<one level>/*.jsonl` files. Never recurses deeper, never opens files. */
export async function listTranscripts(profileDir: string): Promise<string[]> {
  const projects = join(profileDir, "projects");
  const out: string[] = [];
  let dirs: Dirent[];
  try {
    dirs = await readdir(projects, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = join(projects, d.name);
    try {
      for (const f of await readdir(sub, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(".jsonl")) out.push(join(sub, f.name));
      }
    } catch {
      // unreadable folder: skip
    }
  }
  return out;
}

const SESSION_ID = /^[0-9a-f-]{36}$/i;

/** True for a uuid-shaped session id: the only ids ever joined into a transcript path. */
export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

/** stem -> path for every transcript of a profile: one readdir per project folder. */
export async function transcriptIndex(profileDir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const path of await listTranscripts(profileDir)) {
    const stem = basename(path, ".jsonl");
    if (!index.has(stem)) index.set(stem, path);
  }
  return index;
}
