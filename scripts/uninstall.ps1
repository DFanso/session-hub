# Removes Session Hub for the current user. Data in %LOCALAPPDATA%\SessionHub is kept unless -Purge.
param([switch]$Purge)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'dist\hub.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    $exe = Join-Path $env:LOCALAPPDATA 'SessionHub\bin\hub.exe'
}
if (-not (Test-Path -LiteralPath $exe)) { throw 'hub.exe not found: nothing to uninstall' }
$hubArgs = @('uninstall')
if ($Purge) { $hubArgs += '--purge' }
& $exe @hubArgs
exit $LASTEXITCODE
