<#
GUI acceptance run (Windows). Phases:
  Latency  status reply appended to a fixture transcript -> bridge snapshot. Temp USERPROFILE and
           LOCALAPPDATA, own daemon and own `hub bridge`; the real profile and data are never touched.
  Idle     process statistics (CPU time, working set, private bytes) of the INSTALLED tray, its
           `hub.exe bridge` child and the daemon, every 10 s. Statistics only: the processes are never
           read from, signalled or restarted. (A second tray on temp dirs cannot run: its single-instance
           mutex is per session, so it would only signal the installed one.)
  Snapshots  count bridge snapshots that differ from the previous one (ignoring seq) over
           -SnapshotSeconds with nothing written; expect 0 (same temp env as Latency).
  Render   SessionHubTray.exe --render-check into $OutDir\render; a subset is copied by hand to docs\test-reports\gui\.
Writes JSON results to $OutDir\acceptance-results.json; the report is written from those by hand/tooling.
Targets: latency p95 <= 2000 ms; idle mean CPU < 0.5 % of one core, max RAM (tray + bridge working set) < 150 MB.
#>
param(
    [ValidateSet('Latency', 'Snapshots', 'Idle', 'Render', 'All')][string]$Phase = 'All',
    [int]$Runs = 20,
    [int]$IdleSeconds = 600,
    [int]$SnapshotSeconds = 300,
    [string]$Dist = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'),
    [string]$OutDir = (Join-Path $env:TEMP 'gui-acceptance')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$results = @{}
$resultsFile = Join-Path $OutDir 'acceptance-results.json'
if (Test-Path $resultsFile) { (Get-Content $resultsFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $results[$_.Name] = $_.Value } }

function Save-Results { $results | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $resultsFile }

function Get-Percentile([double[]]$sorted, [double]$p) {
    $i = [Math]::Ceiling($p * $sorted.Count) - 1
    return $sorted[[Math]::Max(0, [Math]::Min($sorted.Count - 1, $i))]
}

function Invoke-Latency([int]$Runs = 20, [int]$SnapshotSeconds = 0) {
    $hub = Join-Path $Dist 'hub.exe'
    $tmp = Join-Path $env:TEMP ("gui-acc-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $home_ = Join-Path $tmp 'home'; $lad = Join-Path $tmp 'lad'
    $sid = [guid]::NewGuid().ToString()
    $projDir = Join-Path $home_ ".claude\projects\fixture"
    $sessDir = Join-Path $home_ '.claude\sessions'
    New-Item -ItemType Directory -Force $projDir, $sessDir, $lad, (Join-Path $home_ '.claude-personal') | Out-Null
    # A live session as `claude agents --json` (run by the daemon against the temp profile) sees it:
    # sessions\<pid>.json naming a live pid (this script's). A reply is what a real session does: the
    # transcript grows, then the session file is rewritten (which is what the daemon watches).
    $sessFile = Join-Path $sessDir "$PID.json"
    function Write-SessionFile([int]$n) {
        $o = @{ pid = $PID; sessionId = $sid; cwd = 'C:\fixture'; kind = 'interactive'; startedAt = 1700000000000; name = 'fixture'; status = 'idle'; updatedAt = 1700000000000 + $n } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($sessFile, $o, (New-Object Text.UTF8Encoding $false))
    }
    $transcript = Join-Path $projDir "$sid.jsonl"
    $now = [DateTime]::UtcNow
    $first = @(
        (@{ type = 'user'; isSidechain = $false; uuid = 'u-0'; timestamp = $now.ToString('o'); cwd = 'C:\fixture'; sessionId = $sid; message = @{ role = 'user'; content = 'fixture prompt' } } | ConvertTo-Json -Compress -Depth 6),
        (@{ type = 'assistant'; isSidechain = $false; uuid = 'a-0'; timestamp = $now.ToString('o'); cwd = 'C:\fixture'; sessionId = $sid; message = @{ role = 'assistant'; content = @(@{ type = 'text'; text = '**Progress: about 1% overall. Phase: L-start.**' }) } } | ConvertTo-Json -Compress -Depth 6)
    )
    [IO.File]::WriteAllText($transcript, (($first -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))

    $realHubd = @(Get-Process -Name hubd -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $saved = @{ U = $env:USERPROFILE; L = $env:LOCALAPPDATA }
    $env:USERPROFILE = $home_; $env:LOCALAPPDATA = $lad
    $proc = $null; $daemonStarted = $false
    try {
        # Refuse to continue if the temp env does not isolate us from the real data dir.
        $realLad = $saved.L
        if ($lad -eq $realLad -or -not $lad.StartsWith($env:TEMP)) { throw 'temp env not applied' }
        Write-SessionFile 0
        & $hub daemon start | Out-Null
        $daemonStarted = $true
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do { Start-Sleep -Milliseconds 300; $st = (& $hub daemon status) } while ($LASTEXITCODE -ne 0 -and [DateTime]::UtcNow -lt $deadline)
        if ($LASTEXITCODE -ne 0) { throw "temp daemon did not start: $st" }
        $tempDaemonPid = [int](($st -join ' ') -replace '.*pid=(\d+).*', '$1')
        if ($realHubd -contains $tempDaemonPid) { throw 'temp daemon pid equals a daemon that was running before' }

        $psi = New-Object Diagnostics.ProcessStartInfo $hub, 'bridge'
        $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
        $proc = [Diagnostics.Process]::Start($psi)
        $null = $proc.StandardError.ReadToEndAsync()

        function Read-Snapshot([string]$needle, [int]$timeoutMs) {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
                if ($null -eq $script:readTask) { $script:readTask = $proc.StandardOutput.ReadLineAsync() }
                if (-not $script:readTask.Wait([Math]::Max(1, $timeoutMs - [int]$sw.ElapsedMilliseconds))) { return $false }
                $line = $script:readTask.Result; $script:readTask = $null
                if ($null -eq $line) { throw 'bridge closed stdout' }
                if ($line.Contains('"type":"snapshot"') -and $line.Contains($needle)) { return $true }
            }
            return $false
        }
        if (-not (Read-Snapshot 'L-start' 30000)) { throw 'bridge never showed the fixture session (L-start)' }

        if ($SnapshotSeconds -gt 0) {
            # Snapshot rate with nothing written: the stream should be the 15 s heartbeat only.
            $count = 0; $total = 0; $lastNorm = $null; $sw = [Diagnostics.Stopwatch]::StartNew(); $task = $null
            while ($sw.Elapsed.TotalSeconds -lt $SnapshotSeconds) {
                if ($null -eq $task) { $task = $proc.StandardOutput.ReadLineAsync() }
                $left = [int](($SnapshotSeconds - $sw.Elapsed.TotalSeconds) * 1000)
                if ($left -le 0 -or -not $task.Wait($left)) { break }
                $line = $task.Result; $task = $null
                if ($null -eq $line) { throw 'bridge closed stdout' }
                if ($line.Contains('"type":"snapshot"')) {
                    $total++
                    $norm = $line -replace '"seq":\d+,?', ''
                    if ($null -ne $lastNorm -and $norm -ne $lastNorm) { $count++ }   # the first snapshot is the baseline
                    $lastNorm = $norm
                }
            }
            $results['snapshotRate'] = [ordered]@{ seconds = $SnapshotSeconds; snapshotsTotal = $total; changedSnapshots = $count; expectedChanged = 0 }
            Save-Results
            Write-Host "snapshots in ${SnapshotSeconds}s with no writes: $total total, $count changed"
            return
        }
        $ms = New-Object System.Collections.Generic.List[double]
        for ($i = 1; $i -le $Runs; $i++) {
            $marker = "L$i-" + [guid]::NewGuid().ToString('N').Substring(0, 6)
            $rec = @{ type = 'assistant'; isSidechain = $false; uuid = "a-$i"; timestamp = [DateTime]::UtcNow.ToString('o'); cwd = 'C:\fixture'; sessionId = $sid; message = @{ role = 'assistant'; content = @(@{ type = 'text'; text = "**Progress: about $([Math]::Min(99, $i + 1))% overall. Phase: $marker.**" }) } } | ConvertTo-Json -Compress -Depth 6
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $fs = [IO.File]::Open($transcript, 'Append', 'Write', 'ReadWrite')
            $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($rec + "`n")
            $fs.Write($bytes, 0, $bytes.Length); $fs.Dispose()
            Write-SessionFile $i
            if (-not (Read-Snapshot $marker 15000)) { throw "run $i : no snapshot with $marker within 15 s" }
            $ms.Add($sw.Elapsed.TotalMilliseconds)
            Start-Sleep -Milliseconds 1500   # let the bridge and daemon settle between runs
        }
        $sorted = [double[]]($ms | Sort-Object)
        $p50 = Get-Percentile $sorted 0.5; $p95 = Get-Percentile $sorted 0.95
        $results['latency'] = [ordered]@{
            runs = $Runs; samplesMs = @($ms | ForEach-Object { [Math]::Round($_) })
            minMs = [Math]::Round($sorted[0]); p50Ms = [Math]::Round($p50); p95Ms = [Math]::Round($p95); maxMs = [Math]::Round($sorted[-1])
            targetP95Ms = 2000; pass = ($p95 -le 2000)
        }
        Save-Results
        Write-Host ("latency: p50 {0} ms, p95 {1} ms, max {2} ms -> {3}" -f [Math]::Round($p50), [Math]::Round($p95), [Math]::Round($sorted[-1]), $(if ($p95 -le 2000) { 'PASS' } else { 'FAIL' }))
    }
    finally {
        if ($proc -and -not $proc.HasExited) {
            try { $proc.StandardInput.Close() } catch { }
            if (-not $proc.WaitForExit(5000)) { $proc.Kill() }
        }
        if ($daemonStarted) { & $hub daemon stop | Out-Null }   # still under the temp env
        $env:USERPROFILE = $saved.U; $env:LOCALAPPDATA = $saved.L
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

function Invoke-Idle {
    $pidFile = Join-Path $env:LOCALAPPDATA 'SessionHub\run\tray.pid'
    $trayPid = [int](Get-Content $pidFile -Raw).Trim()
    $tray = Get-Process -Id $trayPid
    if ($tray.ProcessName -ne 'SessionHubTray') { throw "tray.pid names $($tray.ProcessName)" }
    $bridgeIds = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$trayPid" | Where-Object { $_.Name -eq 'hub.exe' } | ForEach-Object { $_.ProcessId })
    if ($bridgeIds.Count -ne 1) { throw "expected one bridge child, found $($bridgeIds.Count)" }
    $bridgePid = $bridgeIds[0]
    $daemon = @(Get-Process -Name hubd -ErrorAction SilentlyContinue)
    $daemonPid = if ($daemon.Count -eq 1) { $daemon[0].Id } else { 0 }
    $cores = [Environment]::ProcessorCount
    $targets = [ordered]@{ tray = $trayPid; bridge = $bridgePid }
    if ($daemonPid) { $targets['daemon'] = $daemonPid }

    $samples = New-Object System.Collections.Generic.List[object]
    $prev = @{}; $prevT = [Diagnostics.Stopwatch]::StartNew()
    foreach ($k in $targets.Keys) { $p = Get-Process -Id $targets[$k]; $prev[$k] = $p.TotalProcessorTime.TotalSeconds }
    $end = [DateTime]::UtcNow.AddSeconds($IdleSeconds)
    $last = $prevT.Elapsed.TotalSeconds
    while ([DateTime]::UtcNow -lt $end) {
        Start-Sleep -Seconds 10
        $t = $prevT.Elapsed.TotalSeconds; $dt = $t - $last; $last = $t
        $row = [ordered]@{ t = [Math]::Round($t) }
        foreach ($k in $targets.Keys) {
            $p = Get-Process -Id $targets[$k]; $p.Refresh()
            $cpu = $p.TotalProcessorTime.TotalSeconds
            $row["$k`Cpu"] = [Math]::Round(100 * ($cpu - $prev[$k]) / $dt, 3)   # % of one core
            $prev[$k] = $cpu
            $row["$k`Ws"] = $p.WorkingSet64; $row["$k`Priv"] = $p.PrivateMemorySize64
        }
        $samples.Add([pscustomobject]$row)
    }
    $n = $samples.Count
    $trayBridgeCpu = @($samples | ForEach-Object { $_.trayCpu + $_.bridgeCpu })
    $sumWs = @($samples | ForEach-Object { $_.trayWs + $_.bridgeWs })
    $sumPriv = @($samples | ForEach-Object { $_.trayPriv + $_.bridgePriv })
    $mean = ($trayBridgeCpu | Measure-Object -Average).Average
    $maxWs = ($sumWs | Measure-Object -Maximum).Maximum
    $maxPriv = ($sumPriv | Measure-Object -Maximum).Maximum
    $out = [ordered]@{
        seconds = $IdleSeconds; samples = $n; cores = $cores
        meanCpuTrayBridgePctOfOneCore = [Math]::Round($mean, 3)
        meanCpuTrayPct = [Math]::Round((($samples | Measure-Object trayCpu -Average).Average), 3)
        meanCpuBridgePct = [Math]::Round((($samples | Measure-Object bridgeCpu -Average).Average), 3)
        maxCpuTrayBridgePct = [Math]::Round((($trayBridgeCpu | Measure-Object -Maximum).Maximum), 3)
        maxWsTrayBridgeMB = [Math]::Round($maxWs / 1MB, 1)
        maxPrivateTrayBridgeMB = [Math]::Round($maxPriv / 1MB, 1)
        maxWsTrayMB = [Math]::Round((($samples | Measure-Object trayWs -Maximum).Maximum) / 1MB, 1)
        maxWsBridgeMB = [Math]::Round((($samples | Measure-Object bridgeWs -Maximum).Maximum) / 1MB, 1)
        targetCpuPct = 0.5; targetRamMB = 150
        passCpu = ($mean -lt 0.5); passRam = (($maxWs / 1MB) -lt 150)
    }
    if ($daemonPid) {
        $out['daemon'] = [ordered]@{
            meanCpuPct = [Math]::Round((($samples | Measure-Object daemonCpu -Average).Average), 3)
            maxWsMB = [Math]::Round((($samples | Measure-Object daemonWs -Maximum).Maximum) / 1MB, 1)
            maxPrivateMB = [Math]::Round((($samples | Measure-Object daemonPriv -Maximum).Maximum) / 1MB, 1)
        }
    }
    $results['idle'] = $out
    $samples | Export-Csv -NoTypeInformation (Join-Path $OutDir 'idle-samples.csv')
    Save-Results
    Write-Host ("idle: mean CPU {0} % (tray+bridge, of one core), max WS {1} MB, max private {2} MB -> CPU {3}, RAM {4}" -f $out.meanCpuTrayBridgePctOfOneCore, $out.maxWsTrayBridgeMB, $out.maxPrivateTrayBridgeMB, $(if ($out.passCpu) { 'PASS' } else { 'FAIL' }), $(if ($out.passRam) { 'PASS' } else { 'FAIL' }))
}

function Invoke-Render {
    $exe = Join-Path $Dist 'SessionHubTray.exe'
    $dir = Join-Path $OutDir 'render'
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    # --render-check never opens the tray's mutex or events, no bridge, no tray icon; windows sit at -32000.
    $p = Start-Process -FilePath $exe -ArgumentList @('--render-check', $dir) -PassThru -Wait -WindowStyle Hidden
    if ($p.ExitCode -ne 0) { throw "render-check exit $($p.ExitCode); see $dir\render-check.txt" }
    $files = @(Get-ChildItem $dir -Filter *.png)
    $results['render'] = [ordered]@{ exitCode = 0; pngCount = $files.Count; dir = $dir }
    Save-Results
    Write-Host "render: $($files.Count) PNGs in $dir"
}

if ($Phase -in 'Latency', 'All') { Invoke-Latency -Runs $Runs }
if ($Phase -eq 'Snapshots') { Invoke-Latency -SnapshotSeconds $SnapshotSeconds }
if ($Phase -in 'Render', 'All') { Invoke-Render }
if ($Phase -in 'Idle', 'All') { Invoke-Idle }
