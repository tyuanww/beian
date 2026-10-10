# Hangzhou production CD. Git hygiene while :8787 is up; refuse to stop if dirty/ahead; otherwise stop, then merge/build/start.
# Encoding: UTF-8 with BOM so Windows PowerShell 5 (GBK) can parse this file.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\release.ps1
# -Restart is accepted and ignored: live pull-while-serving is gone (emptyOutDir 404).
# Does not touch cloudflared or kill processes by PID. 8787 starts/stops only through WinSW.
# Discard npm-dirty package-lock.json and refuse other tracked edits BEFORE stopping.
# A SYSTEM watchdog owns rollback if this PowerShell/Actions process disappears after stop.

param(
  [string]$RepositoryRoot = "",
  [string]$ReleaseSourceDir = "",
  [string]$TargetSha = "",
  [switch]$Restart,
  [switch]$AllowLegacyOfflineBootstrap
)

$ErrorActionPreference = "Stop"
$Root = if ($RepositoryRoot) {
  [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\', '/')
} else {
  (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}
if (-not (Test-Path -LiteralPath (Join-Path $Root ".git") -PathType Container)) {
  throw "RepositoryRoot 不是 Git checkout：$Root"
}
$ReleaseSourceDir = if ($ReleaseSourceDir) {
  [System.IO.Path]::GetFullPath($ReleaseSourceDir).TrimEnd('\', '/')
} else {
  Join-Path $Root "scripts\windows"
}
Set-Location $Root
$env:GIT_OPTIONAL_LOCKS = "0"
$env:WB_DATA_DIR = if ($env:WB_DATA_DIR) { $env:WB_DATA_DIR } else { "C:\supply\data" }
$env:NO_PROXY = "127.0.0.1,localhost"
if ($env:no_proxy) { $env:no_proxy = $env:NO_PROXY }
$ReleaseRecoveryProtocol = "beian.release-recovery.v1"
$ReleaseWatchdogTask = "beian-release-watchdog"
$DataRuntimeDir = Join-Path $env:WB_DATA_DIR "runtime"
$ReleaseRuntimeDir = Join-Path $DataRuntimeDir "release"
$ReleaseJournalPath = Join-Path $ReleaseRuntimeDir "release-journal.json"
$ReleaseRecoveryPath = Join-Path $ReleaseRuntimeDir "release-recover.ps1"
$ReleaseInstallerPath = Join-Path $ReleaseRuntimeDir "release-agent-installer.ps1"
$ReleaseDependencyCheckPath = Join-Path $ReleaseRuntimeDir "release-dependency-check.mjs"
$ReleaseLockPath = Join-Path $ReleaseRuntimeDir "release.lock"
$ReleaseUiSnapshotDir = Join-Path $ReleaseRuntimeDir "ui-dist-snapshot"
$ReleaseDrainFencePath = Join-Path $DataRuntimeDir "release-drain.json"
$ReleaseProcess = [System.Diagnostics.Process]::GetCurrentProcess()
$ReleaseProcessPid = [int]$ReleaseProcess.Id
$ReleaseProcessStartedAt = $ReleaseProcess.StartTime.ToUniversalTime().ToString("o")
$ReleaseProcessStartFileTimeUtc = $ReleaseProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
$ReleaseLockStream = $null
$ReleaseJournalState = $null
$ReleaseUiSnapshotSha256 = ""
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
# Offline dependency handoff: a same-volume sibling of the checkout (D:\beian -> D:\beian-deps)
# so the staged node_modules can be swapped in with atomic directory renames after stop.
$RootParent = [System.IO.Path]::GetDirectoryName($Root)
$DependencyStagingRoot = if ($RootParent) { Join-Path $RootParent "beian-deps" } else { "" }
$DependencyStageStampRuntimePath = Join-Path $ReleaseRuntimeDir "deps-stage.json"
$DependencyStageProtocol = "beian.deps-stage.v1"
$DependencySetRelativePaths = @("apps\web\server\node_modules", "apps\web\ui\node_modules", "node_modules")
$DependencyWorkspaceLinks = [ordered]@{ "beian-ui" = "apps\web\ui"; "beian-server" = "apps\web\server" }
$DependencyRequiredWindowsNatives = @("@img/sharp-win32-x64", "@rollup/rollup-win32-x64-msvc", "@esbuild/win32-x64")
$DependencyMinimumFreeBytes = [int64]4GB
$DependencyNpmCiTimeoutSeconds = 900
$DependencyBackupGenerationsKept = 1
$DependencyHandoff = $null

function Invoke-GitResult([object[]]$GitArgs) {
  if (-not $GitArgs -or $GitArgs.Count -eq 0) {
    throw "Invoke-GitResult requires at least one Git argument"
  }
  $AuthHeader = Get-GithubAuthHeader
  if ($AuthHeader) {
    $lines = @(& git -c "http.extraheader=$AuthHeader" @GitArgs)
  } else {
    $lines = @(& git @GitArgs)
  }
  # Capture this immediately, before the native output enters any PowerShell
  # pipeline. Windows PowerShell 5 can otherwise report -1 after a downstream
  # cmdlet stops early even though git itself exited successfully.
  $exitCode = $LASTEXITCODE
  if ($null -eq $exitCode) { $exitCode = -1 }
  return [PSCustomObject]@{
    ExitCode = [int]$exitCode
    Lines = [object[]]$lines
  }
}

function Assert-GitResult([object]$Result, [string]$What) {
  if ([int]$Result.ExitCode -ne 0) {
    throw "$What 失败 exit=$($Result.ExitCode)"
  }
}

function Invoke-GitChecked([string]$What, [object[]]$GitArgs) {
  $result = Invoke-GitResult -GitArgs $GitArgs
  Assert-GitResult $result $What
  return @($result.Lines)
}

function Get-GitSingleLine([string]$What, [object[]]$GitArgs) {
  $result = Invoke-GitResult -GitArgs $GitArgs
  Assert-GitResult $result $What
  $lines = @(
    $result.Lines |
      ForEach-Object { ([string]$_).Trim() } |
      Where-Object { $_ -ne "" }
  )
  if ($lines.Count -ne 1) {
    throw "$What 输出应恰好一行，实际 $($lines.Count) 行"
  }
  return [string]$lines[0]
}

function Get-TextSha256([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $Utf8NoBom.GetBytes($Text)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-GitMergeLockRelativePaths {
  return @(
    "index.lock",
    "ORIG_HEAD.lock",
    "HEAD.lock",
    "refs\heads\main.lock",
    "logs\HEAD.lock",
    "logs\ORIG_HEAD.lock",
    "logs\refs\heads\main.lock"
  )
}

function Get-GitMergeLockPolicySha256 {
  return Get-TextSha256 ((Get-GitMergeLockRelativePaths) -join "`n")
}

function Assert-GitMergeLocksAbsent([string]$Phase) {
  $gitDir = Join-Path $Root ".git"
  if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) {
    throw "$Phase 无法确认仓库 .git 目录"
  }
  $found = @(
    Get-GitMergeLockRelativePaths | Where-Object {
      Test-Path -LiteralPath (Join-Path $gitDir $_)
    }
  )
  if ($found.Count -gt 0) {
    throw "$Phase 发现既有 Git 锁，拒绝认领或删除：$($found -join ',')"
  }
}

function Get-RevisionText([string]$Revision, [string]$RelativePath) {
  $gitPath = $RelativePath.Replace('\', '/')
  $lines = @(Invoke-GitChecked "git show $Revision`:$gitPath" @("show", "$Revision`:$gitPath"))
  return ($lines -join "`n").Trim()
}

function Restore-NpmLockfileWorktree {
  $relative = "package-lock.json"
  $path = Join-Path $Root $relative
  $expected = Get-GitSingleLine "git rev-parse HEAD:$relative" @("rev-parse", ("HEAD:" + $relative))
  $actual = Get-GitSingleLine "git hash-object $relative" @("hash-object", "--", $relative)
  if ($actual -ne $expected) {
    $contents = (Get-RevisionText "HEAD" $relative) + "`n"
    [System.IO.File]::WriteAllText($path, $contents, $Utf8NoBom)
    $restored = Get-GitSingleLine "git hash-object restored $relative" @("hash-object", "--", $relative)
    if ($restored -ne $expected) {
      throw "无法按 HEAD 精确恢复 package-lock.json 工作树"
    }
  }
  Write-Host "native Git result contract verified before service stop"
}

function Get-NpmDependencyGraphFingerprint([string]$Revision) {
  $node = Get-Command node.exe -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $ReleaseDependencyCheckPath -PathType Leaf)) {
    throw "release dependency checker is missing from the trusted runtime"
  }
  $lines = @(& $node.Source $ReleaseDependencyCheckPath fingerprint $Root $Revision 2>&1)
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    throw "无法计算 $Revision 的 npm 依赖图指纹 exit=$code"
  }
  $fingerprint = [string]($lines | Select-Object -Last 1)
  $fingerprint = $fingerprint.Trim().ToLowerInvariant()
  if ($fingerprint -notmatch '^[0-9a-f]{64}$') {
    throw "npm 依赖图指纹输出无效"
  }
  return $fingerprint
}

function Get-DirectoryFingerprint([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "目录快照不存在：$Path"
  }
  $base = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $records = @(
    Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction Stop |
      Sort-Object FullName |
      ForEach-Object {
        $relative = $_.FullName.Substring($base.Length).Replace('\', '/')
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
        "$relative`t$($_.Length)`t$hash"
      }
  )
  if ($records.Count -eq 0) { throw "目录快照为空：$Path" }
  return Get-TextSha256 ($records -join "`n")
}

function Assert-OfflineDependencyHandoff(
  [string]$FromRevision,
  [string]$ToRevision,
  [string]$PythonPath
) {
  $fromFingerprint = Get-NpmDependencyGraphFingerprint $FromRevision
  $toFingerprint = Get-NpmDependencyGraphFingerprint $ToRevision
  $npmSummary = "npm=$fromFingerprint"
  if ($fromFingerprint -ne $toFingerprint) {
    # Only a stage built and verified offline before stop may carry a changed graph.
    if (-not (Test-StagedDependencyHandoffReady $fromFingerprint $toFingerprint)) {
      throw "真实 npm 依赖图变化，但当前发版没有离线 node_modules 快照；拒绝停 8787"
    }
    $npmSummary = "npm=$fromFingerprint->$toFingerprint staged"
  }
  Assert-PythonRequirementsUnchanged $FromRevision $ToRevision
  if (-not (Test-Path -LiteralPath (Join-Path $Root "node_modules") -PathType Container)) {
    throw "node_modules 不存在；拒绝进入离线发版事务"
  }
  $rollupWin = @(
    (Join-Path $Root "node_modules\@rollup\rollup-win32-x64-msvc"),
    (Join-Path $Root "apps\web\ui\node_modules\@rollup\rollup-win32-x64-msvc")
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
  if (-not $rollupWin) {
    throw "Windows Rollup 依赖未预置；拒绝停 8787 后联网补装"
  }
  if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "找不到 Python：$PythonPath。打样和对照共用这个解释器。"
  }
  $distIndex = Join-Path $Root "apps\web\ui\dist\index.html"
  if (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
    throw "旧版 UI dist 不完整；无法建立离线回滚快照"
  }
  Write-Host "offline dependency handoff verified $npmSummary requirements=unchanged"
}

# Phase 1 keeps Python requirements changes refused: a venv embeds absolute paths
# and cannot be staged elsewhere and renamed into place.
function Assert-PythonRequirementsUnchanged([string]$FromRevision, [string]$ToRevision) {
  & git diff --quiet $FromRevision $ToRevision -- apps/web/backend/requirements.txt
  $requirementsDiff = $LASTEXITCODE
  if ($requirementsDiff -eq 1) {
    throw "Python requirements 变化，但当前发版没有离线虚拟环境快照；拒绝停 8787"
  }
  if ($requirementsDiff -ne 0) {
    throw "无法核对 Python requirements 变化 exit=$requirementsDiff"
  }
}

function Assert-NativeOfflineProbe(
  [string]$Label,
  [string]$Executable,
  [string[]]$Arguments,
  [string]$WorkingDirectory = $Root
) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Stop"
  $code = $null
  $invokeFailure = ""
  Push-Location $WorkingDirectory
  try {
    try {
      & $Executable @Arguments *> $null
      $code = $LASTEXITCODE
    } catch {
      $invokeFailure = [string]$_.Exception.Message
    }
  } finally {
    Pop-Location
    $ErrorActionPreference = $previousPreference
  }
  if ($invokeFailure) {
    throw "$Label 离线完整性探针无法启动：$invokeFailure；拒绝停 8787"
  }
  if ($null -eq $code -or [int]$code -ne 0) {
    throw "$Label 离线完整性探针失败 exit=$code；拒绝停 8787"
  }
}

function Assert-IsolatedServerEntryImport([string]$TsxPath, [string]$WorkingDirectory = $Root) {
  $probeData = Join-Path ([System.IO.Path]::GetTempPath()) ("beian-release-server-probe-" + [Guid]::NewGuid().ToString("N"))
  $prior = @{}
  foreach ($name in @("VITEST", "WB_DATA_DIR", "WB_HOST", "WB_PORT")) {
    $prior[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  New-Item -ItemType Directory -Force -Path $probeData | Out-Null
  try {
    $env:VITEST = "1"
    $env:WB_DATA_DIR = $probeData
    $env:WB_HOST = "127.0.0.1"
    $env:WB_PORT = "0"
    $entryProbe = "import('./apps/web/server/src/index.ts').then((m) => { if (!m.app || typeof m.app.fetch !== 'function') throw new Error('missing Hono app export'); })"
    Assert-NativeOfflineProbe "Hono service entry import" $TsxPath @("-e", $entryProbe) $WorkingDirectory
  } finally {
    foreach ($name in $prior.Keys) {
      if ($null -eq $prior[$name]) {
        Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
      } else {
        [Environment]::SetEnvironmentVariable($name, [string]$prior[$name], "Process")
      }
    }
    Remove-Item -LiteralPath $probeData -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Assert-OfflineRuntimeIntegrity([string]$PythonPath) {
  $node = Get-Command node.exe -ErrorAction Stop
  $npm = Get-Command npm.cmd -ErrorAction Stop
  $tsx = Join-Path $Root "node_modules\.bin\tsx.cmd"
  # A clean lockfile install keeps Vite under the UI workspace; older hand-provisioned trees hoisted it.
  $vite = Get-ViteEntry $Root
  if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) {
    throw "tsx 启动器缺失；旧服务无法离线冷启动"
  }
  if (-not $vite) {
    throw "Vite 构建入口缺失；目标 UI 无法离线构建"
  }
  $rollupNative = @(
    Get-ChildItem -LiteralPath (Join-Path $Root "node_modules\@rollup\rollup-win32-x64-msvc") `
      -Filter "*.node" -File -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath (Join-Path $Root "apps\web\ui\node_modules\@rollup\rollup-win32-x64-msvc") `
      -Filter "*.node" -File -ErrorAction SilentlyContinue
  ) | Select-Object -First 1
  if (-not $rollupNative) {
    throw "Windows Rollup 原生模块缺失；拒绝停 8787 后补装"
  }

  Assert-NativeOfflineProbe "npm installed graph" $npm.Source @("ls", "--all", "--offline", "--ignore-scripts", "--silent")
  Assert-NativeOfflineProbe "tsx launcher" $tsx @("--version")
  Assert-IsolatedServerEntryImport $tsx
  Assert-NativeOfflineProbe "Vite CLI" $node.Source @($vite, "--version")
  Assert-NativeOfflineProbe "Rollup native module" $node.Source @("-e", "require(process.argv[1])", [string]$rollupNative.FullName)
  Assert-NativeOfflineProbe "Python dependency graph" $PythonPath @("-m", "pip", "check")

  $backend = Join-Path $Root "apps\web\backend"
  $priorPythonPath = [Environment]::GetEnvironmentVariable("PYTHONPATH", "Process")
  try {
    $env:PYTHONPATH = "."
    Assert-NativeOfflineProbe `
      "review worker import" `
      $PythonPath `
      @("-c", "import app.cli; import fitz; import openpyxl") `
      $backend
  } finally {
    if ($null -eq $priorPythonPath) {
      Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    } else {
      $env:PYTHONPATH = $priorPythonPath
    }
  }
  Write-Host "offline runtime integrity verified: npm graph, tsx, Hono service entry, Vite, Rollup, pip, worker imports"
}

function Snapshot-UiDist {
  $source = Join-Path $Root "apps\web\ui\dist"
  $sourceFingerprint = Get-DirectoryFingerprint $source
  Remove-Item -LiteralPath $ReleaseUiSnapshotDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $ReleaseUiSnapshotDir | Out-Null
  Get-ChildItem -LiteralPath $source -Force -ErrorAction Stop |
    Copy-Item -Destination $ReleaseUiSnapshotDir -Recurse -Force
  $snapshotFingerprint = Get-DirectoryFingerprint $ReleaseUiSnapshotDir
  if ($snapshotFingerprint -ne $sourceFingerprint) {
    throw "旧版 UI dist 快照校验失败"
  }
  $script:ReleaseUiSnapshotSha256 = $snapshotFingerprint
  Write-Host "offline UI rollback snapshot ready sha256=$snapshotFingerprint"
}

function Get-DependencyHandoffPlan([string]$FromRevision, [string]$ToRevision) {
  $fromFingerprint = Get-NpmDependencyGraphFingerprint $FromRevision
  $toFingerprint = Get-NpmDependencyGraphFingerprint $ToRevision
  $mode = "unchanged"
  if ($fromFingerprint -ne $toFingerprint) { $mode = "npm-staged" }
  return [PSCustomObject]@{
    Mode = $mode
    FromFingerprint = $fromFingerprint
    ToFingerprint = $toFingerprint
    StagingRoot = ""
    StageSource = ""
    StageWork = ""
    BackupDir = ""
    FailedDir = ""
    StampPath = ""
    StampSha256 = ""
    OldPresence = [ordered]@{}
    OldTreeMarker = ""
    Verified = $false
  }
}

function Test-StagedDependencyHandoffReady([string]$FromFingerprint, [string]$ToFingerprint) {
  return [bool](
    $DependencyHandoff -and
    [string]$DependencyHandoff.Mode -eq "npm-staged" -and
    $DependencyHandoff.Verified -eq $true -and
    [string]$DependencyHandoff.FromFingerprint -eq $FromFingerprint -and
    [string]$DependencyHandoff.ToFingerprint -eq $ToFingerprint
  )
}

function Invoke-ReleaseDependencyCheck([string]$What, [string[]]$CheckArguments) {
  $node = Get-Command node.exe -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $ReleaseDependencyCheckPath -PathType Leaf)) {
    throw "release dependency checker is missing from the trusted runtime"
  }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $lines = @(& $node.Source $ReleaseDependencyCheckPath @CheckArguments 2>&1)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $last = ([string]($lines | Select-Object -Last 1)).Trim()
  if ($null -eq $code -or [int]$code -ne 0) {
    throw "$What 失败 exit=$code $last；拒绝停 8787"
  }
  $fingerprint = $last.ToLowerInvariant()
  if ($fingerprint -notmatch '^[0-9a-f]{64}$') {
    throw "$What 输出无效"
  }
  return $fingerprint
}

function Get-DependencyTreeMarker([string]$TreeRoot) {
  $hidden = Join-Path $TreeRoot "node_modules\.package-lock.json"
  if (-not (Test-Path -LiteralPath $hidden -PathType Leaf)) { return "absent" }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $hidden).Hash.ToLowerInvariant()
}

function Get-InstalledPackageDirectory([string]$TreeRoot, [string]$PackageName) {
  foreach ($prefix in @("node_modules", "apps\web\ui\node_modules", "apps\web\server\node_modules")) {
    $candidate = Join-Path (Join-Path $TreeRoot $prefix) $PackageName.Replace('/', '\')
    if (Test-Path -LiteralPath (Join-Path $candidate "package.json") -PathType Leaf) { return $candidate }
  }
  return ""
}

function Get-ViteEntry([string]$TreeRoot) {
  $viteDir = Get-InstalledPackageDirectory $TreeRoot "vite"
  if (-not $viteDir) { return "" }
  $entry = Join-Path $viteDir "bin\vite.js"
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { return "" }
  return $entry
}

function Assert-DependencyStagingLocation {
  if (-not $DependencyStagingRoot) {
    throw "仓库位于卷根目录，无法建立同卷依赖暂存目录；拒绝停 8787"
  }
  $stagingVolume = [System.IO.Path]::GetPathRoot($DependencyStagingRoot)
  $rootVolume = [System.IO.Path]::GetPathRoot($Root)
  if (-not [string]::Equals($stagingVolume, $rootVolume, [StringComparison]::OrdinalIgnoreCase)) {
    throw "依赖暂存目录 $DependencyStagingRoot 与仓库不在同一卷，无法原子换位；拒绝停 8787"
  }
  if (Test-DataDirInsideRepo $DependencyStagingRoot $Root) {
    throw "依赖暂存目录不能在仓库内：$DependencyStagingRoot"
  }
}

function Assert-DependencyStagingFreeSpace {
  $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($Root))
  $free = [int64]$drive.AvailableFreeSpace
  $freeGb = [math]::Round($free / 1GB, 2)
  $needGb = [math]::Round($DependencyMinimumFreeBytes / 1GB, 2)
  if ($free -lt $DependencyMinimumFreeBytes) {
    throw "$($drive.Name) 可用空间 $freeGb GB，低于离线依赖交接所需 $needGb GB；拒绝停 8787"
  }
  Write-Host "dependency staging free space ok drive=$($drive.Name) free_gb=$freeGb need_gb=$needGb"
}

function Initialize-DependencyStagingRoot {
  New-Item -ItemType Directory -Force -Path $DependencyStagingRoot | Out-Null
  # Same principals as the checkout: a same-volume move keeps object ACEs, so the
  # swapped node_modules must not become stricter or looser than D:\beian itself.
  $sections = [System.Security.AccessControl.AccessControlSections]::Access
  $source = [System.IO.Directory]::GetAccessControl($Root, $sections)
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetSecurityDescriptorSddlForm($source.GetSecurityDescriptorSddlForm($sections), $sections)
  [System.IO.Directory]::SetAccessControl($DependencyStagingRoot, $security)
}

function Test-DependencyReparsePoint([string]$Path) {
  $info = [System.IO.DirectoryInfo]::new($Path)
  return (($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Remove-DependencyReparsePoints([string]$Path) {
  # Unlink junctions/symlinks before any recursive delete so it can never follow
  # npm's workspace junction into a real source checkout.
  $pending = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
  $pending.Push([System.IO.DirectoryInfo]::new($Path))
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($child in $current.GetDirectories()) {
      if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        [System.IO.Directory]::Delete($child.FullName, $false)
      } else {
        $pending.Push($child)
      }
    }
  }
}

function Remove-DependencyTreeSafely([string]$Path) {
  if (-not $Path -or -not [System.IO.Directory]::Exists($Path)) { return }
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $boundary = $DependencyStagingRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝删除依赖暂存目录之外的路径：$full"
  }
  if (Test-DependencyReparsePoint $full) {
    [System.IO.Directory]::Delete($full, $false)
    return
  }
  Remove-DependencyReparsePoints $full
  [System.IO.Directory]::Delete($full, $true)
}

function Get-DependencyArtifactTime([string]$Name) {
  return $Name.Substring($Name.Length - 16)
}

function Remove-StaleDependencyArtifacts([string]$KeepShortSha) {
  if (-not $DependencyStagingRoot -or -not [System.IO.Directory]::Exists($DependencyStagingRoot)) { return }
  $entries = @(Get-ChildItem -LiteralPath $DependencyStagingRoot -Directory -Force -ErrorAction Stop)
  foreach ($kind in @("backup", "failed")) {
    $generations = @(
      $entries |
        Where-Object { $_.Name -match ('^' + $kind + '-[0-9a-f]{12}-\d{8}T\d{6}Z$') } |
        Sort-Object -Property @{ Expression = { Get-DependencyArtifactTime $_.Name } } -Descending
    )
    foreach ($stale in @($generations | Select-Object -Skip $DependencyBackupGenerationsKept)) {
      Write-Host "dependency retention removes $($stale.Name)"
      Remove-DependencyTreeSafely $stale.FullName
    }
  }
  foreach ($entry in $entries) {
    if ($entry.Name -match '^(?:stage|work)-([0-9a-f]{12})$') {
      if ($Matches[1] -ne $KeepShortSha) {
        Write-Host "dependency retention removes stale $($entry.Name)"
        Remove-DependencyTreeSafely $entry.FullName
      }
    } elseif ($entry.Name -notmatch '^(?:backup|failed)-[0-9a-f]{12}-\d{8}T\d{6}Z$') {
      Write-Warning "dependency staging root keeps unknown entry $($entry.Name)"
    }
  }
}

function Get-DependencyReparsePointNames([string]$NodeModules) {
  $names = New-Object 'System.Collections.Generic.List[string]'
  if (-not [System.IO.Directory]::Exists($NodeModules)) { return @() }
  foreach ($entry in ([System.IO.DirectoryInfo]::new($NodeModules)).GetDirectories()) {
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      [void]$names.Add($entry.Name)
    } elseif ($entry.Name.StartsWith("@")) {
      foreach ($scoped in $entry.GetDirectories()) {
        if (($scoped.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
          [void]$names.Add($entry.Name + "/" + $scoped.Name)
        }
      }
    }
  }
  return @($names)
}

function Set-StagedWorkspaceJunctions([string]$StageSource, [string]$TargetRoot) {
  $nodeModules = Join-Path $StageSource "node_modules"
  foreach ($relative in $DependencySetRelativePaths) {
    $unknown = @(
      Get-DependencyReparsePointNames (Join-Path $StageSource $relative) |
        Where-Object { $relative -ne "node_modules" -or -not $DependencyWorkspaceLinks.Contains($_) }
    )
    if ($unknown.Count -gt 0) {
      throw "staged $relative 含未知 reparse point：$($unknown -join ',')；拒绝停 8787"
    }
  }
  foreach ($name in @($DependencyWorkspaceLinks.Keys)) {
    $link = Join-Path $nodeModules $name
    $target = Join-Path $TargetRoot $DependencyWorkspaceLinks[$name]
    if ([System.IO.Directory]::Exists($link)) {
      if (-not (Test-DependencyReparsePoint $link)) {
        throw "staged workspace link 不是 junction：$name；拒绝停 8787"
      }
      [System.IO.Directory]::Delete($link, $false)
    }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  }
}

function Get-WorkspaceJunctionTarget([string]$Link) {
  if (-not [System.IO.Directory]::Exists($Link) -or -not (Test-DependencyReparsePoint $Link)) { return "" }
  $item = Get-Item -LiteralPath $Link -Force
  return [string](@($item.Target) | Select-Object -First 1)
}

function ConvertTo-CmdArgument([string]$Value) {
  if ($Value -match '[\s"&|<>^()%!,;=]') {
    return '"' + $Value.Replace('"', '""') + '"'
  }
  return $Value
}

function Stop-ProcessTree([int]$RootProcessId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-ProcessTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

function Invoke-BoundedProcess(
  [string]$Label,
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [string]$LogPath,
  [int]$TimeoutSeconds
) {
  $parts = @('"' + $FilePath + '"') + @($Arguments | ForEach-Object { ConvertTo-CmdArgument ([string]$_) })
  $commandLine = '"' + ($parts -join " ") + ' > ' + (ConvertTo-CmdArgument $LogPath) + ' 2>&1"'
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $env:ComSpec
  $startInfo.Arguments = "/d /s /c $commandLine"
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($startInfo)
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-ProcessTree ([int]$process.Id)
      throw "$Label 超过 $TimeoutSeconds 秒，已终止进程树；8787 未停"
    }
    $process.WaitForExit()
    $code = [int]$process.ExitCode
  } finally {
    $process.Dispose()
  }
  if ($code -ne 0) {
    $tail = @(Get-Content -LiteralPath $LogPath -Tail 40 -ErrorAction SilentlyContinue) -join "`n"
    Write-Host $tail
    throw "$Label 失败 exit=$code；8787 未停，日志 $LogPath"
  }
}

function Export-TargetSourceToStage([object]$Plan) {
  $archive = Join-Path $Plan.StageWork "source.tar"
  Invoke-GitChecked "git archive TargetSha" @("archive", "--format=tar", "-o", $archive, $TargetSha) | Out-Null
  New-Item -ItemType Directory -Force -Path $Plan.StageSource | Out-Null
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  & $tar -x -f $archive -C $Plan.StageSource
  if ($LASTEXITCODE -ne 0) { throw "解包 TargetSha 源码失败 exit=$LASTEXITCODE；拒绝停 8787" }
  Remove-Item -LiteralPath $archive -Force
  Assert-StagedSourceFingerprint $Plan
}

function Assert-StagedSourceFingerprint([object]$Plan) {
  $treeFingerprint = Invoke-ReleaseDependencyCheck "staged source fingerprint" @("fingerprint-tree", $Plan.StageSource)
  if ($treeFingerprint -ne [string]$Plan.ToFingerprint) {
    throw "staged 源码依赖指纹与 TargetSha 不一致；拒绝停 8787"
  }
}

function Invoke-StagedNpmCi([object]$Plan) {
  $npm = Get-Command npm.cmd -ErrorAction Stop
  $cache = Join-Path $Plan.StageWork "npm-cache"
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $proxyConfigured = [bool]($env:HTTPS_PROXY -or $env:HTTP_PROXY)
  Write-Host "staged npm ci start dir=$($Plan.StageSource) proxy_configured=$proxyConfigured timeout_s=$DependencyNpmCiTimeoutSeconds"
  # The only networked dependency step: it runs while 8787 still serves, inside an
  # isolated sibling tree, and never touches the production checkout or its lockfile.
  Invoke-BoundedProcess `
    "staged npm ci" `
    $npm.Source `
    @("ci", "--no-audit", "--no-fund", "--include=dev", "--include=optional", "--foreground-scripts", "--cache", $cache) `
    $Plan.StageSource `
    (Join-Path $Plan.StageWork "logs\npm-ci.log") `
    $DependencyNpmCiTimeoutSeconds
}

function Repair-StagedRollupNative([object]$Plan) {
  # Mac-generated locks omit Rollup's Windows optional native (npm/cli#4828), which
  # is why the live tree had it pre-provisioned. Fetch the exact version Rollup
  # declares while still online; the installed-graph check stays bound to the lock.
  $rollupDir = Get-InstalledPackageDirectory $Plan.StageSource "rollup"
  if (-not $rollupDir) { throw "staged tree 缺少 rollup；拒绝停 8787" }
  $nativeName = "@rollup/rollup-win32-x64-msvc"
  $nativeDir = Join-Path ([System.IO.Path]::GetDirectoryName($rollupDir)) "@rollup\rollup-win32-x64-msvc"
  if (Test-Path -LiteralPath (Join-Path $nativeDir "package.json") -PathType Leaf) { return }
  $rollupManifest = [System.IO.File]::ReadAllText((Join-Path $rollupDir "package.json"), $Utf8NoBom) | ConvertFrom-Json
  $declared = $rollupManifest.optionalDependencies.PSObject.Properties[$nativeName]
  $version = if ($declared) { [string]$declared.Value } else { "" }
  if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "rollup 未声明精确的 $nativeName 版本；拒绝停 8787"
  }
  $npm = Get-Command npm.cmd -ErrorAction Stop
  $packDir = Join-Path $Plan.StageWork "packs"
  New-Item -ItemType Directory -Force -Path $packDir | Out-Null
  Invoke-BoundedProcess `
    "staged Rollup Windows native pack" `
    $npm.Source `
    @("pack", "$nativeName@$version", "--pack-destination", $packDir, "--cache", (Join-Path $Plan.StageWork "npm-cache")) `
    $Plan.StageWork `
    (Join-Path $Plan.StageWork "logs\npm-pack-rollup.log") `
    300
  $tarball = Join-Path $packDir "rollup-rollup-win32-x64-msvc-$version.tgz"
  if (-not (Test-Path -LiteralPath $tarball -PathType Leaf)) { throw "npm pack 未产出 $tarball；拒绝停 8787" }
  New-Item -ItemType Directory -Force -Path $nativeDir | Out-Null
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  & $tar -x -f $tarball -C $nativeDir --strip-components 1
  if ($LASTEXITCODE -ne 0) { throw "解包 $nativeName 失败 exit=$LASTEXITCODE；拒绝停 8787" }
  $installed = [System.IO.File]::ReadAllText((Join-Path $nativeDir "package.json"), $Utf8NoBom) | ConvertFrom-Json
  if ([string]$installed.version -ne $version) { throw "$nativeName 版本不符；拒绝停 8787" }
  Write-Host "staged Rollup Windows native $version restored next to rollup (lockfile omits it)"
}

