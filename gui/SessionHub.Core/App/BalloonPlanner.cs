using SessionHub.Core.Protocol;
using SessionHub.Core.Tray;

namespace SessionHub.Core.App;

/// <summary>A balloon to show: the session it opens (null: the panel's home), its title and one line of detail.</summary>
public sealed record BalloonNote(string? SessionId, string Title, string Text);

/// <summary>
/// Compares each snapshot with the previous one and asks <see cref="BalloonGate"/> about every
/// live session whose waiting items or approval rose. The first snapshot only sets the baseline, so
/// starting the tray never shows a burst of balloons. Windows shows one balloon at a time, so one
/// snapshot gives at most one: several sessions that rose together share one combined balloon (and
/// the gate counts it as shown for each of them). Title and text are never empty.
/// </summary>
public sealed class BalloonPlanner
{
    /// <summary>The line shown when a waiting item has no text.</summary>
    public const string DefaultText = "Open Session Hub to see it.";

    private Dictionary<string, (int Items, bool Approval)>? last;

    /// <summary>The balloon for this snapshot: none or one.</summary>
    public IReadOnlyList<BalloonNote> Plan(HubSnapshot snapshot, BalloonGate gate, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(gate);
        var current = new Dictionary<string, (int Items, bool Approval)>();
        var notes = new List<BalloonNote>();
        var risen = new List<SessionView>();
        foreach (var s in snapshot.Sessions)
        {
            var live = s.EndedAt is null;
            var state = (Items: live ? s.WaitingCount : 0, Approval: live && s.State == "waiting");
            if (!current.TryAdd(s.SessionId, state) || last is null || !live) continue;
            var before = last.TryGetValue(s.SessionId, out var b) ? b : (Items: 0, Approval: false);
            if (gate.ShouldShow(s.SessionId, before.Items, state.Items, before.Approval, state.Approval, now))
            {
                notes.Add(Note(s, state.Items, state.Approval && !before.Approval && state.Items <= before.Items));
                risen.Add(s);
            }
        }

        last = current;
        return notes.Count <= 1 ? notes : [Combined(risen)];
    }

    private static BalloonNote Note(SessionView s, int items, bool approvalOnly)
    {
        if (approvalOnly)
            return new BalloonNote(s.SessionId, $"{NameOf(s)} needs approval", "A permission prompt is open in its terminal.");
        var waiting = s.Status?.Waiting;
        var newest = waiting is { Count: > 0 } ? waiting[^1] : null;
        var text = newest is null || string.IsNullOrWhiteSpace(newest.Text)
            ? DefaultText
            : newest.Id is null ? newest.Text : $"{newest.Id}: {newest.Text}";
        return new BalloonNote(s.SessionId, $"{NameOf(s)} is waiting on you ({items})", text);
    }

    /// <summary>One balloon for several sessions; a click opens the panel's home, which lists them all.</summary>
    private static BalloonNote Combined(List<SessionView> sessions)
    {
        var names = sessions.Select(NameOf).ToList();
        var text = names.Count <= 3
            ? string.Join(", ", names)
            : $"{string.Join(", ", names.Take(3))} and {names.Count - 3} more";
        return new BalloonNote(null, $"{sessions.Count} sessions are waiting on you", text);
    }

    private static string NameOf(SessionView s) => string.IsNullOrWhiteSpace(s.Name) ? "A session" : s.Name;
}
