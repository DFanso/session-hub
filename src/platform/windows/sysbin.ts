/**
 * Absolute paths of the Windows tools the hub runs, so a same-named exe in the cwd or earlier on
 * PATH is never run. Built at call time from SystemRoot.
 */
function system32(rel: string): string {
  return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\${rel}`;
}

export const sysbin = {
  cmd: () => system32("cmd.exe"),
  icacls: () => system32("icacls.exe"),
  powershell: () => system32("WindowsPowerShell\\v1.0\\powershell.exe"),
  reg: () => system32("reg.exe"),
  taskkill: () => system32("taskkill.exe"),
  whoami: () => system32("whoami.exe"),
} as const;
