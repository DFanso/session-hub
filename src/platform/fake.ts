import type { Platform, RunValueName } from "./types.ts";

export interface PlatformCall {
  method: keyof Platform;
  args: unknown[];
}

/**
 * Test double: records every call; `private` decides what isPrivateDir reports. Run values live in
 * an in-memory map. The `on*` hooks let a test observe call order or play a running tray.
 */
export class FakePlatform implements Platform {
  readonly calls: PlatformCall[] = [];
  readonly runValues = new Map<RunValueName, string>();
  private: boolean;
  onSetAutostart: (name: RunValueName, exePath: string) => void = () => {};
  onClearAutostart: (name: RunValueName) => void = () => {};
  /** What signalTrayQuit reports; default false (no tray holds the event). */
  onSignalTrayQuit: () => boolean = () => false;
  /** What trayInstanceExists reports; default false. */
  onTrayInstanceExists: () => boolean = () => false;
  /** What processImagePath reports; default null (unknown pid). */
  onProcessImagePath: (pid: number) => string | null = () => null;
  /** What processStartTime reports; default null (cannot be queried). */
  onProcessStartTime: (pid: number) => number | null = () => null;

  constructor(opts: { private?: boolean } = {}) {
    this.private = opts.private ?? true;
  }

  async ensurePrivateDir(dir: string): Promise<void> {
    this.calls.push({ method: "ensurePrivateDir", args: [dir] });
    this.private = true;
  }

  async isPrivateDir(dir: string): Promise<boolean> {
    this.calls.push({ method: "isPrivateDir", args: [dir] });
    return this.private;
  }

  async setAutostart(name: RunValueName, exePath: string): Promise<void> {
    this.calls.push({ method: "setAutostart", args: [name, exePath] });
    this.runValues.set(name, `"${exePath}"`);
    this.onSetAutostart(name, exePath);
  }

  async clearAutostart(name: RunValueName): Promise<void> {
    this.calls.push({ method: "clearAutostart", args: [name] });
    this.runValues.delete(name);
    this.onClearAutostart(name);
  }

  async getAutostart(name: RunValueName): Promise<string | null> {
    this.calls.push({ method: "getAutostart", args: [name] });
    return this.runValues.get(name) ?? null;
  }

  async signalTrayQuit(): Promise<boolean> {
    this.calls.push({ method: "signalTrayQuit", args: [] });
    return this.onSignalTrayQuit();
  }

  async trayInstanceExists(): Promise<boolean> {
    this.calls.push({ method: "trayInstanceExists", args: [] });
    return this.onTrayInstanceExists();
  }

  processImagePath(pid: number): string | null {
    this.calls.push({ method: "processImagePath", args: [pid] });
    return this.onProcessImagePath(pid);
  }

  processStartTime(pid: number): number | null {
    this.calls.push({ method: "processStartTime", args: [pid] });
    return this.onProcessStartTime(pid);
  }

  async focusSessionWindow(pid: number): Promise<{ ok: boolean; title?: string; reason?: string }> {
    this.calls.push({ method: "focusSessionWindow", args: [pid] });
    return { ok: false, reason: "fake platform" };
  }
}
