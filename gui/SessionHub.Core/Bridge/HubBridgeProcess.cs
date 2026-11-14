using System.Diagnostics;
using System.Text;

namespace SessionHub.Core.Bridge;

/// <summary>The real bridge: <c>hub.exe bridge</c> started by absolute path, with no window.</summary>
public sealed class HubBridgeProcess : IBridgeProcess
{
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);
    private static readonly TimeSpan GracefulExit = TimeSpan.FromSeconds(3);

    private readonly Process process;
    private int disposed;

    private HubBridgeProcess(Process process)
    {
        this.process = process;
        ProcessId = process.Id;
    }

    /// <summary>
    /// <c>&lt;LOCALAPPDATA&gt;\SessionHub\bin\hub.exe</c>. The LOCALAPPDATA value given (normally the
    /// environment variable) wins; when it is empty the known folder is used (ruling R6).
    /// </summary>
    public static string ResolveHubPath(string? localAppData)
    {
        var root = string.IsNullOrEmpty(localAppData)
            ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            : localAppData;
        return Path.Combine(root, "SessionHub", "bin", "hub.exe");
    }

    /// <summary>
    /// A factory that starts <paramref name="hubPath"/> (default: <see cref="ResolveHubPath"/> of the
    /// LOCALAPPDATA environment variable) with the single argument <c>bridge</c>.
    /// </summary>
    public static BridgeFactory Factory(string? hubPath = null)
    {
        var path = hubPath ?? ResolveHubPath(Environment.GetEnvironmentVariable("LOCALAPPDATA"));
        if (!Path.IsPathFullyQualified(path))
            throw new ArgumentException("hub path must be absolute", nameof(hubPath));
        return () => Start(path);
    }

    private static HubBridgeProcess Start(string path)
    {
        var info = new ProcessStartInfo(path)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = Utf8,
            StandardOutputEncoding = Utf8,
            StandardErrorEncoding = Utf8,
            WorkingDirectory = Path.GetDirectoryName(path) ?? string.Empty,
        };
        info.ArgumentList.Add("bridge");

        var process = new Process { StartInfo = info };
        // Drain stderr so a full pipe never blocks the child. Its text is not used.
        process.ErrorDataReceived += static (_, _) => { };
        try
        {
            process.Start();
            process.BeginErrorReadLine();
        }
        catch
        {
            process.Dispose();
            throw;
        }

        return new HubBridgeProcess(process);
    }

    /// <summary>The child's process id, read at start.</summary>
    public int ProcessId { get; }

    public bool HasExited
    {
        get
        {
            try
            {
                return process.HasExited;
            }
            catch (InvalidOperationException)
            {
                return true;
            }
        }
    }

    public async Task<string?> ReadLineAsync(CancellationToken ct) =>
        await process.StandardOutput.ReadLineAsync(ct).ConfigureAwait(false);

    /// <summary>Not safe for concurrent calls; <see cref="BridgeClient"/> serializes writes.</summary>
    public async Task WriteLineAsync(string line)
    {
        var stdin = process.StandardInput;
        await stdin.WriteAsync(line).ConfigureAwait(false);
        await stdin.WriteAsync('\n').ConfigureAwait(false);
        await stdin.FlushAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Closes stdin (the bridge exits on end of input), then kills the bridge after 3 s. Only the
    /// bridge process is killed, never its tree: the daemon it may have started must keep running.
    /// Never throws.
    /// </summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        // Each step is guarded on its own so a failure never skips the kill or the handle cleanup.
        // Closing stdin throws InvalidOperationException while a write is in flight, IOException
        // when the pipe is broken.
        Try(() => process.StandardInput.Close());
        if (!Try(() => process.WaitForExit(GracefulExit)))
        {
            Try(() => process.Kill(entireProcessTree: false));
            Try(() => process.WaitForExit(GracefulExit));
        }

        Try(() => process.StandardOutput.Dispose());
        Try(process.Dispose);
    }

    private static void Try(Action step) => Try(() =>
    {
        step();
        return true;
    });

    private static bool Try(Func<bool> step)
    {
        try
        {
            return step();
        }
        catch (Exception)
        {
            return false;
        }
    }
}
