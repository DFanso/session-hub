using System.Text.Json;
using SessionHub.Core.App;
using SessionHub.Core.Bridge;
using SessionHub.Core.Layout;
using SessionHub.Core.Protocol;
using SessionHub.Core.Settings;
using SessionHub.Core.ViewModels;
using static SessionHub.Tests.TestData;

namespace SessionHub.Tests;

/// <summary>
/// A bridge whose replies the test hands out one request at a time. Requests can arrive from
/// continuations on the thread pool, so the list is read and written under a lock.
/// </summary>
internal sealed class ScriptedBridge
{
    private readonly object gate = new();
    private readonly List<(BridgeRequest Request, TaskCompletionSource<Reply> Reply)> calls = [];

    public IReadOnlyList<BridgeRequest> Requests
    {
        get
        {
            lock (gate) return [.. calls.Select(c => c.Request)];
        }
    }

    public Task<Reply> Request(BridgeRequest r, TimeSpan _)
    {
        var tcs = new TaskCompletionSource<Reply>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate) calls.Add((r, tcs));
        return tcs.Task;
    }

    /// <summary>Answers call <paramref name="index"/> with a JSON result.</summary>
    public void Answer(int index, string resultJson) =>
        Call(index).SetResult(new Reply(1, true, JsonDocument.Parse(resultJson).RootElement.Clone()));

    public void Fail(int index) => Call(index).SetResult(new Reply(1, false, null, new BridgeError("no-store", "x")));

    private TaskCompletionSource<Reply> Call(int index)
    {
        lock (gate) return calls[index].Reply;
    }

    public static string Page(bool more, params (string Uuid, string Ts, string Role, string Text, bool Truncated)[] rows) =>
        JsonSerializer.Serialize(new
        {
            messages = rows.Select(r => new { uuid = r.Uuid, sessionId = "s1", ts = r.Ts, role = r.Role, fromName = (string?)null, text = r.Text, textTruncated = r.Truncated }),
            truncated = false,
            more,
        });

    public static (string, string, string, string, bool) Row(int n, string role = "assistant", string? text = null, bool truncated = false) =>
        ($"u{n}", $"2025-11-13T10:{n / 60:00}:{n % 60:00}.000Z", role, text ?? $"message {n}", truncated);
}

public class HistoryViewModelTests
{
    private static readonly TimeZoneInfo Utc = TimeZoneInfo.Utc;

    /// <summary>"Now" on the day of the scripted rows, so their meta shows the time only.</summary>
    private static DateTimeOffset Today() => new(2025, 11, 13, 12, 0, 0, TimeSpan.Zero);

    private sealed class ManualDelay
    {
        public List<(TimeSpan Delay, TaskCompletionSource Done, CancellationToken Token)> Pending { get; } = [];

        public Task Wait(TimeSpan delay, CancellationToken token)
        {
            var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            token.Register(() => done.TrySetCanceled(token));
            Pending.Add((delay, done, token));
            return done.Task;
        }

        public void Elapse() => Pending[^1].Done.TrySetResult();
    }

