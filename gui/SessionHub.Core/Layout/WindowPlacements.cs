using SessionHub.Core.Settings;

namespace SessionHub.Core.Layout;

/// <summary>
/// The window's saved placement in <c>gui.json</c>: physical pixels of the monitor the window was on
/// (WPF restore bounds in DIP times that monitor's scale), restored through <see cref="WindowLayout.Restore"/>.
/// </summary>
public static class WindowPlacements
{
    public const double DefaultWidth = 1000;
    public const double DefaultHeight = 620;

    // Anything past this is not a real screen coordinate (and would overflow int).
    private const double MaxCoordinate = 1_000_000;

    /// <summary>Restore bounds in DIP, converted to pixels with <paramref name="scale"/> (the window's monitor).</summary>
    public static WindowPlacement ToSaved(double left, double top, double width, double height, double scale, bool maximized)
    {
        if (!double.IsFinite(scale) || scale <= 0) scale = 1.0;
        return new WindowPlacement(
            Math.Round(left * scale, MidpointRounding.AwayFromZero),
            Math.Round(top * scale, MidpointRounding.AwayFromZero),
            Math.Round(width * scale, MidpointRounding.AwayFromZero),
            Math.Round(height * scale, MidpointRounding.AwayFromZero),
            maximized,
            scale);
    }

    /// <summary>
    /// Where the window opens (px). A usable saved rect goes through <see cref="WindowLayout.Restore"/>;
    /// none, or a broken one, gives the default 1000 x 620 DIP centred on the primary work area
    /// (<paramref name="workAreas"/>[0]) and no bigger than it.
    /// </summary>
    public static RectPx Initial(WindowPlacement? saved, IReadOnlyList<RectPx> workAreas, double primaryScale)
    {
        ArgumentNullException.ThrowIfNull(workAreas);
        if (!double.IsFinite(primaryScale) || primaryScale <= 0) primaryScale = 1.0;
        if (saved is not null && Usable(saved))
        {
            var rect = new RectPx((int)saved.Left, (int)saved.Top, (int)saved.Width, (int)saved.Height);
            return WindowLayout.Restore(rect, workAreas, primaryScale, double.IsFinite(saved.Scale) ? saved.Scale : 0);
        }

        var w = (int)Math.Round(DefaultWidth * primaryScale);
        var h = (int)Math.Round(DefaultHeight * primaryScale);
        if (workAreas.Count == 0) return new RectPx(0, 0, w, h);
        var primary = workAreas[0];
        w = Math.Max(0, Math.Min(w, primary.W));
        h = Math.Max(0, Math.Min(h, primary.H));
        return new RectPx(primary.X + ((primary.W - w) / 2), primary.Y + ((primary.H - h) / 2), w, h);
    }

    private static bool Usable(WindowPlacement p) =>
        Finite(p.Left) && Finite(p.Top) && Finite(p.Width) && Finite(p.Height) && p.Width >= 1 && p.Height >= 1;

    private static bool Finite(double v) => double.IsFinite(v) && Math.Abs(v) <= MaxCoordinate;
}
