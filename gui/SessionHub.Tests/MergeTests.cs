using System.Collections.Specialized;
using SessionHub.Core.Protocol;
using SessionHub.Core.ViewModels;
using static SessionHub.Tests.TestData;

namespace SessionHub.Tests;

public class MergeTests
{
    [Fact]
    public void Keeps_ui_state_and_instances_across_100_snapshots()
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("a", "A"), Session("b", "B")));
        var a = hub.Sessions[0];
        var b = hub.Sessions[1];
        a.IsExpanded = true;
        a.Draft = "hello";
        a.ScrollKey = "k1";

        for (var i = 0; i < 100; i++)
            hub.Apply(Snap(Session("a", "A", state: i % 2 == 0 ? "busy" : "idle", phase: "p" + i), Session("b", "B")));

        Assert.Same(a, hub.Sessions[0]);
        Assert.Same(b, hub.Sessions[1]);
        Assert.True(a.IsExpanded);
        Assert.Equal("hello", a.Draft);
        Assert.Equal("k1", a.ScrollKey);
        Assert.Equal("p99", a.Phase);
    }

    [Fact]
    public void Changed_phase_raises_exactly_one_phase_change()
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("a", phase: "one")));
        var a = hub.Sessions[0];
        var raised = new List<string?>();
        a.PropertyChanged += (_, e) => raised.Add(e.PropertyName);

        hub.Apply(Snap(Session("a", phase: "two")));

        Assert.Equal(["Phase"], raised);
    }

    [Fact]
    public void Identical_snapshot_raises_nothing()
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("a", phase: "one", waiting: [new WaitingItem("1", "t", false, ["c"])])));
        var raised = new List<string?>();
        hub.Sessions[0].PropertyChanged += (_, e) => raised.Add(e.PropertyName);
        var collection = 0;
        hub.Sessions.CollectionChanged += (_, _) => collection++;

        hub.Apply(Snap(Session("a", phase: "one", waiting: [new WaitingItem("1", "t", false, ["c"])])));

        Assert.Empty(raised);
        Assert.Equal(0, collection);
    }

    [Fact]
    public void Adds_in_snapshot_order_drops_removed_and_reorders_in_place()
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("a"), Session("b"), Session("c")));
        var a = hub.Sessions[0];
        var c = hub.Sessions[2];

        hub.Apply(Snap(Session("c"), Session("d"), Session("a")));

        Assert.Equal(["c", "d", "a"], hub.Sessions.Select(s => s.SessionId));
        Assert.Same(c, hub.Sessions[0]);
        Assert.Same(a, hub.Sessions[2]);
    }

    [Fact]
    public void Reordering_uses_moves_not_reset()
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("a"), Session("b")));
        var actions = new List<NotifyCollectionChangedAction>();
        hub.Sessions.CollectionChanged += (_, e) => actions.Add(e.Action);

        hub.Apply(Snap(Session("b"), Session("a")));

        Assert.DoesNotContain(NotifyCollectionChangedAction.Reset, actions);
        Assert.Contains(NotifyCollectionChangedAction.Move, actions);
    }

    [Fact]
    public void Draft_survives_a_session_leaving_and_coming_back()
    {
        var hub = new HubViewModel();
        var reported = new List<(string Id, string Text)>();
        hub.DraftChanged += (id, text) => reported.Add((id, text));
        hub.Apply(Snap(Session("a"), Session("b")));
        hub.Sessions[0].Draft = "unsent";

        hub.Apply(Snap(Session("b")));
        hub.Apply(Snap(Session("a"), Session("b")));

        Assert.Equal("unsent", hub.Sessions[0].Draft);
        Assert.Equal([("a", "unsent")], reported);
        Assert.Equal("unsent", hub.Drafts["a"]);
    }

    [Fact]
    public void Saved_drafts_seed_new_rows_without_reporting_a_change()
    {
        var hub = new HubViewModel(new Dictionary<string, string> { ["a"] = "from disk" });
        var reported = 0;
        hub.DraftChanged += (_, _) => reported++;

        hub.Apply(Snap(Session("a")));

        Assert.Equal("from disk", hub.Sessions[0].Draft);
        Assert.Equal(0, reported);
    }

    [Fact]
    public void Clearing_a_draft_is_reported_and_forgotten()
    {
        var hub = new HubViewModel(new Dictionary<string, string> { ["a"] = "x" });
        hub.Apply(Snap(Session("a")));
        string? last = null;
        hub.DraftChanged += (_, text) => last = text;

        hub.Sessions[0].Draft = "";

        Assert.Equal("", last);
        Assert.Empty(hub.Drafts);
    }

    [Fact]
    public void Totals_are_updated_before_the_collection_changes()
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("a")));
        var seen = -1;
        hub.Sessions.CollectionChanged += (_, _) => seen = hub.Totals.Live;

        hub.Apply(Snap(Session("a"), Session("b"), Session("c")));

        Assert.Equal(3, seen);
    }

    [Fact]
    public void Exposes_totals_and_meta()
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("a", state: "waiting")));
        Assert.Equal(1, hub.Totals.NeedsApproval);
        Assert.Equal("running", hub.Meta.Daemon);
    }

    [Theory]
    [InlineData("busy", 0, null, SessionGroup.Working)]
    [InlineData("idle", 0, null, SessionGroup.Idle)]
    [InlineData("unknown", 0, null, SessionGroup.Idle)]
    [InlineData("idle", 2, null, SessionGroup.Waiting)]
    [InlineData("busy", 2, null, SessionGroup.Waiting)]
    [InlineData("waiting", 0, null, SessionGroup.Waiting)]
    [InlineData("waiting", 0, 5L, SessionGroup.Ended)]
    [InlineData("busy", 3, 5L, SessionGroup.Ended)]
    public void Group_rules(string state, int count, long? endedAt, SessionGroup expected)
    {
        var vm = new SessionViewModel(Session("a", state: state, waitingCount: count, endedAt: endedAt));
        Assert.Equal(expected, vm.Group);
    }

    [Fact]
    public void Needs_approval_only_when_live_and_waiting()
    {
        Assert.True(new SessionViewModel(Session("a", state: "waiting")).NeedsApproval);
        Assert.False(new SessionViewModel(Session("a", state: "waiting", endedAt: 1)).NeedsApproval);
        Assert.False(new SessionViewModel(Session("a", state: "idle", waitingCount: 2)).NeedsApproval);
    }

    [Fact]
    public void SendBox_texts()
    {
        var box = new SendBoxViewModel();
        Assert.Equal("Sending…", box.Show("pending", null));
        Assert.Equal("Held by the session, waiting for its approval", box.Show("held", null));
        Assert.Equal("Delivered", box.Show("delivered", null));
        Assert.Equal("Not confirmed within 30 minutes", box.Show("expired", null));
        Assert.Equal("Failed: boom", box.Show("failed", "boom"));
        Assert.Equal("Failed: unknown", box.Show("failed", null));
    }

    [Fact]
    public void SendBox_timeout_never_retries_and_in_flight_offers_override()
    {
        var box = new SendBoxViewModel();
        box.ShowReplyError("timeout");
        Assert.Equal("May have been sent. Check its state before sending again.", box.StateText);
        Assert.False(box.CanOverride);

        box.ShowReplyError("send-in-flight");
        Assert.Equal("A message to this session is still pending. Send anyway?", box.StateText);
        Assert.True(box.CanOverride);

        box.Show("delivered", null);
        Assert.False(box.CanOverride);
    }
}
