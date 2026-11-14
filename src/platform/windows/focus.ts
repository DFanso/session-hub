import { dlopen } from "bun:ffi";
import { run } from "./exec";
import { sysbin } from "./sysbin";

export type FocusResult = { ok: boolean; title?: string; reason?: string };

const SW_RESTORE = 9;
/** The CIM parent walk can take more than 5 s on a cold machine. */
export const FOCUS_TIMEOUT_MS = 15_000;

// The pid reaches the script only through the SH_PID env var, never through the command text.
// The walk stops when a parent is younger than its child: the parent pid was reused.
const SCRIPT = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
& {
  $p = [int]$env:SH_PID
  $seen = @{}
  $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
  while ($cur -and -not $seen.ContainsKey([int]$cur.ProcessId)) {
    $id = [int]$cur.ProcessId
    $seen[$id] = 1
    $pr = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($pr -and $pr.MainWindowHandle -ne 0) {
      [pscustomobject]@{hwnd=[int64]$pr.MainWindowHandle; title=[string]$pr.MainWindowTitle} | ConvertTo-Json -Compress
      return
    }
    $pp = [int]$cur.ParentProcessId
    if ($pp -le 0) { break }
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$pp" -ErrorAction SilentlyContinue
    if (-not $par -or $par.CreationDate -gt $cur.CreationDate) { break }
    $cur = $par
  }
  '{"hwnd":0}'
}`;

export async function focusSessionWindow(pid: number): Promise<FocusResult> {
  if (process.platform !== "win32") return { ok: false, reason: "not-windows" };
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: "error" };
  try {
    const r = await run(
      [sysbin.powershell(), "-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { SH_PID: String(pid) },
      FOCUS_TIMEOUT_MS,
    );
    if (r.code !== 0) return { ok: false, reason: "error" };
    const parsed = JSON.parse(r.stdout.trim()) as { hwnd?: number; title?: string };
    const hwnd = parsed.hwnd ?? 0;
    if (!hwnd) return { ok: false, reason: "no-window" };
    const title = parsed.title ?? "";
    const { symbols, close } = dlopen("user32.dll", {
      IsIconic: { args: ["u64"], returns: "i32" },
      ShowWindow: { args: ["u64", "i32"], returns: "i32" },
      SetForegroundWindow: { args: ["u64"], returns: "i32" },
    });
    try {
      const h = BigInt(hwnd);
      if (symbols.IsIconic(h) !== 0) symbols.ShowWindow(h, SW_RESTORE);
      if (symbols.SetForegroundWindow(h) === 0) return { ok: false, reason: "focus-denied" };
      return { ok: true, title };
    } finally {
      close();
    }
  } catch {
    return { ok: false, reason: "error" };
  }
}
