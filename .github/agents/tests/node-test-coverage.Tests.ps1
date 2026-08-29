#Requires -Version 7.0
#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.0.0' }

# Every Node test file must be reachable from CI, and a COMMENT is not reachable.
#
# The failure this exists to stop is a quiet one. CI runs Pester over ./.github
# and nothing else, so a `*.test.js` added under templates/ with no wrapper in
# this directory passes on the author's machine, is never executed on the pull
# request, and reports green either way. That is worse than having no test: the
# suite's own coverage is what a reviewer trusts when deciding a change is safe.
# It is the same class of defect as #304 -- a suite that never ran reading as a
# suite that passed.
#
# The first version of this guard matched the filename anywhere in the RAW text
# of any wrapper, which meant `# TODO: add a wrapper for foo.test.js` counted as
# coverage. A guard against false green that is itself satisfied by a TODO
# reproduces the exact bug it was written to prevent, so coverage is now defined
# against EXECUTABLE text only:
#
#   1. comments are stripped before matching -- line, trailing and block; and
#   2. the mention must come from a wrapper that actually invokes `node`, so a
#      file that names a test and runs nothing does not vouch for it.
#
# What it still cannot prove is that the wrapper runs THAT test rather than some
# other one, and it does not try to; orphaning is the failure that happens. The
# stripper is line-oriented and does not track here-strings, so a `#` inside a
# multi-line here-string is over-stripped. That direction is deliberate:
# over-stripping reports a spurious orphan and fails loudly, where
# under-stripping is the silent false green above.

