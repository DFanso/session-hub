# Session Hub

A local terminal app and tray app for Windows that list the Claude Code sessions running on this machine,
show what each one is doing and its recent history, and let the owner send a message to one session. They
read session files only, open no network port, and keep the index in `%LOCALAPPDATA%\SessionHub\hub.db`.

## Requirements

- Windows 11
- Bun 1.4.2 and .NET SDK 10.0.404 (only to build or develop; the installed exes are compiled binaries)
- .NET 10 Desktop Runtime (the tray app is a framework-dependent single file)
- Claude Code (tested with 2.1.323). Profiles read: `~/.claude` and `~/.claude-personal`.

## Install and uninstall

    bun install --ignore-scripts
    bun run build
    dist\hub.exe install

`bun run build` produces three executables: `hub.exe` (every command, including the TUI), `hubd.exe` (the
daemon only, built without a console window) and `SessionHubTray.exe` (the tray app, published from
`gui/SessionHub.Tray`). `hub install` copies all three to `%LOCALAPPDATA%\SessionHub\bin\`, writes a `hub.cmd`
shim to `%USERPROFILE%\.local\bin` (already on PATH), creates the private data directory, sets two HKCU Run
values with no arguments (`SessionHubDaemon` = `"%LOCALAPPDATA%\SessionHub\bin\hubd.exe"`, `SessionHubTray` =
`"%LOCALAPPDATA%\SessionHub\bin\SessionHubTray.exe"`), then starts the daemon and the tray. It never edits PATH,
and it refuses to install if a foreign `hub.cmd` already exists in that folder.

`bun run build` also writes `dist\install-manifest.txt`: the commit it built from (marked `dirty` when the tree
had uncommitted changes) and the SHA-256 of each exe. `hub install` refuses exes that do not match it, and a
`dirty` build unless it gets `--allow-unreviewed`. It stages and checks all three copies before it replaces
any exe, puts the old exes back if a replace fails part-way, prints the commit, and keeps the manifest in
`bin\` so the installed build can be traced. `scripts\install.ps1` builds and installs in one step, and only
from a clean tree on `main` whose HEAD is already on `origin/main`, unless it gets `-AllowUnreviewed`.

A running tray is asked to quit first (it saves typed drafts), so `hub install` can replace the exes. If it has
not exited after 5 s it is stopped by force, but only when `run\tray.pid` names a process running
`bin\SessionHubTray.exe`. If an exe cannot be replaced (retried for 10 s), the installed daemon and tray are
started again and `hub install` exits with 1.

A tray started elevated ("Run as administrator") cannot be quit or stopped by a `hub install` or `hub uninstall`
run from a normal prompt: Windows lets a normal process neither set the elevated tray's quit event nor end it.
`hub install` then stops with an error saying the tray did not quit or did not stop, before it replaces or
registers anything; `hub uninstall` reports the same and removes the rest. Quit that tray from its tray-icon
menu, then run the command again.

    hub uninstall            # quits the tray, clears both autostart values, stops the daemon, removes the shim, keeps the data
    hub uninstall --purge    # also deletes the data directory

## Usage

Run `hub` to open the terminal UI. It starts the daemon if it is not running.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select a session |
| `1` / `2` / `3` | Status / History / Send pane |
| `/` | Search |
| `j` | Jump to the session's terminal window |
| `r` | Refresh |
| `q` | Quit |

Send pane: type the text, `Ctrl+S` shows a preview (recipient name, profile, cwd and the full message that
will be sent), `y` sends, `n` cancels. If an earlier send to that session is still open, the pane shows its
state and `o` is needed to override.

Daemon commands: `hub daemon run|start|stop|status`. `hub daemon start` runs `hubd.exe` hidden in the
background; `hub daemon run` runs the daemon in the current console. `hub --version` prints the version.

## Tray app

`SessionHubTray.exe` sits in the notification area and starts at login. It shows the same sessions as the TUI
and starts the daemon if it is not running.

| Icon | Meaning |
| --- | --- |
| Neutral | Daemon running, nothing waiting |
| Orange with a count | That many items are waiting on you |
| Grey | The daemon is stopped; the panel offers "Start daemon" |
| Red | The tray cannot reach `hub.exe` (three failed starts in a row) |

Left-click the icon to open or close the panel next to the taskbar. Right-click for Open panel, Open window and Quit.

| Key | Action |
| --- | --- |
| `Esc` | Close the panel |
| `Ctrl+1` to `Ctrl+4` | Home / Sessions / Waiting / Send tab |
| `Ctrl+F` | Search |
| `Enter` | Send the reply |
| `Shift+Enter` | New line in the reply |

The monitor button in the panel opens the window: a resizable two-pane view with Status, History and Send for
the selected session. Window keys:

| Key | Action |
| --- | --- |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Status / History / Send tab (Send puts the cursor in the reply box) |
| `Ctrl+F` | Search: the History search on the History tab, else the session list search |
| `Esc` | Clear the search box it is typed in |
| `Enter` / `Shift+Enter` | Send the reply / new line |

⚙ Notifications in the panel turns the "waiting on you" balloons on or off (at most one per session every 5
minutes). Settings and drafts are kept in `%LOCALAPPDATA%\SessionHub\gui.json`.

Quit closes the tray only; the daemon keeps running. Start the tray again from
`%LOCALAPPDATA%\SessionHub\bin\SessionHubTray.exe` or at the next login. The tray log is
`%LOCALAPPDATA%\SessionHub\run\tray.log`.

## Security model

- No network listener of any kind. The TUI and the daemon share only the SQLite file `hub.db`. The tray app
  gets its data from a `hub.exe bridge` child over stdin/stdout. Its only other signals are two named events
  that carry no data and only the current user can open: `Local\SessionHub.Tray.Quit` (set by `hub install`
  and `hub uninstall`) and `Local\SessionHub.Tray.Show` (a second start opens the running tray's panel).
  To stop the tray, `hub install` and `hub uninstall` also open the tray's instance mutex
  `Local\SessionHub.Tray.Instance` (SYNCHRONIZE only, to see whether a tray still runs) and read the executable
  path of the process named in `run\tray.pid` (PROCESS_QUERY_LIMITED_INFORMATION), so they never kill a process
  that is not `bin\SessionHubTray.exe`. The daemon is guarded the same way: `run\daemon.lock` holds its pid and
  its process start time, so a pid that Windows gave to another process after an unclean logoff (a different
  start time) is a stale lock, never reported as the daemon or killed. A live pid whose start time cannot be read
  (for example an elevated daemon) still counts as running, so no second daemon starts, but it is never killed;
  a kill also needs the image to be `hubd.exe`, `hub.exe` or `bun.exe`. A lock from an older version (pid only)
  is judged by the process image instead.
- From `sessions/<pid>.json` the hub reads only `name`, `sessionId`, `status`, `updatedAt`, `pid`, `cwd`.
- It never opens, reads or stats `*.key` files and never connects to the Claude Code messaging socket.
- It never stores API request bodies, attachment bodies, file history or tool results.
- The data directory is restricted to the owner with an ACL. Secrets (tokens, connection strings, JWTs) are
  masked before they are shown or indexed. Logs hold counts, timings, session names and errors, never message text.
- Sending runs one fixed relay command, with the message on stdin and cwd `%LOCALAPPDATA%\SessionHub\relay`:

      claude -p -n session-hub-relay --permission-mode <recipient mode> --strict-mcp-config --tools "SendMessage" --allowedTools "SendMessage" --model haiku --no-session-persistence --output-format json

  The relay runs in the recipient's current permission mode (from its latest permission-mode record), which can
  be `bypassPermissions`. Its tools are limited to `SendMessage`. It never uses `--restricted` and never changes
  `crossSessionInbound`.
- A message the session cannot take yet shows "held: approve in the session's terminal".
- When the recipient session is busy, a send stays "pending" until that session takes the message into its turn;
  it then becomes "delivered" (within 30 minutes, else "expired").
- Delivery is confirmed only by an exact SHA-256 match of the message in the recipient's own transcript.
- The message text leaves the machine: the relay is one Claude Haiku turn under the recipient profile's Claude
  Code login, so the text goes to Anthropic as typed, under that account's data terms. A text that looks like a
  secret or card number is refused until the owner confirms it again (`looks-secret`; the TUI preview shows the
  warning). At most 6 relays start per minute, and each run is traced in `run\relay.log` without the text.
- A relay message that matches no send to the session it landed in is counted (`relay_stray_count`) and logged.
- Hub messages are information and instructions, never approvals. Approvals stay in the session's own terminal
  (jump to it with `j`). The hub cannot approve a permission prompt.

## Data and retention

Everything lives in `%LOCALAPPDATA%\SessionHub\` (`hub.db`, `bin\`, logs). Indexed data is kept until 7 days after
a session ends, then deleted.

## Tested versions

Claude Code 2.1.323 on Windows 11. Each release needs a passing Windows report from `scripts/test-windows-report.ps1`.

## Troubleshooting

- `hub daemon status` prints `RUNNING pid=<n>` or `STOPPED`. If stopped, run `hub daemon start`.
- The daemon log is `%LOCALAPPDATA%\SessionHub\run\daemon.log`. It contains no message text.
- A "format changed" banner in the Status pane means Claude Code wrote records the hub does not recognise.
  Check the Claude Code version against the tested one.
- No sessions listed: check that Claude Code is running and that `~/.claude` or `~/.claude-personal` exists.

## Development

    bun install --ignore-scripts
    bun test                 # all tests; `bun test --coverage` enforces 85% lines
    bun run test:windows     # Windows-only tests
    bun run lint             # biome ci
    bun run typecheck        # tsc --noEmit
    bun run build            # dist/hub.exe, dist/hubd.exe and dist/SessionHubTray.exe
    dotnet test gui/SessionHub.Tests                   # tray app logic tests
    powershell -File scripts/test-windows-report.ps1   # writes docs/test-reports/<date>-windows.md

CI (`.github/workflows/ci.yml`) runs lint, typecheck, coverage tests, `bun audit` and gitleaks on the `test` job,
and the tray app's restore, tests, build and publish on the `gui` job, both on GitHub-hosted `ubuntu-24.04`.

## License

MIT. See `LICENSE`.
