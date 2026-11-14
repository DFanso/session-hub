// The build manifest (INF-08c): `bun run build` writes dist\install-manifest.txt with the commit it
// was built from and the SHA-256 of each exe; `hub install` refuses exes that do not match it,
// checks every copy against it, and keeps a copy beside the installed exes, so what is installed can
// always be traced to a commit.

export const MANIFEST_FILE = "install-manifest.txt";

/** The exes a manifest must list, in the order it lists them. */
export const MANIFEST_EXES: readonly string[] = ["hub.exe", "hubd.exe", "SessionHubTray.exe"];

export interface Manifest {
  /** 40 hex characters. */
  commit: string;
  /** True when the working tree had uncommitted changes at build time. */
  dirty: boolean;
  /** Lower-case SHA-256 hex by file name. */
  sha256: Record<string, string>;
}

const HEADER = "# Session Hub build manifest";
const COMMIT = /^commit ([0-9a-f]{40})( dirty)?$/;
const HASH = /^sha256 ([0-9a-f]{64}) {2}(\S+)$/;

export function formatManifest(m: Manifest): string {
  const lines = [HEADER, `commit ${m.commit}${m.dirty ? " dirty" : ""}`];
  for (const name of MANIFEST_EXES) lines.push(`sha256 ${m.sha256[name] ?? ""}  ${name}`);
  return `${lines.join("\n")}\n`;
}

/** Null unless the text is a complete manifest: a commit line and one hash for each exe. */
export function parseManifest(text: string): Manifest | null {
  let commit: string | null = null;
  let dirty = false;
  const sha256: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const c = COMMIT.exec(line);
    if (c !== null) {
      if (commit !== null) return null;
      commit = c[1] ?? null;
      dirty = c[2] !== undefined;
      continue;
    }
    const h = HASH.exec(line);
    if (h === null) return null;
    const name = h[2] ?? "";
    if (!MANIFEST_EXES.includes(name) || name in sha256) return null;
    sha256[name] = h[1] ?? "";
  }
  if (commit === null || MANIFEST_EXES.some((n) => !(n in sha256))) return null;
  return { commit, dirty, sha256 };
}

/** One line for the install output: the short commit, marked when the tree was dirty. */
export function describeBuild(m: Manifest): string {
  return `${m.commit.slice(0, 12)}${m.dirty ? " (built from uncommitted changes)" : ""}`;
}
