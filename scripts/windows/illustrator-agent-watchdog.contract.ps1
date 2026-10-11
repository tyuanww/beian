# Windows PowerShell 5.1 contract for the Illustrator save watchdog and the
# windowless-zombie path. Pure: never starts, inspects, or ends a real process.
Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$agentPath = Join-Path $PSScriptRoot "illustrator-agent.ps1"
$source = [System.IO.File]::ReadAllText($agentPath)
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -ne 0) { throw "illustrator-agent.ps1 did not parse cleanly" }

$wanted = @(
  "Get-JsonProperty", "Test-KillForbiddenStage", "Get-JobOutputSnapshot", "Update-SaveWatch",
  "Select-IdentityMatch", "Select-JobIllustratorIdentity", "Select-WindowlessZombies",
  "Stop-IdentifiedIllustrator", "Remove-JobPartialOutputs", "Get-RestartBudget", "Register-WatchdogRestart"
)
$functions = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) |
  Where-Object { $wanted -contains $_.Name })
if ($functions.Count -ne $wanted.Count) { throw ("missing watchdog functions: " + ($wanted -join ",")) }
$constants = @("UnattendedKillForbiddenStages", "UnattendedSavingStallMs", "SaveWatchStages", "ZombieWindowGraceMs", "WatchdogRestartCap", "WatchdogRestartWindowMs")
$assignments = @($ast.EndBlock.Statements | Where-Object {
  $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and
  $constants -contains $_.Left.VariablePath.UserPath
})
if ($assignments.Count -ne $constants.Count) { throw "missing watchdog constants" }
foreach ($statement in $assignments) { . ([ScriptBlock]::Create($statement.Extent.Text)) }
foreach ($function in $functions) { . ([ScriptBlock]::Create($function.Extent.Text)) }

if ($UnattendedSavingStallMs -ne 300000) { throw "save stall limit must stay 300000 ms (evidence in PR)" }

function Throw-AgentFailure([string]$Code, [string]$Message, [object]$Details = $null) {
  $failure = [System.InvalidOperationException]::new($Message)
  $failure.Data["AgentCode"] = $Code
  throw $failure
}
$script:logged = @()
function Write-AgentLog([string]$Event, [string]$RequestId = "", [string]$Code = "", [object]$Details = $null) { $script:logged += $Event }
$script:stopped = @()
function Stop-Process { param([int]$Id, [switch]$Force, $ErrorAction) $script:stopped += $Id; $script:fake = @($script:fake | Where-Object { $_.pid -ne $Id }) }
function Get-SessionIllustratorProcesses([string]$Executable) { return @($script:fake) }
function Start-Sleep { param([int]$Milliseconds) }

function New-Fake([int]$ProcessId, [string]$Started, [int64]$Window = 100, [bool]$Matches = $true, [int]$Visible = -2) {
  if ($Visible -eq -2) { $Visible = $(if ($Window -ne 0) { 1 } else { 0 }) }
  return [PSCustomObject]@{ pid = $ProcessId; start_time_utc = $Started; session_id = 1; matches_executable = $Matches; window_handle = $Window; visible_windows = $Visible; path = "C:\Illustrator.exe" }
}
function Write-Utf8File([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text) }

# 1. Stuck save: identical files + progress for 300 s triggers, 299 s does not.
$t0 = [DateTime]::Parse("2026-10-10T12:00:00Z").ToUniversalTime()
$watch = @{}
if (Update-SaveWatch $watch "saving_artwork_pdf" "p1" "print.pdf:0:1" $t0) { throw "first observation must not stall" }
if (Update-SaveWatch $watch "saving_artwork_pdf" "p1" "print.pdf:0:1" $t0.AddSeconds(299)) { throw "299 s must not stall" }
if (-not (Update-SaveWatch $watch "saving_artwork_pdf" "p1" "print.pdf:0:1" $t0.AddSeconds(300))) { throw "stuck save was not detected" }

