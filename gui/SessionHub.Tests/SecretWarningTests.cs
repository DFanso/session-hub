using System.Text.Json.Nodes;
using SessionHub.Core.App;
using SessionHub.Core.Protocol;
using SessionHub.Core.ViewModels;
using static SessionHub.Tests.TestData;

namespace SessionHub.Tests;

/// <summary>LLM-03: a message that looks like it holds a secret is sent only after an explicit "Send anyway".</summary>
public class SecretWarningTests
{
    private const string Warning = "The message looks like it contains a secret or card number; it goes to the model provider. Send anyway?";

    /// <summary>What the state line shows for looks-secret (src/send/refusals.ts after "Not sent: ").</summary>
    private const string Shown = "Not sent: " + Warning;

    private sealed class FakeBridge
    {
        public List<SendRequest> Sent { get; } = [];

        public Queue<Reply> Replies { get; } = new();

        public Task<Reply> Request(BridgeRequest r, TimeSpan _)
        {
            Sent.Add((SendRequest)r);
            return Task.FromResult(Replies.Dequeue());
        }
    }

    private static Reply Ok(int sendId) =>
        new(1, true, System.Text.Json.JsonDocument.Parse($"{{\"sendId\":{sendId},\"state\":\"pending\"}}").RootElement.Clone());

    private static Reply Err(string code, string message = "x") => new(1, false, null, new BridgeError(code, message));

    private static Reply LooksSecret() => Err("looks-secret", Warning);

