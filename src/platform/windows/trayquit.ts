import { dlopen } from "bun:ffi";

/** Named auto-reset event the tray waits on; setting it makes the tray quit cleanly. Quit only, no data. */
export const TRAY_QUIT_EVENT = "Local\\SessionHub.Tray.Quit";

const EVENT_MODIFY_STATE = 0x0002;

/**
 * Sets an existing named event. False when no event of that name exists or this user may not open
 * it; never creates one.
 */
export function signalEvent(name: string): boolean {
  const { symbols, close } = dlopen("kernel32.dll", {
    OpenEventW: { args: ["u32", "i32", "ptr"], returns: "ptr" },
    SetEvent: { args: ["ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  });
  try {
    const h = symbols.OpenEventW(EVENT_MODIFY_STATE, 0, Buffer.from(`${name}\0`, "utf16le"));
    if (h === null) return false;
    try {
      return symbols.SetEvent(h) !== 0;
    } finally {
      symbols.CloseHandle(h);
    }
  } finally {
    close();
  }
}

/** Named mutex the running tray owns (its single-instance guard). */
export const TRAY_INSTANCE_MUTEX = "Local\\SessionHub.Tray.Instance";

const SYNCHRONIZE = 0x0010_0000;

/**
 * True when a named mutex of that name exists and this user may open it. A mutex held by an elevated
 * process may not open from here, so false means "not visible", not proof of absence.
 */
export function mutexExists(name: string): boolean {
  const { symbols, close } = dlopen("kernel32.dll", {
    OpenMutexW: { args: ["u32", "i32", "ptr"], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  });
  try {
    const h = symbols.OpenMutexW(SYNCHRONIZE, 0, Buffer.from(`${name}\0`, "utf16le"));
    if (h === null) return false;
    symbols.CloseHandle(h);
    return true;
  } finally {
    close();
  }
}
