# Synthetic contract for the release offline dependency handoff.
# Runs only on GitHub-hosted windows-2022 (quality.yml). Never touches D:\beian,
# C:\supply\data, beian-server-8787, scheduled tasks or the Hangzhou runner: every
# path lives under a fresh temp directory and the functions under test are loaded
# from release.ps1 / release-recover.ps1 by AST, without executing either script.
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "Expected Windows PowerShell 5.1 Desktop, got $($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$releasePath = Join-Path $repo "scripts\windows\release.ps1"
$recoveryPath = Join-Path $repo "scripts\windows\release-recover.ps1"

function Import-ScriptFunctions([string]$Path, [string[]]$Names) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw "parse errors in $Path" }
  $definitions = @(
    $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
  )
  $text = New-Object System.Text.StringBuilder
  foreach ($name in $Names) {
    $definition = @($definitions | Where-Object { $_.Name -eq $name }) | Select-Object -First 1
    if (-not $definition) { throw "missing function $name in $Path" }
    [void]$text.AppendLine($definition.Extent.Text)
  }
  return $text.ToString()
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "DEPS_HANDOFF_CONTRACT failed: $Message" }
}

function Assert-Throws([scriptblock]$Body, [string]$Message) {
  $threw = $false
  try { & $Body } catch { $threw = $true }
  Assert-True $threw $Message
}

. ([scriptblock]::Create((Import-ScriptFunctions $releasePath @(
  "Invoke-GitResult", "Assert-GitResult", "Invoke-GitChecked", "Get-GithubAuthHeader",
  "Get-NpmDependencyGraphFingerprint", "Assert-NativeOfflineProbe", "Copy-AtomicFile",
  "Get-ReleaseProcessAncestors", "Write-AtomicReleaseJournal", "Set-ReleaseJournalStage",
  "Test-DataDirInsideRepo",
  "Get-DependencyHandoffPlan", "Test-StagedDependencyHandoffReady", "Invoke-ReleaseDependencyCheck",
  "Get-DependencyTreeMarker", "Get-InstalledPackageDirectory", "Assert-DependencyStagingLocation",
  "Initialize-DependencyStagingRoot", "Test-DependencyReparsePoint", "Remove-DependencyReparsePoints",
  "Remove-DependencyTreeSafely", "Get-DependencyArtifactTime", "Remove-StaleDependencyArtifacts",
  "Get-DependencyReparsePointNames", "Set-StagedWorkspaceJunctions", "Get-WorkspaceJunctionTarget",
  "ConvertTo-CmdArgument", "Stop-ProcessTree", "Invoke-BoundedProcess", "Export-TargetSourceToStage",
  "Assert-StagedSourceFingerprint", "Invoke-StagedNpmCi", "Invoke-WithOfflineNetworkEnvironment",
  "Write-StagedDependencyStamp", "Assert-NoProcessUsesDependencyTrees", "Invoke-DependencySwap"
))))
$releaseMarker = ${function:Get-DependencyTreeMarker}
. ([scriptblock]::Create((Import-ScriptFunctions $recoveryPath @(
  "JournalProperty", "Assert-PathUnder", "Write-AtomicJournal", "Get-DependencyTreeMarker", "Get-DependencyRestoreAction",
  "Get-VerifiedDependencyRestorePlan", "Move-DependencyTreeAside", "Restore-DependencyBackup"
))))

# --- staged probe ordering (PS 5.1 AST): Hono entry mounts serveStatic(UI_DIST) at import -
$releaseAst = [System.Management.Automation.Language.Parser]::ParseFile($releasePath, [ref]$null, [ref]$null)
$integrityAst = $releaseAst.Find({ param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Assert-StagedOfflineIntegrity" }, $true)
Assert-True ($null -ne $integrityAst) "Assert-StagedOfflineIntegrity missing"
$probeCalls = @($integrityAst.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and
  @("Assert-NativeOfflineProbe", "Assert-IsolatedServerEntryImport") -contains $node.GetCommandName() }, $true) |
  Sort-Object { $_.Extent.StartOffset })
$probeNames = @($probeCalls | ForEach-Object {
  if ($_.GetCommandName() -eq "Assert-IsolatedServerEntryImport") { "entry" } else { [string]$_.CommandElements[1].Value } })
$uiBuildAt = [array]::IndexOf($probeNames, "staged UI build")
$entryAt = [array]::IndexOf($probeNames, "entry")
Assert-True ($uiBuildAt -ge 0 -and $entryAt -gt $uiBuildAt) "staged UI build must run before the Hono entry import ($($probeNames -join ' > '))"
Assert-True ($integrityAst.Extent.Text -notmatch '--outDir') "staged UI build must use the stage's own default dist"

