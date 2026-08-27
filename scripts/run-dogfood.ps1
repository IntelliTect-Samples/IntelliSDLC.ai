<#
.SYNOPSIS
    One-shot dogfood reproducer for the web-api-discovery agent against tripit.com.

.DESCRIPTION
    Runs the web-api-discovery agent end-to-end against TripIt and diffs the
    generated wrapper against a hand-written reference project. If the supplied
    Playwright storageState is still valid (cheap HTTPS 200/JSON probe against
    api.tripit.com), a live capture is invoked via capture-cdp.js. Otherwise a
    synthetic HAR built from the reference project's endpoint inventory is used
    (faithful "as-if dogfood"). The synthetic path is fully deterministic and
    committable-safe: no real user data ever leaves your machine.

    The generated wrapper is written to -Out (default $env:TEMP\dogfood-tripit-<ts>)
    and is NEVER committed. Diff results are printed and (optionally) written to
    a markdown report path.

.PARAMETER StorageState
    Path to a Playwright storageState.json for tripit.com. Required only when
    -Mode is 'live' or 'auto'. Ignored when -Mode is 'synthetic'.

.PARAMETER Reference
    Path to the hand-written reference project (e.g. D:\Git\TripItEx). Required.

.PARAMETER Out
    Output directory for the generated wrapper. Defaults to a fresh timestamped
    folder under $env:TEMP. Created if missing.

.PARAMETER Mode
    'auto' (default) -- probe session, fall back to synthetic on non-200.
    'live'           -- force live capture (fails if storageState is invalid).
    'synthetic'      -- skip probe; always use synthetic HAR.

.PARAMETER ReportPath
    Optional path to write a markdown summary of the run. Default: no file
    written (only stdout).

.EXAMPLE
    .\scripts\run-dogfood.ps1 -StorageState C:\tmp\tripit-storageState.json -Reference D:\Git\TripItEx

.NOTES
    Reproducibility scaffolding for issue #58 / epic #34. Outputs are written
    OUTSIDE the repo. See docs/dogfood/tripit-dry-run-report.md for canonical
    run results.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)] [string] $StorageState,
    [Parameter(Mandatory = $true)]  [string] $Reference,
    [Parameter(Mandatory = $false)] [string] $Out,
    [ValidateSet('auto', 'live', 'synthetic')]
    [string] $Mode = 'auto',
    [Parameter(Mandatory = $false)] [string] $ReportPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# =====================================================================
# Helpers
# =====================================================================

function Invoke-SessionProbe {
    param([Parameter(Mandatory)][string] $StorageStatePath)
    $json = Get-Content $StorageStatePath -Raw | ConvertFrom-Json
    $cookieHeader = ($json.cookies | Where-Object { $_.domain -like '*tripit.com' } |
        ForEach-Object { "$($_.name)=$($_.value)" }) -join '; '
    $req = [System.Net.HttpWebRequest]::Create('https://api.tripit.com/v1/list/trip/format/json')
    $req.Method = 'GET'
    $req.Headers.Add('Cookie', $cookieHeader)
    $req.UserAgent = 'Mozilla/5.0 (dogfood-probe)'
    $req.Accept = 'application/json'
    $req.Timeout = 8000
    try {
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return $code
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return -1
    } catch {
        return -1
    }
}

function New-HarEntry {
    param(
        [Parameter(Mandatory)][string] $Method,
        [Parameter(Mandatory)][string] $Url,
        [Parameter(Mandatory)][string] $RespBody
    )
    [ordered]@{
        startedDateTime = '2025-01-01T00:00:00.000Z'
        time            = 100
        request         = [ordered]@{
            method      = $Method
            url         = $Url
            httpVersion = 'HTTP/1.1'
            cookies     = @()
            headers     = @(
                [ordered]@{ name = 'Cookie';       value = 'session_id=REDACTED_SESSION; it_csrf=REDACTED_CSRF; _abck=REDACTED_AKAMAI' }
                [ordered]@{ name = 'X-CSRF-Token'; value = 'REDACTED_CSRF' }
                [ordered]@{ name = 'Accept';       value = 'application/json' }
                [ordered]@{ name = 'User-Agent';   value = 'Mozilla/5.0' }
            )
            queryString = @()
            headersSize = -1
            bodySize    = 0
        }
        response = [ordered]@{
            status      = 200
            statusText  = 'OK'
            httpVersion = 'HTTP/1.1'
            cookies     = @()
            headers     = @(
                [ordered]@{ name = 'Content-Type'; value = 'application/json' }
                [ordered]@{ name = 'Set-Cookie';   value = 'session_id=REDACTED_SESSION; Path=/; Secure; HttpOnly' }
            )
            content = [ordered]@{
                size     = $RespBody.Length
                mimeType = 'application/json'
                text     = $RespBody
            }
            redirectURL = ''
            headersSize = -1
            bodySize    = $RespBody.Length
        }
        cache    = [ordered]@{}
        timings  = [ordered]@{ send = 0; wait = 100; receive = 0 }
    }
}

