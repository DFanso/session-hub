using System.Text.Json;
using SessionHub.Core.App;
using SessionHub.Core.Protocol;
using SessionHub.Core.ViewModels;
using static SessionHub.Tests.TestData;

namespace SessionHub.Tests;

internal static class Keys
{
    /// <summary>
    /// The draft key of an item without an ID: "text@" and the first 8 hex digits of the SHA-256 of its
    /// text, plus ".k" for the k-th (k &gt;= 2) item with that same text.
    /// </summary>
    public static string NoId(string text, int occurrence = 1) =>
        $"text@{Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text)))[..8]}"
        + (occurrence > 1 ? $".{occurrence}" : "");
}

public class AnswerComposerTests
{
    private static WaitingItem Item(string? id, string text = "question?", params string[] children) => new(id, text, false, children);

    [Fact]
    public void Draft_labels_tie_an_item_without_an_id_to_its_text()
    {
        Assert.Equal(
            ["AUTH-Q1", Keys.NoId("first?"), "Q15", "Q15 (2)", Keys.NoId("second?"), Keys.NoId("first?", 2)],
            AnswerComposer.DraftLabels(
                [Item("AUTH-Q1"), Item(null, "first?"), Item("Q15"), Item("Q15"), Item(null, "second?"), Item(null, "first?")]));
        Assert.Matches("^text@[0-9a-f]{8}$", Keys.NoId("first?"));
        Assert.Matches("^text@[0-9a-f]{8}\\.2$", Keys.NoId("first?", 2));
        Assert.NotEqual(Keys.NoId("first?"), Keys.NoId("second?"));
        // An ID item with the same text does not count as an occurrence.
        Assert.Equal([ "Q1", Keys.NoId("same?") ], AnswerComposer.DraftLabels([Item("Q1", "same?"), Item(null, "same?")]));
    }

    [Fact]
    public void Labels_are_ids_or_item_n_and_repeats_get_a_number()
    {
        Assert.Equal(
            ["AUTH-Q1", "Item 2", "Q15", "Q15 (2)", "Item 5"],
            AnswerComposer.Labels([Item("AUTH-Q1"), Item(null), Item("Q15"), Item("Q15"), Item(null)]));
    }

    [Fact]
    public void Only_filled_answers_are_listed_trimmed_then_the_message()
    {
        var text = AnswerComposer.Compose(
            [Item("AUTH-Q1"), Item("DB-Q1"), Item(null), Item(null)],
            ["  Yes, harden first.  ", "", "   ", "Weekday after 22:00"],
            "  Also check the logs.  ");
        Assert.Equal("Answers:\nAUTH-Q1: Yes, harden first.\nItem 4: Weekday after 22:00\n\nAlso check the logs.", text);
    }

    [Fact]
    public void A_multi_line_answer_keeps_its_lines_indented_by_two_spaces()
    {
        var text = AnswerComposer.Compose([Item("Q1")], ["first line\r\nsecond line\n\nfourth  "], null);
        Assert.Equal("Answers:\nQ1: first line\n  second line\n\n  fourth", text);
    }

    [Fact]
    public void Answers_only_message_only_and_nothing()
    {
        Assert.Equal("Answers:\nQ1: a", AnswerComposer.Compose([Item("Q1")], ["a"], "  "));
        Assert.Equal("just this\nand this", AnswerComposer.Compose([Item("Q1")], [""], "just this\r\nand this"));
        Assert.Equal("", AnswerComposer.Compose([Item("Q1")], [" "], null));
        Assert.Equal("", AnswerComposer.Compose([], [], ""));
    }

    [Fact]
    public void Missing_answers_count_as_blank()
    {
        Assert.Equal("Answers:\nQ1: a", AnswerComposer.Compose([Item("Q1"), Item("Q2")], ["a"], null));
    }

    [Fact]
    public void Draft_keys_join_session_and_label()
    {
        Assert.Equal("s1#AUTH-Q1", AnswerComposer.DraftKey("s1", "AUTH-Q1"));
        Assert.Equal("s1#Item 2", AnswerComposer.DraftKey("s1", "Item 2"));
    }

    [Fact]
    public void Header_and_limit_match_the_relay()
    {
        var line = File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", "constants.ndjson"))
            .Single(l => l.Length > 0);
        using var doc = JsonDocument.Parse(line);
        Assert.Equal(AnswerComposer.MessageHeader, doc.RootElement.GetProperty("messageHeader").GetString());
        Assert.Equal(AnswerComposer.MaxChars, doc.RootElement.GetProperty("maxTextChars").GetInt32());
        Assert.Equal(AnswerComposer.MessageHeader + "\n\nhi", AnswerComposer.Preview("hi"));
    }
}

