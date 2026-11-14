import type { Platform, RunValueName } from "../types";
import { ensurePrivateDir, isPrivateDir } from "./acl";
import { clearAutostart, getAutostart, setAutostart } from "./autostart";
import { type FocusResult, focusSessionWindow } from "./focus";
import { processImagePath, processStartTime } from "./process";
import { mutexExists, signalEvent, TRAY_INSTANCE_MUTEX, TRAY_QUIT_EVENT } from "./trayquit";

export interface WindowsPlatformOptions {
  /**
   * Registry value actually written for each Run value name. Tests map both to throwaway
   * `SessionHubTest-` names; the default is the name itself.
   */
  runValueNames?: Partial<Record<RunValueName, string>>;
  /** Event signalTrayQuit sets. Tests pass a throwaway name; the default is the tray's. */
  trayQuitEvent?: string;
  /** Mutex trayInstanceExists looks for. Tests pass a throwaway name; the default is the tray's. */
  trayInstanceMutex?: string;
}

export class WindowsPlatform implements Platform {
  constructor(private readonly opts: WindowsPlatformOptions = {}) {}

  private requireWindows(): void {
    if (process.platform !== "win32") throw new Error("windows only");
  }

  private valueName(name: RunValueName): string {
    return this.opts.runValueNames?.[name] ?? name;
  }

  async ensurePrivateDir(dir: string): Promise<void> {
    this.requireWindows();
    await ensurePrivateDir(dir);
  }

  async isPrivateDir(dir: string): Promise<boolean> {
    this.requireWindows();
    return await isPrivateDir(dir);
  }

  async setAutostart(name: RunValueName, exePath: string): Promise<void> {
    this.requireWindows();
    await setAutostart(this.valueName(name), exePath);
  }

  async clearAutostart(name: RunValueName): Promise<void> {
    this.requireWindows();
    await clearAutostart(this.valueName(name));
  }

  async getAutostart(name: RunValueName): Promise<string | null> {
    this.requireWindows();
    return await getAutostart(this.valueName(name));
  }

  async signalTrayQuit(): Promise<boolean> {
    this.requireWindows();
    return signalEvent(this.opts.trayQuitEvent ?? TRAY_QUIT_EVENT);
  }

  async trayInstanceExists(): Promise<boolean> {
    this.requireWindows();
    return mutexExists(this.opts.trayInstanceMutex ?? TRAY_INSTANCE_MUTEX);
  }

  processImagePath(pid: number): string | null {
    this.requireWindows();
    return processImagePath(pid);
  }

  processStartTime(pid: number): number | null {
    this.requireWindows();
    return processStartTime(pid);
  }

  focusSessionWindow(pid: number): Promise<FocusResult> {
    return focusSessionWindow(pid);
  }
}

export function createWindowsPlatform(opts?: WindowsPlatformOptions): WindowsPlatform {
  return new WindowsPlatform(opts);
}
