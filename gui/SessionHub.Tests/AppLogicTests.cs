using System.Collections.ObjectModel;
using SessionHub.Core.App;
using SessionHub.Core.Bridge;
using SessionHub.Core.Protocol;
using SessionHub.Core.Tray;
using SessionHub.Core.ViewModels;
using static SessionHub.Tests.TestData;

namespace SessionHub.Tests;

public class AppArgsTests
{
    [Fact]
    public void No_arguments_is_the_normal_start()
    {
        Assert.True(AppArgs.TryParse([], out var a, out var error));
        Assert.Null(error);
        Assert.Equal(new AppArgs(null, null, null), a);
    }

    [Fact]
    public void Reads_data_dir_hub_and_render_check()
    {
        // Fully qualified on the platform running the tests (C:\... on Windows, /... on the Linux CI runner).
        var root = Path.GetFullPath(Path.GetTempPath());
        var data = Path.Combine(root, "data");
        var hub = Path.Combine(root, "hub.exe");
        var output = Path.Combine(root, "out");
        Assert.True(AppArgs.TryParse(["--data-dir", data, "--hub", hub, "--render-check", output], out var a, out _));
        Assert.Equal(data, a.DataDir);
        Assert.Equal(hub, a.HubPath);
        Assert.Equal(output, a.RenderCheckDir);
    }

    [Theory]
    [InlineData("--data-dir")]
    [InlineData("--hub")]
    [InlineData("--bogus")]
    [InlineData("--hub", "relative\\hub.exe")]
    [InlineData("--data-dir", "rel")]
    [InlineData("--hub", "C:\\a.exe", "--hub", "C:\\b.exe")]
    public void Rejects_missing_values_unknown_flags_relative_paths_and_repeats(params string[] args)
    {
        Assert.False(AppArgs.TryParse(args, out _, out var error));
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void Render_check_dir_may_be_relative_and_is_made_absolute()
    {
        Assert.True(AppArgs.TryParse(["--render-check", "out"], out var a, out _));
        Assert.True(Path.IsPathFullyQualified(a.RenderCheckDir!));
    }
}

public class StableListTests
{
    private sealed record Item(string Id);

    private static readonly Item A = new("a"), B = new("b"), C = new("c"), D = new("d");

    [Fact]
    public void Without_reorder_existing_items_never_move()
    {
        var list = new ObservableCollection<Item> { A, B, C };
        var moves = 0;
        list.CollectionChanged += (_, e) =>
        {
            if (e.Action is System.Collections.Specialized.NotifyCollectionChangedAction.Move
                or System.Collections.Specialized.NotifyCollectionChangedAction.Reset) moves++;
        };
        StableList.Sync(list, [C, A, B], reorder: false);
        Assert.Equal([A, B, C], list);
        Assert.Equal(0, moves);
    }

    [Fact]
    public void Without_reorder_removes_gone_items_and_inserts_new_ones_after_their_predecessor()
    {
        var list = new ObservableCollection<Item> { A, B, C };
        StableList.Sync(list, [D, A, C], reorder: false);
        Assert.Equal([D, A, C], list);

        StableList.Sync(list, [D, A, B, C], reorder: false);
        Assert.Equal([D, A, B, C], list);
    }

    [Fact]
    public void With_reorder_matches_the_desired_order()
    {
        var list = new ObservableCollection<Item> { A, B, C };
        StableList.Sync(list, [C, D, A], reorder: true);
        Assert.Equal([C, D, A], list);
    }

    [Fact]
    public void Same_list_raises_nothing()
    {
        var list = new ObservableCollection<Item> { A, B };
        var events = 0;
        list.CollectionChanged += (_, _) => events++;
        StableList.Sync(list, [A, B], reorder: true);
        StableList.Sync(list, [A, B], reorder: false);
        Assert.Equal(0, events);
    }
}

public class TimeTextTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 13, 10, 0, 0, TimeSpan.Zero);

    private static long Ms(TimeSpan before) => (Now - before).ToUnixTimeMilliseconds();

    [Fact]
    public void Ago_matches_the_mockup()
    {
        Assert.Equal("just now", TimeText.Ago(Ms(TimeSpan.FromSeconds(3)), Now));
        Assert.Equal("just now", TimeText.Ago(Ms(TimeSpan.FromSeconds(-30)), Now));
        Assert.Equal("42 s ago", TimeText.Ago(Ms(TimeSpan.FromSeconds(42)), Now));
        Assert.Equal("2 min ago", TimeText.Ago(Ms(TimeSpan.FromSeconds(120)), Now));
        Assert.Equal("3 h ago", TimeText.Ago(Ms(TimeSpan.FromHours(3)), Now));
        Assert.Equal("2 d ago", TimeText.Ago(Ms(TimeSpan.FromDays(2)), Now));
    }

    [Fact]
    public void Day_and_clock_are_culture_independent()
    {
        Assert.Equal("Fri, Nov 13", TimeText.Day(Now));
        Assert.Equal("02:10", TimeText.Clock("2025-11-13T02:10:00.000Z", TimeZoneInfo.Utc));
        Assert.Equal("", TimeText.Clock("not a time", TimeZoneInfo.Utc));
    }
}

