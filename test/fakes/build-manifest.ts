import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeFs } from "../../src/cli/commands.ts";
import { formatManifest, MANIFEST_EXES, MANIFEST_FILE } from "../../src/cli/manifest.ts";

export const TEST_COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** Writes the build manifest `bun run build` would write for the exes now in `distDir`. */
export function writeBuildManifest(distDir: string, dirty = false): void {
  const sha256: Record<string, string> = {};
  for (const name of MANIFEST_EXES) sha256[name] = nodeFs.sha256(join(distDir, name));
  writeFileSync(
    join(distDir, MANIFEST_FILE),
    formatManifest({ commit: TEST_COMMIT, dirty, sha256 }),
  );
}
