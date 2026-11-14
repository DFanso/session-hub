namespace SessionHub.Core.App;

/// <summary>A process's parent id and creation time (any monotonic unit, e.g. FILETIME ticks).</summary>
public readonly record struct ProcessEntry(int ParentPid, long Created);

/// <summary>
/// The chain from a session's process up through its parents, where Jump looks for a window (the
/// terminal usually belongs to a parent). The walk stops at a missing process, a loop, or a parent
/// younger than its child (the parent id was reused), like v1's focus script.
/// </summary>
public static class ParentWalk
{
    public const int MaxDepth = 32;

    public static IReadOnlyList<int> Chain(int pid, Func<int, ProcessEntry?> lookup)
    {
        ArgumentNullException.ThrowIfNull(lookup);
        var chain = new List<int>();
        if (pid <= 0) return chain;
        var current = lookup(pid);
        var id = pid;
        while (current is { } entry && chain.Count < MaxDepth && !chain.Contains(id))
        {
            chain.Add(id);
            var parentId = entry.ParentPid;
            if (parentId <= 0) break;
            var parent = lookup(parentId);
            if (parent is not { } p || p.Created > entry.Created) break;
            id = parentId;
            current = parent;
        }

        return chain;
    }
}