public class CardViewModelTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeMilliseconds(1_000_000);

    private static CardViewModel Card(SessionView v)
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(v));
        var card = new CardViewModel(hub.Sessions[0]);
        card.Update(v, Now);
        return card;
    }

    [Fact]
    public void Chips_and_edge_follow_the_session_state()
    {
        Assert.Equal(new Chip("needs approval", ChipTone.Red), Card(Session("a", state: "waiting")).StatusChip);
        Assert.Equal(CardEdge.Red, Card(Session("a", state: "waiting")).Edge);
        var w = Card(Session("w", waitingCount: 3));
        Assert.Equal(new Chip("3 waiting on you", ChipTone.Amber), w.StatusChip);
        Assert.Equal(CardEdge.Amber, w.Edge);
        Assert.Equal(new Chip("working", ChipTone.Accent), Card(Session("b", state: "busy")).StatusChip);
        Assert.Equal(new Chip("idle", ChipTone.Grey), Card(Session("i")).StatusChip);
        Assert.Equal(new Chip("ended", ChipTone.Grey), Card(Session("e", endedAt: 5)).StatusChip);
        Assert.Equal(CardEdge.None, Card(Session("i")).Edge);
    }

    [Fact]
    public void Jump_needs_a_live_session_and_follows_it_ending()
    {
        Assert.True(Card(Session("a")).CanJump);
        Assert.False(Card(Session("e", endedAt: 5)).CanJump);

        var hub = new HubViewModel();
        hub.Apply(Snap(Session("a")));
        var card = new CardViewModel(hub.Sessions[0]);
        var raised = new List<string?>();
        card.PropertyChanged += (_, e) => raised.Add(e.PropertyName);
        hub.Apply(Snap(Session("a", endedAt: 9)));
        Assert.False(card.CanJump);
        Assert.Contains(nameof(CardViewModel.CanJump), raised);
    }

    [Fact]
    public void Unknown_state_shows_as_idle_with_an_unknown_chip()
    {
        var c = Card(Session("u", state: "unknown"));
        Assert.Equal(new Chip("idle", ChipTone.Grey), c.StatusChip);
        Assert.True(c.IsUnknown);
        Assert.False(Card(Session("i")).IsUnknown);
    }

    [Fact]
    public void Profile_chip_is_teal_for_claude_and_violet_for_personal()
    {
        var hub = new HubViewModel();
        var v = Session("p") with { Profile = "claude-personal" };
        hub.Apply(Snap(v, Session("q")));
        Assert.Equal(new Chip(".claude-personal", ChipTone.Violet), new CardViewModel(hub.Sessions[0]).ProfileChip);
        Assert.Equal(new Chip(".p", ChipTone.Teal), new CardViewModel(hub.Sessions[1]).ProfileChip);
    }

    [Fact]
    public void Initials_never_split_a_surrogate_pair()
    {
        Assert.Equal("ES", Card(Session("x", name: "eslint")).Initials);
        Assert.Equal("🚀B", Card(Session("x", name: "🚀beta")).Initials);
        Assert.Equal("?", Card(Session("x", name: "")).Initials);
    }

    [Fact]
    public void Initials_skip_the_spaces_in_a_name()
    {
        Assert.Equal("AB", Card(Session("x", name: "a b")).Initials);
        Assert.Equal("DA", Card(Session("x", name: "Daily status report template")).Initials);
        Assert.Equal("?", Card(Session("x", name: " ")).Initials);
    }

    [Fact]
    public void Sub_text_has_cwd_and_age_and_ticks()
    {
        var v = Session("x", cwd: "D:/w") with { UpdatedAt = Now.AddMinutes(-2).ToUnixTimeMilliseconds() };
        var c = Card(v);
        Assert.Equal("D:/w · 2 min ago", c.SubText);
        c.Tick(Now.AddMinutes(60));
        Assert.Equal("D:/w · 1 h ago", c.SubText);
    }

    [Fact]
    public void Remaining_lines_are_numbered_and_progress_is_clamped()
    {
        var v = Session("x") with { Status = new SessionStatus(140, "Build", ["one", "two"], [], [], "u", "t") };
        var c = Card(v);
        Assert.Equal(["1. one", "2. two"], c.RemainingLines);
        Assert.Equal(100, c.Progress);
        Assert.True(c.HasProgress);
        Assert.Equal("100%", c.ProgressLabel);
        Assert.False(Card(Session("n")).HasProgress);
    }

    [Fact]
    public void Exchange_takes_the_last_two_messages_with_labels()
    {
        var c = Card(Session("x"));
        c.SetExchange(
            [
                new MessageRow("1", "x", "2025-11-13T02:00:00.000Z", "owner", null, "a"),
                new MessageRow("2", "x", "2025-11-13T02:05:00.000Z", "peer", "beta", "b"),
                new MessageRow("3", "x", "2025-11-13T02:10:00.000Z", "assistant", null, "c"),
            ],
            TimeZoneInfo.Utc);
        Assert.Equal(
            [new ExchangeLine(false, "beta · 02:05", "b"), new ExchangeLine(false, "Claude · 02:10", "c")],
            c.LastExchange);
        c.SetExchange([new MessageRow("1", "x", "2025-11-13T02:00:00.000Z", "owner", null, "a")], TimeZoneInfo.Utc);
        Assert.Equal([new ExchangeLine(true, "You · 02:00", "a")], c.LastExchange);
    }

    [Fact]
    public void Revision_moves_only_when_the_session_changes()
    {
        var v = Session("x") with { UpdatedAt = 100 };
        var c = Card(v);
        var start = c.Revision;
        c.Update(v, Now);
        Assert.Equal(start, c.Revision);
        c.Update(v with { UpdatedAt = 200 }, Now);
        Assert.Equal(start + 1, c.Revision);
    }

    [Fact]
    public void Exchange_text_is_capped_at_2000_characters()
    {
        var c = Card(Session("x"));
        var text = new string('a', 1999) + "😀" + "tail";
        c.SetExchange([new MessageRow("1", "x", "2025-11-13T02:00:00.000Z", "owner", null, text)], TimeZoneInfo.Utc);
        var shown = c.LastExchange[0].Text;
        Assert.Equal(new string('a', 1999) + "…", shown);
        c.SetExchange([new MessageRow("1", "x", "2025-11-13T02:00:00.000Z", "owner", null, new string('b', 2000))], TimeZoneInfo.Utc);
        Assert.Equal(new string('b', 2000), c.LastExchange[0].Text);
    }

    [Fact]
    public void Send_tone_follows_the_state()
    {
        var c = Card(Session("x"));
        c.ShowSend("pending", null);
        Assert.Equal(SendTone.Pending, c.SendTone);
        Assert.True(c.SendBusy);
        c.ShowSend("held", null);
        Assert.Equal(SendTone.Pending, c.SendTone);
        c.ShowSend("delivered", null);
        Assert.Equal(SendTone.Delivered, c.SendTone);
        Assert.False(c.SendBusy);
        c.ShowSendError("send-in-flight", null);
        Assert.Equal(SendTone.Failed, c.SendTone);
        Assert.True(c.SendBox.CanOverride);
    }
}

