import { sysbin } from "../platform/windows/sysbin.ts";

/**
 * Runs `taskkill /PID <pid> /T /F` (the process and its children), waiting at most `boundMs`; a
 * taskkill still running then is killed. True only when it exited 0 in time. Never throws: false
 * when it cannot be started, so the caller falls back to a plain kill.
 */
export async function taskkillTree(pid: number, boundMs: number): Promise<boolean> {
  try {
    const tk = Bun.spawn([sysbin.taskkill(), "/PID", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    let bound: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      tk.exited,
      new Promise<number>((r) => {
        bound = setTimeout(() => r(-1), boundMs);
      }),
    ]);
    clearTimeout(bound);
    if (code === -1) {
      try {
        tk.kill();
      } catch {
        // already gone
      }
    }
    return code === 0;
  } catch {
    return false;
  }
}
