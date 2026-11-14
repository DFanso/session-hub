using System.Diagnostics;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using SessionHub.Core.Bridge;
using SessionHub.Core.Protocol;

namespace SessionHub.Tests;

public class BridgeClientTests
{
    private const string HelloLine = """{"type":"hello","protocol":1,"version":"0.1.0-test"}""";

    private static string SnapshotLine(int seq, string daemon = "running") =>
        "{\"type\":\"snapshot\",\"seq\":" + seq + ",\"snapshot\":{\"sessions\":[],\"meta\":{\"unknownCount\":0,\"unknownVersion\":null,\"stale\":[],\"daemon\":\""
        + daemon + "\"},\"totals\":{\"waitingItems\":0,\"needsApproval\":0,\"live\":0}}}";

    private static readonly TimeSpan Long = TimeSpan.FromSeconds(60);

    [Fact]
    public async Task SnapshotLineRaisesSnapshot()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        p.Emit(SnapshotLine(1, "stopped"));

        await Until(() => h.Snapshots.Length == 1);
        Assert.Equal("stopped", h.Snapshots.Single().Meta.Daemon);
        Assert.Same(h.Snapshots.Single(), h.Client.LastSnapshot);
    }

    [Fact]
    public async Task SendEventRaisesSendChanged()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        p.Emit("""{"type":"send","send":{"id":7,"sessionId":"s-a","state":"delivered","detail":null}}""");

        await Until(() => h.Sends.Length == 1);
        Assert.Equal(7, h.Sends.Single().Send.Id);
        Assert.Equal("delivered", h.Sends.Single().Send.State);
    }

    [Fact]
    public async Task RepliesAreMatchedById()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        var ping = h.Client.RequestAsync(new PingRequest(0), Long);
        var start = h.Client.RequestAsync(new StartDaemonRequest(0), Long);
        await Until(() => p.Written.Length == 2);
        var sent = p.Written.Select(l => JsonDocument.Parse(l).RootElement)
            .ToDictionary(e => e.GetProperty("type").GetString()!, e => e.GetProperty("id").GetInt32());
        Assert.NotEqual(sent["ping"], sent["startDaemon"]);

        // Answer in the opposite order.
        p.Emit("{\"type\":\"reply\",\"id\":" + sent["startDaemon"] + ",\"ok\":true,\"result\":{\"running\":true}}");
        p.Emit("{\"type\":\"reply\",\"id\":" + sent["ping"] + ",\"ok\":true,\"result\":{}}");

        var startReply = await start;
        var pingReply = await ping;
        Assert.Equal(sent["startDaemon"], startReply.Id);
        Assert.True(Json.DecodeStartDaemon(startReply)!.Running);
        Assert.Equal(sent["ping"], pingReply.Id);
        Assert.True(pingReply.Ok);
    }

    [Fact]
    public async Task UnansweredRequestTimesOut()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        var reply = h.Client.RequestAsync(new PingRequest(0), TimeSpan.FromSeconds(5));
        await Until(() => p.Written.Length == 1);
        await Until(() => h.Time.HasTimerDueIn(TimeSpan.FromSeconds(5)));
        h.Time.Advance(TimeSpan.FromSeconds(5));

        var r = await reply;
        Assert.False(r.Ok);
        Assert.Equal("timeout", r.Error!.Code);
    }

    [Fact]
    public async Task ExitBacksOffDoublingToThirtySecondsAndFailsAfterThreeFailedStarts()
    {
        await using var h = new Harness();
        h.Factory.Plan("ok", "dead", "throw", "dead", "dead", "throw", "dead", "dead");
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);
        h.Time.Advance(BridgeClient.StableAfter);

        p.Exit();

        // Start 2 fails, then 3 and 4: red after the third failed start in a row; retries go on.
        BridgeHealth[] expected =
        [
            new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1)),
            new BridgeHealth.Restarting(2, TimeSpan.FromSeconds(2)),
            new BridgeHealth.Restarting(3, TimeSpan.FromSeconds(4)),
            new BridgeHealth.Failed(3),
            new BridgeHealth.Failed(4),
            new BridgeHealth.Failed(5),
            new BridgeHealth.Failed(6),
        ];
        int[] delays = [1, 2, 4, 8, 16, 30, 30];
        for (var i = 0; i < expected.Length; i++)
        {
            await Until(() => h.Health.Length >= i + 2);
            Assert.Equal(expected[i], h.Health[i + 1]);
            var delay = TimeSpan.FromSeconds(delays[i]);
            await Until(() => h.Time.HasTimerDueIn(delay));
            h.Time.Advance(delay);
            await h.Factory.WaitStarted(i + 2);
        }

        Assert.Equal(8, h.Factory.Calls);
        Assert.Equal(1, h.Health.Count(x => x is BridgeHealth.Connected));
    }

    [Fact]
    public async Task ThreeFailedStartsFromColdAreFailed()
    {
        await using var h = new Harness();
        h.Factory.Plan("throw", "dead", "dead");
        h.Client.Start();

        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        Assert.Equal(new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1)), h.Health[^1]);
        await Advance(h, TimeSpan.FromSeconds(1));
        await h.WaitHealth(x => x == new BridgeHealth.Restarting(2, TimeSpan.FromSeconds(2)));
        await Advance(h, TimeSpan.FromSeconds(2));
        await h.WaitHealth(x => x is BridgeHealth.Failed);

        Assert.Equal(new BridgeHealth.Failed(3), h.Health[^1]);
        Assert.Equal(h.Health[^1], h.Client.Health);
    }

    [Fact]
    public async Task HelloThenQuickExitIsAFailedStart()
    {
        await using var h = new Harness();
        h.Factory.Plan("flap", "flap", "flap");
        h.Client.Start();

        await h.WaitHealth(x => x == new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1)));
        await Advance(h, TimeSpan.FromSeconds(1));
        await h.WaitHealth(x => x == new BridgeHealth.Restarting(2, TimeSpan.FromSeconds(2)));
        await Advance(h, TimeSpan.FromSeconds(2));
        await h.WaitHealth(x => x is BridgeHealth.Failed);

        Assert.Equal(new BridgeHealth.Failed(3), h.Health[^1]);
        await Until(() => h.Time.HasTimerDueIn(TimeSpan.FromSeconds(4)));
        Assert.Equal(3, h.Health.Count(x => x is BridgeHealth.Connected));
    }

    [Fact]
    public async Task ThirtySecondsConnectedResetsTheAttemptCount()
    {
        await using var h = new Harness();
        h.Factory.Plan("dead", "dead", "ok");
        h.Client.Start();
        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        await Advance(h, TimeSpan.FromSeconds(1));
        await h.WaitHealth(x => x == new BridgeHealth.Restarting(2, TimeSpan.FromSeconds(2)));
        await Advance(h, TimeSpan.FromSeconds(2));
        var third = await h.Factory.WaitStarted(3);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        h.Time.Advance(BridgeClient.StableAfter);
        third.Exit();

        await Until(() => h.Health.Length == 4);
        Assert.Equal(new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1)), h.Health[3]);
    }

    [Fact]
    public async Task LastSnapshotIsKeptAcrossARestart()
    {
        await using var h = new Harness();
        h.Client.Start();
        var first = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);
        first.Emit(SnapshotLine(1));
        await Until(() => h.Snapshots.Length == 1);
        var kept = h.Client.LastSnapshot;

        first.Exit();
        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        await Advance(h, TimeSpan.FromSeconds(1));
        var second = await h.Factory.WaitStarted(2);
        await Until(() => h.Health.Count(x => x is BridgeHealth.Connected) == 2);

        Assert.Single(h.Snapshots);
        Assert.Same(kept, h.Client.LastSnapshot);
        Assert.True(first.Disposed);

        second.Emit(SnapshotLine(1, "stopped"));
        await Until(() => h.Snapshots.Length == 2);
        Assert.Equal("stopped", h.Client.LastSnapshot!.Meta.Daemon);
    }

    [Fact]
    public async Task PendingRequestsFailWithBridgeRestartedWhenTheProcessDies()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        var a = h.Client.RequestAsync(new PingRequest(0), Long);
        var b = h.Client.RequestAsync(new SearchRequest(0, "x", 10), Long);
        await Until(() => p.Written.Length == 2);
        p.Exit();

        Assert.Equal("bridge-restarted", (await a).Error!.Code);
        Assert.Equal("bridge-restarted", (await b).Error!.Code);
    }

    [Fact]
    public async Task WrongProtocolIsAFailedStartAndRaisesNoSnapshot()
    {
        await using var h = new Harness();
        h.Factory.Plan("proto2", "proto2", "proto2");
        h.Client.Start();

        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        await Advance(h, TimeSpan.FromSeconds(1));
        await h.WaitHealth(x => x == new BridgeHealth.Restarting(2, TimeSpan.FromSeconds(2)));
        await Advance(h, TimeSpan.FromSeconds(2));
        await h.WaitHealth(x => x is BridgeHealth.Failed);

        Assert.Equal(new BridgeHealth.Failed(3), h.Health[^1]);
        Assert.DoesNotContain(h.Health, x => x is BridgeHealth.Connected);
        Assert.Empty(h.Snapshots);
        Assert.Null(h.Client.LastSnapshot);
        Assert.All(h.Factory.Started, p => Assert.True(p.Disposed));
    }

    [Fact]
    public async Task MissingHelloWithinTenSecondsIsAFailedStart()
    {
        await using var h = new Harness();
        h.Factory.Plan("silent");
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);

        await Advance(h, TimeSpan.FromSeconds(10));

        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        Assert.Equal(new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1)), h.Health[^1]);
        Assert.True(p.Disposed);
    }

    [Fact]
    public async Task MalformedLinesAreCountedAndSkipped()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        p.Emit("not json");
        p.Emit("""{"type":"mystery"}""");
        p.Emit("""{"type":"snapshot","seq":1}""");
        p.Emit("{\"type\":\"error\",\"code\":\"x\",\"message\":\"" + new string('a', 1_048_576) + "\"}");
        p.Emit("""{"type":"error","code":"bad-json","message":"skipped"}""");
        p.Emit(SnapshotLine(2));

        await Until(() => h.Snapshots.Length == 1);
        Assert.Equal(4, h.Client.MalformedLines);
        Assert.Equal(1, h.Factory.Calls);
        Assert.IsType<BridgeHealth.Connected>(h.Client.Health);
    }

    [Fact]
    public async Task LoneSurrogateIsSentAsAReplacementCharacter()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        var task = h.Client.RequestAsync(new SendRequest(0, "s-a", "bad \ud800 text"), Long);
        await Until(() => p.Written.Length == 1);
        var sent = JsonDocument.Parse(p.Written[0]).RootElement;
        Assert.Equal("bad � text", sent.GetProperty("text").GetString());
        p.Emit("{\"type\":\"reply\",\"id\":" + sent.GetProperty("id").GetInt32() + ",\"ok\":true,\"result\":{\"sendId\":3,\"state\":\"pending\"}}");

        Assert.Equal(3, Json.DecodeSend(await task)!.SendId);
    }

    [Fact]
    public async Task RequestWithoutAReplyIsABadRequestNotAThrow()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        Reply[] replies =
        [
            await h.Client.RequestAsync(new ShutdownRequest(), Long),
            await h.Client.RequestAsync(null!, Long),
            await h.Client.RequestAsync(new PingRequest(0), TimeSpan.FromSeconds(-1)),
            await h.Client.RequestAsync(new PingRequest(0), TimeSpan.Zero),
            await h.Client.RequestAsync(new PingRequest(0), Timeout.InfiniteTimeSpan),
            await h.Client.RequestAsync(new PingRequest(0), TimeSpan.FromDays(1) + TimeSpan.FromTicks(1)),
        ];

        Assert.All(replies, r => Assert.Equal("bad-request", r.Error!.Code));
        Assert.Empty(p.Written);
    }

    [Fact]
    public async Task LineOverOneMebibyteIsRefused()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        var r = await h.Client.RequestAsync(new SendRequest(0, "s-a", new string('a', 1_048_576)), Long);

        Assert.Equal("too-long", r.Error!.Code);
        Assert.Empty(p.Written);
    }

    [Fact]
    public async Task RequestWhileDisconnectedIsRefused()
    {
        await using var h = new Harness();
        h.Factory.Plan("silent");
        h.Client.Start();
        await h.Factory.WaitStarted(1);

        var r = await h.Client.RequestAsync(new PingRequest(0), Long);

        Assert.Equal("not-connected", r.Error!.Code);
    }

    [Fact]
    public async Task DisposeEndsTheProcessFailsPendingAndStopsRestarts()
    {
        var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);
        var pending = h.Client.RequestAsync(new PingRequest(0), Long);
        await Until(() => p.Written.Length == 1);

        await h.DisposeAsync();

        Assert.True(p.Disposed);
        Assert.Equal("disposed", (await pending).Error!.Code);
        Assert.Equal(1, h.Factory.Calls);
        Assert.DoesNotContain(h.Health, x => x is BridgeHealth.Restarting);
        Assert.Equal("disposed", (await h.Client.RequestAsync(new PingRequest(0), Long)).Error!.Code);
    }

    [Fact]
    public async Task DisposeThatThrowsDoesNotStopSupervision()
    {
        await using var h = new Harness();
        h.Factory.Plan("throwdispose", "ok");
        h.Client.Start();
        var first = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        first.Exit();
        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        await Advance(h, TimeSpan.FromSeconds(1));
        var second = await h.Factory.WaitStarted(2);
        await Until(() => h.Health.Count(x => x is BridgeHealth.Connected) == 2);

        Assert.True(first.Disposed);
        await AssertPingWorks(h, second);
    }

    [Fact]
    public async Task StuckWriteOnADeadBridgeDoesNotBlockTheNextBridge()
    {
        await using var h = new Harness();
        h.Factory.Plan("hangwrite", "ok");
        h.Client.Start();
        var first = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        var stuck = h.Client.RequestAsync(new PingRequest(0), Long);
        await Until(() => first.Written.Length == 1);
        var queued = h.Client.RequestAsync(new PingRequest(0), Long);
        first.Exit();

        Assert.Equal("bridge-restarted", (await stuck).Error!.Code);
        Assert.Equal("bridge-restarted", (await queued).Error!.Code);
        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        await Advance(h, TimeSpan.FromSeconds(1));
        var second = await h.Factory.WaitStarted(2);
        await Until(() => h.Health.Count(x => x is BridgeHealth.Connected) == 2);

        await AssertPingWorks(h, second);
        Assert.Single(first.Written);
    }

    [Fact]
    public async Task RequestThatTimedOutWaitingToWriteIsNeverWritten()
    {
        await using var h = new Harness();
        h.Factory.Plan("hangwrite");
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        _ = h.Client.RequestAsync(new PingRequest(0), Long);
        await Until(() => p.Written.Length == 1);
        var late = h.Client.RequestAsync(new StartDaemonRequest(0), TimeSpan.FromSeconds(5));
        await Advance(h, TimeSpan.FromSeconds(5));
        Assert.Equal("timeout", (await late).Error!.Code);

        p.ReleaseWrites();
        _ = h.Client.RequestAsync(new SearchRequest(0, "x", 1), Long);
        await Until(() => p.Written.Length == 2);

        Assert.Equal("search", JsonDocument.Parse(p.Written[1]).RootElement.GetProperty("type").GetString());
        Assert.DoesNotContain(p.Written, l => l.Contains("startDaemon", StringComparison.Ordinal));
    }

    [Fact]
    public async Task DisposeDuringTheBackoffDelayStopsRestarts()
    {
        var h = new Harness();
        h.Factory.Plan("dead");
        h.Client.Start();
        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        await Until(() => h.Time.HasTimerDueIn(TimeSpan.FromSeconds(1)));

        await h.DisposeAsync();
        h.Time.Advance(TimeSpan.FromSeconds(60));

        Assert.Equal(1, h.Factory.Calls);
        Assert.Single(h.Health);
        Assert.Equal("disposed", (await h.Client.RequestAsync(new PingRequest(0), Long)).Error!.Code);
    }

    [Fact]
    public async Task ThrowingHandlerEndsTheBridgeAndSupervisionGoesOn()
    {
        await using var h = new Harness();
        h.Client.Snapshot += _ => throw new InvalidOperationException("handler bug");
        h.Client.HealthChanged += _ => throw new InvalidOperationException("handler bug");
        h.Client.Start();
        var first = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        first.Emit(SnapshotLine(1));
        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        await Advance(h, TimeSpan.FromSeconds(1));
        var second = await h.Factory.WaitStarted(2);
        await Until(() => h.Health.Count(x => x is BridgeHealth.Connected) == 2);

        Assert.True(first.Disposed);
        await AssertPingWorks(h, second);
    }

    [Fact]
    public async Task SilentBridgeIsRestartedAfterFortyFiveSeconds()
    {
        await using var h = new Harness();
        h.Client.Start();
        var first = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        await Advance(h, BridgeClient.IdleTimeout);

        // Up for 45 s, so this counts as a stable bridge that ended: attempt 1.
        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        Assert.Equal(new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1)), h.Health[^1]);
        Assert.True(first.Disposed);
        await Advance(h, TimeSpan.FromSeconds(1));
        await h.Factory.WaitStarted(2);
        await Until(() => h.Health.Count(x => x is BridgeHealth.Connected) == 2);
    }

    [Fact]
    public async Task AResumeFromSleepGivesTheSilentBridgeOneMoreIdlePeriod()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);
        await Until(() => h.Time.HasTimerDueIn(BridgeClient.IdleTimeout));

        // The PC slept through the whole wait; the bridge was suspended too.
        h.Client.NotifyResumed();
        h.Time.Advance(BridgeClient.IdleTimeout);

        // Not ended: the same read waits one more period, and a line then keeps the bridge.
        await Until(() => h.Time.HasTimerDueIn(BridgeClient.IdleTimeout));
        Assert.False(p.Disposed);
        p.Emit(SnapshotLine(1));
        await Until(() => h.Snapshots.Length == 1);
        Assert.Equal(1, h.Factory.Calls);
        Assert.IsType<BridgeHealth.Connected>(h.Client.Health);
    }

    [Fact]
    public async Task OneResumeGivesOnlyOneGracePeriod()
    {
        await using var h = new Harness();
        h.Client.Start();
        var first = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);
        await Until(() => h.Time.HasTimerDueIn(BridgeClient.IdleTimeout));

        h.Client.NotifyResumed();
        h.Time.Advance(BridgeClient.IdleTimeout);
        await Until(() => h.Time.HasTimerDueIn(BridgeClient.IdleTimeout));
        h.Time.Advance(BridgeClient.IdleTimeout);

        await h.WaitHealth(x => x is BridgeHealth.Restarting);
        Assert.True(first.Disposed);
    }

    [Fact]
    public async Task BridgeWithALineEveryFourteenSecondsStaysConnected()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);

        for (var i = 1; i <= 9; i++)
        {
            await Until(() => h.Time.HasTimerDueIn(BridgeClient.IdleTimeout));
            h.Time.Advance(TimeSpan.FromSeconds(14));
            p.Emit(SnapshotLine(i));
            await Until(() => h.Snapshots.Length == i);
        }

        Assert.Equal(1, h.Factory.Calls);
        Assert.False(p.Disposed);
        Assert.Single(h.Health);
        Assert.IsType<BridgeHealth.Connected>(h.Client.Health);
    }

    [Fact]
    public async Task HeartbeatsKeepABridgeConnectedAndRaiseNothing()
    {
        await using var h = new Harness();
        h.Client.Start();
        var p = await h.Factory.WaitStarted(1);
        await h.WaitHealth(x => x is BridgeHealth.Connected);
        p.Emit(SnapshotLine(1));
        await Until(() => h.Snapshots.Length == 1);

        for (var i = 1; i <= 9; i++)
        {
            await Until(() => h.Time.HasTimerDueIn(BridgeClient.IdleTimeout));
            h.Time.Advance(TimeSpan.FromSeconds(15));
            p.Emit("""{"type":"heartbeat","seq":1}""");
        }

        // The last heartbeat was read: its wait is the one now pending.
        await Until(() => h.Time.HasTimerDueIn(BridgeClient.IdleTimeout));
        Assert.Equal(1, h.Factory.Calls);
        Assert.False(p.Disposed);
        Assert.Single(h.Snapshots);
        Assert.Empty(h.Sends);
        Assert.Equal(0, h.Client.MalformedLines);
        Assert.IsType<BridgeHealth.Connected>(h.Client.Health);
    }

    [Fact]
    public async Task SlowDisposeDoesNotMakeAShortBridgeStable()
    {
        await using var h = new Harness();
        h.Factory.Plan("flap", "flap", "flap");
        h.Factory.OnDispose = () => h.Time.Advance(TimeSpan.FromSeconds(40));
        h.Client.Start();

        await h.WaitHealth(x => x == new BridgeHealth.Restarting(1, TimeSpan.FromSeconds(1)));
        await Advance(h, TimeSpan.FromSeconds(1));
        await h.WaitHealth(x => x == new BridgeHealth.Restarting(2, TimeSpan.FromSeconds(2)));
        await Advance(h, TimeSpan.FromSeconds(2));
        await h.WaitHealth(x => x is BridgeHealth.Failed);

        Assert.Equal(new BridgeHealth.Failed(3), h.Health[^1]);
    }

    [Fact]
    public void HubPathPrefersTheLocalAppDataVariable()
    {
        Assert.Equal(
            Path.Combine(@"C:\tmp\lad", "SessionHub", "bin", "hub.exe"),
            HubBridgeProcess.ResolveHubPath(@"C:\tmp\lad"));
        Assert.Equal(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SessionHub", "bin", "hub.exe"),
            HubBridgeProcess.ResolveHubPath(""));
    }

    [Fact]
    public void FactoryRejectsARelativeHubPath()
    {
        Assert.Throws<ArgumentException>(() => HubBridgeProcess.Factory(@"bin\hub.exe"));
    }

    [Fact]
    public async Task RealProcessRoundTripsLinesAndEndsWhenDisposed()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows only");
        // cmd.exe stands in for hub.exe: it ignores the `bridge` argument, runs stdin lines and exits on EOF.
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var proc = (HubBridgeProcess)HubBridgeProcess.Factory(cmd)();
        using var watcher = Process.GetProcessById(proc.ProcessId);
        try
        {
            // cmd.exe writes in the OEM code page, so the marker stays ASCII.
            await proc.WriteLineAsync("echo marker-ok");
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            string? line;
            do
            {
                line = await proc.ReadLineAsync(cts.Token);
            }
            while (line is not null && line != "marker-ok");
            Assert.Equal("marker-ok", line);
        }
        finally
        {
            proc.Dispose();
        }

        Assert.True(watcher.WaitForExit(TimeSpan.FromSeconds(10)), "cmd.exe still running after Dispose");
    }

    private static async Task AssertPingWorks(Harness h, FakeProcess p)
    {
        var before = p.Written.Length;
        var ping = h.Client.RequestAsync(new PingRequest(0), Long);
        await Until(() => p.Written.Length == before + 1);
        var id = JsonDocument.Parse(p.Written[before]).RootElement.GetProperty("id").GetInt32();
        p.Emit("{\"type\":\"reply\",\"id\":" + id + ",\"ok\":true,\"result\":{}}");
        var reply = await ping;
        Assert.True(reply.Ok);
        Assert.Equal(id, reply.Id);
    }

    private static async Task Advance(Harness h, TimeSpan by)
    {
        await Until(() => h.Time.HasTimerDueIn(by));
        h.Time.Advance(by);
    }

    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) Assert.Fail("condition not met within 10 s");
            await Task.Delay(1, TestContext.Current.CancellationToken);
        }
    }

    private sealed class Harness : IAsyncDisposable
    {
        private readonly ConcurrentQueue<HubSnapshot> snapshots = new();
        private readonly ConcurrentQueue<SendUpdate> sends = new();
        private readonly ConcurrentQueue<BridgeHealth> health = new();

        public Harness()
        {
            Client = new BridgeClient(Factory.Create, new InlineContext(), Time);
            Client.Snapshot += snapshots.Enqueue;
            Client.SendChanged += sends.Enqueue;
            Client.HealthChanged += health.Enqueue;
        }

        public FakeTime Time { get; } = new();

        public FakeFactory Factory { get; } = new();

        public BridgeClient Client { get; }

        public HubSnapshot[] Snapshots => snapshots.ToArray();

        public SendUpdate[] Sends => sends.ToArray();

        public BridgeHealth[] Health => health.ToArray();

        public Task WaitHealth(Func<BridgeHealth, bool> match) => Until(() => Health.Any(match));

        public ValueTask DisposeAsync() => Client.DisposeAsync();
    }

    private sealed class InlineContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback d, object? state) => d(state);

        public override void Send(SendOrPostCallback d, object? state) => d(state);
    }

    private sealed class FakeFactory
    {
        private readonly object gate = new();
        private readonly Queue<string> plan = new();
        private readonly List<FakeProcess> started = [];
        private int calls;

        public int Calls => Volatile.Read(ref calls);

        /// <summary>Runs inside every process's Dispose (a slow teardown, for example).</summary>
        public Action? OnDispose { get; set; }

        public IReadOnlyList<FakeProcess> Started
        {
            get
            {
                lock (gate) return started.ToArray();
            }
        }

        /// <summary>
        /// One mode per start: ok, dead, throw, silent, proto2, flap (hello then exit),
        /// throwdispose (ok, Dispose throws), hangwrite (ok, writes never finish). Default ok.
        /// </summary>
        public void Plan(params string[] modes)
        {
            lock (gate)
                foreach (var m in modes) plan.Enqueue(m);
        }

        public FakeProcess Create()
        {
            string mode;
            lock (gate) mode = plan.Count > 0 ? plan.Dequeue() : "ok";
            if (mode == "throw")
            {
                Interlocked.Increment(ref calls);
                throw new InvalidOperationException("start failed");
            }

            var p = new FakeProcess { OnDispose = OnDispose };
            switch (mode)
            {
                case "ok":
                    p.Emit(HelloLine);
                    break;
                case "flap":
                    p.Emit(HelloLine);
                    p.Exit();
                    break;
                case "throwdispose":
                    p.ThrowOnDispose = true;
                    p.Emit(HelloLine);
                    break;
                case "hangwrite":
                    p.HangWrites = true;
                    p.Emit(HelloLine);
                    break;
                case "dead":
                    p.Exit();
                    break;
                case "proto2":
                    p.Emit("""{"type":"hello","protocol":2,"version":"9.0.0"}""");
                    p.Emit(SnapshotLine(1));
                    break;
            }

            lock (gate) started.Add(p);
            Interlocked.Increment(ref calls);
            return p;
        }

        /// <summary>Waits for the given number of starts; returns the newest process made.</summary>
        public async Task<FakeProcess> WaitStarted(int count)
        {
            await Until(() => Calls >= count);
            return Started[^1];
        }
    }

    private sealed class FakeProcess : IBridgeProcess
    {
        private readonly Channel<string> lines = Channel.CreateUnbounded<string>();
        private readonly ConcurrentQueue<string> written = new();
        private volatile bool exited;
        private volatile bool disposed;
        private readonly TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public bool HasExited => exited;

        public bool Disposed => disposed;

        public string[] Written => written.ToArray();

        public void Emit(string line) => lines.Writer.TryWrite(line);

        public void Exit()
        {
            exited = true;
            lines.Writer.TryComplete();
        }

        public async Task<string?> ReadLineAsync(CancellationToken ct)
        {
            try
            {
                return await lines.Reader.ReadAsync(ct);
            }
            catch (ChannelClosedException)
            {
                return null;
            }
        }

        public bool ThrowOnDispose { get; set; }

        public Action? OnDispose { get; init; }

        public bool HangWrites { get; set; }

        /// <summary>Lets hung writes finish; later writes complete at once.</summary>
        public void ReleaseWrites()
        {
            HangWrites = false;
            release.TrySetResult();
        }

        public Task WriteLineAsync(string line)
        {
            if (exited) throw new IOException("pipe is closed");
            written.Enqueue(line);
            return HangWrites ? release.Task : Task.CompletedTask;
        }

        public void Dispose()
        {
            disposed = true;
            Exit();
            OnDispose?.Invoke();
            // Like StreamWriter.Dispose with a write in flight.
            if (ThrowOnDispose) throw new InvalidOperationException("stream in use");
        }
    }

    /// <summary>Manual clock: timers fire only from <see cref="Advance"/>.</summary>
    private sealed class FakeTime : TimeProvider
    {
        private readonly object gate = new();
        private readonly List<FakeTimer> timers = [];
        private long now = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero).UtcTicks;

        public override DateTimeOffset GetUtcNow()
        {
            lock (gate) return new DateTimeOffset(now, TimeSpan.Zero);
        }

        public override long GetTimestamp()
        {
            lock (gate) return now;
        }

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var t = new FakeTimer(this, callback, state);
            t.Change(dueTime, period);
            return t;
        }

        public bool HasTimerDueIn(TimeSpan d)
        {
            lock (gate) return timers.Any(t => t.Due == now + d.Ticks);
        }

        public void Advance(TimeSpan by)
        {
            long target;
            lock (gate) target = now + by.Ticks;
            while (true)
            {
                FakeTimer? next;
                lock (gate)
                {
                    next = timers.Where(t => t.Due <= target).OrderBy(t => t.Due).FirstOrDefault();
                    if (next is null)
                    {
                        now = target;
                        return;
                    }

                    now = Math.Max(now, next.Due);
                    if (next.Period > 0) next.Due += next.Period;
                    else timers.Remove(next);
                }

                next.Fire();
            }
        }

        private sealed class FakeTimer(FakeTime owner, TimerCallback callback, object? state) : ITimer
        {
            public long Due { get; set; }

            public long Period { get; private set; }

            public void Fire() => callback(state);

            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                lock (owner.gate)
                {
                    owner.timers.Remove(this);
                    if (dueTime == Timeout.InfiniteTimeSpan) return true;
                    Due = owner.now + dueTime.Ticks;
                    Period = period == Timeout.InfiniteTimeSpan ? 0 : period.Ticks;
                    owner.timers.Add(this);
                }

                return true;
            }

            public void Dispose()
            {
                lock (owner.gate) owner.timers.Remove(this);
            }

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }
}
