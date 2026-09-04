#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }

# Tests for Publish-Evidence.ps1 -- the gh-invocation helper used by the
# evidence-capture skill. These are behavior-first tests: each one ships with
# the helper and verifies the observable outcome (the gh args passed and the
# returned object), not the internal layout of the script.

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot '..\helpers\Publish-Evidence.ps1' |
        Resolve-Path | Select-Object -ExpandProperty Path
    $script:TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "publish-evidence-tests-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $script:TempDir | Out-Null
}

AfterAll {
    if (Test-Path -LiteralPath $script:TempDir) {
        Remove-Item -LiteralPath $script:TempDir -Recurse -Force
    }
}

Describe 'Publish-Evidence' {

    Context 'when artifact is a small markdown file' {
        It 'classifies the mode as Inline' {
            $artifact = Join-Path $script:TempDir 'evidence.md'
            Set-Content -LiteralPath $artifact -Value "# Evidence`r`n`r`nHello." -NoNewline

            $captured = @()
            $stub = { param([string[]]$GhArgs) $captured += , $GhArgs }

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 42 -GhInvoker $stub

            $result.Mode | Should -Be 'Inline'
        }

        It 'posts the markdown content as the comment body' {
            $artifact = Join-Path $script:TempDir 'evidence2.md'
            $content = "# Evidence`r`n`r`nThe button now says Submit."
            Set-Content -LiteralPath $artifact -Value $content -NoNewline

            $bag = @{}
            $stub = { param([string[]]$GhArgs) $bag['args'] = $GhArgs }.GetNewClosure()

            & $script:ScriptPath -ArtifactPath $artifact -PullRequest 42 -GhInvoker $stub | Out-Null

            $bag['args'][0] | Should -Be 'pr'
            $bag['args'][1] | Should -Be 'comment'
            $bag['args'][2] | Should -Be '42'
            $bag['args'][3] | Should -Be '--body-file'
        }

        It 'returns the markdown content verbatim in the Comment property' {
            $artifact = Join-Path $script:TempDir 'evidence3.md'
            $content = "# Title`r`n`r`nSome body text with **bold**."
            Set-Content -LiteralPath $artifact -Value $content -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 7 -GhInvoker $stub

            $result.Comment | Should -Be $content
        }

        It 'passes --repo when Repo parameter is provided' {
            $artifact = Join-Path $script:TempDir 'evidence4.md'
            Set-Content -LiteralPath $artifact -Value '# X' -NoNewline

            $bag = @{}
            $stub = { param([string[]]$GhArgs) $bag['args'] = $GhArgs }.GetNewClosure()

            & $script:ScriptPath -ArtifactPath $artifact -PullRequest 7 `
                -Repo 'foo/bar' -GhInvoker $stub | Out-Null

            $bag['args'] | Should -Contain '--repo'
            $bag['args'] | Should -Contain 'foo/bar'
        }
    }

    Context 'when artifact is a binary file' {
        It 'classifies the mode as ArtifactReference for .png' {
            $artifact = Join-Path $script:TempDir 'screenshot.png'
            [System.IO.File]::WriteAllBytes($artifact, [byte[]](137,80,78,71,13,10,26,10))

            $stub = { param([string[]]$GhArgs) }

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 9 -GhInvoker $stub

            $result.Mode | Should -Be 'ArtifactReference'
        }

        It 'produces a reference comment that names the artifact' {
            $artifact = Join-Path $script:TempDir 'recording.mp4'
            [System.IO.File]::WriteAllBytes($artifact, [byte[]](0,0,0,1))

            $stub = { param([string[]]$GhArgs) }

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 9 -GhInvoker $stub

            $result.Comment | Should -Match 'recording.mp4'
            $result.Comment | Should -Match 'CI workflow artifacts'
        }

        It 'classifies the mode as ArtifactReference for HTML' {
            $artifact = Join-Path $script:TempDir 'ui.html'
            Set-Content -LiteralPath $artifact -Value '<html></html>' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 9 -GhInvoker $stub

            $result.Mode | Should -Be 'ArtifactReference'
        }
    }

    Context 'when markdown exceeds the inline size limit' {
        It 'falls back to ArtifactReference mode' {
            $artifact = Join-Path $script:TempDir 'big.md'
            # Generate ~2 KB of content, with a tiny inline limit to force fallback.
            Set-Content -LiteralPath $artifact -Value ('# Big' + ("`r`nline" * 200)) -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 1 `
                -MaxInlineSizeBytes 100 -GhInvoker $stub

            $result.Mode | Should -Be 'ArtifactReference'
        }
    }

    Context 'when given -WhatIf' {
        It 'does not invoke gh' {
            $artifact = Join-Path $script:TempDir 'whatif.md'
            Set-Content -LiteralPath $artifact -Value '# Whatif' -NoNewline

            $bag = @{ count = 0 }
            $stub = { param([string[]]$GhArgs) $bag['count'] = $bag['count'] + 1 }.GetNewClosure()

            & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -WhatIf | Out-Null

            $bag['count'] | Should -Be 0
        }
    }

    Context 'when the artifact path does not exist' {
        It 'throws' {
            $stub = { param([string[]]$GhArgs) }
            $missing = Join-Path $script:TempDir 'does-not-exist.md'

            { & $script:ScriptPath -ArtifactPath $missing -PullRequest 1 -GhInvoker $stub } |
                Should -Throw
        }
    }

    Context 'when -LocalOnly is passed' {
        It 'does not invoke gh' {
            $artifact = Join-Path $script:TempDir 'local-only.md'
            Set-Content -LiteralPath $artifact -Value '# Local only' -NoNewline

            $bag = @{ count = 0 }
            $stub = { param([string[]]$GhArgs) $bag['count'] = $bag['count'] + 1 }.GetNewClosure()

            & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -LocalOnly | Out-Null

            $bag['count'] | Should -Be 0
        }

        It 'returns Mode = LocalOnly on the output object' {
            $artifact = Join-Path $script:TempDir 'local-only-mode.md'
            Set-Content -LiteralPath $artifact -Value '# Local only mode' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -LocalOnly

            $result.Mode | Should -Be 'LocalOnly'
        }

        It 'still resolves and exposes the absolute ArtifactPath' {
            $artifact = Join-Path $script:TempDir 'local-only-path.md'
            Set-Content -LiteralPath $artifact -Value '# Path' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -LocalOnly

            $result.ArtifactPath | Should -Be ((Resolve-Path -LiteralPath $artifact).ProviderPath)
        }
    }

    Context 'file:// link emission' {
        It 'writes a file:/// URL with forward slashes to host output' {
            $artifact = Join-Path $script:TempDir 'link-emit.md'
            Set-Content -LiteralPath $artifact -Value '# Link emit' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $output = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -LocalOnly -InformationAction Continue 6>&1

            $joined = ($output | Out-String)
            $joined | Should -Match 'file:///'
            # Forward slashes only inside the URL portion (no backslashes between file:/// and the end of the line).
            $joined | Should -Match 'file:///[^\\]+'
        }

        It 'emits the file:// URL even when posting to a PR (non-LocalOnly)' {
            $artifact = Join-Path $script:TempDir 'link-emit-pr.md'
            Set-Content -LiteralPath $artifact -Value '# Link emit pr' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $output = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 9 `
                -GhInvoker $stub -InformationAction Continue 6>&1

            ($output | Out-String) | Should -Match 'file:///'
        }
    }

    Context 'inline result display' {
        It 'echoes the inline markdown content to output, not just the URL' {
            $artifact = Join-Path $script:TempDir 'echo-content.md'
            $content = "# Evidence`r`n`r`nThe widget now returns 42."
            Set-Content -LiteralPath $artifact -Value $content -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $output = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -LocalOnly -InformationAction Continue 6>&1

            ($output | Out-String) | Should -Match 'The widget now returns 42\.'
        }

        It 'echoes the inline content when posting to a PR (non-LocalOnly)' {
            $artifact = Join-Path $script:TempDir 'echo-content-pr.md'
            $content = "# Evidence`r`n`r`nResponse body equals OK-MARKER."
            Set-Content -LiteralPath $artifact -Value $content -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $output = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 9 `
                -GhInvoker $stub -InformationAction Continue 6>&1

            ($output | Out-String) | Should -Match 'OK-MARKER'
        }

        It 'strips ANSI escape sequences from the echoed inline content' {
            $artifact = Join-Path $script:TempDir 'ansi.md'
            $esc = [char]27
            $content = "# Out`r`n`r`n${esc}[31mERROR${esc}[0m red text"
            Set-Content -LiteralPath $artifact -Value $content -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $output = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -LocalOnly -InformationAction Continue 6>&1

            $joined = ($output | Out-String)
            $joined | Should -Match 'ERROR red text'
            $joined | Should -Not -Match ([regex]::Escape("$esc["))
        }

        It 'does not echo raw content for an ArtifactReference artifact' {
            $artifact = Join-Path $script:TempDir 'ui-noecho.html'
            Set-Content -LiteralPath $artifact -Value '<html>UNIQUEMARKERXYZ</html>' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $output = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -LocalOnly -InformationAction Continue 6>&1

            $joined = ($output | Out-String)
            $joined | Should -Not -Match 'UNIQUEMARKERXYZ'
            $joined | Should -Match 'file:///'
        }

        It 'suppresses the inline echo under -SkipDisplay but still prints the file:/// link' {
            $artifact = Join-Path $script:TempDir 'skip.md'
            $content = "# Skip`r`n`r`nSECRETMARKER123 should not appear."
            Set-Content -LiteralPath $artifact -Value $content -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $output = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -LocalOnly -SkipDisplay -InformationAction Continue 6>&1

            $joined = ($output | Out-String)
            $joined | Should -Not -Match 'SECRETMARKER123'
            $joined | Should -Match 'file:///'
        }
    }

    Context 'when -LocalOnly is passed without a pull request number (issue #311)' {
        # The Phase 5b local-link step runs BEFORE a PR exists, so there is no
        # number to supply. -PullRequest was declared Mandatory even though the
        # -LocalOnly path returns before ever reading it, so the documented step
        # exited 1 on a missing mandatory parameter. Every pre-existing
        # -LocalOnly test passes -PullRequest 5, which is why CI never saw it.

        It 'succeeds and reports Mode = LocalOnly' {
            $artifact = Join-Path $script:TempDir 'no-pr-mode.md'
            Set-Content -LiteralPath $artifact -Value '# No PR number' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $result = & $script:ScriptPath -ArtifactPath $artifact -GhInvoker $stub -LocalOnly

            $result.Mode | Should -Be 'LocalOnly'
        }

        It 'does not invoke gh' {
            $artifact = Join-Path $script:TempDir 'no-pr-nogh.md'
            Set-Content -LiteralPath $artifact -Value '# No PR gh' -NoNewline

            $bag = @{ count = 0 }
            $stub = { param([string[]]$GhArgs) $bag['count'] = $bag['count'] + 1 }.GetNewClosure()

            & $script:ScriptPath -ArtifactPath $artifact -GhInvoker $stub -LocalOnly | Out-Null

            $bag['count'] | Should -Be 0
        }

        It 'still emits the file:// URL -- the whole point of the Phase 5b step' {
            $artifact = Join-Path $script:TempDir 'no-pr-link.md'
            Set-Content -LiteralPath $artifact -Value '# No PR link' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $output = & $script:ScriptPath -ArtifactPath $artifact `
                -GhInvoker $stub -LocalOnly -InformationAction Continue 6>&1

            ($output | Out-String) | Should -Match 'Evidence \(local\): file:///'
        }

        It 'still honors -SkipDisplay' {
            $artifact = Join-Path $script:TempDir 'no-pr-skip.md'
            Set-Content -LiteralPath $artifact -Value '# UNIQUEBODYTOKEN' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            $output = & $script:ScriptPath -ArtifactPath $artifact `
                -GhInvoker $stub -LocalOnly -SkipDisplay -InformationAction Continue 6>&1
            # Keep only host/information output. The returned object carries the
            # body in its Comment property, which would otherwise render into the
            # formatted stream and defeat the -Not -Match assertion below.
            $text = $output |
                Where-Object { $_ -is [System.Management.Automation.InformationRecord] } |
                Out-String

            $text | Should -Match 'Evidence \(local\): file:///'
            $text | Should -Not -Match 'UNIQUEBODYTOKEN'
        }
    }

    Context 'when neither -PullRequest nor -LocalOnly is supplied (issue #311)' {
        It 'throws an error that names both ways forward' {
            $artifact = Join-Path $script:TempDir 'neither.md'
            Set-Content -LiteralPath $artifact -Value '# Neither' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            # PowerShell's generic missing-mandatory-parameter message gave no
            # hint that -LocalOnly is the intended pre-PR path; the replacement
            # must name both options.
            { & $script:ScriptPath -ArtifactPath $artifact -GhInvoker $stub } |
                Should -Throw -ExpectedMessage '*-PullRequest*'
            { & $script:ScriptPath -ArtifactPath $artifact -GhInvoker $stub } |
                Should -Throw -ExpectedMessage '*-LocalOnly*'
        }

        It 'throws under -WhatIf too, rather than previewing an undecided run' {
            # -WhatIf does not exempt the guard: the preview still has to know
            # whether the run WOULD post, so a missing decision is a usage error
            # rather than something to preview. Pinned because it is a behavior
            # change worth being deliberate about (independent review, #311).
            $artifact = Join-Path $script:TempDir 'neither-whatif.md'
            Set-Content -LiteralPath $artifact -Value '# Neither whatif' -NoNewline

            $stub = { param([string[]]$GhArgs) }

            { & $script:ScriptPath -ArtifactPath $artifact -GhInvoker $stub -WhatIf } |
                Should -Throw -ExpectedMessage '*-LocalOnly*'
        }

        It 'does not invoke gh when it throws' {
            $artifact = Join-Path $script:TempDir 'neither-nogh.md'
            Set-Content -LiteralPath $artifact -Value '# Neither gh' -NoNewline

            $bag = @{ count = 0 }
            $stub = { param([string[]]$GhArgs) $bag['count'] = $bag['count'] + 1 }.GetNewClosure()

            { & $script:ScriptPath -ArtifactPath $artifact -GhInvoker $stub } | Should -Throw
            $bag['count'] | Should -Be 0
        }
    }

    Context 'backward compatibility of the -PullRequest parameter (issue #311)' {
        # The fix must NOT become a breaking change: -PullRequest <n> -LocalOnly
        # together is what dev-loop.agent.md documented and what every
        # pre-existing -LocalOnly test does. Parameter sets would reject it.

        It 'still accepts -PullRequest together with -LocalOnly, and still posts nothing' {
            $artifact = Join-Path $script:TempDir 'compat-both.md'
            Set-Content -LiteralPath $artifact -Value '# Both' -NoNewline

            $bag = @{ count = 0 }
            $stub = { param([string[]]$GhArgs) $bag['count'] = $bag['count'] + 1 }.GetNewClosure()

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 5 `
                -GhInvoker $stub -LocalOnly

            $result.Mode | Should -Be 'LocalOnly'
            $bag['count'] | Should -Be 0
        }

        It 'still posts normally when -PullRequest is supplied without -LocalOnly' {
            $artifact = Join-Path $script:TempDir 'compat-post.md'
            Set-Content -LiteralPath $artifact -Value '# Post' -NoNewline

            $bag = @{}
            $stub = { param([string[]]$GhArgs) $bag['args'] = $GhArgs }.GetNewClosure()

            $result = & $script:ScriptPath -ArtifactPath $artifact -PullRequest 77 -GhInvoker $stub

            $result.Mode | Should -Be 'Inline'
            $bag['args'] | Should -Contain '77'
            $bag['args'] | Should -Contain 'comment'
        }
    }

}
