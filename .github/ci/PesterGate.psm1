# PesterGate -- discovery and verdict logic for the CI Pester job.
#
# Exists because the "Pester tests (.github/)" job reported success while
# running zero tests (issue #304). Two independent defects produced that false
# green, and this module addresses both:
#
#   1. Pester's Find-File calls Get-Item without -Force, so it cannot resolve a
#      *hidden* path. `.github` is hidden on Linux (dot-prefix), so passing the
#      directory to Invoke-Pester resolved to nothing. Every Pester 5.x and 6.x
#      release behaves this way, so pinning a version is not a fix -- instead,
#      Get-PesterTestFile resolves the files itself and hands Pester file paths,
#      which are not hidden.
#
#   2. The gate only asked "did any test fail?". When Invoke-Pester throws,
#      -PassThru never assigns, and `$null.FailedCount -gt 0` is $false -- so
#      the one state it could not detect was the suite not running at all.
#      Test-PesterGate also asks "did any test run?".

Set-StrictMode -Version Latest

# Folders never worth descending into. .git in particular can hold hundreds of
# thousands of files; enumerating them only to discard the results is pure cost.
$script:SkipFolders = @('.git', '.svn', '.hg')

function Get-PesterTestFile {
    <#
    .SYNOPSIS
        Returns the absolute paths of every *.Tests.ps1 file beneath the given
        roots, including files inside hidden directories.

    .DESCRIPTION
        Walks each root explicitly with -Force so hidden directories (anything
        dot-prefixed on Linux, or carrying the Hidden attribute on Windows) are
        traversed. Handing the resulting file paths to Invoke-Pester avoids the
        Get-Item limitation that makes Invoke-Pester -Path ./.github resolve to
        nothing on Linux.

        Throws when a root does not exist. Returning an empty list for a
        mistyped path is precisely how a green build comes to mean nothing.

    .PARAMETER Path
        One or more directories (or files) to search.

    .OUTPUTS
        System.String[] -- absolute file paths, sorted and de-duplicated.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string[]]$Path
    )

    $found = [System.Collections.Generic.List[string]]::new()

    foreach ($root in $Path) {
        if (-not (Test-Path -LiteralPath $root)) {
            throw "Test root does not exist: $root"
        }

        $item = Get-Item -LiteralPath $root -Force

        if (-not $item.PSIsContainer) {
            if ($item.Name -like '*.Tests.ps1') { $found.Add($item.FullName) }
            continue
        }

        foreach ($file in (Get-TestFileInDirectory -Directory $item)) {
            $found.Add($file)
        }
    }

    return @($found | Sort-Object -Unique)
}

function Get-TestFileInDirectory {
    <#
    .SYNOPSIS
        Recursively yields *.Tests.ps1 paths under a directory, skipping VCS
        metadata folders. Internal helper for Get-PesterTestFile.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [System.IO.DirectoryInfo]$Directory
    )

    # -Force so hidden children are enumerated; the walk is manual so the VCS
    # folders below are never opened at all.
    foreach ($child in (Get-ChildItem -LiteralPath $Directory.FullName -Force -ErrorAction Stop)) {
        if ($child.PSIsContainer) {
            if ($script:SkipFolders -contains $child.Name) { continue }
            # A directory symlink or junction can point back up its own tree.
            # Following one recurses until the stack blows -- a discovery step
            # whose job is to never misbehave silently should not do that.
            if ($child.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) { continue }
            Get-TestFileInDirectory -Directory $child
        }
        elseif ($child.Name -like '*.Tests.ps1') {
            $child.FullName
        }
    }
}

