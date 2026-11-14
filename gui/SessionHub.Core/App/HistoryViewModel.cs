using System.Collections.ObjectModel;
using SessionHub.Core.Protocol;
using SessionHub.Core.ViewModels;

namespace SessionHub.Core.App;

/// <summary>One message of the window's History tab. <paramref name="Shortened"/>: the bridge cut it (<c>textTruncated</c>).</summary>
public sealed record HistoryLine(string Uuid, string Ts, bool FromOwner, string Meta, string Text, bool Shortened);

/// <summary>One search hit: "session · You · 10:02" and the snippet.</summary>
public sealed record SearchLine(string Meta, string Text);

/// <summary>How <see cref="HistoryViewModel.Lines"/> changed; the view keeps or moves its scroll position by it.</summary>
public enum HistoryChange
{
    /// <summary>A new list (another session, or a gap of more than a refresh page).</summary>
    Replaced,

    /// <summary>Older messages went in at the top ("Load older").</summary>
    Prepended,

    /// <summary>New messages went in at the bottom (the oldest may have dropped out at the cap).</summary>
    Appended,
}

/// <summary>
/// The window's History tab: pages of one session's messages (newest page first, "Load older" before
/// the oldest row with a tie-safe (ts, uuid) cursor), new messages appended as they arrive, at most
/// <see cref="MaxRows"/> rows, and a debounced search. Replies for a session or query no longer shown
/// are dropped; a refresh asked for while the first page is out runs after it, so no new message is
/// lost. Call on the UI thread.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1001", Justification = "searchWait is disposed on every new search; it never has a timer, so the last one holds nothing unmanaged.")]
public sealed class HistoryViewModel : ObservableObject
{
    public const int PageSize = 100;

    /// <summary>Page of a refresh (new messages): small, since it runs on every activity of the session.</summary>
    public const int RefreshSize = 20;

    public const int SearchLimit = 100;

    /// <summary>Most rows kept in the window; "Load older" stops there and new rows push out the oldest.</summary>
    public const int MaxRows = 2000;

    /// <summary>Longest message text shown; the rest is cut with "…" (the full text is never needed in the UI).</summary>
    public const int MaxMessageChars = 20_000;