public class PanelViewModelTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeMilliseconds(10_000_000);

    private static PanelViewModel Panel(params SessionView[] s)
    {
        var p = new PanelViewModel(new HubViewModel());
        p.SetHealth(new BridgeHealth.Connected());
        p.Apply(Snap(s), Now);
        return p;
    }

    private static PanelViewModel Sample() => Panel(
        Session("w", "shop", waitingCount: 2, waiting: [new WaitingItem("Q1", "Pick", false, [])]),
        Session("ap", "pay", state: "waiting"),
        Session("b", "builder", state: "busy"),
        Session("i", "idler"),
        Session("e", "old", endedAt: 5));

    private static string[] Ids(IEnumerable<CardViewModel> c) => [.. c.Select(x => x.Session.SessionId)];

    [Fact]
    public void Home_lists_sessions_waiting_on_you()
    {
        var p = Sample();
        p.SelectTab(PanelTab.Home);
        Assert.Equal(["w", "ap"], Ids(p.Items));
        Assert.Equal(3, p.WaitingTotal);
        Assert.Equal("3 items wait on you across 2 sessions.", p.Summary);
        Assert.False(p.ShowSearch);
    }

    [Fact]
    public void Sessions_tab_filters_and_searches()
    {
        var p = Sample();
        p.SelectTab(PanelTab.Sessions);
        Assert.Equal(["w", "ap", "b", "i"], Ids(p.Items));
        Assert.True(p.ShowSearch);
        Assert.True(p.ShowFilters);
        Assert.Equal("4 of 4 live sessions · 3 waiting on you · live", p.Summary);
        p.Filter = PanelFilter.Ended;
        Assert.Equal(["e"], Ids(p.Items));
        p.Filter = PanelFilter.All;
        p.Query = "build";
        Assert.Equal(["b"], Ids(p.Items));
    }

    [Fact]
    public void Waiting_tab_has_search_but_no_filter_chips()
    {
        var p = Sample();
        p.SelectTab(PanelTab.Waiting);
        Assert.Equal(["w", "ap"], Ids(p.Items));
        Assert.True(p.ShowSearch);
        Assert.False(p.ShowFilters);
    }

    [Fact]
    public void Empty_states_per_tab()
    {
        var p = Panel(Session("i", "idler"));
        p.SelectTab(PanelTab.Home);
        Assert.True(p.IsEmpty);
        Assert.Equal("All clear", p.EmptyTitle);
        p.SelectTab(PanelTab.Sessions);
        p.Query = "zzz";
        Assert.True(p.IsEmpty);
        Assert.Equal("No sessions match", p.EmptyTitle);
    }

    [Fact]
    public void Sessions_tab_with_no_live_sessions_says_so()
    {
        var p = Panel();
        p.SelectTab(PanelTab.Sessions);
        Assert.True(p.IsEmpty);
        Assert.Equal("No live sessions", p.EmptyTitle);
        Assert.Equal("Start a Claude Code session and it shows up here.", p.EmptyText);
        p.Query = "x";
        Assert.Equal("No sessions match", p.EmptyTitle);
    }

    [Fact]
    public void Snapshot_merge_keeps_order_and_instances_until_reorder()
    {
        var p = Panel(Session("a", "a"), Session("b", "b"));
        p.SelectTab(PanelTab.Sessions);
        var first = p.Items[0];
        p.Apply(Snap(Session("b", "b"), Session("a", "a", waitingCount: 1)), Now);
        Assert.Equal(["a", "b"], Ids(p.Items));
        Assert.Same(first, p.Items[0]);
        p.Refresh(reorder: true);
        Assert.Equal(["b", "a"], Ids(p.Items));
        Assert.Same(first, p.Items[1]);
    }

    [Fact]
    public void Link_states_drive_chip_banner_and_send()
    {
        var p = new PanelViewModel(new HubViewModel());
        Assert.Equal(HubLink.Connecting, p.Link);
        Assert.False(p.CanSend);

        p.SetHealth(new BridgeHealth.Connected());
        p.Apply(Snap(Session("a")), Now);
        Assert.Equal(HubLink.Live, p.Link);
        Assert.Equal("Live · 1 session", p.LinkText);
        Assert.True(p.CanSend);
        Assert.False(p.ShowBanner);

        p.Apply(Snap() with { Meta = Meta("stopped") }, Now);
        Assert.Equal(HubLink.DaemonStopped, p.Link);
        Assert.True(p.ShowBanner);
        Assert.True(p.CanStartDaemon);
        Assert.False(p.CanSend);

        p.SetHealth(new BridgeHealth.Restarting(2, TimeSpan.FromSeconds(2)));
        Assert.Equal(HubLink.Reconnecting, p.Link);
        Assert.Equal("Lost the link to hub.exe. Retrying (attempt 2, next in 2 s).", p.BannerText);
        Assert.True(p.BannerIsError);
        Assert.False(p.CanStartDaemon);
    }

    [Fact]
    public void Expanding_one_card_collapses_the_others_and_asks_for_the_exchange()
    {
        var p = Sample();
        p.SelectTab(PanelTab.Sessions);
        var wanted = new List<string>();
        p.ExchangeWanted += c => wanted.Add(c.Session.SessionId);
        p.Toggle(p.Items[0]);
        p.Toggle(p.Items[1]);
        Assert.False(p.Items[0].Session.IsExpanded);
        Assert.True(p.Items[1].Session.IsExpanded);
        Assert.Equal(["w", "ap"], wanted);
        p.Toggle(p.Items[1]);
        Assert.False(p.Items[1].Session.IsExpanded);
    }

    [Fact]
    public void Focus_session_opens_it_in_sessions()
    {
        var p = Sample();
        p.SelectTab(PanelTab.Home);
        p.FocusSession("b");
        Assert.Equal(PanelTab.Sessions, p.Tab);
        Assert.Equal(PanelFilter.All, p.Filter);
        Assert.True(p.Card("b")!.Session.IsExpanded);
    }

    [Fact]
    public void Send_targets_are_live_sessions_and_the_target_survives_merges()
    {
        var p = Sample();
        Assert.Equal(["w", "ap", "b", "i"], Ids(p.SendTargets));
        p.SendTarget = p.Card("b");
        p.Apply(Snap(Session("b", "builder"), Session("i", "idler")), Now);
        Assert.Equal("b", p.SendTarget!.Session.SessionId);
        p.Apply(Snap(Session("i", "idler")), Now);
        Assert.Equal("i", p.SendTarget!.Session.SessionId);
    }

    [Fact]
    public void Save_failure_shows_a_footer_warning_until_a_save_works()
    {
        var p = Panel(Session("a"));
        Assert.Equal("", p.FooterWarning);
        p.SetSaveFailed(true);
        Assert.Equal("Drafts could not be saved", p.FooterWarning);
        p.SetSaveFailed(false);
        Assert.Equal("", p.FooterWarning);
    }

    [Fact]
    public void Footer_shows_the_day_and_the_newest_update()
    {
        var p = Panel(Session("a") with { UpdatedAt = Now.AddSeconds(-20).ToUnixTimeMilliseconds() });
        Assert.Equal(TimeText.Day(Now.ToLocalTime()) + " · updated 20 s ago", p.FooterText);
    }
}

