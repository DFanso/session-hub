using SessionHub.Core.Bridge;
using SessionHub.Core.Protocol;
using SessionHub.Core.Tray;
using SessionHub.Core.ViewModels;
using static SessionHub.Tests.TestData;

namespace SessionHub.Tests;

public class IconStateTests
{
    private static readonly BridgeHealth Ok = new BridgeHealth.Connected();

    [Fact]
    public void Truth_table()
    {
        Assert.Equal(IconKind.Error, IconState.From(Meta(), new Totals(5, 1, 3), new BridgeHealth.Failed(3)).Kind);
        Assert.Equal(IconKind.Stopped, IconState.From(Meta("stopped"), new Totals(5, 1, 3), Ok).Kind);
        var w = IconState.From(Meta(), new Totals(3, 1, 3), Ok);
        Assert.Equal(IconKind.Waiting, w.Kind);
        Assert.Equal(4, w.Count);
        Assert.Equal(IconKind.Waiting, IconState.From(Meta(), new Totals(0, 1, 1), Ok).Kind);
        Assert.Equal(IconKind.Running, IconState.From(Meta(), new Totals(0, 0, 6), Ok).Kind);
        Assert.Equal(
            IconKind.Running,
            IconState.From(Meta(), new Totals(0, 0, 0), new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1))).Kind);
    }

    [Fact]
    public void Before_the_first_snapshot_it_is_starting_not_daemon_stopped()
    {
        var hub = new HubViewModel();
        Assert.False(hub.HasSnapshot);
        var restarting = new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1));
        Assert.Equal(IconKind.Starting, IconState.From(hub.Meta, hub.Totals, restarting, hub.HasSnapshot).Kind);
        Assert.Equal("Session Hub: starting", IconState.Tooltip(hub.Meta, hub.Totals, Ok, [], hub.HasSnapshot));
        Assert.Equal(IconKind.Error, IconState.From(hub.Meta, hub.Totals, new BridgeHealth.Failed(3), hub.HasSnapshot).Kind);

        hub.Apply(Snap() with { Meta = Meta("stopped") });
        Assert.True(hub.HasSnapshot);
        Assert.Equal("Session Hub: daemon stopped", IconState.Tooltip(hub.Meta, hub.Totals, Ok, [], hub.HasSnapshot));
    }

    private static IReadOnlyList<SessionViewModel> Vms(params SessionView[] s)
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(s));
        return [.. hub.Sessions];
    }

    [Fact]
    public void Tooltip_waiting_matches_mockup()
    {
        var s = Vms(
            Session("1", "shop-e3", waitingCount: 3),
            Session("2", "quiet"),
            Session("3", "mobile-api-2b", state: "waiting"),
            Session("4", "gone", waitingCount: 9, endedAt: 1));
        var t = IconState.Tooltip(Meta(), new Totals(3, 1, 3), Ok, s);
        Assert.Equal("Session Hub: shop-e3 (3), mobile-api-2b (approval) waiting on you", t);
    }

    [Fact]
    public void Tooltip_other_states()
    {
        Assert.Equal("Session Hub: 6 live sessions, nothing waiting", IconState.Tooltip(Meta(), new Totals(0, 0, 6), Ok, []));
        Assert.Equal("Session Hub: 1 live session, nothing waiting", IconState.Tooltip(Meta(), new Totals(0, 0, 1), Ok, []));
        Assert.Equal("Session Hub: daemon stopped", IconState.Tooltip(Meta("stopped"), new Totals(0, 0, 0), Ok, []));
        Assert.Equal(
            "Session Hub: reconnecting to hub.exe",
            IconState.Tooltip(Meta(), new Totals(0, 0, 0), new BridgeHealth.Failed(3), []));
    }

    [Fact]
    public void Truncate_limits_to_127_with_ellipsis()
    {
        var exact = new string('a', 127);
        Assert.Equal(exact, IconState.Truncate(exact));
        var cut = IconState.Truncate(new string('a', 200));
        Assert.Equal(127, cut.Length);
        Assert.EndsWith("…", cut);
        Assert.Equal("short", IconState.Truncate("short"));
    }

    [Fact]
    public void Truncate_never_splits_a_surrogate_pair()
    {
        var s = new string('a', 125) + "😀😀";
        var cut = IconState.Truncate(s);
        Assert.True(cut.Length <= 127);
        Assert.EndsWith("…", cut);
        Assert.False(char.IsHighSurrogate(cut[^2]));
    }
}
