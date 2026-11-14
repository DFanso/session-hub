using System.Collections.ObjectModel;

namespace SessionHub.Core.App;

/// <summary>
/// Brings a bound list in line with a wanted list. Without reorder, items already shown keep their
/// place (no Move, so WPF never regenerates a container under the caret); new items go in after the
/// item that precedes them in the wanted order. With reorder, the list ends in the wanted order.
/// Items are compared by reference.
/// </summary>
public static class StableList
{
    public static void Sync<T>(ObservableCollection<T> target, IReadOnlyList<T> desired, bool reorder)
        where T : class
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(desired);

        var wanted = new HashSet<T>(desired, ReferenceEqualityComparer.Instance);
        for (var i = target.Count - 1; i >= 0; i--)
        {
            if (!wanted.Contains(target[i])) target.RemoveAt(i);
        }

        if (reorder)
        {
            for (var i = 0; i < desired.Count; i++)
            {
                if (i < target.Count && ReferenceEquals(target[i], desired[i])) continue;
                var from = IndexOf(target, desired[i], i + 1);
                if (from >= 0) target.Move(from, i);
                else target.Insert(i, desired[i]);
            }

            return;
        }

        for (var i = 0; i < desired.Count; i++)
        {
            var item = desired[i];
            if (IndexOf(target, item, 0) >= 0) continue;
            var at = 0;
            for (var p = i - 1; p >= 0; p--)
            {
                var prev = IndexOf(target, desired[p], 0);
                if (prev < 0) continue;
                at = prev + 1;
                break;
            }

            target.Insert(at, item);
        }
    }

    private static int IndexOf<T>(ObservableCollection<T> list, T item, int start)
        where T : class
    {
        for (var i = start; i < list.Count; i++)
        {
            if (ReferenceEquals(list[i], item)) return i;
        }

        return -1;
    }
}