public class SendCoordinatorTests
{
    private sealed class FakeBridge
    {
        public List<SendRequest> Sent { get; } = [];

        public Queue<Reply> Replies { get; } = new();

        public Task<Reply> Request(BridgeRequest r, TimeSpan _)
        {
            Sent.Add((SendRequest)r);
            return Task.FromResult(Replies.Dequeue());
        }
    }

    private static Reply Ok(int sendId) =>
        new(1, true, System.Text.Json.JsonDocument.Parse($"{{\"sendId\":{sendId},\"state\":\"pending\"}}").RootElement.Clone());

    private static Reply Err(string code, int? sendId = null) => new(1, false, null, new BridgeError(code, "x", sendId));

    private static CardViewModel Card(string draft = "hello")
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("s1")));
        var c = new CardViewModel(hub.Sessions[0]);
        c.Session.Draft = draft;
        return c;
    }

    [Fact]
    public async Task Send_clears_the_draft_and_tracks_the_pending_send()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Ok(7));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);
        Assert.Equal("hello", bridge.Sent[0].Text);
        Assert.Null(bridge.Sent[0].Override);
        Assert.Equal("", c.Session.Draft);
        Assert.Equal("Sending…", c.SendBox.StateText);
        Assert.True(sends.HasPending);

        sends.OnSendChanged(new SendUpdate(new SendProgress(7, "s1", "delivered", null)));
        Assert.Equal("Delivered", c.SendBox.StateText);
        Assert.False(sends.HasPending);
    }

    [Fact]
    public async Task Blank_text_is_not_sent()
    {
        var bridge = new FakeBridge();
        var sends = new SendCoordinator(bridge.Request);
        await sends.SendAsync(Card("  \n "));
        Assert.Empty(bridge.Sent);
    }

    [Fact]
    public async Task In_flight_offers_override_and_keeps_the_draft()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Err("send-in-flight", 3));
        bridge.Replies.Enqueue(Ok(4));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);
        Assert.Equal("hello", c.Session.Draft);
        Assert.True(c.SendBox.CanOverride);
        Assert.Equal("A message to this session is still pending. Send anyway?", c.SendBox.StateText);

        await sends.SendAsync(c, overrideInFlight: true);
        Assert.True(bridge.Sent[1].Override);
        Assert.Equal("", c.Session.Draft);
    }

    [Fact]
    public async Task Timeout_says_it_may_have_been_sent_and_keeps_the_draft()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Err("timeout"));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);
        Assert.Equal("hello", c.Session.Draft);
        Assert.StartsWith("May have been sent", c.SendBox.StateText);
    }

    [Fact]
    public async Task Text_typed_while_sending_is_kept()
    {
        var reply = new TaskCompletionSource<Reply>();
        var c = Card();
        var sends = new SendCoordinator((_, _) => reply.Task);
        var task = sends.SendAsync(c);
        Assert.True(sends.HasPending);
        c.Session.Draft = "hello again";
        reply.SetResult(Ok(9));
        await task;
        Assert.Equal("hello again", c.Session.Draft);
    }

    [Fact]
    public async Task A_bridge_restart_settles_every_open_send()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Ok(7));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);
        Assert.True(sends.HasPending);

        sends.SettleAll();
        Assert.False(sends.HasPending);
        Assert.Equal("May have been sent. Check its state before sending again.", c.SendBox.StateText);
        Assert.False(c.SendBusy);

        // A late event for the settled send changes nothing.
        sends.OnSendChanged(new SendUpdate(new SendProgress(7, "s1", "delivered", null)));
        Assert.Equal("May have been sent. Check its state before sending again.", c.SendBox.StateText);
    }

    [Fact]
    public async Task Sends_not_final_after_30_minutes_are_settled()
    {
        var now = DateTimeOffset.UnixEpoch;
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Ok(7));
        var sends = new SendCoordinator(bridge.Request, () => now);
        var c = Card();
        await sends.SendAsync(c);

        now += SendCoordinator.TrackLimit - TimeSpan.FromSeconds(1);
        sends.SettleExpired();
        Assert.True(sends.HasPending);

        now += TimeSpan.FromSeconds(2);
        sends.SettleExpired();
        Assert.False(sends.HasPending);
        Assert.StartsWith("May have been sent", c.SendBox.StateText);
    }

    [Fact]
    public async Task Only_the_newest_send_of_a_card_updates_it()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Ok(1));
        bridge.Replies.Enqueue(Ok(2));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);
        c.Session.Draft = "second";
        await sends.SendAsync(c, overrideInFlight: true);

        sends.OnSendChanged(new SendUpdate(new SendProgress(1, "s1", "failed", "old")));
        Assert.Equal("Sending…", c.SendBox.StateText);
        sends.OnSendChanged(new SendUpdate(new SendProgress(2, "s1", "delivered", null)));
        Assert.Equal("Delivered", c.SendBox.StateText);
        Assert.False(sends.HasPending);
    }

    [Fact]
    public async Task A_second_send_while_the_request_is_out_is_ignored()
    {
        var reply = new TaskCompletionSource<Reply>();
        var calls = 0;
        var sends = new SendCoordinator((_, _) =>
        {
            calls++;
            return reply.Task;
        });
        var c = Card();
        var first = sends.SendAsync(c);
        Assert.True(c.IsRequesting);
        await sends.SendAsync(c);
        Assert.Equal(1, calls);
        reply.SetResult(Ok(3));
        await first;
        Assert.False(c.IsRequesting);
    }

    [Fact]
    public void Unknown_send_events_are_ignored()
    {
        var sends = new SendCoordinator((_, _) => Task.FromResult(Ok(1)));
        sends.OnSendChanged(new SendUpdate(new SendProgress(99, "zz", "delivered", null)));
        Assert.False(sends.HasPending);
    }

    private static SendUpdate Update(int id, string state, string? detail = null) =>
        new(new SendProgress(id, "s1", state, detail));

    [Fact]
    public async Task A_final_event_before_the_reply_is_handled_is_replayed_on_registration()
    {
        var reply = new TaskCompletionSource<Reply>();
        var sends = new SendCoordinator((_, _) => reply.Task);
        var c = Card();
        var task = sends.SendAsync(c);

        // The relay failed at once: its event is read before the reply's continuation runs.
        sends.OnSendChanged(Update(7, "failed", "exit 1"));
        reply.SetResult(Ok(7));
        await task;

        Assert.Equal("Failed: exit 1", c.SendBox.StateText);
        Assert.False(c.SendBusy);
        Assert.False(sends.HasPending);
    }

    [Fact]
    public async Task Early_events_replay_in_order_and_only_for_their_own_id()
    {
        var reply = new TaskCompletionSource<Reply>();
        var sends = new SendCoordinator((_, _) => reply.Task);
        var c = Card();
        var task = sends.SendAsync(c);
        sends.OnSendChanged(Update(7, "held", "busy"));
        sends.OnSendChanged(Update(8, "delivered"));
        sends.OnSendChanged(Update(7, "delivered"));
        reply.SetResult(Ok(7));
        await task;
        Assert.Equal("Delivered", c.SendBox.StateText);
        Assert.False(sends.IsWatching);
    }

    [Fact]
    public async Task Early_events_older_than_a_minute_or_beyond_32_are_dropped()
    {
        var now = DateTimeOffset.UnixEpoch;
        var reply = new TaskCompletionSource<Reply>();
        var sends = new SendCoordinator((_, _) => reply.Task, () => now);
        var c = Card();
        var task = sends.SendAsync(c);
        sends.OnSendChanged(Update(7, "failed", "old"));
        now += SendCoordinator.EarlyMaxAge + TimeSpan.FromSeconds(1);
        reply.SetResult(Ok(7));
        await task;
        Assert.Equal("Sending…", c.SendBox.StateText);

        var reply2 = new TaskCompletionSource<Reply>();
        var sends2 = new SendCoordinator((_, _) => reply2.Task, () => now);
        var c2 = Card();
        var task2 = sends2.SendAsync(c2);
        sends2.OnSendChanged(Update(5, "failed", "first"));
        for (var i = 0; i < SendCoordinator.EarlyLimit; i++) sends2.OnSendChanged(Update(100 + i, "delivered"));
        reply2.SetResult(Ok(5));
        await task2;
        Assert.Equal("Sending…", c2.SendBox.StateText);
    }

    [Fact]
    public async Task A_bridge_restart_between_request_and_registration_settles_at_once()
    {
        var reply = new TaskCompletionSource<Reply>();
        var sends = new SendCoordinator((_, _) => reply.Task);
        var c = Card();
        var task = sends.SendAsync(c);
        sends.SettleAll(); // the bridge ended after it replied, before the reply was handled
        reply.SetResult(Ok(7));
        await task;

        Assert.False(sends.IsWatching);
        Assert.Equal("May have been sent. Check its state before sending again.", c.SendBox.StateText);
        Assert.False(c.SendBusy);
    }

    [Fact]
    public async Task A_failed_send_is_still_watched_and_a_later_delivery_shows()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Ok(7));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);

        sends.OnSendChanged(Update(7, "failed", "exit 1"));
        Assert.Equal("Failed: exit 1", c.SendBox.StateText);
        Assert.False(sends.HasPending); // failed is not "still sending": quitting does not ask
        Assert.True(sends.IsWatching);

        sends.OnSendChanged(Update(7, "delivered"));
        Assert.Equal("Delivered", c.SendBox.StateText);
        Assert.False(sends.IsWatching);
    }

    [Fact]
    public async Task A_failed_send_is_dropped_at_the_track_limit_or_a_restart_without_changing_its_text()
    {
        var now = DateTimeOffset.UnixEpoch;
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Ok(7));
        bridge.Replies.Enqueue(Ok(8));
        var sends = new SendCoordinator(bridge.Request, () => now);
        var c = Card();
        await sends.SendAsync(c);
        sends.OnSendChanged(Update(7, "failed", "exit 1"));
        now += SendCoordinator.TrackLimit;
        sends.SettleExpired();
        Assert.False(sends.IsWatching);
        Assert.Equal("Failed: exit 1", c.SendBox.StateText);

        var c2 = Card();
        await sends.SendAsync(c2);
        sends.OnSendChanged(Update(8, "failed", "exit 2"));
        sends.SettleAll();
        Assert.False(sends.IsWatching);
        Assert.Equal("Failed: exit 2", c2.SendBox.StateText);
    }

    [Fact]
    public async Task A_bridge_restarted_reply_says_it_may_have_been_sent()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Err("bridge-restarted"));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);
        Assert.Equal("hello", c.Session.Draft);
        Assert.Equal("May have been sent. Check its state before sending again.", c.SendBox.StateText);
    }

    [Fact]
    public void Track_limit_matches_the_bridge()
    {
        // SEND_TRACK_MS = DELIVERY_WINDOW_MS (30 min) + 2 * EXPIRE_EVERY_MS (30 s).
        Assert.Equal(TimeSpan.FromMinutes(31), SendCoordinator.TrackLimit);
    }
}

