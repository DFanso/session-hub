# Builds dist\hub.exe, dist\hubd.exe and dist\SessionHubTray.exe (the tray app; it needs the .NET 10
# Desktop Runtime), then installs Session Hub for the current user (no admin rights needed).
# hub install quits a running tray first, copies the three exes to %LOCALAPPDATA%\SessionHub\bin,
# writes %USERPROFILE%\.local\bin\hub.cmd, sets the HKCU Run values SessionHubDaemon (hubd.exe) and
# SessionHubTray (SessionHubTray.exe), and starts the daemon and the tray. It never changes PATH.
#
# Install integrity (INF-08c): by default this installs only a clean tree on the reviewed branch
# (main) whose HEAD is already on origin/main, so local commits nobody reviewed or pushed do not
# get installed. The build writes dist\install-manifest.txt with the commit and the SHA-256 of each
# exe; hub install refuses exes that do not match it or that were built from uncommitted changes,
# checks every copy, and keeps the manifest in bin.
# -AllowUnreviewed installs anyway (another branch, a dirty tree, unpushed commits); the manifest
# and the install output say so.
param(
    [switch]$AllowUnreviewed
)
$ErrorActionPreference = 'Stop'
$reviewedBranch = 'main'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $head = (git rev-parse HEAD)
    if ($LASTEXITCODE -ne 0) { throw 'git rev-parse failed: run this from the Session Hub repo' }
    $branch = (git rev-parse --abbrev-ref HEAD)
    if ($LASTEXITCODE -ne 0) { throw 'git rev-parse failed' }
    $dirty = (git status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'git status failed' }

    $problems = @()
    if ($branch -cne $reviewedBranch) { $problems += "HEAD is on '$branch', not '$reviewedBranch'" }
    if ($dirty) { $problems += 'the working tree has uncommitted changes' }
    # Windows PowerShell turns a native command's stderr into errors under 'Stop'; these two may
    # print to stderr when there is no origin, and only their exit codes matter.
    $ErrorActionPreference = 'Continue'
    git fetch --quiet origin $reviewedBranch 2>&1 | Out-Null
    $fetched = ($LASTEXITCODE -eq 0)
    $onOrigin = $false
    if ($fetched) {
        git merge-base --is-ancestor $head "origin/$reviewedBranch" 2>&1 | Out-Null
        $onOrigin = ($LASTEXITCODE -eq 0)
    }
    $ErrorActionPreference = 'Stop'
    if (-not $fetched) {
        $problems += "cannot fetch origin/$reviewedBranch"
    } elseif (-not $onOrigin) {
        $problems += "HEAD is not on origin/$reviewedBranch (unpushed commits)"
    }
    if ($problems.Count -gt 0) {
        if (-not $AllowUnreviewed) {
            throw "Refusing to install: $($problems -join '; '). Fix that, or pass -AllowUnreviewed."
        }
        Write-Warning "Installing an unreviewed build: $($problems -join '; ')."
    }
    Write-Output "HEAD: $head ($branch)"

    bun run build
    if ($LASTEXITCODE -ne 0) { throw 'bun run build failed' }
    $after = (git rev-parse HEAD)
    if ($after -cne $head) { throw "HEAD moved during the build ($head to $after); run the install again." }

    $hubArgs = @('install')
    if ($AllowUnreviewed) { $hubArgs += '--allow-unreviewed' }
    & (Join-Path $root 'dist\hub.exe') @hubArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
