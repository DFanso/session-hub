<#
Runs the Windows test suites and writes docs/test-reports/<yyyy-MM-dd>-windows.md.
Exit code is non-zero when any test failed. The report holds versions, counts and the
tail of the test output only. It must not contain secrets or message text.
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$utc = (Get-Date).ToUniversalTime()
$date = $utc.ToString('yyyy-MM-dd')
$osVersion = [Environment]::OSVersion.VersionString
$bunVersion = 'not found'
if (Get-Command bun -ErrorAction SilentlyContinue) { $bunVersion = ((& bun --version) 2>$null | Select-Object -First 1) }
$claudeVersion = 'not found'
if (Get-Command claude -ErrorAction SilentlyContinue) {
    $claudeVersion = ((& claude --version) 2>$null | Select-Object -First 1)
    if (-not $claudeVersion) { $claudeVersion = 'not found' }
}

function Invoke-Suite([string]$name, [string[]]$bunArgs) {
    $ErrorActionPreference = 'Continue'
    $out = & bun @bunArgs 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" } }
    $code = $LASTEXITCODE
    $text = $out -join "`n"
    $pass = 0; $fail = 0
    if ($text -match '(?m)^\s*(\d+)\s+pass\b') { $pass = [int]$Matches[1] }
    if ($text -match '(?m)^\s*(\d+)\s+fail\b') { $fail = [int]$Matches[1] }
    [pscustomobject]@{
        Name = $name; Command = 'bun ' + ($bunArgs -join ' '); ExitCode = $code
        Pass = $pass; Fail = $fail; Tail = ($out | Select-Object -Last 25) -join "`n"
    }
}

$suites = @(
    (Invoke-Suite 'Windows tests' @('run', 'test:windows')),
    (Invoke-Suite 'Full suite' @('test'))
)

$failed = @($suites | Where-Object { $_.ExitCode -ne 0 -or $_.Fail -gt 0 }).Count -gt 0
$result = if ($failed) { 'FAIL' } else { 'PASS' }

$lines = @(
    "# Windows test report $date",
    '',
    "- Date (UTC): $($utc.ToString('yyyy-MM-dd HH:mm:ss'))",
    "- OS version: $osVersion",
    "- Bun version: $bunVersion",
    "- Claude Code version: $claudeVersion",
    "- Result: **$result**",
    ''
)
foreach ($s in $suites) {
    $lines += "## $($s.Name)"
    $lines += ''
    $lines += "- Command: ``$($s.Command)``"
    $lines += "- Exit code: $($s.ExitCode)"
    $lines += "- Passed: $($s.Pass)"
    $lines += "- Failed: $($s.Fail)"
    $lines += ''
    $lines += 'Output tail:'
    $lines += ''
    $lines += '```text'
    $lines += $s.Tail
    $lines += '```'
    $lines += ''
}

$dir = Join-Path $repo 'docs/test-reports'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$path = Join-Path $dir "$date-windows.md"
Set-Content -Path $path -Value ($lines -join "`n") -Encoding utf8
Write-Output "Report: $path ($result)"
if ($failed) { exit 1 }