public class BalloonPlannerTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.UnixEpoch.AddDays(1);

    [Fact]
    public void First_snapshot_never_balloons_and_rises_do()
    {
        var gate = new BalloonGate();
        var planner = new BalloonPlanner();
        Assert.Empty(planner.Plan(Snap(Session("a", "alpha", waitingCount: 2)), gate, Now));

        var due = planner.Plan(
            Snap(Session("a", "alpha", waitingCount: 3, waiting: [new WaitingItem("Q9", "New one", true, [])])),
            gate,
            Now.AddSeconds(1));
        var b = Assert.Single(due);
        Assert.Equal("a", b.SessionId);
        Assert.Equal("alpha is waiting on you (3)", b.Title);
        Assert.Equal("Q9: New one", b.Text);
    }

    [Fact]
    public void New_session_with_an_approval_balloons()
    {
        var gate = new BalloonGate();
        var planner = new BalloonPlanner();
        planner.Plan(Snap(), gate, Now);
        var b = Assert.Single(planner.Plan(Snap(Session("p", "pay", state: "waiting")), gate, Now));
        Assert.Equal("pay needs approval", b.Title);
        Assert.Equal("A permission prompt is open in its terminal.", b.Text);
    }

    [Fact]
    public void Ended_sessions_never_balloon()
    {
        var gate = new BalloonGate();
        var planner = new BalloonPlanner();
        planner.Plan(Snap(), gate, Now);
        Assert.Empty(planner.Plan(Snap(Session("e", waitingCount: 4, endedAt: 1)), gate, Now));
    }

    [Fact]
    public void A_waiting_item_with_empty_text_gets_the_default_line_and_a_nameless_session_a_name()
    {
        var gate = new BalloonGate();
        var planner = new BalloonPlanner();
        planner.Plan(Snap(), gate, Now);
        var b = Assert.Single(planner.Plan(
            Snap(Session("a", "  ", waitingCount: 1, waiting: [new WaitingItem("Q1", " ", true, [])])),
            gate,
            Now));
        Assert.Equal(BalloonPlanner.DefaultText, b.Text);
        Assert.Equal("A session is waiting on you (1)", b.Title);
    }

    [Fact]
    public void Several_rises_in_one_snapshot_give_one_combined_balloon_and_mark_each_session()
    {
        var gate = new BalloonGate();
        var planner = new BalloonPlanner();
        planner.Plan(Snap(), gate, Now);
        var due = planner.Plan(
            Snap(
                Session("a", "alpha", waitingCount: 1),
                Session("b", "beta", state: "waiting"),
                Session("c", "gamma", waitingCount: 2),
                Session("d", "delta", waitingCount: 1),
                Session("i", "idle")),
            gate,
            Now);
        var b = Assert.Single(due);
        Assert.Null(b.SessionId);
        Assert.Equal("4 sessions are waiting on you", b.Title);
        Assert.Equal("alpha, beta, gamma and 1 more", b.Text);

        // Each was shown (inside the combined one): a further rise within 5 minutes stays quiet.
        Assert.Empty(planner.Plan(
            Snap(Session("a", "alpha", waitingCount: 2), Session("b", "beta", state: "waiting", waitingCount: 1)),
            gate,
            Now.AddMinutes(1)));
    }
}

public class ParentWalkTests
{
    [Fact]
    public void Walks_up_while_parents_are_older()
    {
        var table = new Dictionary<int, ProcessEntry>
        {
            [10] = new(5, 300),
            [5] = new(2, 200),
            [2] = new(1, 100),
            [1] = new(0, 50),
        };
        Assert.Equal([10, 5, 2, 1], ParentWalk.Chain(10, p => table.TryGetValue(p, out var e) ? e : null));
    }

    [Fact]
    public void Stops_at_a_reused_parent_pid_a_loop_or_a_missing_process()
    {
        var reused = new Dictionary<int, ProcessEntry> { [10] = new(5, 300), [5] = new(2, 400) };
        Assert.Equal([10], ParentWalk.Chain(10, p => reused.TryGetValue(p, out var e) ? e : null));

        var loop = new Dictionary<int, ProcessEntry> { [10] = new(5, 300), [5] = new(10, 200) };
        Assert.Equal([10, 5], ParentWalk.Chain(10, p => loop.TryGetValue(p, out var e) ? e : null));

        Assert.Empty(ParentWalk.Chain(10, _ => null));
        Assert.Empty(ParentWalk.Chain(0, _ => new ProcessEntry(0, 0)));
    }
}
