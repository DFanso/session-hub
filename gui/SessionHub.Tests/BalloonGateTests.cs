using SessionHub.Core.Tray;

namespace SessionHub.Tests;

public class BalloonGateTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 13, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Rise_shows_same_count_does_not()
    {
        var g = new BalloonGate();
        Assert.True(g.ShouldShow("a", 0, 1, false, false, T0));
        Assert.False(g.ShouldShow("b", 2, 2, false, false, T0));
        Assert.False(g.ShouldShow("c", 3, 1, false, false, T0));
        Assert.False(g.ShouldShow("d", 0, 0, true, true, T0));
        Assert.False(g.ShouldShow("e", 0, 0, true, false, T0));
    }

    [Fact]
    public void Second_rise_within_five_minutes_is_suppressed_then_allowed()
    {
        var g = new BalloonGate();
        Assert.True(g.ShouldShow("a", 0, 1, false, false, T0));
        Assert.False(g.ShouldShow("a", 1, 2, false, false, T0.AddMinutes(4).AddSeconds(59)));
        Assert.True(g.ShouldShow("a", 1, 2, false, false, T0.AddMinutes(5)));
    }

    [Fact]
    public void Suppressed_rise_does_not_extend_the_window()
    {
        var g = new BalloonGate();
        Assert.True(g.ShouldShow("a", 0, 1, false, false, T0));
        Assert.False(g.ShouldShow("a", 1, 2, false, false, T0.AddMinutes(3)));
        Assert.True(g.ShouldShow("a", 2, 3, false, false, T0.AddMinutes(5)));
    }

    [Fact]
    public void Window_is_per_session()
    {
        var g = new BalloonGate();
        Assert.True(g.ShouldShow("a", 0, 1, false, false, T0));
        Assert.True(g.ShouldShow("b", 0, 1, false, false, T0));
    }

    [Fact]
    public void Approval_false_to_true_shows()
    {
        var g = new BalloonGate();
        Assert.True(g.ShouldShow("a", 0, 0, false, true, T0));
    }

    [Fact]
    public void Notifications_off_never_shows_and_does_not_consume_window()
    {
        var g = new BalloonGate { Notifications = false };
        Assert.False(g.ShouldShow("a", 0, 5, false, true, T0));
        g.Notifications = true;
        Assert.True(g.ShouldShow("a", 0, 1, false, false, T0));
    }
}