    /// <summary>Waits until <paramref name="done"/> holds (continuations run on the thread pool); fails after 10 s.</summary>
    private static async Task Until(Func<bool> done)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (!done())
        {
            Assert.True(sw.Elapsed < TimeSpan.FromSeconds(10), "condition not met within 10 s");
            await Task.Delay(1);
        }
    }

    [Fact]
    public async Task Show_loads_the_newest_page_oldest_first_and_reports_more()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var changes = new List<string>();
        h.Changing += c => changes.Add("before " + c);
        h.Changed += c => changes.Add("after " + c);

        var load = h.ShowAsync("s1");
        var req = Assert.IsType<HistoryRequest>(bridge.Requests[0]);
        Assert.Equal(("s1", 100, (string?)null), (req.SessionId, req.Limit, req.BeforeTs));
        bridge.Answer(0, ScriptedBridge.Page(true, ScriptedBridge.Row(1, "owner"), ScriptedBridge.Row(2)));
        await load;

        Assert.Equal(["u1", "u2"], h.Lines.Select(l => l.Uuid));
        Assert.True(h.Lines[0].FromOwner);
        Assert.Equal("You · 10:00", h.Lines[0].Meta);
        Assert.Equal("Claude · 10:00", h.Lines[1].Meta);
        Assert.True(h.More);
        Assert.True(h.ShowLoadOlder);
        Assert.Equal(["before Replaced", "after Replaced"], changes);
    }

    [Fact]
    public async Task Load_older_asks_before_the_oldest_row_and_prepends_without_duplicates()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var load = h.ShowAsync("s1");
        bridge.Answer(0, ScriptedBridge.Page(true, ScriptedBridge.Row(5), ScriptedBridge.Row(6)));
        await load;

        var changes = new List<HistoryChange>();
        h.Changed += changes.Add;
        var older = h.LoadOlderAsync();
        var req = Assert.IsType<HistoryRequest>(bridge.Requests[1]);
        Assert.Equal(("s1", 100, ScriptedBridge.Row(5).Item2, "u5"), (req.SessionId, req.Limit, req.BeforeTs, req.BeforeUuid));
        Assert.False(h.ShowLoadOlder); // no second click while the page is out
        bridge.Answer(1, ScriptedBridge.Page(false, ScriptedBridge.Row(3), ScriptedBridge.Row(4), ScriptedBridge.Row(5)));
        await older;

        Assert.Equal(["u3", "u4", "u5", "u6"], h.Lines.Select(l => l.Uuid));
        Assert.False(h.More);
        Assert.False(h.ShowLoadOlder);
        Assert.True(h.ShowStart);
        Assert.Equal([HistoryChange.Prepended], changes);

        await h.LoadOlderAsync();
        Assert.Equal(2, bridge.Requests.Count); // nothing older to ask for
    }

    [Fact]
    public async Task New_messages_are_appended_and_a_gap_reloads_the_newest_page()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var load = h.ShowAsync("s1");
        bridge.Answer(0, ScriptedBridge.Page(false, ScriptedBridge.Row(1), ScriptedBridge.Row(2)));
        await load;
        var changes = new List<HistoryChange>();
        h.Changed += changes.Add;

        var refresh = h.RefreshAsync();
        Assert.Equal(20, Assert.IsType<HistoryRequest>(bridge.Requests[1]).Limit);
        bridge.Answer(1, ScriptedBridge.Page(false, ScriptedBridge.Row(1), ScriptedBridge.Row(2), ScriptedBridge.Row(3)));
        await refresh;
        Assert.Equal(["u1", "u2", "u3"], h.Lines.Select(l => l.Uuid));
        Assert.Equal([HistoryChange.Appended], changes);

        // More than a refresh page arrived: the newest shown row is not in it, so the newest full page loads.
        refresh = h.RefreshAsync();
        bridge.Answer(2, ScriptedBridge.Page(true, ScriptedBridge.Row(200), ScriptedBridge.Row(201)));
        await Until(() => bridge.Requests.Count == 4);
        var full = Assert.IsType<HistoryRequest>(bridge.Requests[3]);
        Assert.Equal((100, (string?)null), (full.Limit, full.BeforeTs));
        bridge.Answer(3, ScriptedBridge.Page(true, ScriptedBridge.Row(199), ScriptedBridge.Row(200), ScriptedBridge.Row(201)));
        await refresh;
        Assert.Equal(["u199", "u200", "u201"], h.Lines.Select(l => l.Uuid));
        Assert.True(h.More);
        Assert.Equal(HistoryChange.Replaced, changes[^1]);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_new_message_during_load_older_is_not_lost(bool olderFirst)
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var load = h.ShowAsync("s1");
        bridge.Answer(0, ScriptedBridge.Page(true, ScriptedBridge.Row(5), ScriptedBridge.Row(6)));
        await load;

        var older = h.LoadOlderAsync();
        var refresh = h.RefreshAsync();
        Assert.Equal(3, bridge.Requests.Count);
        var olderPage = ScriptedBridge.Page(false, ScriptedBridge.Row(4));
        var newPage = ScriptedBridge.Page(true, ScriptedBridge.Row(5), ScriptedBridge.Row(6), ScriptedBridge.Row(7));
        if (olderFirst)
        {
            bridge.Answer(1, olderPage);
            await older;
            bridge.Answer(2, newPage);
            await refresh;
        }
        else
        {
            bridge.Answer(2, newPage);
            await refresh;
            bridge.Answer(1, olderPage);
            await older;
        }

        Assert.Equal(["u4", "u5", "u6", "u7"], h.Lines.Select(l => l.Uuid));
    }

    [Fact]
    public async Task A_new_message_while_the_first_page_loads_is_fetched_after_it()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var load = h.ShowAsync("s1");
        var refresh = h.RefreshAsync();
        Assert.Single(bridge.Requests); // waits for the page that is out
        bridge.Answer(0, ScriptedBridge.Page(false, ScriptedBridge.Row(1)));
        await Until(() => bridge.Requests.Count == 2);
        bridge.Answer(1, ScriptedBridge.Page(false, ScriptedBridge.Row(1), ScriptedBridge.Row(2)));
        await load;
        await refresh;
        Assert.Equal(["u1", "u2"], h.Lines.Select(l => l.Uuid));
        Assert.Equal(2, bridge.Requests.Count);
    }

    [Fact]
    public async Task Load_older_answered_after_a_session_switch_is_dropped()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var load = h.ShowAsync("s1");
        bridge.Answer(0, ScriptedBridge.Page(true, ScriptedBridge.Row(5)));
        await load;
        var older = h.LoadOlderAsync();
        var other = h.ShowAsync("s2");
        bridge.Answer(2, ScriptedBridge.Page(false, ScriptedBridge.Row(50)));
        await other;
        bridge.Answer(1, ScriptedBridge.Page(false, ScriptedBridge.Row(4)));
        await older;
        Assert.Equal(["u50"], h.Lines.Select(l => l.Uuid));
        Assert.False(h.More);
        Assert.True(h.ShowStart);
    }

    [Fact]
    public async Task A_failed_older_page_shows_a_notice_that_clears_on_success()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var load = h.ShowAsync("s1");
        bridge.Answer(0, ScriptedBridge.Page(true, ScriptedBridge.Row(5)));
        await load;
        var older = h.LoadOlderAsync();
        bridge.Fail(1);
        await older;
        Assert.Equal("Older messages could not be loaded.", h.Notice);
        older = h.LoadOlderAsync();
        bridge.Answer(2, ScriptedBridge.Page(false, ScriptedBridge.Row(4)));
        await older;
        Assert.Equal("", h.Notice);
        Assert.False(h.ShowNotice);
    }

    [Fact]
    public async Task At_2000_rows_load_older_stops_with_a_note_and_new_rows_push_out_the_oldest()
    {
        Assert.Equal(2000, HistoryViewModel.MaxRows);
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        static string Rows(int from, int to, bool more) =>
            ScriptedBridge.Page(more, [.. Enumerable.Range(from, to - from).Select(n => ScriptedBridge.Row(n))]);

        var load = h.ShowAsync("s1");
        bridge.Answer(0, Rows(2050, 2100, more: true));
        await load;
        for (var page = 1; page <= 20; page++)
        {
            var older = h.LoadOlderAsync();
            var top = 2050 - (page * 100);
            bridge.Answer(page, Rows(top, top + 100, more: true));
            await older;
        }

        Assert.Equal(2000, h.Lines.Count);
        Assert.Equal("u100", h.Lines[0].Uuid); // the 20th page only filled up to the cap
        Assert.True(h.More);
        Assert.False(h.ShowLoadOlder);
        Assert.True(h.ShowCapNote);
        Assert.Equal("Older messages are not kept in this window.", h.CapNote);
        var asked = bridge.Requests.Count;
        await h.LoadOlderAsync();
        Assert.Equal(asked, bridge.Requests.Count);

        var refresh = h.RefreshAsync();
        bridge.Answer(asked, Rows(2090, 2102, more: true));
        await refresh;
        Assert.Equal(2000, h.Lines.Count);
        Assert.Equal("u102", h.Lines[0].Uuid);
        Assert.Equal("u2101", h.Lines[^1].Uuid);
    }

    [Fact]
    public async Task Rows_from_another_day_show_a_short_date()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: () => new DateTimeOffset(2025, 11, 14, 9, 0, 0, TimeSpan.Zero));
        var load = h.ShowAsync("s1");
        bridge.Answer(0, ScriptedBridge.Page(false, ScriptedBridge.Row(1, "owner")));
        await load;
        Assert.Equal("You · Nov 13 · 10:00", h.Lines[0].Meta);
    }

    [Fact]
    public async Task A_failed_search_says_so()
    {
        var bridge = new ScriptedBridge();
        var delay = new ManualDelay();
        var h = new HistoryViewModel(bridge.Request, Utc, null, delay.Wait, Today);
        h.Query = "x";
        delay.Elapse();
        await Until(() => bridge.Requests.Count == 1);
        bridge.Fail(0);
        await h.SearchCompletion;
        Assert.Equal("Search failed.", h.SearchNotice);
        Assert.Empty(h.Hits);
    }

    [Fact]
    public async Task A_reply_for_a_session_no_longer_shown_is_dropped()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var first = h.ShowAsync("s1");
        var second = h.ShowAsync("s2");
        bridge.Answer(1, ScriptedBridge.Page(false, ScriptedBridge.Row(9)));
        await second;
        bridge.Answer(0, ScriptedBridge.Page(false, ScriptedBridge.Row(1)));
        await first;
        Assert.Equal(["u9"], h.Lines.Select(l => l.Uuid));
        Assert.Equal("s2", h.SessionId);
    }

    [Fact]
    public async Task A_failed_page_shows_a_notice_and_no_session_clears()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var load = h.ShowAsync("s1");
        bridge.Fail(0);
        await load;
        Assert.Equal("History could not be loaded.", h.Notice);

        load = h.ShowAsync("s1");
        bridge.Answer(1, ScriptedBridge.Page(false));
        await load;
        Assert.Equal("No messages in the last 7 days.", h.Notice);

        await h.ShowAsync(null);
        Assert.Empty(h.Lines);
        Assert.Equal(2, bridge.Requests.Count);
    }

    [Fact]
    public async Task Long_and_shortened_messages_are_capped_and_marked()
    {
        var bridge = new ScriptedBridge();
        var h = new HistoryViewModel(bridge.Request, Utc, clock: Today);
        var load = h.ShowAsync("s1");
        var huge = new string('x', 25_000);
        bridge.Answer(0, ScriptedBridge.Page(false, ScriptedBridge.Row(1, text: huge), ScriptedBridge.Row(2, text: "cut", truncated: true)));
        await load;
        Assert.Equal(20_001, h.Lines[0].Text.Length);
        Assert.EndsWith("…", h.Lines[0].Text);
        Assert.False(h.Lines[0].Shortened);
        Assert.True(h.Lines[1].Shortened);
    }

    [Fact]
    public void Cap_keeps_up_to_20000_characters_and_never_splits_a_surrogate_pair()
    {
        Assert.Equal(20_000, HistoryViewModel.MaxMessageChars);
        var exact = new string('a', 20_000);
        Assert.Same(exact, HistoryViewModel.Cap(exact));
        var pair = new string('a', 19_999) + "😀" + "tail";
        var cut = HistoryViewModel.Cap(pair);
        Assert.Equal(new string('a', 19_999) + "…", cut);
    }

    [Fact]
    public async Task Search_waits_300_ms_after_the_last_key_and_sends_one_request()
    {
        var bridge = new ScriptedBridge();
        var delay = new ManualDelay();
        var h = new HistoryViewModel(bridge.Request, Utc, id => id == "s1" ? "alpha" : null, delay.Wait, Today);

        h.Query = "a";
        h.Query = "ab";
        h.Query = "abc";
        Assert.True(h.IsSearching);
        Assert.All(delay.Pending, p => Assert.Equal(TimeSpan.FromMilliseconds(300), p.Delay));
        Assert.True(delay.Pending[0].Token.IsCancellationRequested);
        Assert.True(delay.Pending[1].Token.IsCancellationRequested);
        delay.Elapse();
        await Until(() => bridge.Requests.Count == 1);

        var req = Assert.IsType<SearchRequest>(Assert.Single(bridge.Requests));
        Assert.Equal(("abc", 100), (req.Q, req.Limit));
        bridge.Answer(0, """{"hits":[{"sessionId":"s1","uuid":"u1","ts":"2025-11-13T10:00:00.000Z","role":"owner","snippet":"say [abc]"},{"sessionId":"zz","uuid":"u2","ts":"2025-11-13T11:00:00.000Z","role":"assistant","snippet":"x"}]}""");
        await h.SearchCompletion;

        Assert.Equal(2, h.Hits.Count);
        Assert.Equal("alpha · You · 10:00", h.Hits[0].Meta);
        Assert.Equal("say [abc]", h.Hits[0].Text);
        Assert.Equal("another session · Claude · 11:00", h.Hits[1].Meta);
        Assert.Equal("", h.SearchNotice);

        h.Query = " ";
        Assert.False(h.IsSearching);
        Assert.Empty(h.Hits);
    }

    [Fact]
    public async Task A_search_answered_after_the_query_changed_is_dropped()
    {
        var bridge = new ScriptedBridge();
        var delay = new ManualDelay();
        var h = new HistoryViewModel(bridge.Request, Utc, null, delay.Wait, Today);
        h.Query = "old";
        delay.Elapse();
        await Until(() => bridge.Requests.Count == 1);
        var old = h.SearchCompletion;
        h.Query = "";
        bridge.Answer(0, """{"hits":[{"sessionId":"s1","uuid":"u1","ts":"t","role":"owner","snippet":"old"}]}""");
        await old;
        Assert.Empty(h.Hits);

        h.Query = "none";
        delay.Elapse();
        await Until(() => bridge.Requests.Count == 2);
        bridge.Answer(1, """{"hits":[]}""");
        await h.SearchCompletion;
        Assert.Equal("No matches in the last 7 days.", h.SearchNotice);
        Assert.Equal("Last 7 days · secrets masked · No matches in the last 7 days.", h.InfoLine);
    }

    [Fact]
    public async Task The_notice_hides_while_searching_and_the_info_line_is_plain_without_a_search()
    {
        var bridge = new ScriptedBridge();
        var delay = new ManualDelay();
        var h = new HistoryViewModel(bridge.Request, Utc, null, delay.Wait, Today);
        var load = h.ShowAsync("s1");
        bridge.Answer(0, ScriptedBridge.Page(false));
        await load;
        Assert.True(h.ShowNotice);
        Assert.Equal("Last 7 days · secrets masked", h.InfoLine);
        h.Query = "x";
        Assert.False(h.ShowNotice);
        Assert.Equal("Last 7 days · secrets masked · Searching…", h.InfoLine);
    }
}

