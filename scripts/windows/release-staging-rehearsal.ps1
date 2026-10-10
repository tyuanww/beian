# End-to-end rehearsal of the WHOLE pre-stop offline dependency staging path.
# Runs only on GitHub-hosted windows-2022 (quality.yml). Never touches D:\beian,
# C:\supply\data, beian-server-8787, scheduled tasks or the Hangzhou runner.
# It clones the checked-out repository into a fresh temp directory, loads every
# function and the $Dependency* configuration from the real release.ps1 by AST
# (nothing in release.ps1's main body executes), and calls the real
# Get-DependencyHandoffPlan + Prepare-StagedDependencies for a real graph change:
# base = eb2ceb8 (0.30.3.3, no sharp) -> target = the checked-out commit.
param([string]$BaseSha = "eb2ceb86eb698d16ae8e532e885fdc19fadbbd48")
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "Expected Windows PowerShell 5.1 Desktop, got $($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
}
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$releasePath = Join-Path $workspace "scripts\windows\release.ps1"
$rehearsalRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("beian-staging-rehearsal-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
foreach ($forbidden in @("D:\beian", "C:\supply")) {
  if ($rehearsalRoot.StartsWith($forbidden, [StringComparison]::OrdinalIgnoreCase)) { throw "rehearsal must not run under $forbidden" }
}

function Assert-Rehearsal([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "STAGING_REHEARSAL failed: $Message" }
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($releasePath, [ref]$tokens, [ref]$errors)
Assert-Rehearsal ($errors.Count -eq 0) "release.ps1 does not parse"
$functionText = New-Object System.Text.StringBuilder
foreach ($definition in @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false))) {
  [void]$functionText.AppendLine($definition.Extent.Text)
}
$configText = New-Object System.Text.StringBuilder
foreach ($statement in @($ast.EndBlock.Statements)) {
  if ($statement -is [System.Management.Automation.Language.AssignmentStatementAst] -and
      $statement.Left.Extent.Text -match '^\$(RootParent|Dependency\w+|Utf8NoBom)$') {
    [void]$configText.AppendLine($statement.Extent.Text)
  }
}

$previousLocation = Get-Location
$savedToken = $env:GITHUB_TOKEN
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
try {
  New-Item -ItemType Directory -Force -Path $rehearsalRoot | Out-Null
  $Root = Join-Path $rehearsalRoot "beian"
  $ReleaseRuntimeDir = Join-Path $rehearsalRoot "runtime\release"
  $ReleaseDependencyCheckPath = Join-Path $ReleaseRuntimeDir "release-dependency-check.mjs"
  $ReleaseProcessPid = [int]$PID
  $env:GIT_OPTIONAL_LOCKS = "0"
  & git clone -q --no-hardlinks $workspace $Root
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
  Set-Location $Root
  $TargetSha = (& git rev-parse HEAD).Trim()
  & git cat-file -e "$BaseSha^{commit}"
  if ($LASTEXITCODE -ne 0) { throw "base $BaseSha missing; checkout needs fetch-depth: 0" }
  & git checkout -q --detach $BaseSha
  New-Item -ItemType Directory -Force -Path $ReleaseRuntimeDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $workspace "scripts\windows\release-dependency-check.mjs") -Destination $ReleaseDependencyCheckPath

  . ([scriptblock]::Create($functionText.ToString()))
  . ([scriptblock]::Create($configText.ToString()))
  Assert-Rehearsal ($DependencyStagingRoot -eq (Join-Path $rehearsalRoot "beian-deps")) "staging root must be the temp sibling, got $DependencyStagingRoot"

  $DependencyHandoff = Get-DependencyHandoffPlan $BaseSha $TargetSha
  Assert-Rehearsal ($DependencyHandoff.Mode -eq "npm-staged") "base -> target must be a real npm graph change"
  $started = [DateTime]::UtcNow
  Prepare-StagedDependencies $DependencyHandoff $BaseSha
  Write-Host "staging rehearsal took $([int]([DateTime]::UtcNow - $started).TotalSeconds)s"

  Assert-Rehearsal (Test-StagedDependencyHandoffReady $DependencyHandoff.FromFingerprint $DependencyHandoff.ToFingerprint) "stage not marked verified"
  Assert-Rehearsal (Test-Path -LiteralPath (Join-Path $DependencyHandoff.StageSource "apps\web\ui\dist\index.html")) "stage UI dist missing"
  Assert-Rehearsal (-not (Test-Path -LiteralPath (Join-Path $Root "apps\web\ui\dist"))) "staging leaked a UI dist into the checkout"
  Assert-Rehearsal (-not (Test-Path -LiteralPath (Join-Path $Root "node_modules"))) "staging touched the checkout node_modules"
  Assert-Rehearsal ((& git rev-parse HEAD).Trim() -eq $BaseSha) "staging moved the checkout HEAD"
  Assert-Rehearsal ([string]::IsNullOrEmpty((& git status --porcelain --untracked-files=no) -join "")) "staging dirtied the checkout"
  $link = Get-WorkspaceJunctionTarget (Join-Path $DependencyHandoff.StageSource "node_modules\beian-ui")
  Assert-Rehearsal ($link.TrimEnd('\') -eq (Join-Path $Root "apps\web\ui")) "junction not repointed at the checkout: $link"
  Assert-Rehearsal (Test-Path -LiteralPath $DependencyStageStampRuntimePath) "stage stamp missing"

  # Same-SHA reuse path: no reinstall, every probe reruns.
  $again = Get-DependencyHandoffPlan $BaseSha $TargetSha
  Prepare-StagedDependencies $again $BaseSha
  Assert-Rehearsal ($again.Verified -eq $true) "reused stage did not re-verify"
  Write-Host "STAGING_REHEARSAL ok base=$BaseSha target=$TargetSha npm=$($DependencyHandoff.FromFingerprint)->$($DependencyHandoff.ToFingerprint)"
} finally {
  Set-Location $previousLocation
  if ($savedToken) { $env:GITHUB_TOKEN = $savedToken }
  if (Test-Path -LiteralPath $rehearsalRoot) {
    Get-ChildItem -LiteralPath $rehearsalRoot -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue |
      ForEach-Object { [System.IO.Directory]::Delete($_.FullName, $false) }
    Remove-Item -LiteralPath $rehearsalRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