function Invoke-WithOfflineNetworkEnvironment([string]$EmptyCache, [scriptblock]$Body) {
  $offline = [ordered]@{
    HTTP_PROXY = "http://127.0.0.1:9"
    HTTPS_PROXY = "http://127.0.0.1:9"
    ALL_PROXY = "http://127.0.0.1:9"
    NO_PROXY = "127.0.0.1,localhost"
    npm_config_offline = "true"
    npm_config_registry = "http://127.0.0.1:9/"
    npm_config_proxy = "http://127.0.0.1:9"
    npm_config_https_proxy = "http://127.0.0.1:9"
    npm_config_cache = $EmptyCache
    npm_config_update_notifier = "false"
  }
  $prior = @{}
  foreach ($name in @($offline.Keys)) {
    $prior[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  try {
    foreach ($name in @($offline.Keys)) {
      [Environment]::SetEnvironmentVariable($name, [string]$offline[$name], "Process")
    }
    & $Body
  } finally {
    foreach ($name in $prior.Keys) {
      [Environment]::SetEnvironmentVariable($name, $prior[$name], "Process")
    }
  }
}

function Assert-StagedOfflineIntegrity([object]$Plan) {
  $node = Get-Command node.exe -ErrorAction Stop
  $npm = Get-Command npm.cmd -ErrorAction Stop
  $stage = [string]$Plan.StageSource
  $emptyCache = Join-Path $Plan.StageWork ("offline-cache-" + [Guid]::NewGuid().ToString("N"))
  $stageDist = Join-Path $stage "apps\web\ui\dist"
  New-Item -ItemType Directory -Force -Path $emptyCache | Out-Null
  try {
    Invoke-WithOfflineNetworkEnvironment $emptyCache {
      $installed = Invoke-ReleaseDependencyCheck "staged installed graph" @("installed", $stage, $Root, $TargetSha)
      if ($installed -ne [string]$Plan.ToFingerprint) {
        throw "staged node_modules 与目标 npm 依赖图不一致；拒绝停 8787"
      }
      foreach ($package in $DependencyRequiredWindowsNatives) {
        if (-not (Get-InstalledPackageDirectory $stage $package)) {
          throw "staged tree 缺少 Windows 原生包 $package；拒绝停 8787"
        }
      }
      $tsx = Join-Path $stage "node_modules\.bin\tsx.cmd"
      $vite = Get-ViteEntry $stage
      if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) { throw "staged tsx 启动器缺失；拒绝停 8787" }
      if (-not $vite) { throw "staged Vite 构建入口缺失；拒绝停 8787" }
      $rollupNative = Get-ChildItem `
        -LiteralPath (Get-InstalledPackageDirectory $stage "@rollup/rollup-win32-x64-msvc") `
        -Filter "*.node" -File -ErrorAction Stop | Select-Object -First 1
      if (-not $rollupNative) { throw "staged Rollup 原生模块缺失；拒绝停 8787" }
      $logo = Join-Path $stage "apps\web\ui\public\brand\logo-mark.png"
      $sharpProbe = "const sharp = require('sharp'); if (!sharp.versions || !sharp.versions.vips) throw new Error('sharp has no libvips'); sharp(process.argv[1]).metadata().then((m) => { if (!m.width || !m.height) throw new Error('empty sharp metadata'); })"

      Assert-NativeOfflineProbe "staged npm installed graph" $npm.Source @("ls", "--all", "--offline", "--ignore-scripts", "--silent") $stage
      Assert-NativeOfflineProbe "staged tsx launcher" $tsx @("--version") $stage
      Assert-NativeOfflineProbe "staged sharp native module" $node.Source @("-e", $sharpProbe, $logo) (Join-Path $stage "apps\web\server")
      Assert-NativeOfflineProbe "staged Vite CLI" $node.Source @($vite, "--version") $stage
      Assert-NativeOfflineProbe "staged Rollup native module" $node.Source @("-e", "require(process.argv[1])", [string]$rollupNative.FullName) $stage
      # The Hono entry mounts serveStatic(UI_DIST) at import time, exactly like the
      # live probe sees the live tree's built dist. Build the stage's own
      # apps\web\ui\dist first (Vite default outDir inside the stage). Only the three
      # node_modules directories are ever swapped into D:\beian, so this dist never
      # reaches the live checkout; the live UI is rebuilt by the post-merge ui_build.
      # tsc/Vite print warnings on stderr; under PS 5.1 a redirected native stderr line
      # is a terminating error, so judge this build only by exit code and keep its log.
      Invoke-BoundedProcess "staged UI build" $npm.Source @("run", "build", "-w", "beian-ui") $stage (Join-Path $Plan.StageWork "logs\ui-build.log") 600
      if (-not (Test-Path -LiteralPath (Join-Path $stageDist "index.html") -PathType Leaf)) {
        throw "staged UI build 未产出 index.html；拒绝停 8787"
      }
      Assert-IsolatedServerEntryImport $tsx $stage
    }
  } finally {
    Remove-Item -LiteralPath $emptyCache -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "staged offline integrity verified: installed graph, npm ls, tsx, sharp, Vite, Rollup, UI build, Hono entry"
}

function Test-ReusableDependencyStage([object]$Plan) {
  $stampPath = Join-Path $Plan.StageWork "stamp.json"
  if (-not (Test-Path -LiteralPath $stampPath -PathType Leaf)) { return $false }
  if (-not [System.IO.Directory]::Exists((Join-Path $Plan.StageSource "node_modules"))) { return $false }
  try {
    $stamp = [System.IO.File]::ReadAllText($stampPath, $Utf8NoBom) | ConvertFrom-Json
  } catch {
    return $false
  }
  if (
    [string]$stamp.protocol -ne $DependencyStageProtocol -or
    [string]$stamp.target_sha -ne $TargetSha -or
    [string]$stamp.target_npm_fingerprint -ne [string]$Plan.ToFingerprint
  ) {
    return $false
  }
  Assert-StagedSourceFingerprint $Plan
  return $true
}

function Write-StagedDependencyStamp([object]$Plan) {
  $stagedPresence = [ordered]@{}
  foreach ($relative in $DependencySetRelativePaths) {
    $present = [System.IO.Directory]::Exists((Join-Path $Plan.StageSource $relative))
    $stagedPresence[$relative.Replace('\', '/')] = if ($present) { "present" } else { "absent" }
  }
  $junctions = [ordered]@{}
  foreach ($name in @($DependencyWorkspaceLinks.Keys)) {
    $junctions["node_modules/$name"] = Join-Path $Root $DependencyWorkspaceLinks[$name]
  }
  $stamp = [ordered]@{
    protocol = $DependencyStageProtocol
    target_sha = $TargetSha
    target_npm_fingerprint = [string]$Plan.ToFingerprint
    stage_path = [string]$Plan.StageSource
    depset = $stagedPresence
    junctions = $junctions
    verified_at = [DateTime]::UtcNow.ToString("o")
  }
  $stagePath = Join-Path $Plan.StageWork "stamp.json"
  [System.IO.File]::WriteAllText($stagePath, (($stamp | ConvertTo-Json -Depth 6 -Compress) + "`n"), $Utf8NoBom)
  Copy-AtomicFile $stagePath $DependencyStageStampRuntimePath
  $Plan.StampPath = $DependencyStageStampRuntimePath
  $Plan.StampSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $DependencyStageStampRuntimePath).Hash.ToLowerInvariant()
}

function Prepare-StagedDependencies([object]$Plan, [string]$FromRevision) {
  Assert-DependencyStagingLocation
  Assert-DependencyStagingFreeSpace
  Initialize-DependencyStagingRoot
  $targetShort = $TargetSha.Substring(0, 12)
  $utc = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
  $Plan.StagingRoot = $DependencyStagingRoot
  $Plan.StageSource = Join-Path $DependencyStagingRoot ("stage-" + $targetShort)
  $Plan.StageWork = Join-Path $DependencyStagingRoot ("work-" + $targetShort)
  $Plan.BackupDir = Join-Path $DependencyStagingRoot ("backup-" + $FromRevision.Substring(0, 12) + "-" + $utc)
  $Plan.FailedDir = Join-Path $DependencyStagingRoot ("failed-" + $targetShort + "-" + $utc)
  Remove-StaleDependencyArtifacts $targetShort

  if (Test-ReusableDependencyStage $Plan) {
    Write-Host "reuse staged dependency tree for $TargetSha; every offline probe is rerun"
  } else {
    Remove-DependencyTreeSafely $Plan.StageSource
    Remove-DependencyTreeSafely $Plan.StageWork
    New-Item -ItemType Directory -Force -Path $Plan.StageWork, (Join-Path $Plan.StageWork "logs") | Out-Null
    Export-TargetSourceToStage $Plan
    Invoke-StagedNpmCi $Plan
  }
  Repair-StagedRollupNative $Plan
  Set-StagedWorkspaceJunctions $Plan.StageSource $Plan.StageSource
  Assert-StagedOfflineIntegrity $Plan
  # Point the workspace junctions at their final checkout location before the
  # swap so moving node_modules never leaves a link into the staging tree.
  Set-StagedWorkspaceJunctions $Plan.StageSource $Root

  foreach ($relative in $DependencySetRelativePaths) {
    $present = [System.IO.Directory]::Exists((Join-Path $Root $relative))
    $Plan.OldPresence[$relative.Replace('\', '/')] = if ($present) { "present" } else { "absent" }
  }
  $Plan.OldTreeMarker = Get-DependencyTreeMarker $Root
  Write-StagedDependencyStamp $Plan
  $Plan.Verified = $true
  Write-Host "offline dependency stage ready $($Plan.StageSource) npm=$($Plan.FromFingerprint)->$($Plan.ToFingerprint)"
}

function Assert-NoProcessUsesDependencyTrees {
  $ancestors = @(Get-ReleaseProcessAncestors)
  $needles = @(
    $DependencySetRelativePaths | ForEach-Object { (Join-Path $Root $_).ToLowerInvariant() }
  ) + @($DependencyStagingRoot.ToLowerInvariant())
  $holders = New-Object 'System.Collections.Generic.List[string]'
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    $processId = [int]$process.ProcessId
    if ($ancestors -contains $processId) { continue }
    $text = ([string]$process.ExecutablePath + " " + [string]$process.CommandLine).ToLowerInvariant()
    foreach ($needle in $needles) {
      if ($text.Contains($needle)) {
        [void]$holders.Add("${processId}:$($process.Name)")
        break
      }
    }
  }
  if ($holders.Count -gt 0) {
    throw "仍有进程使用 node_modules，拒绝依赖换位：$($holders -join ',')"
  }
}

function Invoke-DependencySwap([object]$Plan) {
  if (-not (Test-StagedDependencyHandoffReady $Plan.FromFingerprint $Plan.ToFingerprint)) {
    throw "依赖换位缺少停服前已验证的 staging"
  }
  $stampHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DependencyStageStampRuntimePath).Hash.ToLowerInvariant()
  if ($stampHash -ne [string]$Plan.StampSha256) {
    throw "staged 依赖 stamp 与停服前记录不一致"
  }
  $stagedFingerprint = Invoke-ReleaseDependencyCheck "staged installed graph before swap" @("installed", $Plan.StageSource, $Root, $TargetSha)
  if ($stagedFingerprint -ne [string]$Plan.ToFingerprint) {
    throw "staged node_modules 在停服后发生变化"
  }
  Assert-NoProcessUsesDependencyTrees

  # Write-ahead: recovery must know dependencies may have moved before the first rename.
  $ReleaseJournalState.dependency_mutated = $true
  Set-ReleaseJournalStage "deps_swap"
  New-Item -ItemType Directory -Force -Path $Plan.BackupDir | Out-Null
  foreach ($relative in $DependencySetRelativePaths) {
    $key = $relative.Replace('\', '/')
    $live = Join-Path $Root $relative
    $backup = Join-Path $Plan.BackupDir $relative
    $staged = Join-Path $Plan.StageSource $relative
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($backup)) | Out-Null
    if ([System.IO.Directory]::Exists($live)) {
      [System.IO.Directory]::Move($live, $backup)
    } else {
      [System.IO.File]::WriteAllText("$backup.absent", "absent`n", $Utf8NoBom)
    }
    $ReleaseJournalState.deps_swap_progress[$key] = "backed_up"
    Write-AtomicReleaseJournal
    if ([System.IO.Directory]::Exists($staged)) {
      [System.IO.Directory]::Move($staged, $live)
    }
    $ReleaseJournalState.deps_swap_progress[$key] = "swapped"
    Write-AtomicReleaseJournal
  }
  Set-ReleaseJournalStage "deps_swapped"
}

function Assert-LiveDependencyMatchesTarget([object]$Plan, [string]$PythonPath) {
  $live = Invoke-ReleaseDependencyCheck "live installed graph after swap" @("installed", $Root, $Root, $TargetSha)
  if ($live -ne [string]$Plan.ToFingerprint) {
    throw "换位后的 node_modules 与目标 npm 依赖图不一致"
  }
  foreach ($name in @($DependencyWorkspaceLinks.Keys)) {
    $expected = [System.IO.Path]::GetFullPath((Join-Path $Root $DependencyWorkspaceLinks[$name])).TrimEnd('\', '/')
    $actual = Get-WorkspaceJunctionTarget (Join-Path $Root "node_modules\$name")
    if (-not $actual -or -not [string]::Equals([System.IO.Path]::GetFullPath($actual).TrimEnd('\', '/'), $expected, [StringComparison]::OrdinalIgnoreCase)) {
      throw "换位后 workspace junction $name 未指向 $expected"
    }
  }
  Assert-OfflineRuntimeIntegrity $PythonPath
  Write-Host "live node_modules swapped to target npm graph $live"
}

function Complete-DependencyHandoffRetention([object]$Plan) {
  if (-not $Plan -or [string]$Plan.Mode -ne "npm-staged") { return }
  Remove-DependencyTreeSafely $Plan.StageSource
  Remove-DependencyTreeSafely $Plan.StageWork
  Remove-StaleDependencyArtifacts ""
  Write-Host "dependency retention keeps one previous generation: $($Plan.BackupDir)"
}

# Actions runner may not have Git Credential Manager. Never print GITHUB_TOKEN.
# GitHub's smart HTTP credential is Basic(x-access-token:GITHUB_TOKEN).
function Get-GithubAuthHeader {
  if (-not $env:GITHUB_TOKEN) { return "" }
  $Credential = "x-access-token:$($env:GITHUB_TOKEN)"
  $Encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Credential))
  return "AUTHORIZATION: basic $Encoded"
}

function Clear-GithubToken {
  if ($env:GITHUB_TOKEN) {
    Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
  }
}

# Windows 上 packed-refs 和零散 origin/main 拧在一起时：
# cannot lock ref 'refs/remotes/origin/main': is at A but expected B
# 只在这一条 ref 锁上才删指针。网络/401/Clash 失败不要动 origin/main。
# git fetch 把 "From https://..." 写在 stderr。PS5 + Stop 会打成 NativeCommandError，
# 即使 exit 0 也在停 8787 之前抛（0.12.17.0 hangzhou-release 8s 红）。只看 LASTEXITCODE。
function Invoke-GitFetch {
  param([string]$LogPath = "")
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $AuthHeader = Get-GithubAuthHeader
    if ($LogPath) {
      if ($AuthHeader) {
        & git -c "http.extraheader=$AuthHeader" fetch origin *> $LogPath
      } else {
        & git fetch origin *> $LogPath
      }
    } else {
      if ($AuthHeader) {
        & git -c "http.extraheader=$AuthHeader" fetch origin
      } else {
        & git fetch origin
      }
    }
  } catch {
    # NativeCommandError from git stderr — LASTEXITCODE is the real result
  } finally {
    $ErrorActionPreference = $prevEap
  }
  $code = $LASTEXITCODE
  if ($null -eq $code) { return 1 }
  return [int]$code
}

function Fetch-OriginMain {
  $log = Join-Path $env:TEMP "beian-git-fetch.log"
  if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
  try {
    $code = Invoke-GitFetch -LogPath $log
    if ($code -eq 0) { return }
    $msg = ""
    foreach ($enc in @("Unicode", "UTF8", "Default")) {
      try {
        $t = Get-Content $log -Raw -Encoding $enc -ErrorAction Stop
      } catch {
        continue
      }
      if ($t -match "cannot lock ref 'refs/remotes/origin/main'") {
        $msg = $t
        break
      }
      if (-not $msg -and $t) { $msg = $t }
    }
    if ($msg -match "cannot lock ref 'refs/remotes/origin/main'") {
      Write-Host "origin/main ref 拧了，删掉再 fetch"
      Invoke-GitChecked "git update-ref -d origin/main" @(
        "update-ref", "-d", "refs/remotes/origin/main"
      ) | Out-Null
      $code = Invoke-GitFetch
      if ($code -eq 0) { return }
    }
    throw "git fetch origin 失败 exit=$code"
  } finally {
    if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
  }
}

function Resolve-ReleaseTarget([string]$RequestedSha) {
  $resolved = [string]$RequestedSha
  if (-not $resolved) {
    $resolved = Get-GitSingleLine "git rev-parse origin/main" @("rev-parse", "origin/main")
  }
  $resolved = $resolved.Trim().ToLowerInvariant()
  if ($resolved -notmatch '^[0-9a-f]{40}$') {
    throw "TargetSha 必须是完整的 40 位 Git commit SHA"
  }
  Invoke-GitChecked "git cat-file TargetSha" @("cat-file", "-e", ($resolved + "^{commit}")) | Out-Null
  $ancestor = Invoke-GitResult -GitArgs @("merge-base", "--is-ancestor", $resolved, "origin/main")
  if ([int]$ancestor.ExitCode -ne 0) {
    throw "TargetSha 不属于当前 origin/main，拒绝用其他分支或悬空提交升生产"
  }
  return $resolved
}

function Get-Health {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/health" -TimeoutSec 8
  } catch {
    return $null
  }
}

function Get-LiveReleaseIdentity([object]$Control) {
  try {
    return Invoke-RestMethod `
      -Uri "http://127.0.0.1:8787/api/internal/release/identity" `
      -Headers @{ "x-beian-release-token" = [string]$Control.token } `
      -TimeoutSec 8
  } catch {
    throw "release control 存在但无法核对在线实例，拒绝升版"
  }
}

function Get-ReleaseControl {
  $path = Join-Path (Join-Path $env:WB_DATA_DIR "runtime") "release-control.json"
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try {
    $control = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
  } catch {
    throw "release control 文件损坏，拒绝升版"
  }
  if (
    [string]$control.protocol -ne "beian.release.v1" -or
    [string]$control.token -notmatch '^[A-Za-z0-9_-]{32,}$' -or
    [string]$control.instance_id -notmatch '^[A-Za-z0-9_-]{32,128}$' -or
    [int]$control.pid -le 0 -or
    -not [string]$control.written_at
  ) {
    throw "release control 合同不完整，拒绝升版"
  }
  $controlPid = [int]$control.pid
  $listenerPid = Get-ListenerPid 8787
  $controlProcess = Get-Process -Id $controlPid -ErrorAction SilentlyContinue
  if (-not $controlProcess) {
    Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    Write-Host "remove stale release control pid=$controlPid listener=$listenerPid"
    return $null
  }
  if ($listenerPid -and $listenerPid -eq $controlPid) {
    $identity = Get-LiveReleaseIdentity $control
    if (
      $identity.ok -and
      [string]$identity.protocol -eq [string]$control.protocol -and
      [string]$identity.instance_id -eq [string]$control.instance_id -and
      [string]$identity.version -eq [string]$control.version -and
      [int]$identity.pid -eq $controlPid
    ) {
      return $control
    }
    throw "release control 文件与在线 8787 实例不匹配，拒绝升版"
  }
  if (-not $listenerPid) {
    throw "release control pid=$controlPid 仍存活但 8787 没有监听，拒绝清理或升版"
  }
  throw "release control pid=$controlPid 不拥有当前 8787 listener=$listenerPid，拒绝升版"
}

function Invoke-ReleaseControl([string]$Method, [object]$Control, [string]$LeaseId) {
  $headers = @{
    "x-beian-release-token" = [string]$Control.token
    "x-beian-release-lease" = $LeaseId
  }
  return Invoke-RestMethod `
    -Uri "http://127.0.0.1:8787/api/internal/release/drain" `
    -Method $Method `
    -Headers $headers `
    -TimeoutSec 8
}

function Enter-ReleaseDrain {
  $control = Get-ReleaseControl
  if (-not $control) { return $null }
  $leaseId = [Guid]::NewGuid().ToString("N")
  try {
    $state = Invoke-ReleaseControl "Post" $control $leaseId
  } catch {
    throw "release control 存在但服务端不能进入 drain，拒绝升版"
  }
  if (
    -not $state.ok -or
    [string]$state.protocol -ne "beian.release.v1" -or
    [string]$state.instance_id -ne [string]$control.instance_id -or
    [int]$state.pid -ne [int]$control.pid -or
    [string]$state.version -ne [string]$control.version -or
    [string]$state.state -ne "draining" -or
    [string]$state.lease_id -ne $leaseId -or
    [string]$state.mode -ne "lease" -or
    -not [string]$state.expires_at
  ) {
    throw "release drain 身份或状态不匹配，拒绝升版"
  }
  return [PSCustomObject]@{ Control = $control; LeaseId = $leaseId; State = $state }
}

function Promote-ReleaseDrain([object]$Drain) {
  if (-not $Drain) { throw "release drain is required before transaction promotion" }
  try {
    $state = Invoke-ReleaseControl "Put" $Drain.Control $Drain.LeaseId
  } catch {
    throw "release drain 无法升级为事务围栏"
  }
  if (
    -not $state.ok -or
    [string]$state.protocol -ne "beian.release.v1" -or
    [string]$state.instance_id -ne [string]$Drain.Control.instance_id -or
    [int]$state.pid -ne [int]$Drain.Control.pid -or
    [string]$state.version -ne [string]$Drain.Control.version -or
    [string]$state.state -ne "draining" -or
    [string]$state.lease_id -ne [string]$Drain.LeaseId -or
    [string]$state.mode -ne "transaction" -or
    [string]$state.expires_at
  ) {
    throw "release transaction fence 身份或状态不匹配"
  }
  return [PSCustomObject]@{ Control = $Drain.Control; LeaseId = $Drain.LeaseId; State = $state }
}

function Exit-ReleaseDrain([object]$Drain) {
  if (-not $Drain) { return }
  try {
    $state = Invoke-ReleaseControl "Delete" $Drain.Control $Drain.LeaseId
    if ([string]$state.state -ne "open") { throw "drain did not reopen" }
  } catch {
    throw "release drain 未能解除；服务仍在线时需要先恢复接单"
  }
}

function Write-StartupDrainFence([string]$LeaseId) {
  if ($LeaseId -notmatch '^[A-Za-z0-9_-]{16,128}$') {
    throw "target release lease id is invalid"
  }
  New-Item -ItemType Directory -Force -Path $DataRuntimeDir | Out-Null
  $payload = [ordered]@{
    protocol = "beian.release.v1"
    lease_id = $LeaseId
    mode = "transaction"
    entered_at = [DateTime]::UtcNow.ToString("o")
  }
  $temporary = "$ReleaseDrainFencePath.$ReleaseProcessPid.tmp"
  [System.IO.File]::WriteAllText(
    $temporary,
    (($payload | ConvertTo-Json -Compress) + "`n"),
    $Utf8NoBom
  )
  try {
    if (Test-Path -LiteralPath $ReleaseDrainFencePath) {
      [System.IO.File]::Replace($temporary, $ReleaseDrainFencePath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      [System.IO.File]::Move($temporary, $ReleaseDrainFencePath)
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Get-TargetReleaseDrain([string]$LeaseId, [string]$ExpectedVersion) {
  $control = Get-ReleaseControl
  if (-not $control -or [string]$control.version -ne $ExpectedVersion) {
    throw "目标 8787 release control 版本不匹配"
  }
  $state = Invoke-ReleaseControl "Get" $control $LeaseId
  if (
    -not $state.ok -or
    [string]$state.protocol -ne "beian.release.v1" -or
    [string]$state.instance_id -ne [string]$control.instance_id -or
    [int]$state.pid -ne [int]$control.pid -or
    [string]$state.version -ne $ExpectedVersion -or
    [string]$state.state -ne "draining" -or
    [string]$state.lease_id -ne $LeaseId -or
    [string]$state.mode -ne "transaction" -or
    [string]$state.expires_at -or
    $state.ready -ne $true -or
    @($state.blocker_codes).Count -ne 0
  ) {
    throw "目标 8787 未继承可提交的 release drain，拒绝提交发版；blocker_codes=$(@($state.blocker_codes) -join ',')"
  }
  return [PSCustomObject]@{ Control = $control; LeaseId = $LeaseId; State = $state }
}

function Open-TargetReleaseDrain([object]$TargetDrain, [string]$ExpectedVersion) {
  $state = Invoke-ReleaseControl "Delete" $TargetDrain.Control $TargetDrain.LeaseId
  if (
    -not $state.ok -or
    [string]$state.protocol -ne "beian.release.v1" -or
    [string]$state.instance_id -ne [string]$TargetDrain.Control.instance_id -or
    [int]$state.pid -ne [int]$TargetDrain.Control.pid -or
    [string]$state.version -ne $ExpectedVersion -or
    [string]$state.state -ne "open"
  ) {
    throw "目标 8787 冒烟通过但 release drain 未能原子解除"
  }
}

function Test-PortListening([int]$Port) {
  $raw = @(& netstat.exe -ano 2>$null)
  $netstatCode = $LASTEXITCODE
  if ($netstatCode -ne 0 -or $raw.Count -eq 0) {
    throw "netstat.exe -ano 探测失败 exit=$netstatCode，拒绝把端口当作未监听"
  }
  $pat = ":$Port\s+.+(LISTENING|侦听)"
  return [bool]($raw | Select-String -Pattern $pat)
}

function Get-ListenerPid([int]$Port) {
  $raw = @(& netstat.exe -ano 2>$null)
  $netstatCode = $LASTEXITCODE
  if ($netstatCode -ne 0 -or $raw.Count -eq 0) {
    throw "netstat.exe -ano PID 探测失败 exit=$netstatCode，拒绝继续"
  }
  $pat = ":$Port\s+.+(LISTENING|侦听)\s+(\d+)\s*$"
  foreach ($line in $raw) {
    $m = [regex]::Match([string]$line, $pat)
    if ($m.Success) {
      $n = [int]$m.Groups[2].Value
      if ($n -gt 0) { return $n }
    }
  }
  return $null
}

function Test-DataDirInsideRepo([string]$DataDir, [string]$RepoRoot) {
  $d = [System.IO.Path]::GetFullPath($DataDir).TrimEnd("\", "/")
  $r = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd("\", "/")
  if ([string]::Equals($d, $r, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  $prefix = $r + [IO.Path]::DirectorySeparatorChar
  return $d.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-ReleaseProcessAncestors {
  $found = @()
  $nextPid = $ReleaseProcessPid
  for ($depth = 0; $depth -lt 12 -and $nextPid -gt 0; $depth++) {
    $found += [int]$nextPid
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $nextPid" -ErrorAction Stop
    if (-not $row) { break }
    $parentPid = [int]$row.ParentProcessId
    if ($parentPid -le 0 -or $found -contains $parentPid) { break }
    $nextPid = $parentPid
  }
  return $found
}

function Get-LegacyOfflineBlockers {
  $blockers = New-Object 'System.Collections.Generic.List[string]'
  $activeJobStates = @("queued", "running", "comparing")
  $jobFiles = New-Object 'System.Collections.Generic.List[string]'
  $tasksDir = Join-Path $env:WB_DATA_DIR "tasks"
  if (Test-Path -LiteralPath $tasksDir -PathType Container) {
    foreach ($file in @(Get-ChildItem -LiteralPath $tasksDir -Filter "*.json" -File -ErrorAction Stop)) {
      [void]$jobFiles.Add($file.FullName)
    }
  }
  $mockupsDir = Join-Path $env:WB_DATA_DIR "mockups"
  if (Test-Path -LiteralPath $mockupsDir -PathType Container) {
    foreach ($dir in @(Get-ChildItem -LiteralPath $mockupsDir -Directory -ErrorAction Stop)) {
      $jobPath = Join-Path $dir.FullName "job.json"
      if (Test-Path -LiteralPath $jobPath -PathType Leaf) { [void]$jobFiles.Add($jobPath) }
    }
  }
  foreach ($path in $jobFiles) {
    try {
      $job = [System.IO.File]::ReadAllText($path, $Utf8NoBom) | ConvertFrom-Json
    } catch {
      [void]$blockers.Add("unreadable_job:" + [System.IO.Path]::GetFileName($path))
      continue
    }
    $jobState = [string]$job.job_status
    $status = [string]$job.status
    if ($activeJobStates -contains $jobState -or $activeJobStates -contains $status) {
      $jobId = [string]$job.id
      if (-not $jobId) { $jobId = [System.IO.Path]::GetFileNameWithoutExtension($path) }
      [void]$blockers.Add("active_job:${jobId}:${jobState}:${status}")
    }
  }

  $leaseCutoff = [DateTime]::UtcNow.AddMinutes(-2)
  $sessionsDir = Join-Path $env:WB_DATA_DIR "uploads\sessions"
  if (Test-Path -LiteralPath $sessionsDir -PathType Container) {
    foreach ($sessionDir in @(Get-ChildItem -LiteralPath $sessionsDir -Directory -ErrorAction Stop)) {
      $sessionPath = Join-Path $sessionDir.FullName "session.json"
      if (-not (Test-Path -LiteralPath $sessionPath -PathType Leaf)) { continue }
      try {
        $session = [System.IO.File]::ReadAllText($sessionPath, $Utf8NoBom) | ConvertFrom-Json
        $updatedAt = [DateTimeOffset]::Parse([string]$session.updated_at).UtcDateTime
        if ($updatedAt -ge $leaseCutoff) {
          [void]$blockers.Add("active_upload_session:" + $sessionDir.Name)
        }
      } catch {
        [void]$blockers.Add("unreadable_upload_session:" + $sessionDir.Name)
      }
    }
  }
  $receiptsDir = Join-Path $env:WB_DATA_DIR "uploads\receipts"
  if (Test-Path -LiteralPath $receiptsDir -PathType Container) {
    foreach ($incoming in @(Get-ChildItem -LiteralPath $receiptsDir -Directory -Filter ".incoming-*" -ErrorAction Stop)) {
      if ($incoming.LastWriteTimeUtc -ge [DateTime]::UtcNow.AddMinutes(-30)) {
        [void]$blockers.Add("active_multipart:" + $incoming.Name)
      }
    }
  }

  $ancestors = @(Get-ReleaseProcessAncestors)
  $rootNeedle = $Root.ToLowerInvariant()
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    $processPid = [int]$process.ProcessId
    if ($ancestors -contains $processPid) { continue }
    $name = [string]$process.Name
    $commandLine = [string]$process.CommandLine
    $desktopAutomation = @("illustrator.exe", "blender.exe", "cscript.exe", "wscript.exe") -contains $name.ToLowerInvariant()
    $repoWorker = $commandLine -and $commandLine.ToLowerInvariant().Contains($rootNeedle)
    if ($desktopAutomation -or $repoWorker) {
      [void]$blockers.Add("active_process:${processPid}:${name}")
    }
  }
  return @($blockers | Sort-Object -Unique)
}

function Assert-LegacyOfflineIdle {
  for ($pass = 1; $pass -le 2; $pass++) {
    $blockers = @(Get-LegacyOfflineBlockers)
    if ($blockers.Count -gt 0) {
      throw "legacy offline bootstrap 仍有活动作业/上传/桌面自动化，拒绝升版：$($blockers -join ',')"
    }
    if ($pass -eq 1) { Start-Sleep -Seconds 2 }
  }
  Write-Host "legacy offline bootstrap idle gate passed twice"
}

function Assert-LegacyBootstrapVersion([string]$PreVersion, [string]$TargetRevision) {
  $targetVersion = Get-RevisionText $TargetRevision "VERSION"
  try {
    $preRelease = [version]$PreVersion
    $targetRelease = [version]$targetVersion
  } catch {
    throw "-AllowLegacyOfflineBootstrap 的版本格式无效；当前=$PreVersion 目标=$targetVersion"
  }
  if (
    $preRelease -lt [version]"0.19.0.0" -or
    $preRelease -ge [version]"0.20.0.0" -or
    $targetRelease -lt [version]"0.20.0.0" -or
    $targetRelease -ge [version]"0.21.0.0"
  ) {
    throw "-AllowLegacyOfflineBootstrap 只允许已批准的 0.19.x -> 0.20.x 首次切换；当前=$PreVersion 目标=$targetVersion"
  }
}

function Stop-BeianWinSwService {
  $name = "beian-server-8787"
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $svc) {
    throw "找不到 Windows 服务 $name（WinSW），拒绝按 PID 盲杀监听进程"
  }
  Stop-Service -Name $name -Force -ErrorAction Stop
  for ($w = 0; $w -lt 30; $w++) {
    Start-Sleep -Seconds 1
    $status = (Get-Service -Name $name -ErrorAction Stop).Status
    if ($status -eq "Stopped") { break }
  }
  if ((Get-Service -Name $name -ErrorAction Stop).Status -ne "Stopped") {
    throw "Stop-Service $name 未在时限内进入 Stopped，拒绝按 PID 强杀"
  }
  if (Test-PortListening 8787) {
    throw "WinSW 已 Stopped 但 8787 仍在监听；拒绝仅凭瞬时 PID 杀进程，请管理员处理残留进程"
  }
}

function Start-BeianWinSwService {
  $name = "beian-server-8787"
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $svc) {
    throw "找不到 Windows 服务 $name（WinSW）。拒绝用 schtasks ONLOGON 兜底。"
  }
  try {
    Restart-Service -Name $name -Force -ErrorAction Stop
  } catch {
    Start-Service -Name $name -ErrorAction Stop
  }
}

function Sync-IllustratorAgentTaskToCurrentTree {
  $taskName = "beian-illustrator-agent"
  $installer = Join-Path $Root "scripts\windows\install-illustrator-agent.ps1"
  if (Test-Path -LiteralPath $installer -PathType Leaf) {
    Write-Host "install/update Session 1 Illustrator agent task"
    & $installer -Root $Root -DataRoot $env:WB_DATA_DIR -TaskName $taskName
    return
  }
  $prior = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($prior) {
    Write-Host "restored tree has no Illustrator agent; remove the task created by this upgrade"
    Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
}

function Write-AtomicReleaseJournal {
  if (-not $ReleaseJournalState) { throw "release journal is not armed" }
  $temporary = "$ReleaseJournalPath.$ReleaseProcessPid.tmp"
  [System.IO.File]::WriteAllText(
    $temporary,
    (($ReleaseJournalState | ConvertTo-Json -Depth 8 -Compress) + "`n"),
    $Utf8NoBom
  )
  try {
    if (Test-Path -LiteralPath $ReleaseJournalPath) {
      [System.IO.File]::Replace($temporary, $ReleaseJournalPath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      [System.IO.File]::Move($temporary, $ReleaseJournalPath)
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Set-ReleaseJournalStage([string]$Stage) {
  if (-not $ReleaseJournalState) { throw "release journal is not armed" }
  $ReleaseJournalState.stage = $Stage
  $ReleaseJournalState.updated_at = [DateTime]::UtcNow.ToString("o")
  Write-AtomicReleaseJournal
}

function Arm-GitMergeTransaction {
  if ([string]$ReleaseJournalState.stage -ne "agent_quiesce") {
    throw "Git merge 事务只能在 Illustrator Agent 静默后建立"
  }
  if ([bool]$ReleaseJournalState.git_transaction_armed -or [string]$ReleaseJournalState.git_transaction_owner) {
    throw "Git merge 事务所有权已经建立，拒绝覆盖"
  }
  Assert-GitMergeLocksAbsent "merge 前"
  $started = [DateTime]::UtcNow
  $ReleaseJournalState.git_transaction_protocol = "beian.git-merge-locks.v1"
  $ReleaseJournalState.git_transaction_operation = "merge-ff-only-main"
  $ReleaseJournalState.git_transaction_ref = "refs/heads/main"
  $ReleaseJournalState.git_transaction_target_sha = $TargetSha
  $ReleaseJournalState.git_transaction_source_stage = "agent_quiesce"
  $ReleaseJournalState.git_transaction_baseline = "all-absent"
  $ReleaseJournalState.git_transaction_lock_policy_sha256 = Get-GitMergeLockPolicySha256
  $ReleaseJournalState.git_transaction_started_at = $started.ToString("o")
  $ReleaseJournalState.git_transaction_start_filetime_utc = $started.ToFileTimeUtc().ToString()
  $ReleaseJournalState.git_transaction_owner = (
    "beian.git-merge-locks.v1|pid=$ReleaseProcessPid|start=$ReleaseProcessStartFileTimeUtc" +
    "|op=merge-ff-only-main|target=$TargetSha"
  )
  $ReleaseJournalState.git_transaction_armed = $true
  $ReleaseJournalState.updated_at = $started.ToString("o")
  Write-AtomicReleaseJournal
}

function Quote-WatchdogArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Copy-AtomicFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "发版恢复组件缺失：$Source"
  }
  New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($Destination)) | Out-Null
  $temporary = "$Destination.$ReleaseProcessPid.tmp"
  Copy-Item -LiteralPath $Source -Destination $temporary -Force
  try {
    if (Test-Path -LiteralPath $Destination) {
      [System.IO.File]::Replace($temporary, $Destination, [System.Management.Automation.Language.NullString]::Value)
    } else {
      [System.IO.File]::Move($temporary, $Destination)
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Set-ReleaseRuntimeAcl {
  New-Item -ItemType Directory -Force -Path $ReleaseRuntimeDir | Out-Null
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  foreach ($sidValue in @("S-1-5-18", "S-1-5-32-544")) {
    $sid = [System.Security.Principal.SecurityIdentifier]::new($sidValue)
    $security.AddAccessRule(
      [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        $rights,
        $inheritance,
        $propagation,
        $allow
      )
    )
  }
  [System.IO.Directory]::SetAccessControl($ReleaseRuntimeDir, $security)
}

function Prepare-ReleaseRecoveryRuntime {
  Set-ReleaseRuntimeAcl
  Copy-AtomicFile (Join-Path $ReleaseSourceDir "release-recover.ps1") $ReleaseRecoveryPath
  Copy-AtomicFile (Join-Path $ReleaseSourceDir "install-illustrator-agent.ps1") $ReleaseInstallerPath
  Copy-AtomicFile (Join-Path $ReleaseSourceDir "release-dependency-check.mjs") $ReleaseDependencyCheckPath
}

function Register-ReleaseWatchdog {
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Quote-WatchdogArgument $ReleaseRecoveryPath),
    "-JournalPath", (Quote-WatchdogArgument $ReleaseJournalPath),
    "-TaskName", (Quote-WatchdogArgument $ReleaseWatchdogTask)
  ) -join " "
  $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
  $trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew
  Register-ScheduledTask `
    -TaskName $ReleaseWatchdogTask `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Beian release rollback watchdog" `
    -Force | Out-Null
}

function Arm-ReleaseRecovery(
  [string]$PreSha,
  [string]$PreVersion,
  [string]$PythonPath,
  [string]$ReleaseLeaseId,
  [string]$RequestedTargetSha,
  [string]$RequestedTargetVersion
) {
  Register-ReleaseWatchdog
  $script:ReleaseJournalState = [ordered]@{
    protocol = $ReleaseRecoveryProtocol
    root = $Root
    data_root = [System.IO.Path]::GetFullPath($env:WB_DATA_DIR)
    pre_sha = $PreSha
    pre_version = $PreVersion
    release_pid = $ReleaseProcessPid
    release_started_at = $ReleaseProcessStartedAt
    release_start_filetime_utc = $ReleaseProcessStartFileTimeUtc
    release_lease_id = $ReleaseLeaseId
    stage = "armed"
    updated_at = [DateTime]::UtcNow.ToString("o")
    last_error = ""
    failed_from_stage = ""
    git_transaction_armed = $false
    git_transaction_protocol = ""
    git_transaction_operation = ""
    git_transaction_ref = ""
    git_transaction_target_sha = ""
    git_transaction_source_stage = ""
    git_transaction_baseline = ""
    git_transaction_lock_policy_sha256 = ""
    git_transaction_started_at = ""
    git_transaction_start_filetime_utc = ""
    git_transaction_owner = ""
    dependency_mutated = $false
    deps_mode = [string]$DependencyHandoff.Mode
    deps_old_fingerprint = [string]$DependencyHandoff.FromFingerprint
    deps_new_fingerprint = [string]$DependencyHandoff.ToFingerprint
    deps_root = [string]$DependencyHandoff.StagingRoot
    deps_stage_path = [string]$DependencyHandoff.StageSource
    deps_backup_path = [string]$DependencyHandoff.BackupDir
    deps_failed_path = [string]$DependencyHandoff.FailedDir
    deps_set = @($DependencySetRelativePaths | ForEach-Object { $_.Replace('\', '/') })
    deps_old_presence = $DependencyHandoff.OldPresence
    deps_old_tree_marker = [string]$DependencyHandoff.OldTreeMarker
    deps_stage_stamp = [string]$DependencyHandoff.StampPath
    deps_stage_stamp_sha256 = [string]$DependencyHandoff.StampSha256
    deps_swap_progress = [ordered]@{}
    ui_mutated = $false
    python_mutated = $false
    agent_mutated = $false
    python_executable = $PythonPath
    runtime_recovery = $ReleaseRecoveryPath
    recovery_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ReleaseRecoveryPath).Hash.ToLowerInvariant()
    runtime_installer = $ReleaseInstallerPath
    runtime_installer_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ReleaseInstallerPath).Hash.ToLowerInvariant()
    runtime_dependency_check = $ReleaseDependencyCheckPath
    runtime_dependency_check_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ReleaseDependencyCheckPath).Hash.ToLowerInvariant()
    ui_snapshot = $ReleaseUiSnapshotDir
    ui_snapshot_sha256 = $ReleaseUiSnapshotSha256
    target_sha = $RequestedTargetSha
    target_version = $RequestedTargetVersion
    target_ui_sha256 = ""
  }
  Write-AtomicReleaseJournal
  Write-Host "release recovery armed task=$ReleaseWatchdogTask preSha=$PreSha"
}

function Commit-ReleaseRecovery([string]$ExpectedTargetSha, [string]$ExpectedTargetVersion) {
  if (
    [string]$ReleaseJournalState.target_sha -ne $ExpectedTargetSha -or
    [string]$ReleaseJournalState.target_version -ne $ExpectedTargetVersion
  ) {
    throw "提交目标与停服前锁定的 TargetSha/VERSION 不一致"
  }
  $ReleaseJournalState.target_ui_sha256 = Get-DirectoryFingerprint (Join-Path $Root "apps\web\ui\dist")
  Set-ReleaseJournalStage "committed"
}

function Disarm-ReleaseRecovery {
  Unregister-ScheduledTask -TaskName $ReleaseWatchdogTask -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ReleaseJournalPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ReleaseRecoveryPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ReleaseInstallerPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ReleaseDependencyCheckPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $DependencyStageStampRuntimePath -Force -ErrorAction SilentlyContinue
  $script:ReleaseJournalState = $null
}

function Acquire-ReleaseLock {
  try {
    $script:ReleaseLockStream = [System.IO.FileStream]::new(
      $ReleaseLockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    throw "另一个发版或恢复事务仍在运行"
  }
  $identityBytes = $Utf8NoBom.GetBytes("pid=$ReleaseProcessPid start_filetime_utc=$ReleaseProcessStartFileTimeUtc`n")
  $ReleaseLockStream.SetLength(0)
  $ReleaseLockStream.Write($identityBytes, 0, $identityBytes.Length)
  $ReleaseLockStream.Flush($true)
}

function Release-ReleaseLock {
  if ($ReleaseLockStream) {
    try { $ReleaseLockStream.Dispose() } catch { }
    $script:ReleaseLockStream = $null
  }
}

function Remove-UnarmedReleaseRuntime {
  if (Test-Path -LiteralPath $ReleaseJournalPath -PathType Leaf) { return }

  try {
    Unregister-ScheduledTask -TaskName $ReleaseWatchdogTask -Confirm:$false -ErrorAction SilentlyContinue
  } catch {
    Write-Warning "release pre-journal cleanup could not unregister watchdog: $($_.Exception.Message)"
  }

  # Only delete artifacts owned by this release transaction. File.Delete avoids
  # the Windows PowerShell 5 FileSystemProvider failure that can mask the real
  # pre-journal exception; an unknown entry keeps the runtime directory intact.
  foreach ($path in @(
    $ReleaseRecoveryPath,
    $ReleaseInstallerPath,
    $ReleaseDependencyCheckPath,
    $DependencyStageStampRuntimePath,
    $ReleaseLockPath
  )) {
    try {
      [System.IO.File]::Delete($path)
    } catch {
      Write-Warning "release pre-journal cleanup could not delete $path`: $($_.Exception.Message)"
    }
  }

  if ([System.IO.Directory]::Exists($ReleaseUiSnapshotDir)) {
    try {
      [System.IO.Directory]::Delete($ReleaseUiSnapshotDir, $true)
    } catch {
      Write-Warning "release pre-journal cleanup could not delete UI snapshot: $($_.Exception.Message)"
    }
  }
  if ([System.IO.Directory]::Exists($ReleaseRuntimeDir)) {
    try {
      [System.IO.Directory]::Delete($ReleaseRuntimeDir, $false)
    } catch {
      Write-Warning "release pre-journal cleanup left an unknown runtime artifact: $($_.Exception.Message)"
    }
  }
}

function Invoke-ArmedRecovery([string]$Why) {
  if (-not $ReleaseJournalState -and -not (Test-Path -LiteralPath $ReleaseJournalPath)) { return }
  # committed 是不可逆切换点：目标进程已在 drain 中通过完整冒烟。之后即使
  # 放行响应丢失，也只能继续完成目标版本，不能再回滚到可能不理解新写入的旧树。
  if (-not $ReleaseJournalState -or [string]$ReleaseJournalState.stage -ne "committed") {
    try {
      if ($ReleaseJournalState) {
        if (-not [string]$ReleaseJournalState.failed_from_stage) {
          $ReleaseJournalState.failed_from_stage = [string]$ReleaseJournalState.stage
        }
      }
      Set-ReleaseJournalStage "failed"
    } catch { }
  }
  Release-ReleaseLock
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  & $powershell `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $ReleaseRecoveryPath `
    -JournalPath $ReleaseJournalPath `
    -TaskName $ReleaseWatchdogTask `
    -Force
  if ($LASTEXITCODE -ne 0) {
    throw "$Why；自动恢复失败。watchdog 会继续重试，保持现场并检查 $ReleaseJournalPath"
  }
  $script:ReleaseJournalState = $null
  Write-Host "$Why；已完成独立恢复事务并核对最终服务身份"
}

$env:WB_PUBLIC = "1"
$env:WB_DEV_DISPLAY_LOGIN = "false"
if (Test-DataDirInsideRepo $env:WB_DATA_DIR $Root) {
  throw "WB_PUBLIC=1 时 WB_DATA_DIR 不能在仓库内，当前=$($env:WB_DATA_DIR)"
}

if (Test-Path -LiteralPath $ReleaseJournalPath -PathType Leaf) {
  if (-not (Test-Path -LiteralPath $ReleaseRecoveryPath -PathType Leaf)) {
    throw "发现未完成发版 journal，但独立恢复脚本缺失：$ReleaseRecoveryPath"
  }
  $recoveryPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  & $recoveryPowerShell `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $ReleaseRecoveryPath `
    -JournalPath $ReleaseJournalPath `
    -TaskName $ReleaseWatchdogTask
  if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $ReleaseJournalPath)) {
    throw "上一次发版事务尚未恢复完成，拒绝开始新发版"
  }
}

Set-ReleaseRuntimeAcl
Acquire-ReleaseLock
try {
  if ($Restart) {
    Write-Host "-Restart 已隐含：脚本总是先停 8787 再 pull"
  }

  Prepare-ReleaseRecoveryRuntime

# Git hygiene while :8787 is still up. Actions downloads the new release
# components to RUNNER_TEMP, so the production checkout needs no bootstrap
# checkout/reset and cannot strand an unowned index.lock before the journal.
Fetch-OriginMain
$TargetSha = Resolve-ReleaseTarget $TargetSha
$requestedTargetVersion = Get-RevisionText $TargetSha "VERSION"
if ($requestedTargetVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  throw "TargetSha 的 VERSION 无效：$requestedTargetVersion"
}
Write-Host "release target locked SHA=$TargetSha VERSION=$requestedTargetVersion"
Write-Host "restore package-lock.json worktree from HEAD without touching the index"
Restore-NpmLockfileWorktree
$branch = Get-GitSingleLine "git symbolic-ref --short HEAD" @(
  "symbolic-ref", "--quiet", "--short", "HEAD"
)
if ($branch -ne "main") {
  throw "当前分支不是 main，拒绝切分支或停 8787"
}
$rawStatus = @(Invoke-GitChecked "git status" @("status", "--porcelain", "--untracked-files=no"))
$dirty = @($rawStatus | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() -ne "" })
if ($dirty.Count -gt 0) {
  throw "工作树有未提交改动，拒绝停 8787:`n$($dirty -join "`n")"
}
$preSha = (Get-GitSingleLine "git rev-parse HEAD" @("rev-parse", "HEAD")).ToLowerInvariant()
$fastForward = Invoke-GitResult -GitArgs @("merge-base", "--is-ancestor", $preSha, $TargetSha)
if ([int]$fastForward.ExitCode -ne 0) {
  throw "当前 HEAD 不能 ff-only 到 TargetSha；过期 workflow 不得回退或部署旁支"
}
$ahead = Get-GitSingleLine "git rev-list origin/main..HEAD" @(
  "rev-list", "--count", "origin/main..HEAD"
)
if ($ahead -ne "0") {
  throw "本地 main 比 origin/main 多 $ahead 个 commit，拒绝停 8787"
}

$preVersion = (Get-Content -Raw (Join-Path $Root "VERSION")).Trim()
Write-Host "pre-stop SHA=$preSha VERSION=$preVersion"
Clear-GithubToken
$releasePython = [string]$env:WB_PYTHON
if (-not $releasePython) {
  $releasePython = Join-Path $Root "apps\web\backend\.venv\Scripts\python.exe"
}
$releasePython = [System.IO.Path]::GetFullPath($releasePython)
Assert-PythonRequirementsUnchanged $preSha $TargetSha
$DependencyHandoff = Get-DependencyHandoffPlan $preSha $TargetSha
if ([string]$DependencyHandoff.Mode -eq "npm-staged") {
  Write-Host "npm dependency graph changed; build and verify an offline stage while :8787 still serves"
  Prepare-StagedDependencies $DependencyHandoff $preSha
}
Assert-OfflineDependencyHandoff $preSha $TargetSha $releasePython
Assert-OfflineRuntimeIntegrity $releasePython
Snapshot-UiDist
Assert-GitMergeLocksAbsent "停服前"

$drain = $null
$releaseLeaseId = ""
try {
  $drain = Enter-ReleaseDrain
  if ($drain) {
    $drained = $false
    $lastBlockers = @()
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      $state = Invoke-ReleaseControl "Get" $drain.Control $drain.LeaseId
      if ([string]$state.state -ne "draining") { throw "release drain 意外解除，拒绝停服务" }
      if ([string]$state.lease_id -ne [string]$drain.LeaseId) { throw "release drain lease 已被替换，拒绝停服务" }
      if ([string]$state.mode -ne "lease") { throw "release drain 尚未进入事务阶段却已改变模式，拒绝停服务" }
      $lastBlockers = @($state.blocker_codes | ForEach-Object { [string]$_ })
      if ($state.ready -eq $true) { $drained = $true; break }
      Start-Sleep -Milliseconds 250
    }
    if (-not $drained) {
      throw "release drain 等待超时，blocker_codes=$($lastBlockers -join ',')"
    }
    # 最后续租一次，给 Stop-Service 留出完整租约窗口；业务是否可停由 Hono 聚合。
    $finalDrainState = Invoke-ReleaseControl "Get" $drain.Control $drain.LeaseId
    if ($finalDrainState.ready -ne $true -or [string]$finalDrainState.mode -ne "lease") {
      throw "release drain 最终复核失败，blocker_codes=$(@($finalDrainState.blocker_codes) -join ',')"
    }
    Write-Host "release drain ready: all new business writes are blocked"
  } else {
    # 旧服务不认识 admission gate，无法在保持对外接单时安全自举。只有运维已在
    # 明确维护窗停掉旧 8787，且没有任何 worker 时才允许首次切换。
    if (Test-PortListening 8787) {
      throw "当前服务缺 release control。首次升到 0.20 必须先进入批准维护窗并停止旧 8787，拒绝带 TOCTOU 自动切换"
    }
    if (-not $AllowLegacyOfflineBootstrap) {
      throw "旧 8787 已停但没有 release control；批准维护窗必须显式传 -AllowLegacyOfflineBootstrap"
    }
    Assert-LegacyBootstrapVersion $preVersion $TargetSha
    Assert-LegacyOfflineIdle
    Write-Host "offline maintenance bootstrap explicitly approved: :8787 already stopped"
  }
  $releaseLeaseId = if ($drain) { [string]$drain.LeaseId } else { [Guid]::NewGuid().ToString("N") }
  Arm-ReleaseRecovery `
    $preSha `
    $preVersion `
    $releasePython `
    $releaseLeaseId `
    $TargetSha `
    $requestedTargetVersion
} catch {
  if ($drain) { Exit-ReleaseDrain $drain }
  throw
}

# journal 与 SYSTEM watchdog 都已持久化以后，把短租约提升为不自动过期的事务
# fence。此后即使发版进程消失、机器重启或构建超过两分钟，也只能由同一
# release_lease_id 的提交/恢复路径放行。
try {
  if ($drain) {
    $drain = Promote-ReleaseDrain $drain
    Write-Host "release drain promoted to persistent transaction fence"
  } else {
    Write-StartupDrainFence $releaseLeaseId
    Write-Host "legacy offline bootstrap armed persistent transaction fence"
  }
} catch {
  Invoke-ArmedRecovery "发版事务围栏建立失败"
  throw
}

# Stop only through WinSW. A residual listener after Stopped is a hard failure; do not
# race a reused netstat PID with process-tree termination.
try {
  Set-ReleaseJournalStage "stopping"
  Write-Host "Stop-Service beian-server-8787 so WinSW onfailure does not respawn"
  Stop-BeianWinSwService
  Set-ReleaseJournalStage "stopped"
} catch {
  if ($drain -and (Test-PortListening 8787)) {
    try { Exit-ReleaseDrain $drain } catch { }
  }
  Invoke-ArmedRecovery "停服阶段失败"
  throw
}

try {
  # Persist ownership before touching the Agent. The immutable target installer
  # disables its keep-alive trigger and stops the process while preserving the
  # InteractiveToken principal that an older rollback tree may need.
  $ReleaseJournalState.agent_mutated = $true
  Set-ReleaseJournalStage "agent_quiesce"
  & $ReleaseInstallerPath `
    -DataRoot $env:WB_DATA_DIR `
    -TaskName "beian-illustrator-agent" `
    -Quiesce

  Arm-GitMergeTransaction
  Set-ReleaseJournalStage "merging"
  Invoke-GitChecked "git merge --ff-only TargetSha" @("merge", "--ff-only", $TargetSha) |
    ForEach-Object { Write-Host ([string]$_) }
  $mergedHeadSha = (Get-GitSingleLine "git rev-parse merged HEAD" @("rev-parse", "HEAD")).ToLowerInvariant()
  if ($mergedHeadSha -ne $TargetSha) {
    throw "merge 后 HEAD=$mergedHeadSha，不是停服前锁定的 TargetSha=$TargetSha"
  }
  $sha = Get-GitSingleLine "git rev-parse --short HEAD" @("rev-parse", "--short", "HEAD")
  $ver = (Get-Content -Raw VERSION).Trim()
  if ($ver -ne $requestedTargetVersion) {
    throw "merge 后 VERSION=$ver，不是停服前锁定的 $requestedTargetVersion"
  }
  Set-ReleaseJournalStage "merged"
  Write-Host "tree $sha VERSION=$ver"

  Clear-GithubToken
  if ([string]$DependencyHandoff.Mode -eq "npm-staged") {
    Invoke-DependencySwap $DependencyHandoff
    Assert-LiveDependencyMatchesTarget $DependencyHandoff $releasePython
  }
  Assert-OfflineDependencyHandoff $preSha $TargetSha $releasePython
  if ([string]$DependencyHandoff.Mode -eq "npm-staged") {
    Write-Host "dependency graph changed; swapped verified offline node_modules from $($DependencyHandoff.StageSource)"
  } else {
    Write-Host "dependency graph unchanged; reuse verified offline node_modules and Python environment"
  }

  $ReleaseJournalState.ui_mutated = $true
  Set-ReleaseJournalStage "ui_build"
  npm run build -w beian-ui
  if ($LASTEXITCODE -ne 0) { throw "npm run build -w beian-ui 失败 exit=$LASTEXITCODE" }

  Write-Host "requirements unchanged; reuse verified offline Python environment"

  Set-ReleaseJournalStage "agent_sync"
  Sync-IllustratorAgentTaskToCurrentTree

  Set-ReleaseJournalStage "starting"
  # 目标 Node 必须继承同一 lease 并保持拒写，直到版本、listener、logo 和
  # journal commit 全部成功；不能在冒烟失败仍可能回滚时先接新业务。
  Write-StartupDrainFence $releaseLeaseId
  Write-Host "start beian-server WB_DATA_DIR=$($env:WB_DATA_DIR)"
  # GitHub Actions kills the job process tree. Restart-Service beian-server-8787 is outside that tree.
  Start-BeianWinSwService
  Set-ReleaseJournalStage "smoke"
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $health = Get-Health
    if ($health -and $health.ok) { $ok = $true; break }
  }
  if (-not $ok) { throw "重启后 :8787 /api/health 没起来" }
  if ($health.version -ne $ver) {
    throw "health.version=$($health.version) 但 VERSION=$ver，拒绝 SMOKE ok"
  }
  $targetDrain = Get-TargetReleaseDrain $releaseLeaseId $ver

  # Only the trusted main release may exercise the Hangzhou InteractiveToken
  # desktop. Pull requests never execute on the production self-hosted runner.
  # The target remains behind the transaction fence until this Session 1
  # pipe -> VBS -> JSX identity probe has passed.
  $illustratorSmoke = Join-Path $Root "scripts\windows\illustrator-jsx-smoke.ps1"
  if (-not (Test-Path -LiteralPath $illustratorSmoke -PathType Leaf)) {
    throw "目标版本缺少 Illustrator Session 1 冒烟脚本"
  }
  $smokePowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  & $smokePowerShell -NoProfile -ExecutionPolicy Bypass -File $illustratorSmoke
  if ($LASTEXITCODE -ne 0) {
    throw "Illustrator Session 1 冒烟失败 exit=$LASTEXITCODE"
  }

  # RF-11: Blender contract smoke after Illustrator identity smoke.
  # Hangzhou freeze: 0.21.45.0 hangzhou-release 34186013159 measured ~63s, so
  # TimeoutMs is 90000. Failure keeps the existing drain/fence and falls
  # through the same recovery throw path. PowerShell does not copy
  # generation/GLB checks. Skip (do not roll back) when Hangzhou has no
  # resolved Blender executable; skip is not 质量门杭州实跑.
  $blenderSmoke = Join-Path $Root "scripts\windows\blender-contract-smoke.ps1"
  if (-not (Test-Path -LiteralPath $blenderSmoke -PathType Leaf)) {
    throw "目标版本缺少 Blender 合同冒烟脚本"
  }
  $blenderExe = [string]$env:WB_BLENDER
  if (-not $blenderExe) { $blenderExe = [string]$env:BLENDER_EXECUTABLE }
  if (-not $blenderExe) {
    $blenderDataDir = $env:WB_DATA_DIR
    if (-not $blenderDataDir) { $blenderDataDir = "C:\supply\data" }
    $blenderSettings = Join-Path $blenderDataDir "settings.json"
    if (Test-Path -LiteralPath $blenderSettings -PathType Leaf) {
      try {
        $blenderSettingsObj = Get-Content -LiteralPath $blenderSettings -Raw -Encoding UTF8 | ConvertFrom-Json
        $blenderExe = [string]$blenderSettingsObj.BLENDER_EXECUTABLE
      } catch {
        $blenderExe = ""
      }
    }
  }
  if (-not $blenderExe -or -not (Test-Path -LiteralPath $blenderExe -PathType Leaf)) {
    Write-Host "Blender 合同冒烟跳过：未解析到 BLENDER_EXECUTABLE（跳过不算质量门杭州实跑）"
  } else {
    $env:WB_BLENDER = $blenderExe
    & $smokePowerShell -NoProfile -ExecutionPolicy Bypass -File $blenderSmoke -Python $releasePython -TimeoutMs 90000
    if ($LASTEXITCODE -ne 0) {
      throw "Blender 合同冒烟失败 exit=$LASTEXITCODE"
    }
  }

  $logo = Invoke-WebRequest -Uri "http://127.0.0.1:8787/brand/logo-mark.png" -TimeoutSec 10 -UseBasicParsing
  if ($logo.StatusCode -ne 200) { throw "logo HTTP $($logo.StatusCode)" }
  $png = $null
  if ($logo.Content -is [byte[]]) {
    $png = $logo.Content
  } elseif ($logo.RawContentStream) {
    $ms = New-Object System.IO.MemoryStream
    $logo.RawContentStream.CopyTo($ms)
    $png = $ms.ToArray()
  }
  if (-not $png -or $png.Length -lt 8 -or $png[0] -ne 0x89 -or $png[1] -ne 0x50) {
    throw "logo 不是 PNG"
  }
  Write-Host "SMOKE ok version=$($health.version) sha=$sha logo=$($logo.StatusCode) bytes=$($png.Length)"
  Commit-ReleaseRecovery $mergedHeadSha $ver
  Open-TargetReleaseDrain $targetDrain $ver
  Disarm-ReleaseRecovery
  try {
    Complete-DependencyHandoffRetention $DependencyHandoff
  } catch {
    Write-Warning "dependency retention cleanup failed after commit: $($_.Exception.Message)"
  }
  Write-Host "不要动 cloudflared。Mac 不要 run beian。不要并行跑本脚本。"
  Write-Host "公网核对: curl https://www.jianghua.site/api/health  （version 应等于本机）"
} catch {
  Invoke-ArmedRecovery "升版失败"
  throw
}
} finally {
  Release-ReleaseLock
  try {
    Remove-UnarmedReleaseRuntime
  } catch {
    Write-Warning "release pre-journal cleanup itself failed: $($_.Exception.Message)"
  }
}
