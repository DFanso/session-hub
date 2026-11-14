using System.Text.Json;
using SessionHub.Core.ViewModels;

namespace SessionHub.Tests;

public class SendBoxTests
{
    private static readonly string[] Codes =
    [
        // The relay's refusals (src/send/relay.ts RefuseReason).
        "unknown-session", "session-not-live", "duplicate-name", "unsafe-name", "send-in-flight",
        "empty-message", "too-long", "rate-limited", "looks-secret",
        // The bridge and the bridge client.
        "send-error", "internal", "no-store", "store-error", "too-large", "bad-json", "unknown-type",
        "bad-request", "not-connected", "timeout", "bridge-restarted", "disposed", "bad-reply", "unknown",
        // A code this build has never heard of.
        "some-future-code",
    ];

    [Fact]
    public void Every_reply_error_is_plain_english_and_never_the_code()
    {
        foreach (var code in Codes)
        {
            var text = new SendBoxViewModel().ShowReplyError(code, "boom");
            Assert.False(string.IsNullOrWhiteSpace(text), code);
            Assert.DoesNotContain(code, text, StringComparison.Ordinal);
            Assert.Matches("^[A-Z].*[.?]$", text);
        }
    }

    [Fact]
    public void Relay_refusals_match_the_texts_the_tui_shows()
    {
        var lines = File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", "refusals.ndjson"))
            .Where(l => l.Length > 0).ToArray();
        Assert.Equal(9, lines.Length);
        foreach (var line in lines)
        {
            using var doc = JsonDocument.Parse(line);
            var code = doc.RootElement.GetProperty("code").GetString()!;
            var text = doc.RootElement.GetProperty("text").GetString()!;
            // send-in-flight offers the tray's own "Send anyway" button instead.
            if (code == "send-in-flight") continue;
            Assert.Equal("Not sent: " + text, new SendBoxViewModel().ShowReplyError(code, $"send refused: {code}"));
        }
    }

    [Fact]
    public void Unsafe_name_says_how_to_fix_it()
    {
        Assert.Equal(
            "Not sent: This session's name has characters Session Hub can't send to safely. Rename it in Claude Code (/rename) and try again.",
            new SendBoxViewModel().ShowReplyError("unsafe-name", "send refused: unsafe-name"));
    }

    [Fact]
    public void Send_error_keeps_the_bridge_message_as_detail()
    {
        Assert.Equal(
            "Not sent: something went wrong (claude agents failed). Try again.",
            new SendBoxViewModel().ShowReplyError("send-error", "claude agents failed"));
        Assert.Equal(
            "Not sent: something went wrong. Try again.",
            new SendBoxViewModel().ShowReplyError("send-error"));
    }

    [Fact]
    public void Only_send_in_flight_offers_override()
    {
        foreach (var code in Codes)
        {
            var box = new SendBoxViewModel();
            box.ShowReplyError(code);
            Assert.Equal(code == "send-in-flight", box.CanOverride);
        }
    }
}
