using SessionHub.Core.Layout;

namespace SessionHub.Tests;

public class LayoutTests
{
    public static TheoryData<int, int, int, int, double, TaskbarEdge> Cases()
    {
        var d = new TheoryData<int, int, int, int, double, TaskbarEdge>();
        foreach (var (x, y, w, h) in new[] { (0, 0, 1920, 1040), (0, 0, 1366, 728), (1920, 40, 1920, 1040) })
            foreach (var s in new[] { 1.0, 1.5, 2.0 })
                foreach (var e in Enum.GetValues<TaskbarEdge>())
                    d.Add(x, y, w, h, s, e);
        return d;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Panel_inside_work_area_with_scaled_width(int x, int y, int w, int h, double scale, TaskbarEdge edge)
    {
        var wa = new RectPx(x, y, w, h);
        var r = PanelPlacement.Compute(wa, edge, scale);
        Assert.Equal((int)Math.Round(404 * scale), r.W);
        Assert.True(r.H > 0);
        Assert.True(r.X >= wa.X && r.Y >= wa.Y && r.Right <= wa.Right && r.Bottom <= wa.Bottom);
        var gap = (int)Math.Round(12 * scale);
        if (edge == TaskbarEdge.Left) Assert.Equal(wa.X + gap, r.X); else Assert.Equal(wa.Right - gap, r.Right);
        if (edge == TaskbarEdge.Top) Assert.Equal(wa.Y + gap, r.Y); else Assert.Equal(wa.Bottom - gap, r.Bottom);
    }

    [Fact]
    public void Panel_height_is_capped_at_760_dip_or_work_area_minus_24()
    {
        Assert.Equal(760, PanelPlacement.Compute(new RectPx(0, 0, 1920, 1040), TaskbarEdge.Bottom, 1.0).H);
        Assert.Equal(1040 - 2 * (int)Math.Round(12 * 1.5), PanelPlacement.Compute(new RectPx(0, 0, 1920, 1040), TaskbarEdge.Bottom, 1.5).H);
        Assert.Equal(728 - 24, PanelPlacement.Compute(new RectPx(0, 0, 1366, 728), TaskbarEdge.Bottom, 1.0).H);
    }

    [Theory]
    [InlineData(TaskbarEdge.Bottom)]
    [InlineData(TaskbarEdge.Top)]
    [InlineData(TaskbarEdge.Left)]
    [InlineData(TaskbarEdge.Right)]
    public void Tiny_work_area_clamps_never_negative_never_outside(TaskbarEdge edge)
    {
        var wa = new RectPx(0, 0, 800, 560);
        var r = PanelPlacement.Compute(wa, edge, 2.0);
        const int gap = 24;
        Assert.Equal(560 - 2 * gap, r.H);
        Assert.Equal(800 - gap, r.W);
        Assert.True(r.W >= 0 && r.H >= 0);
        Assert.True(r.X >= 0 && r.Y >= 0 && r.Right <= 800 && r.Bottom <= 560);
        if (edge == TaskbarEdge.Top) Assert.Equal(gap, r.Y); else Assert.Equal(560 - gap, r.Bottom);
        if (edge == TaskbarEdge.Left) Assert.Equal(gap, r.X); else Assert.Equal(800 - gap, r.Right);
    }

    [Theory]
    [InlineData(1.05)]
    [InlineData(1.25)]
    [InlineData(1.75)]
    public void Fractional_scales_keep_the_gap(double scale)
    {
        var gap = (int)Math.Round(12 * scale);
        foreach (var wa in new[] { new RectPx(0, 0, 1920, 1040), new RectPx(0, 0, 1366, 728) })
        {
            var b = PanelPlacement.Compute(wa, TaskbarEdge.Bottom, scale);
            Assert.Equal(wa.Right - gap, b.Right);
            Assert.Equal(wa.Bottom - gap, b.Bottom);
            Assert.True(b.Y >= wa.Y + gap);
            var t = PanelPlacement.Compute(wa, TaskbarEdge.Top, scale);
            Assert.Equal(wa.Y + gap, t.Y);
            Assert.True(t.Bottom <= wa.Bottom - gap);
        }
    }

    [Theory]
    [InlineData(0, 100, 1.0)]
    [InlineData(100, -5, 1.0)]
    [InlineData(-10, -10, 2.0)]
    [InlineData(1920, 1040, 0.0)]
    [InlineData(1920, 1040, -1.0)]
    [InlineData(1920, 1040, double.NaN)]
    [InlineData(1920, 1040, double.PositiveInfinity)]
    public void Bad_input_does_not_throw(int w, int h, double scale)
    {
        var wa = new RectPx(7, 9, w, h);
        var r = PanelPlacement.Compute(wa, TaskbarEdge.Bottom, scale);
        Assert.True(r.W >= 0 && r.H >= 0);
        if (w <= 0 || h <= 0) Assert.Equal(new RectPx(7, 9, 0, 0), r);
        else Assert.Equal(PanelPlacement.Compute(wa, TaskbarEdge.Bottom, 1.0), r);
    }

    [Fact]
    public void Degenerate_work_area_gives_non_negative_rect()
    {
        var r = PanelPlacement.Compute(new RectPx(10, 10, 100, 20), TaskbarEdge.Bottom, 2.0);
        Assert.True(r.W >= 0 && r.H >= 0);
        Assert.True(r.X >= 10 && r.Y >= 10 && r.Right <= 110 && r.Bottom <= 30);
    }

    [Theory]
    [InlineData(899, 240, false, true)]
    [InlineData(900, 300, true, false)]
    [InlineData(1400, 300, true, false)]
    [InlineData(720, 240, false, true)]
    public void Breakpoints(double width, double list, bool subtitles, bool stack)
    {
        Assert.Equal(list, WindowLayout.ListWidth(width));
        Assert.Equal(subtitles, WindowLayout.ShowSubtitles(width));
        Assert.Equal(stack, WindowLayout.StackStatusBoxes(width));
        Assert.Equal(720, WindowLayout.MinWidth);
        Assert.Equal(480, WindowLayout.MinHeight);
    }

    private static readonly RectPx Primary = new(0, 0, 1920, 1040);
    private static readonly RectPx Second = new(1920, 0, 1920, 1040);

    [Fact]
    public void Restore_keeps_rect_visible_on_a_monitor()
    {
        var saved = new RectPx(2000, 100, 900, 600);
        Assert.Equal(saved, WindowLayout.Restore(saved, [Primary, Second]));
    }

    [Fact]
    public void Restore_keeps_rect_at_least_half_visible()
    {
        var saved = new RectPx(100, 700, 800, 600);
        Assert.Equal(saved, WindowLayout.Restore(saved, [Primary]));
    }

    [Fact]
    public void Restore_centres_on_primary_when_second_monitor_unplugged()
    {
        var r = WindowLayout.Restore(new RectPx(2000, 100, 900, 600), [Primary]);
        Assert.Equal(new RectPx(510, 220, 900, 600), r);
    }

    [Fact]
    public void Restore_centres_when_less_than_half_visible()
    {
        var r = WindowLayout.Restore(new RectPx(1620, 100, 800, 600), [Primary]);
        Assert.Equal(new RectPx(560, 220, 800, 600), r);
    }

    [Fact]
    public void Restore_enforces_minimum_size_and_primary_bounds()
    {
        Assert.Equal(new RectPx(600, 280, 720, 480), WindowLayout.Restore(new RectPx(9000, 9000, 100, 100), [Primary]));
        var small = new RectPx(0, 0, 600, 400);
        Assert.Equal(new RectPx(0, 0, 600, 400), WindowLayout.Restore(new RectPx(9000, 9000, 5000, 5000), [small]));
    }

    [Theory]
    [InlineData(1.5, 1080, 720)]
    [InlineData(2.0, 1440, 960)]
    public void Restore_minimum_is_dip_scaled(double scale, int w, int h)
    {
        var primary = new RectPx(0, 0, 3840, 2040);
        var r = WindowLayout.Restore(new RectPx(9000, 0, 720, 480), [primary], scale);
        Assert.Equal(new RectPx((3840 - w) / 2, (2040 - h) / 2, w, h), r);
    }

    [Fact]
    public void Restore_100_percent_window_on_200_percent_primary_grows_to_min()
    {
        var primary = new RectPx(0, 0, 3840, 2040);
        var r = WindowLayout.Restore(new RectPx(5000, 100, 720, 480), [primary], 2.0);
        Assert.Equal(new RectPx(1200, 540, 1440, 960), r);
    }

    [Fact]
    public void Restore_size_capped_to_primary_at_high_scale()
    {
        var r = WindowLayout.Restore(new RectPx(5000, 0, 720, 480), [new RectPx(0, 0, 800, 560)], 2.0);
        Assert.Equal(new RectPx(0, 0, 800, 560), r);
    }

    [Fact]
    public void Restore_recentres_when_title_bar_is_off_screen()
    {
        var r = WindowLayout.Restore(new RectPx(100, -500, 800, 1000), [Primary]);
        Assert.Equal(new RectPx(560, 20, 800, 1000), r);
    }

    [Fact]
    public void Restore_with_no_work_areas_returns_saved()
    {
        var saved = new RectPx(-5, 7, 300, 200);
        Assert.Equal(saved, WindowLayout.Restore(saved, []));
    }
}
