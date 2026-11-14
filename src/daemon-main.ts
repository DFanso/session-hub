import { hubdArgv, runCli } from "./cli/commands.ts";
import { realCliDeps } from "./cli/real-deps.ts";

// hubd.exe: compiled with no console window, so the HKCU Run value can start it at login without a
// window. It runs the daemon by default and never loads Ink or the TUI.

const deps = realCliDeps({
  entryPath: import.meta.path,
  runTui: async () => {
    throw new Error("hubd.exe has no TUI; run hub");
  },
  runBridge: async () => {
    throw new Error("hubd.exe has no bridge; run hub bridge");
  },
});
const argv = hubdArgv(Bun.argv.slice(2));
if (argv === null) {
  deps.err(
    "hubd.exe runs only the daemon (hubd, hubd daemon run|start|stop|status). Use hub for the rest.",
  );
  process.exit(2);
}
process.exit(await runCli(argv, deps));