BeforeAll {
    # Defined here rather than at file scope: Pester runs each It in a scope
    # that does not see file-scope functions, but does see what BeforeAll
    # defines. The self-tests in the second Describe drive these directly.

    function Remove-PowerShellComments {
        param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

        # Block comments first: they span lines, so the line scanner below
        # cannot see them.
        $withoutBlocks = [regex]::Replace($Text, '(?s)<#.*?#>', ' ')

        $out = foreach ($line in ($withoutBlocks -split "`r?`n")) {
            $sb = [System.Text.StringBuilder]::new()
            $inSingle = $false
            $inDouble = $false
            for ($i = 0; $i -lt $line.Length; $i++) {
                $ch = $line[$i]
                if ($ch -eq '`' -and $inDouble) {
                    # A backtick escape inside a double-quoted string consumes
                    # the next character, which may itself be a quote.
                    [void]$sb.Append($ch)
                    if ($i + 1 -lt $line.Length) { [void]$sb.Append($line[$i + 1]); $i++ }
                    continue
                }
                if ($ch -eq "'" -and -not $inDouble) { $inSingle = -not $inSingle }
                elseif ($ch -eq '"' -and -not $inSingle) { $inDouble = -not $inDouble }
                elseif ($ch -eq '#' -and -not $inSingle -and -not $inDouble) { break }
                [void]$sb.Append($ch)
            }
            $sb.ToString()
        }
        return (@($out) -join "`n")
    }

    function Get-RunnerText {
        # The executable text of every wrapper that actually invokes node,
        # joined. A wrapper that runs nothing vouches for nothing.
        param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$WrapperText)

        $runners = foreach ($raw in $WrapperText) {
            $code = Remove-PowerShellComments -Text $raw
            if ($code -match '(?m)(^|[^\w.-])node\b') { $code }
        }
        return (@($runners) -join "`n")
    }

    function Get-OrphanNodeTest {
        param(
            [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$TestFileName,
            [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$WrapperText
        )
        $runnerText = Get-RunnerText -WrapperText $WrapperText
        return @($TestFileName | Where-Object { -not $runnerText.Contains($_) })
    }

    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\') | Select-Object -ExpandProperty Path
    $script:ScriptsDir = Join-Path $script:RepoRoot 'templates/web-api-discovery/scripts'

    $script:NodeTests = @(
        Get-ChildItem -LiteralPath $script:ScriptsDir -Recurse -File -Filter '*.test.js' |
            Select-Object -ExpandProperty Name |
            Sort-Object -Unique
    )

    $script:WrapperText = @(
        Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.Tests.ps1' |
            ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }
    )

    # The self-tests below need two synthetic filenames, and they must NOT
    # appear in this file as literals. This file is itself part of the corpus
    # the real check scans, so a literal `foo.test.js` sitting in executable
    # text here would vouch for a real foo.test.js that no wrapper runs --
    # accidental coverage granted by the coverage guard itself. Assembling the
    # names from fragments keeps the corpus clean.
    $script:ProbeName = 'zz-orphan-probe' + '.test' + '.js'
    $script:CoveredName = 'zz-covered-probe' + '.test' + '.js'

    $script:RealRunner = @"
Describe 'x' {
    It 'runs' {
        `$out = & node (Join-Path `$dir '$($script:CoveredName)')
        `$LASTEXITCODE | Should -Be 0
    }
}
"@
}

Describe 'Node test files are covered by a Pester wrapper' {
    It 'finds Node test files to check' {
        $script:NodeTests.Count | Should -BeGreaterThan 0
    }

    It 'finds wrapper files to check against' {
        $script:WrapperText.Count | Should -BeGreaterThan 0
    }

    It 'every *.test.js under templates/web-api-discovery/scripts is named by a wrapper' {
        $orphans = Get-OrphanNodeTest -TestFileName $script:NodeTests -WrapperText $script:WrapperText

        $orphans -join ', ' | Should -BeExactly '' -Because (
            'CI runs Pester over ./.github only, so a Node test no wrapper names never ' +
            'runs on the pull request while still reporting green. Add a wrapper in ' +
            '.github/agents/tests/ that invokes it and asserts $LASTEXITCODE is 0.')
    }
}

Describe 'the coverage check cannot be satisfied by a mention that runs nothing' {
    # These drive the helpers with synthetic wrapper text, so they pin the
    # guard's own semantics without touching the repo. A guard whose weakness is
    # untested is a guard nobody can trust to have stayed strong.

    It 'a filename named only in a line comment is NOT coverage' {
        # The reviewer's exact reproduction: a TODO promising a wrapper someday.
        $wrapper = "# TODO: someday add a wrapper for $($script:ProbeName)`n" + $script:RealRunner
        $orphans = Get-OrphanNodeTest -TestFileName @($script:ProbeName) -WrapperText @($wrapper)
        $orphans | Should -Contain $script:ProbeName -Because (
            'a TODO invokes nothing; counting it as coverage reproduces the false-green ' +
            'bug this guard exists to catch')
    }

    It 'a filename named only in a trailing comment is NOT coverage' {
        $wrapper = $script:RealRunner + "`n`$x = 1  # see $($script:ProbeName)"
        $orphans = Get-OrphanNodeTest -TestFileName @($script:ProbeName) -WrapperText @($wrapper)
        $orphans | Should -Contain $script:ProbeName
    }

    It 'a filename named only in a block comment is NOT coverage' {
        $wrapper = "<#`n  Related: $($script:ProbeName)`n#>`n" + $script:RealRunner
        $orphans = Get-OrphanNodeTest -TestFileName @($script:ProbeName) -WrapperText @($wrapper)
        $orphans | Should -Contain $script:ProbeName
    }

    It 'a filename in executable code of a wrapper that runs node IS coverage' {
        $orphans = Get-OrphanNodeTest -TestFileName @($script:CoveredName) -WrapperText @($script:RealRunner)
        $orphans | Should -BeNullOrEmpty
    }

    It 'a filename in a wrapper that never invokes node is NOT coverage' {
        $wrapper = "Describe 'x' { It 'y' { Test-Path '$($script:ProbeName)' | Should -BeTrue } }"
        $orphans = Get-OrphanNodeTest -TestFileName @($script:ProbeName) -WrapperText @($wrapper)
        $orphans | Should -Contain $script:ProbeName -Because (
            'a wrapper that runs nothing vouches for nothing')
    }

    It 'this file leaks no synthetic filename into the corpus it scans' {
        # The bug this pins was found by probing: the self-tests originally used
        # literal filenames, this file invokes node inside its fixture, so the
        # guard granted coverage to any real file sharing a fixture's name -- and
        # a real orphan by that name went undetected. The guard must not be able
        # to vouch for a file because of its own test data.
        $self = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'node-test-coverage.Tests.ps1') -Raw
        $code = Remove-PowerShellComments -Text $self
        $code | Should -Not -Match ([regex]::Escape($script:ProbeName))
        $code | Should -Not -Match ([regex]::Escape($script:CoveredName))
    }

    It 'a # inside a quoted string does not start a comment' {
        # Over-stripping would report spurious orphans. That fails loudly rather
        # than silently, but it is still wrong, so it is pinned too.
        $stripped = Remove-PowerShellComments -Text '$msg = "count #1"  # trailing'
        $stripped | Should -Match '#1'
        $stripped | Should -Not -Match 'trailing'
    }
}