function Write-SyntheticHar {
    param([Parameter(Mandatory)][string] $Path)
    # Endpoint inventory + response SHAPES mirror TripItEx (Models/Trip.cs,
    # Profile.cs, ListResponse.cs, etc.). Values are obvious placeholders --
    # no real user data appears anywhere in this file.
    $entries = @(
        (New-HarEntry -Method GET -Url 'https://api.tripit.com/api/v2/list/trip?past=true&page_num=1&page_size=25' `
            -RespBody '{"timestamp":"2025-01-01T00:00:00Z","num_bytes":42,"page_num":1,"page_size":25,"max_page":1,"Trip":[{"id":"100","display_name":"Sample Trip","start_date":"2025-02-01","end_date":"2025-02-05","primary_location":"Seattle, WA","is_private":false,"image_url":"https://example.invalid/img.jpg","relative_url":"/trip/show/id/100"}]}'),
        (New-HarEntry -Method GET -Url 'https://api.tripit.com/api/v2/get/profile' `
            -RespBody '{"display_name":"Sample User","screen_name":"sample","public_display_name":"Sample","company":"Example Inc","home_city":"Seattle","locale":"en_US","ts_pre_check_id":null}'),
        (New-HarEntry -Method GET -Url 'https://api.tripit.com/api/v2/travelerProfile/get?profile_ref=current' `
            -RespBody '{"traveler_first_name":"Sample","traveler_last_name":"User","traveler_email":"sample@example.invalid","date_of_birth":"1990-01-01","gender":"unspecified"}'),
        (New-HarEntry -Method GET -Url 'https://api.tripit.com/api/v2/purchasedProductInfo' `
            -RespBody '{"is_pro":true,"is_subscription":true,"product_name":"TripIt Pro","expiration_date":"2026-01-01"}'),
        (New-HarEntry -Method GET -Url 'https://api.tripit.com/api/v2/appConfig' `
            -RespBody '{"feature_flags":{"pro_alerts":true,"refunds":false},"min_app_version":"10.0.0"}'),
        (New-HarEntry -Method GET -Url 'https://api.tripit.com/api/v2/gtmDataAsJson' `
            -RespBody '{"user_id_hash":"0000000000000000","is_pro":true,"locale":"en_US"}'),
        (New-HarEntry -Method GET -Url 'https://api.tripit.com/api/v2/listProAlerts' `
            -RespBody '{"timestamp":"2025-01-01T00:00:00Z","num_bytes":0,"page_num":1,"page_size":25,"max_page":1,"ProAlert":[]}')
    )
    $har = [ordered]@{
        log = [ordered]@{
            version = '1.2'
            creator = [ordered]@{ name = 'run-dogfood.ps1'; version = '1.0' }
            entries = $entries
        }
    }
    Set-Content -Encoding utf8 -Path $Path -Value ($har | ConvertTo-Json -Depth 12)
}

function Compare-Endpoints {
    param(
        [Parameter(Mandatory)][string] $GeneratedDir,
        [Parameter(Mandatory)][string] $ReferenceDir
    )
    # Literal endpoints: "/api/..." in quotes (reference style: hand-written paths).
    $literalRegex = '"(/[a-zA-Z0-9][a-zA-Z0-9/._-]+)"'
    # Templated endpoints: $"/api/..." with {id}-style placeholders (generated style).
    $templateRegex = '\$"(/[a-zA-Z0-9][a-zA-Z0-9/._{}-]+)"'

    $genCs = Get-ChildItem -Path $GeneratedDir -Filter *.cs -Recurse -ErrorAction SilentlyContinue
    $refCs = Get-ChildItem -Path $ReferenceDir -Filter TripItClient.cs -Recurse -ErrorAction SilentlyContinue

    $genLiterals  = @()
    $genTemplates = @()
    foreach ($f in $genCs) {
        $text = Get-Content $f.FullName -Raw
        $genLiterals  += [regex]::Matches($text, $literalRegex)  | ForEach-Object { $_.Groups[1].Value }
        $genTemplates += [regex]::Matches($text, $templateRegex) | ForEach-Object { $_.Groups[1].Value }
    }
    $genLiterals  = @($genLiterals  | Where-Object { $_ -match '^/api/' } | Sort-Object -Unique)
    $genTemplates = @($genTemplates | Where-Object { $_ -match '^/api/' } | Sort-Object -Unique)
    # "Generated endpoints" for coverage = literals (templates with {id} can't claim a specific endpoint).
    $genPaths = $genLiterals

    $refPaths = @()
    foreach ($f in $refCs) {
        $refPaths += [regex]::Matches((Get-Content $f.FullName -Raw), $literalRegex) |
            ForEach-Object { $_.Groups[1].Value }
    }
    $refPaths = @($refPaths | Where-Object { $_ -match '^/api/' } | Sort-Object -Unique)

    $all = @($genPaths + $refPaths) | Sort-Object -Unique
    $rows = foreach ($p in $all) {
        $inGen = $genPaths -contains $p
        $inRef = $refPaths -contains $p
        $status = if ($inGen -and $inRef) { 'OK' }
                  elseif ($inRef -and -not $inGen) { 'MISSED' }
                  else { 'BONUS' }
        [pscustomobject]@{ Endpoint = $p; Reference = $inRef; Generated = $inGen; Status = $status }
    }

    # Generated method signatures (typed wrapper surface).
    $methodRegex = 'public\s+async\s+Task<[^>]+>\s+(\w+Async)\s*\('
    $genMethods = @()
    foreach ($f in $genCs) {
        $genMethods += [regex]::Matches((Get-Content $f.FullName -Raw), $methodRegex) |
            ForEach-Object { $_.Groups[1].Value }
    }
    $genMethods = @($genMethods | Sort-Object -Unique)

    [pscustomobject]@{
        Rows                  = @($rows)
        ReferenceCount        = $refPaths.Count
        GeneratedCount        = $genPaths.Count
        IntersectionCount     = @($rows | Where-Object { $_.Status -eq 'OK' }).Count
        MissedCount           = @($rows | Where-Object { $_.Status -eq 'MISSED' }).Count
        BonusCount            = @($rows | Where-Object { $_.Status -eq 'BONUS' }).Count
        GeneratedPaths        = $genPaths
        GeneratedTemplatePaths = $genTemplates
        ReferencePaths        = $refPaths
        GeneratedMethods      = $genMethods
    }
}

function Write-DogfoodReport {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Mode,
        [Parameter(Mandatory)][string] $Out,
        [Parameter(Mandatory)][object] $Diff,
        [Parameter(Mandatory)][int]    $BuildExit,
        [Parameter(Mandatory)][int]    $TestExit
    )
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine("# TripIt Dogfood Run -- $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("Mode: $Mode")
    [void]$sb.AppendLine("Output: $Out")
    [void]$sb.AppendLine("Build exit: $BuildExit; Test exit: $TestExit")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("## Endpoint Coverage")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| Endpoint | Reference | Generated | Status |")
    [void]$sb.AppendLine("|---|---|---|---|")
    foreach ($r in $Diff.Rows) {
        [void]$sb.AppendLine("| $($r.Endpoint) | $($r.Reference) | $($r.Generated) | $($r.Status) |")
    }
    Set-Content -Path $Path -Value $sb.ToString() -Encoding utf8
}

# =====================================================================
# Main
# =====================================================================

$repoRoot   = Split-Path -Parent $PSScriptRoot
$scriptsDir = Join-Path $repoRoot 'templates/web-api-discovery/scripts'
$runAgent   = Join-Path $scriptsDir 'run-agent.js'

if (-not (Test-Path $runAgent)) {
    throw "run-agent.js not found at $runAgent (run from a clone of IntelliSDLC.ai)"
}
if (-not (Test-Path $Reference)) {
    throw "Reference project not found: $Reference"
}

if (-not $Out) {
    $ts  = (Get-Date -Format 'yyyyMMddTHHmmssZ')
    $Out = Join-Path $env:TEMP "dogfood-tripit-$ts"
}
New-Item -ItemType Directory -Path $Out -Force | Out-Null

# Decide live vs synthetic
$effectiveMode = $Mode
if ($Mode -in @('auto', 'live')) {
    if (-not $StorageState -or -not (Test-Path $StorageState)) {
        if ($Mode -eq 'live') { throw "-Mode live requires a valid -StorageState path" }
        $effectiveMode = 'synthetic'
        Write-Host "[dogfood] No storageState -> synthetic mode." -ForegroundColor Yellow
    } else {
        Write-Host "[dogfood] Probing api.tripit.com with stored cookies..." -ForegroundColor Cyan
        $probeStatus = Invoke-SessionProbe -StorageStatePath $StorageState
        Write-Host "[dogfood] Probe status: $probeStatus"
        if ($probeStatus -eq 200) {
            $effectiveMode = 'live'
        } else {
            if ($Mode -eq 'live') { throw "Probe returned $probeStatus; refusing to attempt live capture." }
            $effectiveMode = 'synthetic'
            Write-Host "[dogfood] Session not authenticated -> synthetic mode." -ForegroundColor Yellow
        }
    }
}

# Produce a HAR
$harDir  = Join-Path $Out 'har'
New-Item -ItemType Directory -Path $harDir -Force | Out-Null
$harPath = Join-Path $harDir 'tripit-dogfood.har'

if ($effectiveMode -eq 'live') {
    Write-Host "[dogfood] Invoking capture-cdp.js (live, polite-crawl)..." -ForegroundColor Cyan
    & node (Join-Path $scriptsDir 'capture-cdp.js') `
        --storage-state $StorageState --out $harPath --max-requests 10
    if ($LASTEXITCODE -ne 0) { throw "capture-cdp.js failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "[dogfood] Building synthetic HAR from TripItEx endpoint inventory..." -ForegroundColor Cyan
    Write-SyntheticHar -Path $harPath
}

# Run the agent pipeline (non-interactive)
$wrapperDir = Join-Path $Out 'wrapper'
Write-Host "[dogfood] Running run-agent.js -> $wrapperDir" -ForegroundColor Cyan
& node $runAgent `
    --har $harPath `
    --out $wrapperDir `
    --project 'TripIt' `
    --namespace 'TripIt' `
    --base-url 'https://api.tripit.com' `
    --no-sdlc `
    --fixed-time '2025-01-01T00:00:00Z'
$agentExit = $LASTEXITCODE
if ($agentExit -ne 0) { throw "run-agent.js failed (exit $agentExit)" }

# Build + test the generated wrapper
$buildLog = Join-Path $Out 'build.log'
$testLog  = Join-Path $Out 'test.log'
$buildExit = -1
$testExit  = -1
# The generator now emits a top-level .slnx (issue #65) so `dotnet build`
# from the wrapper root "just works" without probing for a specific csproj.
$slnFile = Get-ChildItem -Path $wrapperDir -Filter '*.slnx' -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $slnFile) {
    # Defensive fallback for older generator output: classic .sln, else first csproj.
    $slnFile = Get-ChildItem -Path $wrapperDir -Filter '*.sln' -File -ErrorAction SilentlyContinue | Select-Object -First 1
}
$buildTarget = if ($slnFile) { $slnFile.FullName } else {
    (Get-ChildItem -Path $wrapperDir -Recurse -Filter '*.csproj' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}

if ($buildTarget) {
    Write-Host "[dogfood] dotnet build $buildTarget" -ForegroundColor Cyan
    & dotnet build $buildTarget --nologo -v minimal *> $buildLog
    $buildExit = $LASTEXITCODE
    Write-Host "[dogfood] dotnet build exit=$buildExit (log: $buildLog)"
    if ($buildExit -eq 0) {
        Write-Host "[dogfood] dotnet test $buildTarget" -ForegroundColor Cyan
        & dotnet test $buildTarget --nologo --no-build -v minimal *> $testLog
        $testExit = $LASTEXITCODE
        Write-Host "[dogfood] dotnet test exit=$testExit (log: $testLog)"
    }
} else {
    Set-Content -Path $buildLog -Value 'no solution or csproj found to build'
}

# Diff vs reference
$diff = Compare-Endpoints -GeneratedDir $wrapperDir -ReferenceDir $Reference

Write-Host ""
Write-Host "================ Endpoint Coverage ================" -ForegroundColor Green
$diff.Rows | Format-Table -AutoSize
Write-Host ""
Write-Host "Mode:                $effectiveMode"
Write-Host "Generated wrapper:   $wrapperDir"
Write-Host "Build exit code:     $buildExit"
Write-Host "Test exit code:      $testExit"
Write-Host "Reference:           $Reference"
Write-Host "Endpoints (ref):     $($diff.ReferenceCount)"
Write-Host "Endpoints (gen):     $($diff.GeneratedCount)"
Write-Host "Templates (gen):     $($diff.GeneratedTemplatePaths -join ', ')"
Write-Host "Methods (gen):       $($diff.GeneratedMethods -join ', ')"
Write-Host "Intersection:        $($diff.IntersectionCount)"
Write-Host "Missed (ref-only):   $($diff.MissedCount)"
Write-Host "Bonus  (gen-only):   $($diff.BonusCount)"

if ($ReportPath) {
    Write-DogfoodReport -Path $ReportPath -Mode $effectiveMode -Out $Out -Diff $diff -BuildExit $buildExit -TestExit $testExit
    Write-Host "[dogfood] Report written: $ReportPath"
}
