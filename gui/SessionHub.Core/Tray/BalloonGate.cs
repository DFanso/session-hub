namespace SessionHub.Core.Tray;

/// <summary>
/// Decides when the tray shows a balloon: only when a session's waiting count rises or an approval
/// opens, at most once per session per 5 minutes, and never when notifications are off.
/// A suppressed rise does not start a new window.
/// </summary>
public sealed class BalloonGate
{
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(5);

    private readonly Dictionary<string, DateTimeOffset> lastShown = [];

    public bool Notifications { get; set; } = true;

    public bool ShouldShow(string sessionId, int itemsBefore, int itemsAfter, bool approvalBefore, bool approvalAfter, DateTimeOffset now)
    {
        if (!Notifications) return false;
        var rise = itemsAfter > itemsBefore || (!approvalBefore && approvalAfter);
        if (!rise) return false;
        if (lastShown.TryGetValue(sessionId, out var last) && now - last < Window) return false;
        lastShown[sessionId] = now;
        return true;
    }
}
