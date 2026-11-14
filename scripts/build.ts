// Builds three executables:
// - dist/hub.exe from src/cli.ts: every command, with a console (the TUI needs one).
// - dist/hubd.exe from src/daemon-main.ts: the daemon only, with no console window, so the HKCU Run
//   value can start it at login without opening a window.
// - dist/SessionHubTray.exe from gui/SessionHub.Tray: the tray app, a framework-dependent single file
//   (it needs the .NET 10 Desktop Runtime). Published to dist/gui, then copied next to hub.exe.
// Ink imports the optional `react-devtools-core` only when DEV=true; it is not installed, so the
// bundler gets an empty stand-in instead of a missing module.
import { copyFileSync, writeFileSync } from "node:fs";
import type { BunPlugin } from "bun";
import { formatManifest, MANIFEST_EXES, MANIFEST_FILE } from "../src/cli/manifest.ts";

const noReactDevtools: BunPlugin = {
  name: "no-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

const targets = [
  { entry: "src/cli.ts", outfile: "dist/hub.exe", hideConsole: false },
  { entry: "src/daemon-main.ts", outfile: "dist/hubd.exe", hideConsole: true },
];

for (const t of targets) {
  const result = await Bun.build({
    entrypoints: [t.entry],
    compile: { outfile: t.outfile, windows: { hideConsole: t.hideConsole } },
    plugins: [noReactDevtools],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`built ${t.outfile}`);
}

// The publish profile (gui/SessionHub.Tray/Properties/PublishProfiles/SingleFile.pubxml) sets win-x64,
// framework-dependent, single file, no debug files and no single-file analyzer, for the tray project
// only. The same settings as command-line flags (-r win-x64, -p:PublishSingleFile=true) would be
// global properties that also reach SessionHub.Core, whose locked restore then fails with NU1004
// (a win-x64 RID and the ILLink pack it does not lock). Locked mode makes a restore that disagrees
// with the committed packages.lock.json fail instead of rewriting it.
const publish = Bun.spawnSync(
  [
    "dotnet",
    "publish",
    "gui/SessionHub.Tray",
    "-c",
    "Release",
    "-p:PublishProfile=SingleFile",
    "-p:RestoreLockedMode=true",
    "-o",
    "dist/gui",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (publish.exitCode !== 0) {
  console.error(`dotnet publish failed with exit code ${publish.exitCode}`);
  process.exit(1);
}
copyFileSync("dist/gui/SessionHubTray.exe", "dist/SessionHubTray.exe");
console.log("built dist/SessionHubTray.exe");

// The build manifest (INF-08c): the commit and the SHA-256 of each exe. `hub install` refuses exes
// that do not match it and keeps a copy beside the installed exes.
const git = (args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  if (r.exitCode !== 0) {
    console.error(`git ${args.join(" ")} failed with exit code ${r.exitCode}`);
    process.exit(1);
  }
  return r.stdout.toString().trim();
};
const sha256: Record<string, string> = {};
for (const name of MANIFEST_EXES) {
  sha256[name] = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(`dist/${name}`).arrayBuffer())
    .digest("hex");
}
const manifest = {
  commit: git(["rev-parse", "HEAD"]),
  dirty: git(["status", "--porcelain"]) !== "",
  sha256,
};
writeFileSync(`dist/${MANIFEST_FILE}`, formatManifest(manifest));
console.log(`wrote dist/${MANIFEST_FILE}`);
process.stdout.write(formatManifest(manifest));
