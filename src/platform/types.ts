/** HKCU Run values the hub owns: the daemon (`hubd.exe`) and the tray app (`SessionHubTray.exe`). */
export type RunValueName = "SessionHubDaemon" | "SessionHubTray";

export interface Platform {
  ensurePrivateDir(dir: string): Promise<void>;
  isPrivateDir(dir: string): Promise<boolean>;
  setAutostart(name: RunValueName, exePath: string): Promise<void>;
  clearAutostart(name: RunValueName): Promise<void>;
  /** The Run value's data, or null when it is not set. */
  getAutostart(name: RunValueName): Promise<string | null>;
  /**
   * Sets the tray's quit event. True when the event existed (a tray is running) and was set; false
   * when no tray holds it.
   */
  signalTrayQuit(): Promise<boolean>;
  /**
   * True while a tray instance holds its single-instance mutex (as far as this user can see: an
   * elevated tray's mutex may not be visible).
   */
  trayInstanceExists(): Promise<boolean>;
  /**
   * Full path of the process's executable, or null when it is gone or cannot be queried. Synchronous
   * (one OpenProcess call): the bridge asks it on every poll.
   */
  processImagePath(pid: number): string | null;
  /** When the process started, epoch ms; null when it is gone or cannot be queried. Synchronous. */
  processStartTime(pid: number): number | null;
  focusSessionWindow(pid: number): Promise<{ ok: boolean; title?: string; reason?: string }>;
}
