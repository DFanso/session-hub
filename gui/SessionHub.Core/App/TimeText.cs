using System.Globalization;

namespace SessionHub.Core.App;

/// <summary>Short time texts used by the panel, the same in every culture.</summary>
public static class TimeText
{
    /// <summary>"just now", "42 s ago", "2 min ago", "3 h ago" or "2 d ago". A time in the future is "just now".</summary>
    public static string Ago(long unixMs, DateTimeOffset now)
    {
        var seconds = (long)Math.Round((now.ToUnixTimeMilliseconds() - unixMs) / 1000.0);
        if (seconds < 10) return "just now";
        if (seconds < 60) return $"{seconds} s ago";
        if (seconds < 3600) return $"{(long)Math.Round(seconds / 60.0)} min ago";
        if (seconds < 86_400) return $"{(long)Math.Round(seconds / 3600.0)} h ago";
        return $"{(long)Math.Round(seconds / 86_400.0)} d ago";
    }

    /// <summary>"Fri, Nov 13".</summary>
    public static string Day(DateTimeOffset local) =>
        local.ToString("ddd, MMM d", CultureInfo.InvariantCulture);

    /// <summary>
    /// Local "HH:mm" of an ISO timestamp when it falls on <paramref name="now"/>'s local day,
    /// otherwise "Nov 12 · 07:39"; empty when it does not parse.
    /// </summary>
    public static string Stamp(string isoTs, TimeZoneInfo zone, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(zone);
        if (!DateTimeOffset.TryParse(isoTs, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)) return "";
        var local = TimeZoneInfo.ConvertTime(t, zone);
        var today = TimeZoneInfo.ConvertTime(now, zone);
        var clock = local.ToString("HH:mm", CultureInfo.InvariantCulture);
        return local.Date == today.Date ? clock : $"{local.ToString("MMM d", CultureInfo.InvariantCulture)} · {clock}";
    }

    /// <summary>Local "HH:mm" of an ISO timestamp, or empty when it does not parse.</summary>
    public static string Clock(string isoTs, TimeZoneInfo zone)
    {
        ArgumentNullException.ThrowIfNull(zone);
        return DateTimeOffset.TryParse(isoTs, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)
            ? TimeZoneInfo.ConvertTime(t, zone).ToString("HH:mm", CultureInfo.InvariantCulture)
            : "";
    }
}
