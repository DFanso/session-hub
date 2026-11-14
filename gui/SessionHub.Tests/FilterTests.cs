using SessionHub.Core.Protocol;
using SessionHub.Core.ViewModels;
using static SessionHub.Tests.TestData;

namespace SessionHub.Tests;

public class FilterTests
{
    private static HubViewModel Hub()
    {
        var hub = new HubViewModel();
        hub.Apply(Snap(
            Session("w", "shop-e3", waitingCount: 1, waiting: [new WaitingItem("Q7", "Pick a DB", false, [])]),
            Session("ap", "approval-only", state: "waiting", cwd: "D:/work/Pay"),
            Session("b", "builder", state: "busy"),
            Session("i", "idler"),
            Session("e", "old", state: "busy", waitingCount: 2, endedAt: 9)));
        return hub;
    }

    private static string[] Ids(IEnumerable<SessionViewModel> v) => [.. v.Select(s => s.SessionId)];

    [Fact]
    public void All_excludes_ended_and_ended_only_under_ended()
    {
        var hub = Hub();
        Assert.Equal(["w", "ap", "b", "i"], Ids(hub.Filter(PanelFilter.All, "")));
        Assert.Equal(["e"], Ids(hub.Filter(PanelFilter.Ended, "")));
    }

    [Fact]
    public void Approval_only_session_is_in_waiting()
    {
        var hub = Hub();
        Assert.Equal(["w", "ap"], Ids(hub.Filter(PanelFilter.Waiting, "")));
        Assert.Equal(["b"], Ids(hub.Filter(PanelFilter.Working, "")));
        Assert.Equal(["i"], Ids(hub.Filter(PanelFilter.Idle, "")));
    }

    [Theory]
    [InlineData("SHOP", "w")]
    [InlineData("d:/work/pay", "ap")]
    [InlineData("q7", "w")]
    [InlineData("pick a db", "w")]
    [InlineData("  idler ", "i")]
    [InlineData("nomatch", "")]
    public void Query_matches_name_cwd_waiting_id_and_text(string query, string expected)
    {
        var ids = Ids(Hub().Filter(PanelFilter.All, query));
        Assert.Equal(expected.Length == 0 ? [] : [expected], ids);
    }

    [Fact]
    public void Query_applies_with_group_filter()
    {
        Assert.Empty(Hub().Filter(PanelFilter.Idle, "shop"));
    }
}
