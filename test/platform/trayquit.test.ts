import { dlopen } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { createWindowsPlatform } from "../../src/platform/windows";
import { processImagePath } from "../../src/platform/windows/process";
import {
  mutexExists,
  signalEvent,
  TRAY_INSTANCE_MUTEX,
  TRAY_QUIT_EVENT,
} from "../../src/platform/windows/trayquit";

// Only throwaway events and mutexes this test creates itself: the real tray's are never opened here.

const win = process.platform === "win32";
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;

let seq = 0;
function throwawayName(): string {
  seq += 1;
  return `Local\\SessionHubTest-${process.pid}-${Date.now()}-${seq}`;
}

function wide(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf16le");
}

/** Creates an auto-reset, non-signalled event; runs `fn` with a probe that consumes one signal. */
async function withEvent(
  name: string,
  fn: (signalled: () => boolean) => void | Promise<void>,
): Promise<void> {
  const { symbols, close } = dlopen("kernel32.dll", {
    CreateEventW: { args: ["ptr", "i32", "i32", "ptr"], returns: "ptr" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  });
  try {
    const h = symbols.CreateEventW(null, 0, 0, wide(name));
    expect(h).not.toBeNull();
    if (h === null) return;
    try {
      await fn(() => {
        const r = symbols.WaitForSingleObject(h, 0);
        expect([WAIT_OBJECT_0, WAIT_TIMEOUT]).toContain(r);
        return r === WAIT_OBJECT_0;
      });
    } finally {
      symbols.CloseHandle(h);
    }
  } finally {
    close();
  }
}

describe("tray quit event", () => {
  test("the tray's event name", () => {
    expect(TRAY_QUIT_EVENT).toBe("Local\\SessionHub.Tray.Quit");
  });

  test.skipIf(!win)("signalEvent sets an existing event and reports true", async () => {
    const name = throwawayName();
    await withEvent(name, (signalled) => {
      expect(signalled()).toBe(false);
      expect(signalEvent(name)).toBe(true);
      expect(signalled()).toBe(true);
      expect(signalled()).toBe(false); // auto-reset: one signal, one wake
    });
  });

  test.skipIf(!win)("signalEvent reports false when no such event exists", () => {
    expect(signalEvent(throwawayName())).toBe(false);
  });

  test.skipIf(!win)("platform.signalTrayQuit sets the configured event only", async () => {
    const name = throwawayName();
    const platform = createWindowsPlatform({ trayQuitEvent: name });
    expect(await platform.signalTrayQuit()).toBe(false);
    await withEvent(name, async (signalled) => {
      expect(await platform.signalTrayQuit()).toBe(true);
      expect(signalled()).toBe(true);
    });
  });

  test.skipIf(win)("signalTrayQuit is windows only", async () => {
    await expect(createWindowsPlatform().signalTrayQuit()).rejects.toThrow("windows only");
  });
});

describe("tray instance mutex", () => {
  test("the tray's mutex name", () => {
    // The exact characters, so a dropped backslash cannot pass unnoticed.
    expect(TRAY_INSTANCE_MUTEX).toBe(
      ["Local", "SessionHub.Tray.Instance"].join(String.fromCharCode(92)),
    );
  });

  test.skipIf(!win)("mutexExists sees a mutex only while it is open", async () => {
    const name = throwawayName();
    expect(mutexExists(name)).toBe(false);
    const { symbols, close } = dlopen("kernel32.dll", {
      CreateMutexW: { args: ["ptr", "i32", "ptr"], returns: "ptr" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
    });
    try {
      const h = symbols.CreateMutexW(null, 0, wide(name));
      expect(h).not.toBeNull();
      if (h === null) return;
      try {
        expect(mutexExists(name)).toBe(true);
        const platform = createWindowsPlatform({ trayInstanceMutex: name });
        expect(await platform.trayInstanceExists()).toBe(true);
      } finally {
        symbols.CloseHandle(h);
      }
      expect(mutexExists(name)).toBe(false);
    } finally {
      close();
    }
  });
});

describe("processImagePath", () => {
  test.skipIf(!win)("returns this process's own exe, again on a second call", () => {
    const image = processImagePath(process.pid);
    expect(image?.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(createWindowsPlatform().processImagePath(process.pid)?.toLowerCase()).toBe(
      process.execPath.toLowerCase(),
    );
  });

  test.skipIf(!win)("null for a pid that does not exist or is invalid", () => {
    // Windows pids are multiples of 4: an odd pid never names a process.
    expect(processImagePath(0x7fff_fff1)).toBeNull();
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 33]) expect(processImagePath(bad)).toBeNull();
  });
});
