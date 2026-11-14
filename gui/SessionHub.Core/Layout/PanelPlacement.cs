namespace SessionHub.Core.Layout;

public readonly record struct RectPx(int X, int Y, int W, int H)
{
    public int Right => X + W;
    public int Bottom => Y + H;
}

public enum TaskbarEdge { Bottom, Top, Left, Right }

public static class PanelPlacement
{
    public const double WidthDip = 404;
    public const double MaxHeightDip = 760;
    public const double GapDip = 12;

    /// <summary>
    /// Panel rect in physical pixels, inside <paramref name="workArea"/>. <paramref name="scale"/> is the
    /// monitor DPI scale (1.0 = 96 DPI); a value that is not a positive finite number is treated as 1.0.
    /// A work area with no size gives a zero-size rect at its origin.
    /// </summary>
    public static RectPx Compute(RectPx workArea, TaskbarEdge edge, double scale)
    {
        if (workArea.W <= 0 || workArea.H <= 0) return new RectPx(workArea.X, workArea.Y, 0, 0);
        if (!double.IsFinite(scale) || scale <= 0) scale = 1.0;

        var gap = (int)Math.Round(GapDip * scale);
        var w = Math.Clamp((int)Math.Round(WidthDip * scale), 0, Math.Max(0, workArea.W - gap));
        var h = Math.Clamp(Math.Min((int)Math.Round(MaxHeightDip * scale), workArea.H - 2 * gap), 0, workArea.H);

        var x = edge == TaskbarEdge.Left ? workArea.X + gap : workArea.Right - w - gap;
        var y = edge == TaskbarEdge.Top ? workArea.Y + gap : workArea.Bottom - h - gap;

        x = Math.Clamp(x, workArea.X, workArea.Right - w);
        y = Math.Clamp(y, workArea.Y, workArea.Bottom - h);
        return new RectPx(x, y, w, h);
    }
}