public class AnswerFormTests
{
    internal static readonly WaitingItem[] Questions =
    [
        new("AUTH-Q1", "Approve the auth direction?", true, []),
        new("DB-Q1", "Stay on the current database?", false, []),
        new(null, "Pick a date for the cutover window.", false, ["Weekday evening", "Weekend morning"]),
    ];

    internal static (HubViewModel Hub, CardViewModel Card) Card(IReadOnlyList<WaitingItem>? waiting = null, IReadOnlyDictionary<string, string>? drafts = null)
    {
        var hub = new HubViewModel(drafts);
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 3, waiting: waiting ?? Questions)));
        return (hub, new CardViewModel(hub.Sessions[0]));
    }

    [Fact]
    public void Items_mirror_the_waiting_list()
    {
        var (_, c) = Card();
        var f = c.Answers;
        Assert.True(f.IsActive);
        Assert.Equal(3, f.Total);
        Assert.Equal(["AUTH-Q1", "DB-Q1", "Item 3"], f.Items.Select(i => i.Label));
        Assert.Equal([false, false, true], f.Items.Select(i => i.IsNoId));
        Assert.Equal("Your answer to DB-Q1… (optional)", f.Items[1].Placeholder);
        Assert.Equal(["Weekday evening", "Weekend morning"], f.Items[2].Children);
        Assert.Equal("Pick a date for the cutover window.", f.Items[2].Text);
    }

    [Fact]
    public void Not_active_without_waiting_items_or_when_ended()
    {
        Assert.False(Card(waiting: []).Card.Answers.IsActive);
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("s1", waitingCount: 3, endedAt: 5, waiting: Questions)));
        Assert.False(new CardViewModel(hub.Sessions[0]).Answers.IsActive);
    }

    [Fact]
    public void Counts_button_label_preview_and_can_send()
    {
        var (_, c) = Card();
        var f = c.Answers;
        Assert.False(f.CanSend);
        Assert.False(f.HasPreview);
        Assert.Equal("0 of 3 answered · Ctrl+Enter sends", f.FooterText);
        Assert.Equal("Send message", f.SendLabel);

        c.Session.Draft = "hi";
        Assert.True(f.CanSend);
        Assert.Equal("0 of 3 answered + message · Ctrl+Enter sends", f.FooterText);
        Assert.Equal("Send message", f.SendLabel);

        f.Items[0].Answer = "Yes";
        Assert.True(f.Items[0].IsFilled);
        Assert.False(f.Items[1].IsFilled);
        Assert.Equal(1, f.AnsweredCount);
        Assert.Equal("1 of 3 answered + message · Ctrl+Enter sends", f.FooterText);
        Assert.Equal("Send answers", f.SendLabel);
        Assert.Equal("Answers:\nAUTH-Q1: Yes\n\nhi", f.Composed);
        Assert.True(f.HasPreview);
        Assert.Equal(AnswerComposer.MessageHeader + "\n\nAnswers:\nAUTH-Q1: Yes\n\nhi", f.PreviewText);

        c.Session.Draft = "";
        f.Items[0].Answer = "   ";
        Assert.False(f.Items[0].IsFilled);
        Assert.False(f.CanSend);
    }

    [Fact]
    public void Too_long_is_shown_before_sending()
    {
        var (_, c) = Card();
        var f = c.Answers;
        f.Items[0].Answer = new string('a', AnswerComposer.MaxChars);
        Assert.True(f.IsTooLong);
        Assert.False(f.CanSend);
        Assert.StartsWith("Too long to send", f.TooLongText);
        f.Items[0].Answer = "short";
        Assert.False(f.IsTooLong);
        Assert.True(f.CanSend);
    }

    [Fact]
    public void Answers_are_kept_as_drafts_by_session_and_label()
    {
        var (hub, c) = Card();
        var changes = new List<(string, string)>();
        hub.DraftChanged += (k, v) => changes.Add((k, v));
        c.Answers.Items[2].Answer = "Weekend";
        var key = "s1#" + Keys.NoId(Questions[2].Text);
        Assert.Equal("Weekend", hub.Drafts[key]);
        Assert.Equal([(key, "Weekend")], changes);
        c.Answers.Items[2].Answer = "";
        Assert.False(hub.Drafts.ContainsKey(key));
    }

    [Fact]
    public void Saved_answer_drafts_come_back()
    {
        var (_, c) = Card(drafts: new Dictionary<string, string>
        {
            ["s1#DB-Q1"] = "Stay",
            ["s1"] = "msg",
            ["s2#DB-Q1"] = "other",
            ["s1#" + Keys.NoId(Questions[2].Text)] = "Weekend",
        });
        Assert.Equal("Stay", c.Answers.Items[1].Answer);
        Assert.Equal("", c.Answers.Items[0].Answer);
        Assert.Equal("Weekend", c.Answers.Items[2].Answer);
        Assert.Equal("msg", c.Session.Draft);
        // A draft saved for another question (or under the old "Item n" key) is not shown.
        var (_, other) = Card(drafts: new Dictionary<string, string> { ["s1#Item 3"] = "old", ["s1#" + Keys.NoId("another question")] = "x" });
        Assert.Equal("", other.Answers.Items[2].Answer);
    }

    [Fact]
    public void Clear_empties_every_box()
    {
        var (hub, c) = Card();
        c.Answers.Items[0].Answer = "a";
        c.Session.Draft = "m";
        c.Answers.Clear();
        Assert.All(c.Answers.Items, i => Assert.Equal("", i.Answer));
        Assert.Equal("", c.Session.Draft);
        Assert.Empty(hub.Drafts);
    }

    [Fact]
    public void A_changed_waiting_list_keeps_answers_by_label()
    {
        var (hub, c) = Card();
        c.Answers.Items[1].Answer = "Stay";
        c.Answers.Items[0].Answer = "Yes";
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 1, waiting: [Questions[1]])));
        Assert.Equal(["DB-Q1"], c.Answers.Items.Select(i => i.Label));
        Assert.Equal("Stay", c.Answers.Items[0].Answer);
        Assert.Equal("Answers:\nDB-Q1: Stay", c.Answers.Composed);
        // AUTH-Q1 is gone from the list but its draft is kept until a send succeeds.
        Assert.Equal("Yes", hub.Drafts["s1#AUTH-Q1"]);
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 3, waiting: Questions)));
        Assert.Equal("Yes", c.Answers.Items[0].Answer);
    }

    [Fact]
    public void Clear_sent_clears_only_what_was_sent_and_drops_gone_labels()
    {
        var (hub, c) = Card();
        c.Answers.Items[0].Answer = "Yes";
        c.Answers.Items[1].Answer = "Stay";
        c.Session.Draft = "msg";
        var sent = c.Answers.Capture();
        Assert.Equal("Answers:\nAUTH-Q1: Yes\nDB-Q1: Stay\n\nmsg", sent.Text);

        // While the request is out: DB-Q1 edited, and the list changes (AUTH-Q1 answered and gone).
        c.Answers.Items[1].Answer = "Stay for now";
        c.Session.SetAnswer("Q9", "kept for later");
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 2, waiting: [Questions[1], Questions[2]])));
        c.Answers.Items[1].Answer = "Weekend";

        c.Answers.ClearSent(sent);
        Assert.Equal("", c.Session.Draft);
        Assert.Equal("Stay for now", c.Answers.Items[0].Answer);
        Assert.Equal("Weekend", c.Answers.Items[1].Answer);
        Assert.False(hub.Drafts.ContainsKey("s1#AUTH-Q1"));
        Assert.False(hub.Drafts.ContainsKey("s1#Q9"));
        Assert.Equal("Stay for now", hub.Drafts["s1#DB-Q1"]);
        Assert.Equal("Weekend", hub.Drafts["s1#" + Keys.NoId(Questions[2].Text)]);
    }

    [Fact]
    public void An_answer_moves_with_its_question_when_the_list_shifts()
    {
        WaitingItem[] three =
        [
            new(null, "First question?", false, []),
            new(null, "Second question?", false, []),
            new(null, "Third question?", false, []),
        ];
        var (hub, c) = Card(waiting: three);
        c.Answers.Items[1].Answer = "answer to the second";

        // Item 1 is answered and gone: the second question is now Item 1, the third is Item 2.
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 2, waiting: [three[1], three[2]])));
        Assert.Equal(["Item 1", "Item 2"], c.Answers.Items.Select(i => i.Label));
        Assert.Equal("answer to the second", c.Answers.Items[0].Answer);
        Assert.Equal("", c.Answers.Items[1].Answer);
        Assert.Equal("Answers:\nItem 1: answer to the second", c.Answers.Composed);
        Assert.Equal("answer to the second", hub.Drafts["s1#" + Keys.NoId("Second question?")]);
    }

    [Fact]
    public void Identical_questions_keep_separate_drafts()
    {
        WaitingItem[] twins = [new(null, "Same?", false, []), new(null, "Same?", false, [])];
        var (hub, c) = Card(waiting: twins);
        c.Answers.Items[0].Answer = "one";
        c.Answers.Items[1].Answer = "two";
        Assert.Equal("one", hub.Drafts["s1#" + Keys.NoId("Same?")]);
        Assert.Equal("two", hub.Drafts["s1#" + Keys.NoId("Same?", 2)]);
        Assert.Equal("Answers:\nItem 1: one\nItem 2: two", c.Answers.Composed);
    }

    [Fact]
    public void A_reworded_question_does_not_inherit_the_old_answer()
    {
        WaitingItem[] one = [new(null, "Pick a date?", false, [])];
        var (hub, c) = Card(waiting: one);
        c.Answers.Items[0].Answer = "Friday";
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 1, waiting: [new(null, "Pick a date and a time?", false, [])])));
        Assert.Equal("", c.Answers.Items[0].Answer);
        Assert.Equal("", c.Answers.Composed);
        // Kept until a send prunes it.
        Assert.Equal("Friday", hub.Drafts["s1#" + Keys.NoId("Pick a date?")]);
    }

    [Fact]
    public void Unchanged_items_keep_their_view_model_across_a_rebuild()
    {
        var (hub, c) = Card();
        var before = c.Answers.Items.ToList();

        // AUTH-Q1 is no longer new, and DB-Q1's text changed.
        WaitingItem[] next = [Questions[0] with { IsNew = false }, Questions[1] with { Text = "Reworded?" }, Questions[2]];
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 3, waiting: next)));
        Assert.Same(before[0], c.Answers.Items[0]);
        Assert.NotSame(before[1], c.Answers.Items[1]);
        Assert.Equal("Reworded?", c.Answers.Items[1].Text);
        Assert.Same(before[2], c.Answers.Items[2]);

        // The session ends: the form turns off, the items stay the same objects.
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 3, endedAt: 9, waiting: next)));
        Assert.False(c.Answers.IsActive);
        Assert.Same(before[0], c.Answers.Items[0]);

        // AUTH-Q1 is answered and gone: DB-Q1 moves up as the same object; the item without an ID is
        // relabelled "Item 2" (a new view model) and keeps its answer.
        var reworded = c.Answers.Items[1];
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 2, waiting: [next[1], next[2]])));
        Assert.Equal(2, c.Answers.Items.Count);
        Assert.Same(reworded, c.Answers.Items[0]);
        Assert.Equal("Item 2", c.Answers.Items[1].Label);
        Assert.NotSame(before[2], c.Answers.Items[1]);
    }

    [Fact]
    public void Without_questions_the_draft_is_sent_as_typed()
    {
        var (_, c) = Card(waiting: []);
        c.Session.Draft = "  plain\r\ntext ";
        var sent = c.Answers.Capture();
        Assert.Equal("  plain\r\ntext ", sent.Text);
        c.Answers.ClearSent(sent);
        Assert.Equal("", c.Session.Draft);
    }
}

