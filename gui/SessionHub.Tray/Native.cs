using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SessionHub.Core.App;
using SessionHub.Core.Layout;

// Every native library the tray loads (user32, kernel32, shell32, shcore) is a system DLL: never
// search the application directory or the current directory for it (CA5392, DLL planting).
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace SessionHub.Tray;

/// <summary>Outcome of <see cref="Native.FocusProcessWindow"/>.</summary>
public enum FocusResult
{
    Focused,
    NoWindow,
    Denied,
    BadPid,
}

/// <summary>Win32 calls the tray needs: Jump, taskbar position, monitor DPI, process tree.</summary>
internal static partial class Native
{
    /// <summary>Signalled by <c>hub install</c>/<c>hub uninstall</c>; the tray quits. Carries no data.</summary>
    public const string QuitEventName = "Local\\SessionHub.Tray.Quit";

    /// <summary>Held by the running tray.</summary>
    public const string InstanceMutexName = "Local\\SessionHub.Tray.Instance";

    /// <summary>A second start sets it; the running tray opens its panel.</summary>
    public const string ShowEventName = "Local\\SessionHub.Tray.Show";

    private const int SW_RESTORE = 9;
    private const uint GW_OWNER = 4;
    private const uint ABM_GETTASKBARPOS = 5;
    private const uint MONITOR_DEFAULTTOPRIMARY = 1;
    private const uint MONITOR_DEFAULTTONEAREST = 2;
    private const uint TH32CS_SNAPPROCESS = 0x2;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int SM_CXSMICON = 49;
    private const int SM_CXSIZEFRAME = 32;
    private const int SM_CYSIZEFRAME = 33;
    private const int SM_CXPADDEDBORDER = 92;
    private const uint MONITORINFOF_PRIMARY = 1;

    /// <summary>
    /// Brings the window of a session's terminal to the front: the first visible, unowned top-level
    /// window of the process or of its nearest parent that has one (the terminal usually owns it).
    /// Restores it when minimized. The click that asked for it gives this process the foreground right.
    /// </summary>
    public static FocusResult FocusProcessWindow(int pid)
    {
        if (pid <= 0) return FocusResult.BadPid;
        var processes = ProcessTable();
        ProcessEntry? Lookup(int p) =>
            processes.TryGetValue(p, out var e) && CreationTime(p) is { } created ? new ProcessEntry(e.Parent, created) : null;
        foreach (var id in ParentWalk.Chain(pid, Lookup))
        {
            // The shell is no session's terminal: never bring a File Explorer window forward instead.
            if (processes[id].Exe.Equals("explorer.exe", StringComparison.OrdinalIgnoreCase)) break;
            var hwnd = FindMainWindow(id);
            if (hwnd == IntPtr.Zero) continue;
            if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
            return SetForegroundWindow(hwnd) ? FocusResult.Focused : FocusResult.Denied;
        }

        return FocusResult.NoWindow;
    }

    private static IntPtr FindMainWindow(int pid)
    {
        var found = IntPtr.Zero;
        EnumWindows(
            (hwnd, _) =>
            {
                GetWindowThreadProcessId(hwnd, out var owner);
                if (owner != (uint)pid || !IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
                found = hwnd;
                return false;
            },
            IntPtr.Zero);
        return found;
    }

    /// <summary>Every process's parent id and file name, from one Toolhelp snapshot.</summary>
    private static Dictionary<int, (int Parent, string Exe)> ProcessTable()
    {
        var table = new Dictionary<int, (int Parent, string Exe)>();
        var snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return table;
        try
        {
            var entry = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
            for (var ok = Process32FirstW(snap, ref entry); ok; ok = Process32NextW(snap, ref entry))
            {
                table[(int)entry.th32ProcessID] = ((int)entry.th32ParentProcessID, entry.szExeFile ?? "");
            }
        }
        finally
        {
            CloseHandle(snap);
        }

        return table;
    }

    private static long? CreationTime(int pid)
    {
        var h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            return GetProcessTimes(h, out var created, out _, out _, out _) ? created : null;
        }
        finally
        {
            CloseHandle(h);
        }
    }

