using SessionHub.Core.Settings;

namespace SessionHub.Tests;

public sealed class SettingsTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "sh-settings-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        else if (File.Exists(dir)) File.Delete(dir);
    }

    [Fact]
    public void Missing_file_gives_defaults()
    {
        var s = new SettingsStore(dir).Load();
        Assert.True(s.Notifications);
        Assert.Null(s.Window);
        Assert.Empty(s.Drafts);
    }

    [Fact]
    public void Round_trip()
    {
        var store = new SettingsStore(dir);
        store.Save(new GuiSettings
        {
            Notifications = false,
            Window = new WindowPlacement(10, 20, 300, 400, true),
            Drafts = { ["s1"] = "hello" },
        });
        var back = new SettingsStore(dir).Load();
        Assert.False(back.Notifications);
        Assert.Equal(new WindowPlacement(10, 20, 300, 400, true), back.Window);
        Assert.Equal("hello", back.Drafts["s1"]);
        Assert.Equal(["gui.json"], Directory.GetFiles(dir).Select(Path.GetFileName));
    }

    [Theory]
    [InlineData("not json {{{")]
    [InlineData("")]
    [InlineData("[1,2]")]
    [InlineData("{\"notifications\": \"yes\"}")]
    [InlineData("null")]
    public void Corrupt_file_gives_defaults_without_throwing(string content)
    {
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "gui.json"), content);
        var s = new SettingsStore(dir).Load();
        Assert.True(s.Notifications);
        Assert.Empty(s.Drafts);
    }

    [Fact]
    public void A_corrupt_file_is_renamed_to_gui_json_bad_and_reported_before_defaults_load()
    {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "gui.json");
        File.WriteAllText(path, "{\"drafts\": {\"a\": \"precious\"");
        var store = new SettingsStore(dir);
        var reported = new List<(Exception Error, string? MovedTo)>();
        store.Corrupt += (e, moved) => reported.Add((e, moved));

        var s = store.Load();

        Assert.Empty(s.Drafts);
        var (error, movedTo) = Assert.Single(reported);
        Assert.IsAssignableFrom<System.Text.Json.JsonException>(error);
        Assert.Equal(path + ".bad", movedTo);
        Assert.False(File.Exists(path));
        Assert.Equal("{\"drafts\": {\"a\": \"precious\"", File.ReadAllText(path + ".bad"));

        // The next save writes a fresh gui.json and leaves the .bad copy alone.
        store.Save(new GuiSettings());
        Assert.True(File.Exists(path));
        Assert.True(File.Exists(path + ".bad"));
    }

    [Fact]
    public void A_second_corrupt_file_gets_a_timestamped_name_when_gui_json_bad_exists()
    {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "gui.json");
        File.WriteAllText(path + ".bad", "older");
        File.WriteAllText(path, "not json");
        var store = new SettingsStore(dir, null, new FixedNow(new DateTimeOffset(2026, 11, 13, 21, 5, 9, 42, TimeSpan.Zero)));
        string? movedTo = null;
        store.Corrupt += (_, m) => movedTo = m;

        store.Load();

        var expected = path + ".bad-20261113-210509-042";
        Assert.Equal(expected, movedTo);
        Assert.Equal("not json", File.ReadAllText(expected));
        Assert.Equal("older", File.ReadAllText(path + ".bad"));
    }

    private sealed class FixedNow(DateTimeOffset at) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => at;
    }

    private static readonly DateTimeOffset Now = new(2026, 11, 13, 12, 0, 0, TimeSpan.Zero);

    private string Old(string name, TimeSpan age, string content = "x")
    {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name);
        File.WriteAllText(path, content);
        File.SetLastWriteTimeUtc(path, (Now - age).UtcDateTime);
        return path;
    }

    [Fact]
    public void Cleanup_never_deletes_gui_json_temp_files_or_look_alike_names()
    {
        var keep = new[]
        {
            Old("gui.json", TimeSpan.FromDays(400), "{}"),
            Old("gui.json.tmp", TimeSpan.FromDays(400)),
            Old("gui.json.new.tmp", TimeSpan.FromDays(400)),
            Old("old-gui.json.bad", TimeSpan.FromDays(400)),
            Old("gui.jsonbad", TimeSpan.FromDays(400)),
        };

        new SettingsStore(dir, null, new FixedNow(Now)).Load();

        foreach (var path in keep) Assert.True(File.Exists(path), path);
    }

    [Fact]
    public void Bad_copies_older_than_seven_days_are_deleted_on_load()
    {
        Assert.Equal(TimeSpan.FromDays(7), SettingsStore.BadCopyRetention);
        var oldBad = Old("gui.json.bad", TimeSpan.FromDays(8));
        var oldStamped = Old("gui.json.bad-20261101-000000-000", TimeSpan.FromDays(7) + TimeSpan.FromMinutes(1));
        var fresh = Old("gui.json.bad-20261110-000000-000", TimeSpan.FromDays(6));
        var settings = Old("gui.json", TimeSpan.FromDays(400), "{\"drafts\": {\"a\": \"kept\"}}");
        var other = Old("hub.db", TimeSpan.FromDays(400));

        var s = new SettingsStore(dir, null, new FixedNow(Now)).Load();

        Assert.Equal("kept", s.Drafts["a"]);
        Assert.False(File.Exists(oldBad));
        Assert.False(File.Exists(oldStamped));
        Assert.True(File.Exists(fresh));
        Assert.True(File.Exists(settings));
        Assert.True(File.Exists(other));
    }

    [Fact]
    public void Bad_copies_older_than_seven_days_are_deleted_on_save()
    {
        var store = new SettingsStore(dir, null, new FixedNow(Now));
        store.Load();
        var oldBad = Old("gui.json.bad", TimeSpan.FromDays(10));

        store.Save(new GuiSettings());

        Assert.False(File.Exists(oldBad));
        Assert.True(File.Exists(Path.Combine(dir, "gui.json")));
    }

    [Fact]
    public void A_corrupt_file_moved_aside_is_kept_for_seven_days_from_the_move()
    {
        // gui.json was last written long ago; the .bad copy must not go on the very next cleanup.
        Old("gui.json", TimeSpan.FromDays(30), "not json");
        var store = new SettingsStore(dir, null, new FixedNow(Now));
        string? movedTo = null;
        store.Corrupt += (_, m) => movedTo = m;

        store.Load();
        store.Save(new GuiSettings());

        Assert.Equal(Path.Combine(dir, "gui.json.bad"), movedTo);
        Assert.Equal(["gui.json", "gui.json.bad"], Directory.GetFiles(dir).Select(Path.GetFileName).Order());
        Assert.Equal("not json", File.ReadAllText(Path.Combine(dir, "gui.json.bad")));
    }

    [Fact]
    public void A_bad_copy_that_can_not_be_deleted_is_skipped_without_failing()
    {
        // An open FileShare.None handle blocks a delete only on Windows; Linux deletes the name anyway.
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows only: file locks block deletes there");
        var locked = Old("gui.json.bad", TimeSpan.FromDays(10));
        var other = Old("gui.json.bad-20261101-000000-000", TimeSpan.FromDays(10));
        Old("gui.json", TimeSpan.FromDays(1), "{\"notifications\": false}");

        GuiSettings s;
        using (new FileStream(locked, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            s = new SettingsStore(dir, null, new FixedNow(Now)).Load();
        }

        Assert.False(s.Notifications);
        Assert.True(File.Exists(locked));
        Assert.False(File.Exists(other));
    }

    [Fact]
    public void Draft_seen_times_round_trip_and_follow_their_drafts()
    {
        var store = new SettingsStore(dir);
        var at = new DateTimeOffset(2026, 11, 10, 8, 30, 0, TimeSpan.Zero);
        store.Save(new GuiSettings
        {
            Drafts = { ["a"] = "x" },
            DraftsSeen = { ["a"] = at, ["orphan"] = at },
        });

        var back = new SettingsStore(dir).Load();

        Assert.Equal(at, back.DraftsSeen["a"]);
        Assert.Equal(["a"], back.DraftsSeen.Keys);
    }

    [Fact]
    public void A_gui_json_from_before_draft_seen_times_loads_its_drafts()
    {
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "gui.json"), "{\"notifications\": true, \"drafts\": {\"a\": \"older format\"}}");

        var s = new SettingsStore(dir).Load();

        Assert.Equal("older format", s.Drafts["a"]);
        Assert.Empty(s.DraftsSeen);
    }

    [Fact]
    public void A_missing_file_is_not_corrupt()
    {
        var store = new SettingsStore(dir);
        var reported = 0;
        store.Corrupt += (_, _) => reported++;
        store.Load();
        Assert.Equal(0, reported);
    }

    [Fact]
    public void Drafts_are_capped_at_20000_chars_on_save()
    {
        var store = new SettingsStore(dir);
        store.Save(new GuiSettings { Drafts = { ["a"] = new string('x', 25_000) } });
        Assert.Equal(20_000, store.Load().Drafts["a"].Length);
    }

    [Fact]
    public void Drafts_are_capped_on_load_too()
    {
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "gui.json"), "{\"drafts\":{\"a\":\"" + new string('y', 30_000) + "\"}}");
        Assert.Equal(20_000, new SettingsStore(dir).Load().Drafts["a"].Length);
    }

    [Fact]
    public void Cap_never_splits_a_surrogate_pair()
    {
        var store = new SettingsStore(dir);
        var text = new string('a', 19_999) + "😀" + "tail";
        store.Save(new GuiSettings { Drafts = { ["a"] = text } });
        var back = store.Load().Drafts["a"];
        Assert.Equal(19_999, back.Length);
        Assert.False(char.IsHighSurrogate(back[^1]));
    }

    [Fact]
    public void Data_dir_prefers_environment_variable_then_shell_folder()
    {
        Assert.Equal(Path.Combine(dir, "SessionHub"), SettingsStore.DefaultDirectory(name => name == "LOCALAPPDATA" ? dir : null));
        Assert.Equal(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SessionHub"),
            SettingsStore.DefaultDirectory(_ => null));
    }

    [Fact]
    public void Schedule_save_debounces_and_writes_the_latest()
    {
        var clock = new FakeTimeProvider();
        using var store = new SettingsStore(dir, TimeSpan.FromMilliseconds(500), clock);
        var writes = 0;
        store.Saved += () => writes++;

        for (var i = 0; i < 10; i++)
        {
            store.ScheduleSave(new GuiSettings { Drafts = { ["a"] = "v" + i } });
            clock.Advance(TimeSpan.FromMilliseconds(400));
        }

        Assert.Equal(0, writes);
        Assert.False(File.Exists(Path.Combine(dir, "gui.json")));
        clock.Advance(TimeSpan.FromMilliseconds(100));
        Assert.Equal(1, writes);
        Assert.Equal("v9", store.Load().Drafts["a"]);
    }

    [Fact]
    public void Flush_writes_pending_now()
    {
        using var store = new SettingsStore(dir, TimeSpan.FromMinutes(5), new FakeTimeProvider());
        store.ScheduleSave(new GuiSettings { Notifications = false });
        store.Flush();
        Assert.False(store.Load().Notifications);
    }

    [Fact]
    public void Save_after_schedule_is_not_overwritten_by_the_stale_timer()
    {
        var clock = new FakeTimeProvider();
        using var store = new SettingsStore(dir, TimeSpan.FromMilliseconds(500), clock);
        store.ScheduleSave(new GuiSettings { Drafts = { ["a"] = "A" } });
        store.Save(new GuiSettings { Drafts = { ["a"] = "B" } });
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal("B", store.Load().Drafts["a"]);
        Assert.Equal(0, clock.ActiveTimers);
    }

    [Fact]
    public void Dispose_flushes_a_pending_save()
    {
        var store = new SettingsStore(dir, TimeSpan.FromMinutes(5), new FakeTimeProvider());
        store.ScheduleSave(new GuiSettings { Drafts = { ["a"] = "keep" } });
        store.Dispose();
        Assert.Equal("keep", new SettingsStore(dir).Load().Drafts["a"]);
    }

    [Fact]
    public void Failed_write_keeps_pending_reports_and_retries_every_5_seconds()
    {
        var clock = new FakeTimeProvider();
        Directory.CreateDirectory(Path.GetDirectoryName(dir)!);
        File.WriteAllText(dir, "a file where the directory should be");
        using var store = new SettingsStore(dir, TimeSpan.FromMilliseconds(500), clock);
        var saved = 0;
        var failed = 0;
        store.Saved += () => saved++;
        store.SaveFailed += _ => failed++;

        store.ScheduleSave(new GuiSettings { Drafts = { ["a"] = "precious" } });
        clock.Advance(TimeSpan.FromMilliseconds(500));
        Assert.Equal((0, 1), (saved, failed));

        clock.Advance(TimeSpan.FromSeconds(4));
        Assert.Equal(1, failed);
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal((0, 2), (saved, failed));

        File.Delete(dir);
        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal((1, 2), (saved, failed));
        Assert.Equal("precious", store.Load().Drafts["a"]);
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal((1, 2), (saved, failed));
    }

    [Fact]
    public void A_newer_schedule_wins_over_a_failed_older_one()
    {
        var clock = new FakeTimeProvider();
        Directory.CreateDirectory(Path.GetDirectoryName(dir)!);
        File.WriteAllText(dir, "blocker");
        using var store = new SettingsStore(dir, TimeSpan.FromMilliseconds(500), clock);
        store.ScheduleSave(new GuiSettings { Drafts = { ["a"] = "old" } });
        clock.Advance(TimeSpan.FromMilliseconds(500));
        store.ScheduleSave(new GuiSettings { Drafts = { ["a"] = "new" } });
        File.Delete(dir);
        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal("new", store.Load().Drafts["a"]);
    }

    [Fact]
    public void A_schedule_after_a_failure_keeps_its_own_debounce_not_the_retry_delay()
    {
        var clock = new FakeTimeProvider();
        File.WriteAllText(dir, "blocker");
        using var store = new SettingsStore(dir, TimeSpan.FromMilliseconds(500), clock);
        var saved = 0;
        store.Saved += () => saved++;
        store.ScheduleSave(new GuiSettings { Drafts = { ["a"] = "old" } });
        clock.Advance(TimeSpan.FromMilliseconds(500));
        clock.Advance(TimeSpan.FromSeconds(1));
        store.ScheduleSave(new GuiSettings { Drafts = { ["a"] = "new" } });
        File.Delete(dir);

        clock.Advance(TimeSpan.FromMilliseconds(500));

        Assert.Equal(1, saved);
        Assert.Equal("new", store.Load().Drafts["a"]);
    }

    [Fact]
    public void Save_after_dispose_does_nothing_and_does_not_throw()
    {
        var store = new SettingsStore(dir);
        store.Dispose();
        store.Save(new GuiSettings { Notifications = false });
        store.ScheduleSave(new GuiSettings { Notifications = false });
        Assert.False(File.Exists(Path.Combine(dir, "gui.json")));
    }

    [Fact]
    public void Saved_handler_may_wait_for_a_save_on_another_thread()
    {
        using var store = new SettingsStore(dir);
        var nested = 0;
        var completed = false;
        store.Saved += () =>
        {
            if (Interlocked.Increment(ref nested) > 1) return;
            completed = Task.Run(() => store.Save(new GuiSettings { Drafts = { ["a"] = "inner" } })).Wait(TimeSpan.FromSeconds(10));
        };

        store.Save(new GuiSettings { Drafts = { ["a"] = "outer" } });

        Assert.True(completed);
        Assert.Equal("inner", store.Load().Drafts["a"]);
    }

    [Fact]
    public void SaveFailed_handler_may_wait_for_a_save_on_another_thread()
    {
        File.WriteAllText(dir, "blocker");
        using var store = new SettingsStore(dir);
        var nested = 0;
        var completed = false;
        store.SaveFailed += _ =>
        {
            if (Interlocked.Increment(ref nested) > 1) return;
            completed = Task.Run(() => store.Save(new GuiSettings())).Wait(TimeSpan.FromSeconds(10));
        };

        store.Save(new GuiSettings());

        Assert.True(completed);
    }

    [Fact]
    public void Save_inside_a_failed_event_only_schedules_and_does_not_recurse()
    {
        var clock = new FakeTimeProvider();
        File.WriteAllText(dir, "blocker");
        using var store = new SettingsStore(dir, TimeSpan.FromMilliseconds(500), clock);
        var failed = 0;
        store.SaveFailed += _ =>
        {
            if (++failed == 1) store.Save(new GuiSettings { Drafts = { ["a"] = "again" } });
        };

        store.ScheduleSave(new GuiSettings());
        clock.Advance(TimeSpan.FromMilliseconds(500));
        Assert.Equal(1, failed);

        File.Delete(dir);
        clock.Advance(TimeSpan.FromMilliseconds(500));
        Assert.Equal("again", store.Load().Drafts["a"]);
    }

    [Fact]
    public void A_throwing_handler_never_escapes_the_timer()
    {
        var clock = new FakeTimeProvider();
        using var store = new SettingsStore(dir, TimeSpan.FromMilliseconds(500), clock);
        store.Saved += () => throw new InvalidOperationException("handler bug");
        store.ScheduleSave(new GuiSettings());
        clock.Advance(TimeSpan.FromMilliseconds(500));
        Assert.True(File.Exists(Path.Combine(dir, "gui.json")));
    }
}