    public static readonly TimeSpan SearchDelay = TimeSpan.FromMilliseconds(300);
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);

    private readonly Func<BridgeRequest, TimeSpan, Task<Reply>> request;
    private readonly TimeZoneInfo zone;
    private readonly Func<string, string?> sessionName;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly Func<DateTimeOffset> clock;
    private readonly HashSet<string> known = [];
    private int generation;
    private int searchGeneration;
    private CancellationTokenSource? searchWait;
    private string? sessionId;
    private bool more;
    private bool loadingPage;
    private bool loadingOlder;
    private bool refreshPending;
    private string notice = "";
    private string query = "";
    private bool isSearching;
    private string searchNotice = "";

    public HistoryViewModel(
        Func<BridgeRequest, TimeSpan, Task<Reply>> request,
        TimeZoneInfo zone,
        Func<string, string?>? sessionName = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<DateTimeOffset>? clock = null)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(zone);
        this.request = request;
        this.zone = zone;
        this.sessionName = sessionName ?? (_ => null);
        this.delay = delay ?? ((d, token) => Task.Delay(d, token));
        this.clock = clock ?? (() => DateTimeOffset.Now);
    }

    /// <summary>Raised before <see cref="Lines"/> changes (the view reads its scroll position).</summary>
    public event Action<HistoryChange>? Changing;

    /// <summary>Raised after <see cref="Lines"/> changed.</summary>
    public event Action<HistoryChange>? Changed;

    /// <summary>Oldest first.</summary>
    public ObservableCollection<HistoryLine> Lines { get; } = [];

    public ObservableCollection<SearchLine> Hits { get; } = [];

    public string? SessionId
    {
        get => sessionId;
        private set => SetField(ref sessionId, value);
    }

    /// <summary>Older messages exist before the first row.</summary>
    public bool More
    {
        get => more;
        private set
        {
            if (SetField(ref more, value)) RaiseButtons();
        }
    }

    /// <summary>A page request (first page or older) is out.</summary>
    public bool Loading => loadingPage || loadingOlder;

    private bool AtCap => Lines.Count >= MaxRows;

    public bool ShowLoadOlder => more && !Loading && !isSearching && !AtCap;

    /// <summary>"Start of history": every message of the session is shown.</summary>
    public bool ShowStart => !more && !Loading && !isSearching && Lines.Count > 0;

    /// <summary>Older messages exist but the window keeps no more rows.</summary>
    public bool ShowCapNote => more && !Loading && !isSearching && AtCap;

    /// <summary>Shown instead of "Load older" at <see cref="MaxRows"/>.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1822", Justification = "WPF binding target: HistoryView.xaml binds {Binding CapNote} on the instance.")]
    public string CapNote => "Older messages are not kept in this window.";

    /// <summary>Empty, or why there is nothing (more) to show.</summary>
    public string Notice
    {
        get => notice;
        private set
        {
            if (SetField(ref notice, value)) Raise(nameof(ShowNotice));
        }
    }

    /// <summary>The notice is shown with the messages, not over search hits.</summary>
    public bool ShowNotice => notice.Length > 0 && !isSearching;

    /// <summary>The line above the list: "Last 7 days · secrets masked", plus the search state while searching.</summary>
    public string InfoLine => isSearching && searchNotice.Length > 0
        ? $"Last 7 days · secrets masked · {searchNotice}"
        : "Last 7 days · secrets masked";

    /// <summary>Search text; a change searches after <see cref="SearchDelay"/> without typing.</summary>
    public string Query
    {
        get => query;
        set
        {
            if (!SetField(ref query, value ?? "")) return;
            StartSearch();
        }
    }

    /// <summary>The newest search's work (wait, request, results); done when it ended or was dropped.</summary>
    public Task SearchCompletion { get; private set; } = Task.CompletedTask;

    /// <summary>The search has text: the view shows <see cref="Hits"/> instead of <see cref="Lines"/>.</summary>
    public bool IsSearching
    {
        get => isSearching;
        private set
        {
            if (!SetField(ref isSearching, value)) return;
            RaiseButtons();
            Raise(nameof(ShowNotice));
            Raise(nameof(InfoLine));
        }
    }

    public string SearchNotice
    {
        get => searchNotice;
        private set
        {
            if (SetField(ref searchNotice, value)) Raise(nameof(InfoLine));
        }
    }

    /// <summary>Shows the newest page of a session (null clears).</summary>
    public async Task ShowAsync(string? id)
    {
        var gen = ++generation;
        SessionId = id;
        More = false;
        Notice = "";
        loadingOlder = false;
        refreshPending = false;
        if (id is null)
        {
            SetLoadingPage(false);
            Replace([]);
            return;
        }

        SetLoadingPage(true);
        // The old session's messages must not stay while the new page loads.
        if (Lines.Count > 0) Replace([]);
        var page = await Fetch(new HistoryRequest(0, id, PageSize));
        if (gen != generation) return;
        SetLoadingPage(false);
        if (page is null)
        {
            Notice = "History could not be loaded.";
        }
        else
        {
            Replace(page.Messages);
            More = page.More;
            Notice = Lines.Count == 0 ? "No messages in the last 7 days." : "";
        }

        // A new message announced while this page was out may not be in it.
        if (refreshPending)
        {
            refreshPending = false;
            await RefreshAsync();
        }
    }

    /// <summary>The page before the oldest row. Does nothing while a page is out, at the cap, or when there is nothing older.</summary>
    public async Task LoadOlderAsync()
    {
        if (sessionId is null || !more || Loading || Lines.Count == 0 || AtCap) return;
        var gen = generation;
        loadingOlder = true;
        RaiseButtons();
        var oldest = Lines[0];
        var page = await Fetch(new HistoryRequest(0, sessionId, PageSize, oldest.Ts, oldest.Uuid));
        if (gen != generation) return;
        loadingOlder = false;
        RaiseButtons();
        if (page is null)
        {
            Notice = "Older messages could not be loaded.";
            return;
        }

        Notice = "";
        var older = page.Messages.Where(m => !known.Contains(m.Uuid)).ToList();
        var room = MaxRows - Lines.Count;
        var cut = older.Count > room;
        // At the cap, keep the newest of the older rows: they join the rows already shown.
        if (cut) older = older.Skip(older.Count - room).ToList();
        Changing?.Invoke(HistoryChange.Prepended);
        for (var i = 0; i < older.Count; i++) Insert(i, Line(older[i]));
        More = page.More || cut;
        RaiseButtons();
        Changed?.Invoke(HistoryChange.Prepended);
    }

    /// <summary>
    /// Fetches the newest rows and appends what is new (the session has new activity). While the
    /// first page is out it runs after that page; while an older page is out it appends anyway (the
    /// two touch different ends). A gap of more than <see cref="RefreshSize"/> rows reloads the newest page.
    /// </summary>
    public async Task RefreshAsync()
    {
        if (sessionId is null) return;
        if (loadingPage)
        {
            refreshPending = true;
            return;
        }

        if (Lines.Count == 0)
        {
            await ShowAsync(sessionId);
            return;
        }

        var gen = generation;
        var page = await Fetch(new HistoryRequest(0, sessionId, RefreshSize));
        // A switch or a reload since: that newest page is fetched after this one, so nothing is lost.
        if (gen != generation || page is null) return;

        var last = Lines[^1].Uuid;
        var at = -1;
        for (var i = 0; i < page.Messages.Count; i++)
        {
            if (page.Messages[i].Uuid == last) at = i;
        }

        if (at < 0)
        {
            if (page.Messages.All(m => known.Contains(m.Uuid))) return;
            await ShowAsync(sessionId);
            return;
        }

        var fresh = page.Messages.Skip(at + 1).Where(m => !known.Contains(m.Uuid)).ToList();
        if (fresh.Count == 0) return;
        Changing?.Invoke(HistoryChange.Appended);
        foreach (var m in fresh) Insert(Lines.Count, Line(m));
        var over = Lines.Count - MaxRows;
        for (var i = 0; i < over; i++) RemoveFirst();
        if (over > 0) More = true;
        Notice = "";
        RaiseButtons();
        Changed?.Invoke(HistoryChange.Appended);
    }

    /// <summary>Cuts to <see cref="MaxMessageChars"/> plus "…", never splitting a surrogate pair.</summary>
    public static string Cap(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.Length <= MaxMessageChars) return text;
        var keep = MaxMessageChars;
        if (char.IsHighSurrogate(text[keep - 1])) keep--;
        return text[..keep] + "…";
    }

    private void StartSearch()
    {
        searchWait?.Cancel();
        searchWait?.Dispose();
        searchWait = null;
        var gen = ++searchGeneration;
        var q = query.Trim();
        Hits.Clear();
        if (q.Length == 0)
        {
            IsSearching = false;
            SearchNotice = "";
            return;
        }

        IsSearching = true;
        SearchNotice = "Searching…";
        searchWait = new CancellationTokenSource();
        SearchCompletion = SearchAsync(q, gen, searchWait.Token);
    }

    private async Task SearchAsync(string q, int gen, CancellationToken token)
    {
        try
        {
            await delay(SearchDelay, token);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        if (gen != searchGeneration) return;
        // BridgeClient.RequestAsync never throws: a timeout or a restart is an error reply.
        var reply = await request(new SearchRequest(0, q, SearchLimit), RequestTimeout);
        if (gen != searchGeneration) return;
        var result = Json.DecodeSearch(reply);
        if (result is null)
        {
            SearchNotice = "Search failed.";
            return;
        }

        foreach (var hit in result.Hits)
        {
            var name = sessionName(hit.SessionId) ?? "another session";
            Hits.Add(new SearchLine(Meta($"{name} · {Who(hit.Role, null)}", hit.Ts), Cap(hit.Snippet)));
        }

        SearchNotice = Hits.Count == 0 ? "No matches in the last 7 days." : "";
    }

    /// <summary>Null for an error reply (timeout, restart, no store) or an unreadable one.</summary>
    private async Task<HistoryResult?> Fetch(HistoryRequest r) => Json.DecodeHistory(await request(r, RequestTimeout));

    private void SetLoadingPage(bool value)
    {
        if (loadingPage == value) return;
        loadingPage = value;
        RaiseButtons();
    }

    private void Replace(IReadOnlyList<MessageRow> rows)
    {
        Changing?.Invoke(HistoryChange.Replaced);
        Lines.Clear();
        known.Clear();
        foreach (var m in rows.Skip(Math.Max(0, rows.Count - MaxRows)))
        {
            if (known.Add(m.Uuid)) Lines.Add(Line(m));
        }

        RaiseButtons();
        Changed?.Invoke(HistoryChange.Replaced);
    }

    private void Insert(int index, HistoryLine line)
    {
        if (!known.Add(line.Uuid)) return;
        Lines.Insert(index, line);
    }

    private void RemoveFirst()
    {
        known.Remove(Lines[0].Uuid);
        Lines.RemoveAt(0);
    }

    private HistoryLine Line(MessageRow r) =>
        new(r.Uuid, r.Ts, r.Role == "owner", Meta(Who(r.Role, r.FromName), r.Ts), Cap(r.Text), r.TextTruncated);

    private static string Who(string role, string? fromName) => role switch
    {
        "owner" => "You",
        "assistant" => "Claude",
        _ => string.IsNullOrEmpty(fromName) ? role : fromName,
    };

    private string Meta(string who, string ts)
    {
        var stamp = TimeText.Stamp(ts, zone, clock());
        return stamp.Length == 0 ? who : $"{who} · {stamp}";
    }

    private void RaiseButtons()
    {
        Raise(nameof(Loading));
        Raise(nameof(ShowLoadOlder));
        Raise(nameof(ShowStart));
        Raise(nameof(ShowCapNote));
    }
}