    private static CardViewModel Card(string draft = "token sk-live-123")
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(Session("s1")));
        var c = new CardViewModel(hub.Sessions[0]);
        c.Session.Draft = draft;
        return c;
    }

    [Fact]
    public void AllowSecret_is_encoded_only_when_set()
    {
        var plain = JsonNode.Parse(Json.Encode(new SendRequest(4, "s-alpha", "hi")))!.AsObject();
        Assert.False(plain.ContainsKey("allowSecret"));

        var allowed = JsonNode.Parse(Json.Encode(new SendRequest(5, "s-alpha", "hi", null, true)))!.AsObject();
        Assert.True(allowed["allowSecret"]!.GetValue<bool>());
        Assert.False(allowed.ContainsKey("override"));

        var both = JsonNode.Parse(Json.Encode(new SendRequest(6, "s-alpha", "hi", true, true)))!.AsObject();
        Assert.True(both["override"]!.GetValue<bool>());
        Assert.True(both["allowSecret"]!.GetValue<bool>());
    }

    [Fact]
    public void SendBox_looks_secret_offers_send_anyway_with_the_refusal_text()
    {
        var box = new SendBoxViewModel();
        box.ShowReplyError("looks-secret", Warning);
        Assert.True(box.CanSendAnyway);
        Assert.False(box.CanOverride);
        Assert.Equal(Shown, box.StateText);
        Assert.Equal(Warning, SendBoxViewModel.LooksSecretText);

        box.Show("pending", null);
        Assert.False(box.CanSendAnyway);

        // The fixed text is shown whatever the bridge's message says.
        box.ShowReplyError("looks-secret", "send refused: looks-secret");
        Assert.Equal(Shown, box.StateText);
        box.ShowReplyError("send-in-flight");
        Assert.False(box.CanSendAnyway);
        Assert.True(box.CanOverride);
    }

    [Fact]
    public void SendBox_text_edit_clears_the_offer_and_its_text()
    {
        var box = new SendBoxViewModel();
        box.ShowReplyError("looks-secret", Warning);
        box.TextEdited();
        Assert.False(box.CanSendAnyway);
        Assert.Equal("", box.StateText);

        // Other states are not touched by an edit.
        box.ShowReplyError("send-in-flight");
        box.TextEdited();
        Assert.True(box.CanOverride);
        Assert.StartsWith("A message", box.StateText);
    }

    [Fact]
    public async Task A_normal_send_omits_allowSecret()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Ok(1));
        await new SendCoordinator(bridge.Request).SendAsync(Card());
        Assert.Null(bridge.Sent[0].AllowSecret);
    }

    [Fact]
    public async Task Looks_secret_keeps_the_draft_offers_send_anyway_and_never_resends_by_itself()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(LooksSecret());
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();

        await sends.SendAsync(c);

        Assert.Single(bridge.Sent);
        Assert.Equal("token sk-live-123", c.Session.Draft);
        Assert.True(c.SendBox.CanSendAnyway);
        Assert.Equal(Shown, c.SendBox.StateText);
        Assert.Equal(SendTone.Failed, c.SendTone);
        Assert.False(sends.HasPending);
    }

    [Fact]
    public async Task Send_anyway_resends_the_same_text_with_allowSecret()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(LooksSecret());
        bridge.Replies.Enqueue(Ok(8));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);

        await sends.SendSecretAnywayAsync(c);

        Assert.Equal(2, bridge.Sent.Count);
        Assert.Equal("token sk-live-123", bridge.Sent[1].Text);
        Assert.True(bridge.Sent[1].AllowSecret);
        Assert.Null(bridge.Sent[1].Override);
        Assert.Equal("", c.Session.Draft);
        Assert.False(c.SendBox.CanSendAnyway);
    }

    [Fact]
    public async Task Send_anyway_keeps_an_override_that_was_set()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(Err("send-in-flight"));
        bridge.Replies.Enqueue(LooksSecret());
        bridge.Replies.Enqueue(Ok(8));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);
        await sends.OverrideAsync(c);
        Assert.True(bridge.Sent[1].Override);
        Assert.Null(bridge.Sent[1].AllowSecret);

        await sends.SendSecretAnywayAsync(c);

        Assert.True(bridge.Sent[2].Override);
        Assert.True(bridge.Sent[2].AllowSecret);
    }

    [Fact]
    public async Task Override_after_send_anyway_keeps_allowSecret_for_the_same_text_only()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(LooksSecret());
        bridge.Replies.Enqueue(Err("send-in-flight"));
        bridge.Replies.Enqueue(Err("send-in-flight"));
        bridge.Replies.Enqueue(Ok(9));
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);
        await sends.SendSecretAnywayAsync(c);

        await sends.OverrideAsync(c);
        Assert.True(bridge.Sent[2].Override);
        Assert.True(bridge.Sent[2].AllowSecret);

        // Edited text is checked again.
        c.Session.Draft = "something else";
        await sends.OverrideAsync(c);
        Assert.True(bridge.Sent[3].Override);
        Assert.Null(bridge.Sent[3].AllowSecret);
    }

    [Fact]
    public async Task Editing_the_text_withdraws_the_offer()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(LooksSecret());
        var sends = new SendCoordinator(bridge.Request);
        var c = Card();
        await sends.SendAsync(c);

        c.Session.Draft = "token sk-live-1234";

        Assert.False(c.SendBox.CanSendAnyway);
        Assert.Equal("", c.SendBox.StateText);
        await sends.SendSecretAnywayAsync(c);
        Assert.Single(bridge.Sent);
    }

    [Fact]
    public async Task Text_typed_while_the_check_was_out_gets_no_offer()
    {
        var reply = new TaskCompletionSource<Reply>();
        var sent = new List<SendRequest>();
        var sends = new SendCoordinator((r, _) =>
        {
            sent.Add((SendRequest)r);
            return reply.Task;
        });
        var c = Card();
        var task = sends.SendAsync(c);
        c.Session.Draft = "a different text";
        reply.SetResult(LooksSecret());
        await task;

        Assert.False(c.SendBox.CanSendAnyway);
        await sends.SendSecretAnywayAsync(c);
        Assert.Single(sent);
    }

    [Fact]
    public async Task Send_anyway_without_an_offer_does_nothing()
    {
        var bridge = new FakeBridge();
        var sends = new SendCoordinator(bridge.Request);
        await sends.SendSecretAnywayAsync(Card());
        Assert.Empty(bridge.Sent);
    }

    [Fact]
    public async Task Send_anyway_resends_exactly_the_refused_answers_and_message()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(LooksSecret());
        bridge.Replies.Enqueue(Ok(8));
        var sends = new SendCoordinator(bridge.Request);
        var (_, c) = AnswerFormTests.Card();
        c.Answers.Items[0].Answer = "Yes, key sk-live-123";
        c.Session.Draft = "msg";
        await sends.SendAsync(c);
        var refused = bridge.Sent[0].Text;
        Assert.Equal("Answers:\nAUTH-Q1: Yes, key sk-live-123\n\nmsg", refused);

        await sends.SendSecretAnywayAsync(c);

        Assert.Equal(refused, bridge.Sent[1].Text);
        Assert.True(bridge.Sent[1].AllowSecret);
        Assert.Equal("", c.Answers.Items[0].Answer);
        Assert.Equal("", c.Session.Draft);
    }

    [Fact]
    public async Task Editing_an_answer_withdraws_the_offer()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(LooksSecret());
        var sends = new SendCoordinator(bridge.Request);
        var (_, c) = AnswerFormTests.Card();
        c.Answers.Items[0].Answer = "Yes, key sk-live-123";
        await sends.SendAsync(c);
        Assert.True(c.SendBox.CanSendAnyway);

        c.Answers.Items[1].Answer = "Stay";

        Assert.False(c.SendBox.CanSendAnyway);
        Assert.Equal("", c.SendBox.StateText);
        await sends.SendSecretAnywayAsync(c);
        Assert.Single(bridge.Sent);
    }

    [Fact]
    public async Task A_changed_waiting_list_makes_send_anyway_withdraw_instead_of_sending()
    {
        var bridge = new FakeBridge();
        bridge.Replies.Enqueue(LooksSecret());
        var sends = new SendCoordinator(bridge.Request);
        var (hub, c) = AnswerFormTests.Card();
        c.Answers.Items[0].Answer = "Yes, key sk-live-123";
        c.Answers.Items[1].Answer = "Stay";
        await sends.SendAsync(c);

        // AUTH-Q1 was answered in the terminal: its answer drops out, so the text that would go out now
        // differs from the refused one.
        hub.Apply(Snap(Session("s1", name: "alpha", waitingCount: 2, waiting: [AnswerFormTests.Questions[1], AnswerFormTests.Questions[2]])));
        await sends.SendSecretAnywayAsync(c);

        Assert.Single(bridge.Sent);
        Assert.False(c.SendBox.CanSendAnyway);
    }
}