    /// <summary>The taskbar edge, the work area of its monitor (px) and that monitor's DPI scale.</summary>
    public static (TaskbarEdge Edge, RectPx WorkArea, double Scale) TaskbarPlacement()
    {
        var data = new APPBARDATA { cbSize = (uint)Marshal.SizeOf<APPBARDATA>() };
        var edge = TaskbarEdge.Bottom;
        IntPtr monitor;
        if (SHAppBarMessage(ABM_GETTASKBARPOS, ref data) != IntPtr.Zero)
        {
            edge = data.uEdge switch
            {
                0 => TaskbarEdge.Left,
                1 => TaskbarEdge.Top,
                2 => TaskbarEdge.Right,
                _ => TaskbarEdge.Bottom,
            };
            monitor = MonitorFromRect(ref data.rc, MONITOR_DEFAULTTONEAREST);
        }
        else
        {
            monitor = MonitorFromPoint(default, MONITOR_DEFAULTTOPRIMARY);
        }

        var info = new MONITORINFO { cbSize = (uint)Marshal.SizeOf<MONITORINFO>() };
        var work = GetMonitorInfoW(monitor, ref info)
            ? new RectPx(info.rcWork.Left, info.rcWork.Top, info.rcWork.Right - info.rcWork.Left, info.rcWork.Bottom - info.rcWork.Top)
            : new RectPx(0, 0, 0, 0);
        return (edge, work, MonitorScale(monitor));
    }

    public static double MonitorScale(IntPtr monitor) =>
        GetDpiForMonitor(monitor, 0, out var dpiX, out _) == 0 && dpiX > 0 ? dpiX / 96.0 : 1.0;

    /// <summary>The small-icon size of the taskbar's monitor (16 at 100 %, 20 at 125 %, 24 at 150 %, 32 at 200 %).</summary>
    public static int TrayIconSize()
    {
        var (_, _, scale) = TaskbarPlacement();
        var px = GetSystemMetricsForDpi(SM_CXSMICON, (uint)Math.Round(96 * scale));
        return px > 0 ? px : 16;
    }

    /// <summary>The resize frame plus padded border (px) at a DPI scale: how far a maximized window reaches past its monitor.</summary>
    public static (int X, int Y) MaximizedFrame(double scale)
    {
        var dpi = (uint)Math.Round(96 * (double.IsFinite(scale) && scale > 0 ? scale : 1.0));
        var padded = GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
        return (GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + padded, GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + padded);
    }

    /// <summary>Moves and sizes a window in physical pixels, without activating it.</summary>
    public static void PlaceWindow(IntPtr hwnd, RectPx r) =>
        SetWindowPos(hwnd, IntPtr.Zero, r.X, r.Y, r.W, r.H, 0x0010 /* SWP_NOACTIVATE */ | 0x0004 /* SWP_NOZORDER */);

    public static void Activate(IntPtr hwnd) => SetForegroundWindow(hwnd);

    /// <summary>A second start (which the user just launched) lets the running tray (that pid only) take the foreground for its panel.</summary>
    public static void AllowForegroundFor(int pid) => AllowSetForegroundWindow(pid);

    /// <summary>
    /// Every monitor's work area (px), the primary first, and the primary's DPI scale. Used to restore
    /// the window onto a monitor that still exists.
    /// </summary>
    public static (IReadOnlyList<RectPx> WorkAreas, double PrimaryScale) WorkAreas()
    {
        var areas = new List<RectPx>();
        var primaryScale = 1.0;
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (monitor, _, _, _) =>
        {
            var info = new MONITORINFO { cbSize = (uint)Marshal.SizeOf<MONITORINFO>() };
            if (!GetMonitorInfoW(monitor, ref info)) return true;
            var work = new RectPx(info.rcWork.Left, info.rcWork.Top, info.rcWork.Right - info.rcWork.Left, info.rcWork.Bottom - info.rcWork.Top);
            if ((info.dwFlags & MONITORINFOF_PRIMARY) != 0)
            {
                areas.Insert(0, work);
                primaryScale = MonitorScale(monitor);
            }
            else
            {
                areas.Add(work);
            }

            return true;
        }, IntPtr.Zero);
        return (areas, primaryScale);
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct APPBARDATA
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uCallbackMessage;
        public uint uEdge;
        public RECT rc;
        public IntPtr lParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public uint cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr lParam);

    [LibraryImport("user32.dll")]
    private static partial uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsWindowVisible(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    private static partial IntPtr GetWindow(IntPtr hwnd, uint cmd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsIconic(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ShowWindow(IntPtr hwnd, int cmd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetForegroundWindow(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AllowSetForegroundWindow(int pid);

    [LibraryImport("user32.dll")]
    private static partial int GetSystemMetricsForDpi(int index, uint dpi);

    [LibraryImport("user32.dll")]
    private static partial IntPtr MonitorFromRect(ref RECT rect, uint flags);

    [LibraryImport("user32.dll")]
    private static partial IntPtr MonitorFromPoint(POINT pt, uint flags);

    [LibraryImport("user32.dll", EntryPoint = "GetMonitorInfoW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);

    [LibraryImport("shcore.dll")]
    private static partial int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);

    [LibraryImport("shell32.dll")]
    private static partial IntPtr SHAppBarMessage(uint message, ref APPBARDATA data);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(IntPtr handle);
}
