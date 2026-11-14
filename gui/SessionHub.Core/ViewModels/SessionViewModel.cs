using SessionHub.Core.Protocol;

namespace SessionHub.Core.ViewModels;

public enum SessionGroup
{
    Waiting,
    Working,
    Idle,
    Ended,
}

/// <summary>
/// One session row. The instance lives as long as the session is in the snapshots: <see cref="Update"/>
/// changes it in place, and never touches <see cref="IsExpanded"/>, <see cref="Draft"/> or <see cref="ScrollKey"/>.
/// </summary>
public sealed class SessionViewModel : ObservableObject
{
    private string name = "";
    private string cwd = "";
    private int pid;
    private string state = "unknown";
    private long? endedAt;
    private int waitingCount;
    private int? progressPct;
    private string? phase;
    private IReadOnlyList<WaitingItem> waiting = [];
    private IReadOnlyList<string> remaining = [];
    private IReadOnlyList<string> recommendations = [];
    private SessionGroup group;
    private bool needsApproval;
    private bool isExpanded;
    private string draft = "";
    private string? scrollKey;
    private readonly Dictionary<string, string> answers = new(StringComparer.Ordinal);

    public SessionViewModel(SessionView view)
    {
        ArgumentNullException.ThrowIfNull(view);
        SessionId = view.SessionId;
        Profile = view.Profile;
        Fill(view, raise: false);
    }

    public string SessionId { get; }

    public string Profile { get; }

    public string Name => name;

    public string Cwd => cwd;

    public int Pid => pid;

    public string State => state;

    public long? EndedAt => endedAt;

    /// <summary>Open items the session waits on you for.</summary>
    public int WaitingCount => waitingCount;

    public int? ProgressPct => progressPct;

    public string? Phase => phase;

    public IReadOnlyList<WaitingItem> Waiting => waiting;

    public IReadOnlyList<string> Remaining => remaining;

    public IReadOnlyList<string> Recommendations => recommendations;

    public SessionGroup Group => group;

    public bool IsLive => endedAt is null;

    /// <summary>A permission prompt is open in a live session.</summary>
    public bool NeedsApproval => needsApproval;

    public bool IsExpanded
    {
        get => isExpanded;
        set => SetField(ref isExpanded, value);
    }

    public string Draft
    {
        get => draft;
        set => SetField(ref draft, value ?? "");
    }

    public string? ScrollKey
    {
        get => scrollKey;
        set => SetField(ref scrollKey, value);
    }

    /// <summary>Unsent answers to waiting items, by label (the item's ID or "Item n"). Kept across snapshots like <see cref="Draft"/>.</summary>
    public IReadOnlyDictionary<string, string> Answers => answers;

    /// <summary>Raised with the label and new text when an answer changes (empty text: cleared).</summary>
    public event Action<string, string>? AnswerChanged;

    public string GetAnswer(string label) => answers.TryGetValue(label, out var text) ? text : "";

    public void SetAnswer(string label, string? text)
    {
        ArgumentNullException.ThrowIfNull(label);
        text ??= "";
        if (GetAnswer(label) == text) return;
        if (text.Length == 0) answers.Remove(label);
        else answers[label] = text;
        AnswerChanged?.Invoke(label, text);
    }

    /// <summary>Takes the new values and raises one change per property that differs.</summary>
    public void Update(SessionView view)
    {
        ArgumentNullException.ThrowIfNull(view);
        Fill(view, raise: true);
    }

    private void Fill(SessionView v, bool raise)
    {
        var wasLive = IsLive;
        Set(ref name, v.Name, nameof(Name), raise);
        Set(ref cwd, v.Cwd, nameof(Cwd), raise);
        Set(ref pid, v.Pid, nameof(Pid), raise);
        Set(ref state, v.State, nameof(State), raise);
        Set(ref endedAt, v.EndedAt, nameof(EndedAt), raise);
        Set(ref waitingCount, v.WaitingCount, nameof(WaitingCount), raise);
        Set(ref progressPct, v.Status?.ProgressPct, nameof(ProgressPct), raise);
        Set(ref phase, v.Status?.Phase, nameof(Phase), raise);
        SetList(ref waiting, v.Status?.Waiting ?? [], WaitingEquals, nameof(Waiting), raise);
        SetList(ref remaining, v.Status?.Remaining ?? [], string.Equals, nameof(Remaining), raise);
        SetList(ref recommendations, v.Status?.Recommendations ?? [], string.Equals, nameof(Recommendations), raise);

        var live = endedAt is null;
        Set(ref needsApproval, live && state == "waiting", nameof(NeedsApproval), raise);
        Set(ref group, ComputeGroup(), nameof(Group), raise);
        if (raise && wasLive != live) Raise(nameof(IsLive));
    }

    private SessionGroup ComputeGroup()
    {
        if (endedAt is not null) return SessionGroup.Ended;
        if (waitingCount > 0 || state == "waiting") return SessionGroup.Waiting;
        return state == "busy" ? SessionGroup.Working : SessionGroup.Idle;
    }

    private void Set<T>(ref T field, T value, string property, bool raise)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        if (raise) Raise(property);
    }

    private void SetList<T>(ref IReadOnlyList<T> field, IReadOnlyList<T> value, Func<T, T, bool> equals, string property, bool raise)
    {
        if (field.Count == value.Count && field.Zip(value).All(p => equals(p.First, p.Second))) return;
        field = value;
        if (raise) Raise(property);
    }

    private static bool WaitingEquals(WaitingItem a, WaitingItem b) =>
        a.Id == b.Id && a.Text == b.Text && a.IsNew == b.IsNew && a.Children.SequenceEqual(b.Children);
}
