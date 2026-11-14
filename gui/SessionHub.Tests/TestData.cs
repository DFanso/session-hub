using SessionHub.Core.Protocol;

namespace SessionHub.Tests;

internal static class TestData
{
    public static SessionView Session(
        string id,
        string name = "s",
        string state = "idle",
        int waitingCount = 0,
        long? endedAt = null,
        string cwd = "D:/work/x",
        string? phase = null,
        IReadOnlyList<WaitingItem>? waiting = null)
    {
        var status = phase is null && waiting is null
            ? null
            : new SessionStatus(null, phase, [], waiting ?? [], [], "u", "t");
        return new SessionView(id, "p", name, cwd, 1, "cli", 0, 0, endedAt, null, state, status, null, waitingCount);
    }

    public static Meta Meta(string daemon = "running") => new(0, null, [], daemon);

    public static HubSnapshot Snap(params SessionView[] sessions)
    {
        var live = sessions.Where(s => s.EndedAt is null).ToList();
        return new HubSnapshot(
            sessions,
            Meta(),
            new Totals(live.Sum(s => s.WaitingCount), live.Count(s => s.State == "waiting"), live.Count));
    }
}
