namespace SessionHub.Core.Bridge;

/// <summary>One running <c>hub bridge</c> child: NDJSON lines in on stdout, out on stdin.</summary>
public interface IBridgeProcess : IDisposable
{
    /// <summary>The next stdout line without its terminator, or null at end of stream.</summary>
    Task<string?> ReadLineAsync(CancellationToken ct);

    /// <summary>Writes one line and its <c>\n</c> terminator to stdin, then flushes.</summary>
    Task WriteLineAsync(string line);

    bool HasExited { get; }
}

/// <summary>Starts a new bridge process. May throw when the process cannot start.</summary>
public delegate IBridgeProcess BridgeFactory();