# 2. Slow but growing save over 2 h: never stalls while print.pdf grows.
$dir = Join-Path ([System.IO.Path]::GetTempPath()) ("aiwd-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $dir | Out-Null
try {
  $partial = Join-Path $dir "print.pdf"
  $watch = @{}
  for ($minute = 0; $minute -le 120; $minute += 4) {
    [System.IO.File]::AppendAllText($partial, ("x" * 10))
    if (Update-SaveWatch $watch "saving_full_pdf" "p1" (Get-JobOutputSnapshot $dir) $t0.AddMinutes($minute)) { throw "growing save was treated as stalled" }
  }
  # Progress updates alone also count as progress.
  $watch = @{}
  $snap = Get-JobOutputSnapshot $dir
  for ($minute = 0; $minute -le 60; $minute += 4) {
    if (Update-SaveWatch $watch "saving_full_pdf" ("p" + $minute) $snap $t0.AddMinutes($minute)) { throw "progress update was treated as stalled" }
  }
  # Non-save stages never use the save watchdog.
  $watch = @{}
  if (Update-SaveWatch $watch "writing_result" "p" $snap $t0) { throw "writing_result watched" }
  if (Update-SaveWatch $watch "writing_result" "p" $snap $t0.AddHours(3)) { throw "writing_result stalled" }

  # Cleanup deletes only this job's outputs inside the job directory.
  $outside = Join-Path ([System.IO.Path]::GetTempPath()) ("aiwd-out-" + [Guid]::NewGuid().ToString("N") + ".pdf")
  [System.IO.File]::WriteAllText($outside, "keep")
  [System.IO.File]::WriteAllText((Join-Path $dir "source.pdf"), "keep")
  $config = [PSCustomObject]@{ print_pdf = $partial; full_pdf = $outside; result_json = (Join-Path $dir "result.json") }
  $removed = @(Remove-JobPartialOutputs $config $dir)
  if ($removed.Count -ne 1 -or $removed[0] -ne "print.pdf") { throw ("unexpected cleanup: " + ($removed -join ",")) }
  if (-not (Test-Path -LiteralPath $outside)) { throw "cleanup deleted a file outside the job dir" }
  if (-not (Test-Path -LiteralPath (Join-Path $dir "source.pdf"))) { throw "cleanup deleted the source copy" }
  Remove-Item -LiteralPath $outside -Force
} finally {
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}

# 3. Identity: only exact pid + start time is eligible; others are never ended.
$started = "2026-10-10T11:00:00.0000000Z"
$expected = [ordered]@{ pid = 15628; start_time_utc = $started }
if ($null -eq (Select-IdentityMatch @(New-Fake 15628 $started) $expected)) { throw "exact identity not matched" }
if ($null -ne (Select-IdentityMatch @(New-Fake 15628 "2026-10-10T11:00:01.0000000Z") $expected)) { throw "reused pid matched" }
if ($null -ne (Select-IdentityMatch @(New-Fake 4040 $started) $expected)) { throw "other pid matched" }
if ($null -ne (Select-IdentityMatch @(New-Fake 15628 $started 100 $false) $expected)) { throw "foreign executable matched" }
if ($null -ne (Select-IdentityMatch @(New-Fake 15628 $started) $null)) { throw "unknown identity matched" }
if ($null -ne (Select-JobIllustratorIdentity @((New-Fake 1 $started), (New-Fake 2 $started)))) { throw "ambiguous job identity accepted" }

$script:fake = @(New-Fake 15628 "2026-10-10T11:30:00.0000000Z")
$script:stopped = @()
$threw = $false
try { Stop-IdentifiedIllustrator "C:\Illustrator.exe" $expected "illustrator_save_timeout" | Out-Null } catch { $threw = ([string]$_.Exception.Data["AgentCode"] -eq "illustrator_recovery_failed") }
if (-not $threw -or $script:stopped.Count -ne 0) { throw "wrong-identity process was ended" }

$script:fake = @((New-Fake 15628 $started), (New-Fake 4040 "2026-10-10T13:00:00.0000000Z"))
$script:stopped = @()
if ((Stop-IdentifiedIllustrator "C:\Illustrator.exe" $expected "illustrator_save_timeout") -ne "ended") { throw "matching process was not ended" }
if (($script:stopped -join ",") -ne "15628") { throw ("ended unexpected pids: " + ($script:stopped -join ",")) }

# 4. Windowless zombie: only matching processes windowless beyond the grace.
$now = [DateTime]::Parse("2026-10-10T14:00:00Z").ToUniversalTime()
$old = $now.AddMinutes(-10).ToString("o")
$young = $now.AddSeconds(-30).ToString("o")
if (@(Select-WindowlessZombies @(New-Fake 4040 $old 0) $now).Count -ne 1) { throw "old windowless process not detected" }
if (@(Select-WindowlessZombies @(New-Fake 4040 $young 0) $now).Count -ne 0) { throw "starting Illustrator treated as zombie" }
if (@(Select-WindowlessZombies @(New-Fake 4040 $old 100) $now).Count -ne 0) { throw "windowed Illustrator treated as zombie" }
if (@(Select-WindowlessZombies @(New-Fake 4040 $old 0 $false) $now).Count -ne 0) { throw "foreign executable treated as zombie" }
if (@(Select-WindowlessZombies @(New-Fake 4040 "" 0) $now).Count -ne 0) { throw "unknown start time treated as zombie" }

# 5. Loading / sign-in / license dialog: MainWindowHandle=0 but a visible
# top-level window exists, or window enumeration failed (-1) => never a zombie.
if (@(Select-WindowlessZombies @(New-Fake 4040 $old 0 $true 1) $now).Count -ne 0) { throw "dialog-only Illustrator treated as zombie" }
if (@(Select-WindowlessZombies @(New-Fake 4040 $old 0 $true -1) $now).Count -ne 0) { throw "unknown window state treated as zombie" }

# 6. Restart cap: 2 per rolling hour, persisted across agent restarts.
if ($WatchdogRestartCap -ne 2 -or $WatchdogRestartWindowMs -ne 3600000) { throw "restart cap must stay 2 per hour" }
$b = Get-RestartBudget @($now.AddMinutes(-50).ToString("o"), $now.AddMinutes(-10).ToString("o")) $now
if ($b.allowed) { throw "third restart within an hour allowed" }
$b = Get-RestartBudget @($now.AddMinutes(-61).ToString("o"), $now.AddMinutes(-10).ToString("o")) $now
if (-not $b.allowed -or @($b.history).Count -ne 1) { throw "expired restart not pruned" }
$b = Get-RestartBudget @("garbage", "garbage") $now
if ($b.allowed) { throw "unparseable history must fail closed" }
$RuntimeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("aiwd-rt-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
try {
  Register-WatchdogRestart "illustrator_no_window"
  Register-WatchdogRestart "illustrator_no_window"   # a fresh agent re-reads the same file
  $capped = $false
  try { Register-WatchdogRestart "illustrator_no_window" } catch { $capped = ([string]$_.Exception.Data["AgentCode"] -eq "illustrator_recovery_failed") }
  if (-not $capped) { throw "restart cap not enforced from persisted history" }
  [System.IO.File]::WriteAllText((Join-Path $RuntimeDir "watchdog-restarts.json"), "{not json")
  $capped = $false
  try { Register-WatchdogRestart "illustrator_no_window" } catch { $capped = $true }
  if (-not $capped) { throw "corrupt restart history must fail closed" }
} finally {
  Remove-Item -LiteralPath $RuntimeDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "illustrator-agent watchdog contract ok"
