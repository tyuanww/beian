$ErrorActionPreference = "Stop"

$workflow = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "../../.github/workflows/hangzhou-release.yml")
$command = [regex]::Match($workflow, '(?ms)^ {10}powershell\.exe -NoProfile -ExecutionPolicy Bypass -Command "(.*?)"\r?$')
if (-not $command.Success) { throw "Could not locate the release bootstrap command" }
$bootstrap = [scriptblock]::Create(($command.Groups[1].Value -split '\r?\n\s*') -join ' ')

$files = @("release.ps1", "release-recover.ps1", "install-illustrator-agent.ps1", "release-dependency-check.mjs")
$requests = [System.Collections.Generic.List[object]]::new()
$downloadsComplete = "Synthetic release downloads complete"
$invalidProxy = "HTTPS_PROXY must be an HTTP proxy URL without credentials."

function Invoke-WebRequest {
    param([switch] $UseBasicParsing, [hashtable] $Headers, [uri] $Uri, [string] $OutFile, [uri] $Proxy)
    $requests.Add(@{ Uri = $Uri; Proxy = $Proxy; OutFile = $OutFile; Headers = $Headers; Basic = $UseBasicParsing })
    if ($requests.Count -eq $files.Count) { throw $downloadsComplete }
}

$env:RUNNER_TEMP = Join-Path ([System.IO.Path]::GetTempPath()) ("beian-release-bootstrap-" + [Guid]::NewGuid().ToString("N"))
$env:GITHUB_RUN_ID = "42"
$env:GITHUB_RUN_ATTEMPT = "3"
$env:GITHUB_REPOSITORY = "fixture/repo"
$env:GITHUB_SHA = "0000000000000000000000000000000000000012"
$env:GITHUB_TOKEN = "synthetic-token"
$downloadDir = Join-Path $env:RUNNER_TEMP "beian-release-42-3"
$defaultWebProxy = [System.Net.WebRequest]::DefaultWebProxy
$systemProxy = [System.Net.WebProxy]::new("http://127.0.0.1:3129")

try {
    foreach ($case in @(
        @{ Name = "runner proxy"; Https = "http://127.0.0.1:3128"; Bypass = "127.0.0.1, www.jianghua.site, api.github.com:80"; Proxy = "http://127.0.0.1:3128" },
        @{ Name = "unset proxy"; Https = $null },
        @{ Name = "host and port bypass"; Https = "http://127.0.0.1:3128"; Bypass = "localhost, API.GITHUB.COM:443"; Direct = $true },
        @{ Name = "domain bypass"; Https = "http://127.0.0.1:3128"; Bypass = ".github.com"; Direct = $true },
        @{ Name = "global bypass"; Https = "http://127.0.0.1:3128"; Bypass = "*"; Direct = $true },
        @{ Name = "invalid URI"; Https = "fixture-invalid"; Invalid = $true },
        @{ Name = "unsupported TLS proxy"; Https = "https://127.0.0.1:3128"; Invalid = $true },
        @{ Name = "credentialed proxy"; Https = "http://fixture:synthetic-secret@127.0.0.1:3128/"; Invalid = $true }
    )) {
        $requests.Clear()
        $env:HTTPS_PROXY = $case.Https
        $env:NO_PROXY = $case.Bypass
        [System.Net.WebRequest]::DefaultWebProxy = $systemProxy
        $expectedError = if ($case.Invalid) { $invalidProxy } else { $downloadsComplete }
        try {
            & $bootstrap
            throw "Bootstrap did not stop at the test boundary"
        } catch {
            if ($_.Exception.Message -ne $expectedError) {
                throw "Unexpected bootstrap result for $($case.Name)"
            }
        }
        if (Test-Path -LiteralPath $downloadDir) { throw "Bootstrap left its temporary downloads behind" }
        if ($case.Invalid) {
            if ($requests.Count -ne 0) { throw "Invalid proxy triggered downloads" }
            continue
        }
        $expectedDefault = if ($case.Direct) { $null } else { $systemProxy }
        if ([System.Net.WebRequest]::DefaultWebProxy -ne $expectedDefault) {
            throw "Unexpected default proxy for $($case.Name)"
        }
        for ($index = 0; $index -lt $files.Count; $index++) {
            $request = $requests[$index]
            $file = $files[$index]
            $uri = "https://api.github.com/repos/fixture/repo/contents/scripts/windows/${file}?ref=$env:GITHUB_SHA"
            if ($request.Uri -ne [uri] $uri -or $request.OutFile -ne (Join-Path $downloadDir $file)) {
                throw "Bootstrap request did not use the event SHA and temporary directory"
            }
            if ($request.Proxy -ne [uri] $case.Proxy) { throw "Unexpected request proxy for $($case.Name)" }
            if (-not $request.Basic -or $request.Headers.Authorization -ne "Bearer synthetic-token" -or
                $request.Headers.Accept -ne "application/vnd.github.raw+json") {
                throw "Bootstrap did not use the Contents API headers"
            }
        }
    }
} finally {
    [System.Net.WebRequest]::DefaultWebProxy = $defaultWebProxy
    Remove-Item -LiteralPath $env:RUNNER_TEMP -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "RELEASE_BOOTSTRAP_CONTRACT ok"