# --- recovery decision table (design §7.2) -------------------------------------
$table = @(
  @($true, $false, $false, $true, "none"),
  @($true, $true, $false, $true, "swap-back"),
  @($false, $true, $false, $true, "restore"),
  @($true, $false, $true, $false, "discard-target"),
  @($false, $false, $true, $false, "clear-marker"),
  @($false, $false, $false, $false, "none"),
  @($false, $false, $false, $true, "lost")
)
foreach ($row in $table) {
  $actual = Get-DependencyRestoreAction $row[0] $row[1] $row[2] $row[3]
  Assert-True ($actual -eq $row[4]) "restore action live=$($row[0]) backup=$($row[1]) marker=$($row[2]) was=$($row[3]) => $actual"
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("beian-deps-contract-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$previousLocation = Get-Location
try {
  $Root = Join-Path $testRoot "beian"
  $DependencyStagingRoot = Join-Path $testRoot "beian-deps"
  $ReleaseRuntimeDir = Join-Path $testRoot "runtime\release"
  $ReleaseJournalPath = Join-Path $ReleaseRuntimeDir "release-journal.json"
  $JournalPath = $ReleaseJournalPath
  $ReleaseDependencyCheckPath = Join-Path $repo "scripts\windows\release-dependency-check.mjs"
  $DependencyStageStampRuntimePath = Join-Path $ReleaseRuntimeDir "deps-stage.json"
  $DependencyStageProtocol = "beian.deps-stage.v1"
  $DependencySetRelativePaths = @("apps\web\server\node_modules", "apps\web\ui\node_modules", "node_modules")
  $DependencyAllowedRelativePaths = @("apps/web/server/node_modules", "apps/web/ui/node_modules", "node_modules")
  $DependencyWorkspaceLinks = [ordered]@{ "beian-ui" = "apps\web\ui"; "beian-server" = "apps\web\server" }
  $DependencyNpmCiTimeoutSeconds = 600
  $DependencyBackupGenerationsKept = 1
  $ReleaseProcessPid = [int]$PID
  $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  New-Item -ItemType Directory -Force -Path $Root, $ReleaseRuntimeDir | Out-Null

  # --- junction-safe deletion -----------------------------------------------------
  New-Item -ItemType Directory -Force -Path $DependencyStagingRoot | Out-Null
  $sentinelDir = Join-Path $testRoot "sentinel"
  New-Item -ItemType Directory -Force -Path $sentinelDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $sentinelDir "keep.txt"), "keep")
  $doomed = Join-Path $DependencyStagingRoot "stage-000000000000\node_modules"
  New-Item -ItemType Directory -Force -Path $doomed | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $doomed "beian-ui") -Target $sentinelDir | Out-Null
  Remove-DependencyTreeSafely (Join-Path $DependencyStagingRoot "stage-000000000000")
  Assert-True (Test-Path -LiteralPath (Join-Path $sentinelDir "keep.txt")) "recursive delete followed a junction"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $DependencyStagingRoot "stage-000000000000"))) "stage dir not removed"
  Assert-Throws { Remove-DependencyTreeSafely $sentinelDir } "delete outside the staging root must be refused"

  # --- retention: exactly one previous generation ---------------------------------
  foreach ($name in @(
    "backup-111111111111-20260101T000000Z", "backup-222222222222-20260301T000000Z", "backup-000000000000-20260201T000000Z",
    "failed-333333333333-20260101T000000Z", "failed-444444444444-20260102T000000Z",
    "stage-aaaaaaaaaaaa", "work-aaaaaaaaaaaa", "stage-bbbbbbbbbbbb", "work-bbbbbbbbbbbb", "operator-notes"
  )) {
    New-Item -ItemType Directory -Force -Path (Join-Path $DependencyStagingRoot $name) | Out-Null
  }
  Remove-StaleDependencyArtifacts "aaaaaaaaaaaa"
  $left = @(Get-ChildItem -LiteralPath $DependencyStagingRoot -Directory | ForEach-Object { $_.Name } | Sort-Object)
  $expected = @("backup-222222222222-20260301T000000Z", "failed-444444444444-20260102T000000Z", "operator-notes", "stage-aaaaaaaaaaaa", "work-aaaaaaaaaaaa")
  Assert-True (($left -join ",") -eq ($expected -join ",")) "retention left $($left -join ',')"
  foreach ($name in $left) { Remove-DependencyTreeSafely (Join-Path $DependencyStagingRoot $name) }

  # --- bounded process kills its tree on timeout ------------------------------------
  $ping = Join-Path $env:SystemRoot "System32\PING.EXE"
  $timeoutLog = Join-Path $testRoot "timeout.log"
  $started = [DateTime]::UtcNow
  Assert-Throws { Invoke-BoundedProcess "timeout probe" $ping @("-n", "30", "127.0.0.1") $testRoot $timeoutLog 2 } "bounded process must time out"
  Assert-True (([DateTime]::UtcNow - $started).TotalSeconds -lt 20) "timeout did not stop the process tree promptly"

  # --- synthetic workspace repo with an old and a target dependency graph -----------
  Set-Location $Root
  $env:GIT_OPTIONAL_LOCKS = "0"
  & git init -q -b main . | Out-Null
  & git config user.email "contract@example.invalid"
  & git config user.name "contract"
  New-Item -ItemType Directory -Force -Path (Join-Path $Root "apps\web\ui"), (Join-Path $Root "apps\web\server") | Out-Null
  function Write-Manifests([string]$IsNumberVersion) {
    [System.IO.File]::WriteAllText((Join-Path $Root "package.json"), '{"name":"beian","private":true,"version":"0.0.1","workspaces":["apps/web/ui","apps/web/server"]}', $Utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $Root "apps\web\ui\package.json"), '{"name":"beian-ui","private":true,"version":"0.1.0"}', $Utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $Root "apps\web\server\package.json"), ('{"name":"beian-server","private":true,"version":"0.1.0","dependencies":{"is-number":"' + $IsNumberVersion + '"}}'), $Utf8NoBom)
  }
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Write-Manifests "6.0.0"
  & $npm install --no-audit --no-fund --silent
  if ($LASTEXITCODE -ne 0) { throw "npm install old graph failed" }
  [System.IO.File]::WriteAllText((Join-Path $Root ".gitignore"), "node_modules/`n", $Utf8NoBom)
  & git add -A
  & git commit -q -m old
  $preSha = (& git rev-parse HEAD).Trim()
  Write-Manifests "7.0.0"
  & $npm install --package-lock-only --no-audit --no-fund --silent
  if ($LASTEXITCODE -ne 0) { throw "npm lock target graph failed" }
  & git add -A
  & git commit -q -m target
  $TargetSha = (& git rev-parse HEAD).Trim()
  & git checkout -q $preSha -- .
  Assert-True (Test-DependencyReparsePoint (Join-Path $Root "node_modules\beian-server")) "npm must link workspaces as junctions on Windows"

  # --- stage: archive export, npm ci, junction repoint, offline graph proof ---------
  $plan = Get-DependencyHandoffPlan $preSha $TargetSha
  Assert-True ($plan.Mode -eq "npm-staged") "fingerprint must detect the dependency change"
  Assert-DependencyStagingLocation
  Initialize-DependencyStagingRoot
  $plan.StagingRoot = $DependencyStagingRoot
  $plan.StageSource = Join-Path $DependencyStagingRoot ("stage-" + $TargetSha.Substring(0, 12))
  $plan.StageWork = Join-Path $DependencyStagingRoot ("work-" + $TargetSha.Substring(0, 12))
  $plan.BackupDir = Join-Path $DependencyStagingRoot ("backup-" + $preSha.Substring(0, 12) + "-20260101T000000Z")
  $plan.FailedDir = Join-Path $DependencyStagingRoot ("failed-" + $TargetSha.Substring(0, 12) + "-20260101T000000Z")
  New-Item -ItemType Directory -Force -Path $plan.StageWork, (Join-Path $plan.StageWork "logs") | Out-Null
  Export-TargetSourceToStage $plan
  Invoke-StagedNpmCi $plan
  Set-StagedWorkspaceJunctions $plan.StageSource $plan.StageSource
  $emptyCache = Join-Path $plan.StageWork "offline-cache"
  New-Item -ItemType Directory -Force -Path $emptyCache | Out-Null
  Invoke-WithOfflineNetworkEnvironment $emptyCache {
    $installed = Invoke-ReleaseDependencyCheck "staged installed graph" @("installed", $plan.StageSource, $Root, $TargetSha)
    Assert-True ($installed -eq $plan.ToFingerprint) "staged installed graph must equal the target fingerprint"
    Assert-NativeOfflineProbe "staged npm ls" $npm @("ls", "--all", "--offline", "--ignore-scripts", "--silent") $plan.StageSource
    Assert-True ($env:npm_config_offline -eq "true") "offline environment not applied"
  }
  Assert-True (-not $env:npm_config_offline) "offline environment leaked after the probe"
  Assert-Throws { Invoke-ReleaseDependencyCheck "old tree vs target" @("installed", $Root, $Root, $TargetSha) } "installed check must reject the old graph"
  Set-StagedWorkspaceJunctions $plan.StageSource $Root
  Assert-True ((Get-WorkspaceJunctionTarget (Join-Path $plan.StageSource "node_modules\beian-ui")).TrimEnd('\') -eq (Join-Path $Root "apps\web\ui")) "junction must point at the checkout"
  foreach ($relative in $DependencySetRelativePaths) {
    $plan.OldPresence[$relative.Replace('\', '/')] = if ([System.IO.Directory]::Exists((Join-Path $Root $relative))) { "present" } else { "absent" }
  }
  $plan.OldTreeMarker = & $releaseMarker $Root
  Write-StagedDependencyStamp $plan
  $plan.Verified = $true
  $DependencyHandoff = $plan

  function New-ContractJournal {
    $script:ReleaseJournalState = [ordered]@{
      protocol = "beian.release-recovery.v1"
      stage = "merged"
      updated_at = [DateTime]::UtcNow.ToString("o")
      dependency_mutated = $false
      deps_mode = $plan.Mode
      deps_root = $plan.StagingRoot
      deps_backup_path = $plan.BackupDir
      deps_failed_path = $plan.FailedDir
      deps_set = @($DependencyAllowedRelativePaths)
      deps_old_presence = $plan.OldPresence
      deps_old_tree_marker = $plan.OldTreeMarker
      deps_swap_progress = [ordered]@{}
    }
    Write-AtomicReleaseJournal
  }

  # --- swap blocked by an open handle: the rename fails, recovery restores ----------
  New-ContractJournal
  $held = [System.IO.FileStream]::new((Join-Path $Root "node_modules\is-number\package.json"), "Open", "Read", "None")
  try {
    Assert-Throws { Invoke-DependencySwap $plan } "swap must fail while a node_modules file is held open"
  } finally {
    $held.Dispose()
  }
  $journal = [System.IO.File]::ReadAllText($JournalPath, $Utf8NoBom) | ConvertFrom-Json
  Assert-True ([bool]$journal.dependency_mutated) "dependency_mutated must be journaled before the first rename"
  $restorePlan = Get-VerifiedDependencyRestorePlan $journal $Root
  Restore-DependencyBackup $restorePlan $journal $Root
  $oldVersion = ([System.IO.File]::ReadAllText((Join-Path $Root "node_modules\is-number\package.json")) | ConvertFrom-Json).version
  Assert-True ($oldVersion -eq "6.0.0") "partial swap recovery must keep the old tree (got $oldVersion)"

  # --- full swap, then recovery swaps back idempotently -----------------------------
  New-ContractJournal
  Invoke-DependencySwap $plan
  $live = Invoke-ReleaseDependencyCheck "live installed graph" @("installed", $Root, $Root, $TargetSha)
  Assert-True ($live -eq $plan.ToFingerprint) "live tree must match the target after swap"
  Assert-True ((Get-WorkspaceJunctionTarget (Join-Path $Root "node_modules\beian-server")).TrimEnd('\') -eq (Join-Path $Root "apps\web\server")) "swapped junction target"
  $newVersion = ([System.IO.File]::ReadAllText((Join-Path $Root "node_modules\is-number\package.json")) | ConvertFrom-Json).version
  Assert-True ($newVersion -eq "7.0.0") "swapped tree must be the target (got $newVersion)"
  $journal = [System.IO.File]::ReadAllText($JournalPath, $Utf8NoBom) | ConvertFrom-Json
  Assert-True ($journal.stage -eq "deps_swapped") "journal stage after swap"
  $restorePlan = Get-VerifiedDependencyRestorePlan $journal $Root
  Restore-DependencyBackup $restorePlan $journal $Root
  Restore-DependencyBackup $restorePlan $journal $Root
  $rolledBack = ([System.IO.File]::ReadAllText((Join-Path $Root "node_modules\is-number\package.json")) | ConvertFrom-Json).version
  Assert-True ($rolledBack -eq "6.0.0") "recovery must restore the old tree (got $rolledBack)"
  Assert-True ([System.IO.Directory]::Exists((Join-Path $plan.FailedDir "node_modules"))) "target tree must be kept aside for diagnosis"
  Assert-True ((& $releaseMarker $Root) -eq $plan.OldTreeMarker) "restored tree marker"

  $journal.deps_root = Join-Path $testRoot "elsewhere"
  Assert-Throws { Get-VerifiedDependencyRestorePlan $journal $Root } "recovery must refuse an untrusted dependency root"

  Write-Host "DEPS_HANDOFF_CONTRACT ok"
} finally {
  Set-Location $previousLocation
  if (Test-Path -LiteralPath $testRoot) {
    Get-ChildItem -LiteralPath $testRoot -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue |
      ForEach-Object { [System.IO.Directory]::Delete($_.FullName, $false) }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
