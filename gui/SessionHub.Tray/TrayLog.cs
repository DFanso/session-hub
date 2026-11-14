using System;
using System.Globalization;
using System.IO;

namespace SessionHub.Tray;

/// <summary>
/// Appends unexpected errors to <c>run\tray.log</c>: time, where, exception type, HResult and stack.
/// Never the exception message, which may quote session text. The file is cut at 1 MiB.
/// </summary>
internal static class TrayLog
{
    private const long MaxBytes = 1_048_576;
    private static readonly object Gate = new();
    private static string? path;

    public static void Init(string runDir) => path = Path.Combine(runDir, "tray.log");

    public static void Error(string where, Exception? e)
    {
        var file = path;
        if (file is null) return;
        try
        {
            var line = string.Create(
                CultureInfo.InvariantCulture,
                $"{DateTimeOffset.UtcNow:O} {where}: {e?.GetType().FullName ?? "unknown"} 0x{e?.HResult ?? 0:x8}{Environment.NewLine}{e?.StackTrace}{Environment.NewLine}");
            lock (Gate)
            {
                var info = new FileInfo(file);
                if (info.Exists && info.Length > MaxBytes) File.WriteAllText(file, "");
                File.AppendAllText(file, line);
            }
        }
        catch (Exception)
        {
            // Logging must never take the tray down.
        }
    }
}
