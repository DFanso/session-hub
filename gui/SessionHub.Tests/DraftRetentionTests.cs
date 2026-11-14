using SessionHub.Core.Protocol;
using SessionHub.Core.ViewModels;
using static SessionHub.Tests.TestData;

namespace SessionHub.Tests;

public class DraftRetentionTests
{
    private static readonly TimeSpan Minute = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan Retention = TimeSpan.FromDays(7);

    private static HubSnapshot Stopped(params SessionView[] sessions) => Snap(sessions) with { Meta = Meta("stopped") };

    [Fact]
    public void Retention_is_seven_days()
    {
        Assert.Equal(Retention, HubViewModel.DraftRetention);
    }

    [Fact]
    public void A_draft_whose_session_is_unseen_for_seven_days_is_dropped_and_reported()
    {
        var clock = new FakeTimeProvider();
        var hub = new HubViewModel(null, null, clock);
        var reported = new List<(string Id, string Text)>();
        hub.Apply(Snap(Session("a"), Session("b")));
        hub.Sessions[0].Draft = "unsent";
        hub.DraftChanged += (id, text) => reported.Add((id, text));

        hub.Apply(Snap(Session("b")));
        clock.Advance(Retention - Minute);
        hub.Apply(Snap(Session("b")));
        Assert.Equal("unsent", hub.Drafts["a"]);
        Assert.Empty(reported);

        clock.Advance(Minute);
        hub.Apply(Snap(Session("b")));

        Assert.Empty(hub.Drafts);
        Assert.Empty(hub.DraftsSeen);
        Assert.Equal([("a", "")], reported);
    }

    [Fact]
    public void A_draft_whose_session_stays_in_snapshots_never_expires()
    {
        var clock = new FakeTimeProvider();
        var hub = new HubViewModel(new Dictionary<string, string> { ["a"] = "keep" }, null, clock);
        for (var day = 0; day < 30; day++)
        {
            hub.Apply(Snap(Session("a")));
            clock.Advance(TimeSpan.FromDays(1));
        }

        hub.Apply(Snap(Session("a")));
        Assert.Equal("keep", hub.Drafts["a"]);
        Assert.Equal(clock.GetUtcNow(), hub.DraftsSeen["a"]);
    }

    [Fact]
    public void An_answer_draft_follows_its_session_not_its_key()
    {
        var clock = new FakeTimeProvider();
        var hub = new HubViewModel(
            new Dictionary<string, string> { ["a#Q1"] = "answer for live a", ["b#Q2"] = "answer for gone b" },
            null,
            clock);
        for (var day = 0; day < 10; day++)
        {
            hub.Apply(Snap(Session("a")));
            clock.Advance(TimeSpan.FromDays(1));
        }

        hub.Apply(Snap(Session("a")));
        Assert.Equal("answer for live a", hub.Drafts["a#Q1"]);
        Assert.False(hub.Drafts.ContainsKey("b#Q2"));
    }

    [Fact]
    public void A_saved_draft_without_a_timestamp_counts_as_seen_at_load()
    {
        var clock = new FakeTimeProvider();
        var hub = new HubViewModel(new Dictionary<string, string> { ["a"] = "old file" }, null, clock);
        Assert.Equal(FakeTimeProvider.Start, hub.DraftsSeen["a"]);

        clock.Advance(Retention - Minute);
        hub.Apply(Snap(Session("other")));
        Assert.Equal("old file", hub.Drafts["a"]);

        clock.Advance(Minute);
        hub.Apply(Snap(Session("other")));
        Assert.Empty(hub.Drafts);
    }

    [Fact]
    public void An_old_timestamp_is_refreshed_when_the_first_snapshot_still_has_the_session()
    {
        // The tray was off for a month; the session is still there, so its draft stays.
        var clock = new FakeTimeProvider();
        var seen = new Dictionary<string, DateTimeOffset> { ["a"] = FakeTimeProvider.Start - TimeSpan.FromDays(30) };
        var hub = new HubViewModel(new Dictionary<string, string> { ["a"] = "x" }, seen, clock);

        hub.Apply(Snap(Session("a")));

        Assert.Equal("x", hub.Sessions[0].Draft);
        Assert.Equal("x", hub.Drafts["a"]);
        Assert.Equal(FakeTimeProvider.Start, hub.DraftsSeen["a"]);
    }

