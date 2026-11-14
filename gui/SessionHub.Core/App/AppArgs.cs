namespace SessionHub.Core.App;

/// <summary>
/// Command line of <c>SessionHubTray.exe</c>. Every switch is optional:
/// <c>--data-dir &lt;abs&gt;</c> replaces <c>%LOCALAPPDATA%\SessionHub</c> (tests),
/// <c>--hub &lt;abs&gt;</c> replaces the installed <c>hub.exe</c>, and the hidden
/// <c>--render-check &lt;dir&gt;</c> renders the panel to PNG files and exits.
/// </summary>
public sealed record AppArgs(string? DataDir, string? HubPath, string? RenderCheckDir)
{
    public static bool TryParse(IReadOnlyList<string> args, out AppArgs result, out string? error)
    {
        ArgumentNullException.ThrowIfNull(args);
        result = new AppArgs(null, null, null);
        string? data = null, hub = null, render = null;
        for (var i = 0; i < args.Count; i++)
        {
            var flag = args[i];
            if (flag is not ("--data-dir" or "--hub" or "--render-check"))
            {
                error = $"unknown argument: {flag}";
                return false;
            }

            if (i + 1 >= args.Count || args[i + 1].Length == 0)
            {
                error = $"{flag} needs a path";
                return false;
            }

            var value = args[++i];
            switch (flag)
            {
                case "--data-dir" when data is null && Path.IsPathFullyQualified(value):
                    data = value;
                    break;
                case "--hub" when hub is null && Path.IsPathFullyQualified(value):
                    hub = value;
                    break;
                case "--render-check" when render is null:
                    render = Path.GetFullPath(value);
                    break;
                default:
                    error = $"{flag} is repeated or not an absolute path";
                    return false;
            }
        }

        result = new AppArgs(data, hub, render);
        error = null;
        return true;
    }
}