public class WindowViewModelTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeMilliseconds(10_000_000);

    private static (PanelViewModel Panel, WindowViewModel Window) Make(params SessionView[] sessions)
    {
        var panel = new PanelViewModel(new HubViewModel());
        panel.SetHealth(new BridgeHealth.Connected());
        var window = new WindowViewModel(panel);
        Apply(panel, window, sessions);
        return (panel, window);
    }

    private static void Apply(PanelViewModel panel, WindowViewModel window, params SessionView[] sessions)
    {
        panel.Apply(Snap(sessions), Now);
        window.Refresh(reorder: false);
    }

    private static readonly SessionView[] Mixed =
    [
        Session("i1", name: "idle-one"),
        Session("b1", name: "busy-one", state: "busy"),
        Session("w1", name: "waits", waitingCount: 2),
        Session("a1", name: "approve", state: "waiting"),
        Session("e1", name: "gone", endedAt: 5),
    ];

    [Fact]
    public void Sessions_are_grouped_and_the_ended_group_starts_collapsed()
    {
        var (_, w) = Make(Mixed);
        Assert.Equal(["Waiting on you", "Working", "Idle", "Ended (7 days)"], w.Groups.Select(g => g.Title));
        Assert.Equal(["waits", "approve"], w.Groups[0].Items.Select(c => c.Session.Name));
        Assert.Equal(["busy-one"], w.Groups[1].Items.Select(c => c.Session.Name));
        Assert.Equal(["idle-one"], w.Groups[2].Items.Select(c => c.Session.Name));
        Assert.Equal(["gone"], w.Groups[3].Items.Select(c => c.Session.Name));
        Assert.Equal("Waiting on you · 2", w.Groups[0].Header);
        Assert.Equal("Ended (7 days) · 1", w.Groups[3].Header);
        Assert.True(w.Groups[0].ShowItems);
        Assert.False(w.Groups[3].IsExpanded);
        Assert.False(w.Groups[3].ShowItems);
        Assert.True(w.Groups[3].HasItems);

        WindowViewModel.ToggleGroup(w.Groups[3]);
        Assert.True(w.Groups[3].ShowItems);
        WindowViewModel.ToggleGroup(w.Groups[0]); // only the ended group folds
        Assert.True(w.Groups[0].IsExpanded);
    }

    [Fact]
    public void The_first_waiting_session_is_selected_and_selection_survives_snapshots()
    {
        var (p, w) = Make(Mixed);
        Assert.Equal("w1", w.Selected!.Session.SessionId);
        w.Select(p.Card("i1"));
        Apply(p, w, Mixed);
        Assert.Equal("i1", w.Selected!.Session.SessionId);

        // The selected session left the snapshot: the first one in group order takes over.
        Apply(p, w, Mixed[1], Mixed[4]);
        Assert.Equal("b1", w.Selected!.Session.SessionId);

        Apply(p, w);
        Assert.Null(w.Selected);
        Assert.False(w.HasSelection);
    }

    [Fact]
    public void Only_ended_sessions_still_give_a_selection()
    {
        var (_, w) = Make(Mixed[4]);
        Assert.Equal("e1", w.Selected!.Session.SessionId);
    }

    [Fact]
    public void Search_filters_the_list_but_keeps_the_selection()
    {
        var (_, w) = Make(Mixed);
        w.Query = "busy";
        Assert.Empty(w.Groups[0].Items);
        Assert.False(w.Groups[0].HasItems);
        Assert.Equal(["busy-one"], w.Groups[1].Items.Select(c => c.Session.Name));
        Assert.Equal("w1", w.Selected!.Session.SessionId);
    }

    [Fact]
    public void Selecting_by_id_opens_the_ended_group_and_unknown_ids_are_ignored()
    {
        var (_, w) = Make(Mixed);
        Assert.True(w.Select("e1"));
        Assert.True(w.Groups[3].IsExpanded);
        Assert.Equal("e1", w.Selected!.Session.SessionId);
        Assert.False(w.Select("nope"));
        Assert.Equal("e1", w.Selected!.Session.SessionId);
    }

    [Fact]
    public void Header_texts_follow_the_selection_and_the_link()
    {
        var (p, w) = Make(Session("w1", name: "waits", waitingCount: 3, cwd: @"D:\work\x") with { UpdatedAt = Now.AddMinutes(-2).ToUnixTimeMilliseconds() });
        Assert.Equal(@"D:\work\x · .p · 3 waiting on you", w.HeaderSub);
        Assert.Equal("3 waiting on you", w.WaitingChip);
        Assert.Equal("live · last update 2 min ago", w.StatusText);

        p.SetHealth(new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1)));
        Assert.Equal("reconnecting · last update 2 min ago", w.StatusText);

        var raised = new List<string?>();
        w.PropertyChanged += (_, e) => raised.Add(e.PropertyName);
        Apply(p, w, Session("w1", name: "waits", cwd: @"D:\work\x") with { UpdatedAt = Now.ToUnixTimeMilliseconds() });
        Assert.Equal(@"D:\work\x · .p · idle", w.HeaderSub);
        Assert.Equal("", w.WaitingChip);
        Assert.Contains(nameof(WindowViewModel.HeaderSub), raised);
    }

    [Fact]
    public void New_activity_of_the_selected_session_is_announced_once_per_snapshot()
    {
        var s = Session("s1") with { UpdatedAt = 5, LatestReply = new LatestReply("r1", "t", true) };
        var (p, w) = Make(s);
        var news = new List<string>();
        w.NewActivity += c => news.Add(c.Session.SessionId);
        Apply(p, w, s);
        Assert.Empty(news);
        Apply(p, w, s with { UpdatedAt = 9 }); // a new owner or peer message moves updatedAt only
        Assert.Equal(["s1"], news);
        Apply(p, w, s with { UpdatedAt = 12, LatestReply = new LatestReply("r2", "t", true) });
        Assert.Equal(["s1", "s1"], news);
    }

    [Fact]
    public void A_selected_session_that_ends_opens_the_ended_group_once()
    {
        var live = Session("s1");
        var (p, w) = Make(live, Session("s2"));
        Assert.Equal("s1", w.Selected!.Session.SessionId);
        Apply(p, w, live with { EndedAt = 5 }, Session("s2"));
        Assert.Equal("s1", w.Selected!.Session.SessionId);
        Assert.True(w.Groups[3].IsExpanded);
        WindowViewModel.ToggleGroup(w.Groups[3]);
        Apply(p, w, live with { EndedAt = 5 }, Session("s2"));
        Assert.False(w.Groups[3].IsExpanded);
    }

    [Fact]
    public void Selecting_raises_selection_changed_once()
    {
        var (p, w) = Make(Mixed);
        var seen = new List<string?>();
        w.SelectionChanged += c => seen.Add(c?.Session.SessionId);
        w.Select(p.Card("b1"));
        w.Select(p.Card("b1"));
        Assert.Equal(["b1"], seen);
    }

    [Theory]
    [InlineData(720, 240, false, true)]
    [InlineData(899, 240, false, true)]
    [InlineData(900, 300, true, false)]
    [InlineData(1400, 300, true, false)]
    public void Width_breakpoints(double width, double list, bool subtitles, bool stacked)
    {
        var (_, w) = Make();
        w.SetWidth(width);
        Assert.Equal((list, subtitles, stacked), (w.ListWidth, w.ShowSubtitles, w.StackStatusBoxes));
    }

    [Fact]
    public void List_rows_show_profile_and_phase_and_a_badge()
    {
        var (p, _) = Make(Mixed);
        Assert.Equal(".p · no phase yet", p.Card("i1")!.ListSubText);
        Assert.Null(p.Card("i1")!.ListBadge);
        Assert.Equal(new Chip("2", ChipTone.Amber), p.Card("w1")!.ListBadge);
        Assert.Equal(new Chip("approve", ChipTone.Red), p.Card("a1")!.ListBadge);

        var (q, _) = Make(Session("x", phase: "Build"));
        Assert.Equal(".p · Build", q.Card("x")!.ListSubText);
    }
}