    [Fact]
    public void An_old_timestamp_of_a_session_missing_from_the_first_snapshot_is_dropped()
    {
        var clock = new FakeTimeProvider();
        var seen = new Dictionary<string, DateTimeOffset>
        {
            ["gone"] = FakeTimeProvider.Start - Retention,
            ["recent"] = FakeTimeProvider.Start - TimeSpan.FromDays(6),
        };
        var hub = new HubViewModel(new Dictionary<string, string> { ["gone"] = "g", ["recent"] = "r" }, seen, clock);

        hub.Apply(Snap(Session("other")));

        Assert.Equal(["recent"], hub.Drafts.Keys);
        Assert.Equal(["recent"], hub.DraftsSeen.Keys);
    }

    [Fact]
    public void A_snapshot_with_the_daemon_stopped_expires_nothing()
    {
        var clock = new FakeTimeProvider();
        var seen = new Dictionary<string, DateTimeOffset> { ["a"] = FakeTimeProvider.Start - TimeSpan.FromDays(30) };
        var hub = new HubViewModel(new Dictionary<string, string> { ["a"] = "x" }, seen, clock);

        hub.Apply(Stopped());

        Assert.Equal("x", hub.Drafts["a"]);
    }

    [Fact]
    public void A_timestamp_in_the_future_is_clamped_to_now()
    {
        var clock = new FakeTimeProvider();
        var seen = new Dictionary<string, DateTimeOffset> { ["a"] = FakeTimeProvider.Start + TimeSpan.FromDays(365) };
        var hub = new HubViewModel(new Dictionary<string, string> { ["a"] = "x" }, seen, clock);
        Assert.Equal(FakeTimeProvider.Start, hub.DraftsSeen["a"]);

        clock.Advance(Retention);
        hub.Apply(Snap(Session("other")));
        Assert.Empty(hub.Drafts);
    }

    [Fact]
    public void An_empty_snapshot_with_the_daemon_running_expires_nothing()
    {
        // The bridge sends an empty list with daemon "running" when the index cannot be opened.
        var clock = new FakeTimeProvider();
        var seen = new Dictionary<string, DateTimeOffset> { ["a"] = FakeTimeProvider.Start - TimeSpan.FromDays(30) };
        var hub = new HubViewModel(new Dictionary<string, string> { ["a"] = "x", ["a#Q1"] = "y" }, seen, clock);

        hub.Apply(Snap());
        clock.Advance(Retention);
        hub.Apply(Snap());

        Assert.Equal("x", hub.Drafts["a"]);
        Assert.Equal("y", hub.Drafts["a#Q1"]);
        Assert.False(hub.TakeSeenSaveDue());
    }

    [Fact]
    public void Seen_times_are_due_for_a_save_at_the_first_trusted_snapshot_then_daily()
    {
        var clock = new FakeTimeProvider();
        var hub = new HubViewModel(new Dictionary<string, string> { ["a"] = "x" }, null, clock);

        hub.Apply(Snap());
        Assert.False(hub.TakeSeenSaveDue());
        hub.Apply(Stopped(Session("a")));
        Assert.False(hub.TakeSeenSaveDue());

        hub.Apply(Snap(Session("a")));
        Assert.True(hub.TakeSeenSaveDue());
        Assert.False(hub.TakeSeenSaveDue());

        clock.Advance(TimeSpan.FromDays(1) - Minute);
        hub.Apply(Snap(Session("a")));
        Assert.False(hub.TakeSeenSaveDue());

        clock.Advance(Minute);
        hub.Apply(Snap(Session("a")));
        Assert.True(hub.TakeSeenSaveDue());
    }

    [Fact]
    public void No_seen_save_is_due_without_drafts()
    {
        var clock = new FakeTimeProvider();
        var hub = new HubViewModel(null, null, clock);

        hub.Apply(Snap(Session("a")));

        Assert.False(hub.TakeSeenSaveDue());
    }

    [Fact]
    public void Editing_a_draft_marks_it_seen_now_and_clearing_forgets_the_time()
    {
        var clock = new FakeTimeProvider();
        var hub = new HubViewModel(null, null, clock);
        hub.Apply(Snap(Session("a")));
        clock.Advance(TimeSpan.FromHours(3));

        hub.Sessions[0].Draft = "typed";
        Assert.Equal(FakeTimeProvider.Start + TimeSpan.FromHours(3), hub.DraftsSeen["a"]);

        hub.Sessions[0].Draft = "";
        Assert.Empty(hub.DraftsSeen);
    }

    [Fact]
    public void Saved_timestamps_without_a_draft_are_ignored()
    {
        var clock = new FakeTimeProvider();
        var seen = new Dictionary<string, DateTimeOffset> { ["nodraft"] = FakeTimeProvider.Start };
        var hub = new HubViewModel(null, seen, clock);

        Assert.Empty(hub.DraftsSeen);
    }
}
