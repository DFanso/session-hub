namespace SessionHub.Core.Layout;

public static class WindowLayout
{
    public const double MinWidth = 720;
    public const double MinHeight = 480;
    public const double WideBreakpoint = 900;
    public const double TitleBarDip = 32;

    public static double ListWidth(double windowWidthDip) => windowWidthDip >= WideBreakpoint ? 300 : 240;
    public static bool ShowSubtitles(double windowWidthDip) => windowWidthDip >= WideBreakpoint;
    public static bool StackStatusBoxes(double windowWidthDip) => windowWidthDip < WideBreakpoint;

    /// <summary>
    /// Window rect to use on start. <paramref name="workAreas"/>[0] is the primary monitor's work area.
    /// The saved rect is kept when at least half of it is visible and its top 32 DIP strip lies fully inside
    /// one work area (so it can be dragged). Otherwise it is centred on the primary, sized at least
    /// 720x480 DIP (scaled by <paramref name="primaryScale"/>) and at most the primary work area.
    /// When <paramref name="savedScale"/> is known (above 0), the saved size is first converted from
    /// that monitor's pixels to the primary's, so the window keeps its size in DIP.
    /// With no work areas the saved rect is returned unchanged.
    /// </summary>
    public static RectPx Restore(RectPx saved, IReadOnlyList<RectPx> workAreas, double primaryScale = 1.0, double savedScale = 0)
    {
        if (workAreas.Count == 0) return saved;
        if (!double.IsFinite(primaryScale) || primaryScale <= 0) primaryScale = 1.0;

        var area = (long)saved.W * saved.H;
        if (area > 0)
        {
            var strip = (int)Math.Ceiling(TitleBarDip * primaryScale);
            var visible = false;
            var stripOk = false;
            foreach (var wa in workAreas)
            {
                var iw = Math.Min(saved.Right, wa.Right) - Math.Max(saved.X, wa.X);
                var ih = Math.Min(saved.Bottom, wa.Bottom) - Math.Max(saved.Y, wa.Y);
                if (iw > 0 && ih > 0 && (long)iw * ih * 2 >= area) visible = true;
                if (saved.X >= wa.X && saved.Right <= wa.Right && saved.Y >= wa.Y
                    && saved.Y + Math.Min(strip, saved.H) <= wa.Bottom)
                    stripOk = true;
            }
            if (visible && stripOk) return saved;
        }

        if (double.IsFinite(savedScale) && savedScale > 0 && Math.Abs(savedScale - primaryScale) > 1e-9)
        {
            var f = primaryScale / savedScale;
            saved = saved with { W = (int)Math.Round(saved.W * f), H = (int)Math.Round(saved.H * f) };
        }

        var primary = workAreas[0];
        var minW = (int)Math.Ceiling(MinWidth * primaryScale);
        var minH = (int)Math.Ceiling(MinHeight * primaryScale);
        var w = Math.Max(0, Math.Min(Math.Max(saved.W, minW), primary.W));
        var h = Math.Max(0, Math.Min(Math.Max(saved.H, minH), primary.H));
        return new RectPx(primary.X + (primary.W - w) / 2, primary.Y + (primary.H - h) / 2, w, h);
    }
}
