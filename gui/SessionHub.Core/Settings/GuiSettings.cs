namespace SessionHub.Core.Settings;

/// <summary>
/// The window's restore bounds in pixels of the monitor it was on, and that monitor's scale
/// (0: unknown, from a gui.json written before the scale was kept).
/// </summary>
public sealed record WindowPlacement(double Left, double Top, double Width, double Height, bool Maximized, double Scale = 0);

/// <summary>The tray's own settings, kept in <c>gui.json</c>.</summary>
public sealed class GuiSettings
{
    public const int MaxDraftChars = 20_000;

    public bool Notifications { get; set; } = true;

    public WindowPlacement? Window { get; set; }

    /// <summary>Unsent message text by session id.</summary>
    public Dictionary<string, string> Drafts { get; set; } = [];

    /// <summary>
    /// When each draft's session was last in a snapshot (or the draft was edited), by session id. A draft
    /// with no entry (a gui.json from before this field) counts as seen when the tray loads it.
    /// </summary>
    public Dictionary<string, DateTimeOffset> DraftsSeen { get; set; } = [];
}
