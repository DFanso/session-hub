import { type ExecResult, run, runChecked } from "./exec";
import { sysbin } from "./sysbin";

const PARENT_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion";
const RUN_KEY = `${PARENT_KEY}\\Run`;
/** How `reg query` prints the Run key when it lists the parent's subkeys. */
const RUN_KEY_LISTED = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

type Exec = (argv: string[]) => Promise<ExecResult>;
const defaultExec: Exec = (argv) => run(argv);

/** Run value `"<exePath>"`, plus ` <args>` when given. hubd.exe needs no arguments. */
export async function setAutostart(name: string, exePath: string, args = ""): Promise<void> {
  await runChecked([
    sysbin.reg(),
    "add",
    RUN_KEY,
    "/v",
    name,
    "/t",
    "REG_SZ",
    "/d",
    args ? `"${exePath}" ${args}` : `"${exePath}"`,
    "/f",
  ]);
}

/**
 * reg delete exits 1 both when the value is missing and on a real failure, so the follow-up
 * query decides: not found is fine, a value still there or a failed query throws.
 */
export async function clearAutostart(name: string, exec: Exec = defaultExec): Promise<void> {
  const r = await exec([sysbin.reg(), "delete", RUN_KEY, "/v", name, "/f"]);
  if (r.code === 0) return;
  if ((await getAutostart(name, exec)) !== null) {
    throw new Error(`reg failed with exit code ${r.code}`);
  }
}

/**
 * The value's data, or null when the value (or the whole Run key) does not exist. Throws
 * "reg failed with exit code N" on any other failure. reg exits 1 for every error and its
 * message is localized, so the whole Run key is listed instead of querying one value: a
 * listing that works but lacks the name is "not found", and a failed listing is "not found"
 * only when the parent key lists no Run subkey.
 */
export async function getAutostart(name: string, exec: Exec = defaultExec): Promise<string | null> {
  const r = await exec([sysbin.reg(), "query", RUN_KEY]);
  if (r.code === 0) return valueIn(r.stdout, name);
  if (await runKeyMissing(exec)) return null;
  throw new Error(`reg failed with exit code ${r.code}`);
}

function valueIn(listing: string, name: string): string | null {
  for (const line of listing.split(/\r?\n/)) {
    // REG_EXPAND_SZ data is returned as stored, unexpanded.
    const m = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/.exec(line);
    if (m && m[1]?.toLowerCase() === name.toLowerCase()) return m[2] ?? null;
  }
  return null;
}

/** True only when the parent key lists cleanly and has no Run subkey. */
async function runKeyMissing(exec: Exec): Promise<boolean> {
  const p = await exec([sysbin.reg(), "query", PARENT_KEY]);
  if (p.code !== 0) return false;
  const want = RUN_KEY_LISTED.toLowerCase();
  return !p.stdout.split(/\r?\n/).some((l) => l.trim().toLowerCase() === want);
}