public class TimeStampTests
{
    private static readonly DateTimeOffset Now = new(2025, 11, 13, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Today_shows_the_time_and_other_days_a_short_date()
    {
        Assert.Equal("10:00", TimeText.Stamp("2025-11-13T10:00:00.000Z", TimeZoneInfo.Utc, Now));
        Assert.Equal("Nov 12 · 07:39", TimeText.Stamp("2025-11-12T07:39:00.000Z", TimeZoneInfo.Utc, Now));
        Assert.Equal("", TimeText.Stamp("not a time", TimeZoneInfo.Utc, Now));
    }
}

public class WindowPlacementsTests
{
    private static readonly RectPx Primary = new(0, 0, 1920, 1040);

    [Fact]
    public void Restore_bounds_in_dip_are_saved_as_pixels_of_that_monitor_with_its_scale()
    {
        var saved = WindowPlacements.ToSaved(100.4, 50, 1000, 620, 1.5, maximized: true);
        Assert.Equal(new WindowPlacement(151, 75, 1500, 930, true, 1.5), saved);
    }

    [Fact]
    public void A_window_from_a_lost_200_percent_monitor_keeps_its_dip_size_on_a_100_percent_primary()
    {
        var lost = new WindowPlacement(3000, 100, 2000, 1200, false, 2.0);
        Assert.Equal(new RectPx(460, 220, 1000, 600), WindowPlacements.Initial(lost, [Primary], 1.0));
        Assert.Equal(new RectPx(460, 220, 1000, 600), WindowLayout.Restore(new RectPx(3000, 100, 2000, 1200), [Primary], 1.0, 2.0));
        // An old gui.json without a scale keeps the pixel size.
        Assert.Equal(new RectPx(0, 0, 1920, 1040), WindowPlacements.Initial(lost with { Scale = 0 }, [Primary], 1.0));
    }