public class AnswerSendTests
{
    private sealed class FakeBridge
    {
        public List<SendRequest> Sent { get; } = [];

        public Task<Reply> Request(BridgeRequest r, TimeSpan _)
        {
            Sent.Add((SendRequest)r);
            return Task.FromResult(new Reply(1, true, JsonDocument.Parse("{\"sendId\":5,\"state\":\"pending\"}").RootElement.Clone()));
        }
    }

    [Fact]
    public async Task The_composed_text_is_sent_and_the_sent_boxes_cleared()
    {
        var (hub, c) = AnswerFormTests.Card();
        c.Answers.Items[0].Answer = "Yes";
        c.Answers.Items[2].Answer = "Weekend";
        var bridge = new FakeBridge();
        await new SendCoordinator(bridge.Request).SendAsync(c);
        Assert.Equal("Answers:\nAUTH-Q1: Yes\nItem 3: Weekend", bridge.Sent.Single().Text);
        Assert.All(c.Answers.Items, i => Assert.Equal("", i.Answer));
        Assert.Empty(hub.Drafts);
        Assert.Equal("Sending…", c.SendBox.StateText);
    }

    [Fact]
    public async Task Nothing_to_send_sends_nothing()
    {
        var (_, c) = AnswerFormTests.Card();
        c.Answers.Items[0].Answer = "  ";
        var bridge = new FakeBridge();
        await new SendCoordinator(bridge.Request).SendAsync(c);
        Assert.Empty(bridge.Sent);
    }

    [Fact]
    public async Task Too_long_is_refused_without_a_request()
    {
        var (_, c) = AnswerFormTests.Card();
        c.Answers.Items[0].Answer = new string('a', AnswerComposer.MaxChars);
        var bridge = new FakeBridge();
        await new SendCoordinator(bridge.Request).SendAsync(c);
        Assert.Empty(bridge.Sent);
        Assert.Equal("Not sent: The message is too long. Shorten it and try again.", c.SendBox.StateText);
        Assert.Equal(new string('a', AnswerComposer.MaxChars), c.Answers.Items[0].Answer);
    }
}
