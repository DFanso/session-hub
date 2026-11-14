import { dlopen } from "bun:ffi";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** Longest path QueryFullProcessImageNameW can return, in UTF-16 units. */
const MAX_PATH_UNITS = 32_768;
/** 100 ns FILETIME ticks between 1601-01-01 and 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

function openKernel32() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
    GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  });
}

type Kernel32 = ReturnType<typeof openKernel32>["symbols"];
type Handle = NonNullable<ReturnType<Kernel32["OpenProcess"]>>;
/** Loaded once and kept: the bridge asks on every poll, and dlopen compiles its call stubs each time. */
let kernel32: Kernel32 | null = null;
/** Reused between calls (64 KiB); every call sets `size` before using it. */
const buf = new Uint16Array(MAX_PATH_UNITS);
const size = new Uint32Array(1);
/** Four FILETIMEs (creation, exit, kernel, user), each two u32 (low, high). */
const times = new Uint32Array(8);

/** Runs `fn` with a query handle to the process; null when the pid is invalid or cannot be opened. */
function withProcess<T>(pid: number, fn: (k: Kernel32, h: Handle) => T): T | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return null;
  kernel32 ??= openKernel32().symbols;
  const k = kernel32;
  const h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (h === null) return null;
  try {
    return fn(k, h);
  } finally {
    k.CloseHandle(h);
  }
}

/**
 * Full Win32 path of the process's executable, or null when the pid is invalid, gone, or cannot be
 * opened (for example a protected process). The handle is closed on every path.
 */
export function processImagePath(pid: number): string | null {
  return withProcess(pid, (k, h) => {
    size[0] = MAX_PATH_UNITS;
    if (k.QueryFullProcessImageNameW(h, 0, buf, size) === 0) return null;
    const units = size[0] ?? 0;
    return Buffer.from(buf.buffer, 0, units * 2).toString("utf16le");
  });
}

/**
 * When the process started (GetProcessTimes creation time), in epoch ms; null when the pid is
 * invalid, gone, or cannot be opened. Together with the pid it names one process: a pid reused later
 * has a later start time. The handle is closed on every path.
 */
export function processStartTime(pid: number): number | null {
  return withProcess(pid, (k, h) => {
    times.fill(0);
    const ft = (i: number) => times.subarray(i * 2, i * 2 + 2);
    if (k.GetProcessTimes(h, ft(0), ft(1), ft(2), ft(3)) === 0) return null;
    const ticks = (BigInt(times[1] ?? 0) << 32n) | BigInt(times[0] ?? 0);
    if (ticks <= FILETIME_UNIX_EPOCH) return null;
    return Number((ticks - FILETIME_UNIX_EPOCH) / 10_000n);
  });
}