function Test-PesterGate {
    <#
    .SYNOPSIS
        Decides whether a Pester run should gate the build, and says why.

    .DESCRIPTION
        Fails the build when any of the following holds:

          1. $Result is $null                  -- Invoke-Pester threw
          2. no test files were discovered     -- nothing to run
          3. $Result.TotalCount is below 1     -- nothing executed
          4. $Result.FailedCount is above 0    -- a test failed
          5. $Result.Result is not 'Passed'    -- a container errored with no
                                                  failed test, which FailedCount
                                                  alone would miss
          6. a discovered file produced no container -- discovery silently shrank

        Check 6 stands in for a hard-coded "expect at least N tests" floor: it
        catches partial collapse without a magic number to keep updated.

    .PARAMETER Result
        The object Invoke-Pester returns via -PassThru, or $null if it threw.

    .PARAMETER ExpectedFile
        The test file paths handed to Invoke-Pester, from Get-PesterTestFile.

    .OUTPUTS
        PSCustomObject with Passed ([bool]) and Reason ([string]).
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Result,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$ExpectedFile
    )

    $reason = Get-GateFailureReason -Result $Result -ExpectedFile $ExpectedFile

    if ($reason) {
        return [pscustomobject]@{ Passed = $false; Reason = $reason }
    }

    return [pscustomobject]@{
        Passed = $true
        Reason = "$($Result.TotalCount) test(s) ran across $(@($ExpectedFile).Count) file(s); all passed."
    }
}

function Get-GateFailureReason {
    <#
    .SYNOPSIS
        Returns the reason the run should fail the build, or $null if it should
        pass. Internal helper for Test-PesterGate.

    .DESCRIPTION
        Checks are ordered most-specific first, and the first match wins.
        "Nothing was discovered" precedes "no result object" deliberately: when
        there is nothing to run there is nothing for Invoke-Pester to have
        thrown from, so blaming it would misdiagnose.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()][AllowNull()][object]$Result,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ExpectedFile
    )

    $fileCount = @($ExpectedFile).Count

    if ($fileCount -eq 0) {
        return 'no test files were discovered, so the suite cannot have run.'
    }

    if ($null -eq $Result) {
        return 'Invoke-Pester produced no result object -- it threw before ' +
        '-PassThru could assign. This is the false green of issue #304.'
    }

    if ($Result.TotalCount -lt 1) {
        return "no tests ran ($fileCount file(s) were discovered). " +
        'A suite that executes nothing must never report success.'
    }

    if ($Result.FailedCount -gt 0) {
        return "$($Result.FailedCount) of $($Result.TotalCount) test(s) failed."
    }

    if ($Result.Result -ne 'Passed') {
        return "the run reported '$($Result.Result)' with no failed test -- " +
        'a container most likely errored during discovery.'
    }

    $missing = @(Get-FileWithoutContainer -Result $Result -ExpectedFile $ExpectedFile)

    if ($missing.Count -gt 0) {
        return "$($missing.Count) discovered file(s) produced no test container, " +
        "so discovery silently shrank: $($missing -join ', ')"
    }

    return $null
}

function Get-FileWithoutContainer {
    <#
    .SYNOPSIS
        Returns the discovered files that produced no Pester container.
        Internal helper for Get-GateFailureReason.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)][object]$Result,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ExpectedFile
    )

    $ran = @(Get-ContainerPath -Result $Result | ConvertTo-ComparablePath)

    return @($ExpectedFile | Where-Object { (ConvertTo-ComparablePath $_) -notin $ran })
}

function Get-ContainerPath {
    <#
    .SYNOPSIS
        Extracts the source file path from each container of a Pester result.
        Internal helper for Test-PesterGate.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][object]$Result)

    foreach ($container in @($Result.Containers)) {
        $item = $container.Item
        if ($null -eq $item) { continue }
        # File containers carry a FileInfo; ScriptBlock containers do not.
        if ($item.PSObject.Properties.Name -contains 'FullName') { $item.FullName }
        else { [string]$item }
    }
}

function ConvertTo-ComparablePath {
    <#
    .SYNOPSIS
        Normalizes a path for comparison: forward slashes, lower case. Internal
        helper so a container path and a discovered path match regardless of
        separator or casing.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory, ValueFromPipeline)][string]$Path)
    process { ($Path -replace '\\', '/').ToLowerInvariant() }
}

Export-ModuleMember -Function Get-PesterTestFile, Test-PesterGate