    [Fact]
    public void No_saved_placement_centres_the_default_size_on_the_primary()
    {
        Assert.Equal(new RectPx(460, 210, 1000, 620), WindowPlacements.Initial(null, [Primary], 1.0));
        Assert.Equal(new RectPx(210, 55, 1500, 930), WindowPlacements.Initial(null, [Primary], 1.5));
        // Never bigger than the primary work area.
        Assert.Equal(new RectPx(0, 0, 1280, 700), WindowPlacements.Initial(null, [new RectPx(0, 0, 1280, 700)], 2.0));
    }

    [Fact]
    public void A_visible_saved_rect_is_kept_and_a_lost_monitor_moves_it_to_the_primary()
    {
        var second = new RectPx(1920, 0, 2560, 1400);
        var onSecond = new WindowPlacement(2000, 100, 1200, 800, false);
        Assert.Equal(new RectPx(2000, 100, 1200, 800), WindowPlacements.Initial(onSecond, [Primary, second], 1.0));
        Assert.Equal(new RectPx(360, 120, 1200, 800), WindowPlacements.Initial(onSecond, [Primary], 1.0));
    }

    [Theory]
    [InlineData(double.NaN, 0, 800, 600)]
    [InlineData(0, 0, -5, 600)]
    [InlineData(0, 0, 800, double.PositiveInfinity)]
    [InlineData(1e12, 0, 800, 600)]
    public void A_broken_saved_rect_is_ignored(double x, double y, double w, double h)
    {
        Assert.Equal(new RectPx(460, 210, 1000, 620), WindowPlacements.Initial(new WindowPlacement(x, y, w, h, false), [Primary], 1.0));
    }
}
