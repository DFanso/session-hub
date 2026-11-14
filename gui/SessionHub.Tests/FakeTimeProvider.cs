namespace SessionHub.Tests;

/// <summary>A clock that only moves when a test calls <see cref="Advance"/>. Timers fire inline.</summary>
internal sealed class FakeTimeProvider : TimeProvider
{
    /// <summary>What <see cref="GetUtcNow"/> returns before any <see cref="Advance"/>.</summary>
    public static readonly DateTimeOffset Start = new(2026, 11, 13, 12, 0, 0, TimeSpan.Zero);

    private readonly List<FakeTimer> timers = [];
    private TimeSpan now = TimeSpan.Zero;

    public override DateTimeOffset GetUtcNow() => Start + now;

    public int ActiveTimers
    {
        get
        {
            lock (timers) return timers.Count(t => t.Due is not null);
        }
    }

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var timer = new FakeTimer(this, callback, state);
        timer.Change(dueTime, period);
        lock (timers) timers.Add(timer);
        return timer;
    }

    public void Advance(TimeSpan by)
    {
        var target = now + by;
        while (true)
        {
            FakeTimer? next;
            lock (timers) next = timers.Where(t => t.Due is { } d && d <= target).OrderBy(t => t.Due).FirstOrDefault();
            if (next is null) break;
            now = next.Due!.Value;
            next.Due = null;
            next.Fire();
        }

        now = target;
    }

    private sealed class FakeTimer(FakeTimeProvider owner, TimerCallback callback, object? state) : ITimer
    {
        public TimeSpan? Due { get; set; }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            Due = dueTime == Timeout.InfiniteTimeSpan ? null : owner.now + dueTime;
            return true;
        }

        public void Fire() => callback(state);

        public void Dispose()
        {
            Due = null;
            lock (owner.timers) owner.timers.Remove(this);
        }

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
