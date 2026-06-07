# Plan: Make the dev cycle reliably DISPLAY the result at the end (#190)

## Issue

Closes #190.

## Problem

At end of dev cycle the agent should DISPLAY the result so the user can confirm
the change worked without re-running the command. Today Phase 5b is silently
skipped, and even when run it only emits a `file:///` link rather than the
actual result.

## Confirmed decisions

1. Result display is MANDATORY on every dev-loop run; a gate-enforced field of
   the Task Complete Summary; never silently skipped by the agent.
2. Form depends on change type, mapping onto Publish-Evidence.ps1's existing
   Inline (.md) vs ArtifactReference (binary/UI) classification:
   - Inline -> render the real result INLINE (command + ANSI-stripped output;
     refactor -> test-run summary / "no behavior change" attestation).
   - ArtifactReference -> `file:///` link (plus PR link) only.
3. Strip ANSI escape sequences from echoed inline content (clean fenced block).
4. Opt-out: default ON; natural-language opt-out ("skip evidence display" /
   "skip the output") backed by `-SkipDisplay` switch. When skipped: suppress
   inline echo but STILL print the `Evidence (local): file:///` link line, and
   record that the display was skipped by user request.

## Constraints

- Shared upstream instruction files: generic + ASCII-only. No project names,
  domains, hardcoded paths, deps.
- Pre-production: replace old wording outright; no backwards-compat shims.
- Publish-Evidence.ps1 change is behavior-first: failing Pester test FIRST.

## Acceptance criteria

- Inline `.md` artifact: helper echoes the artifact CONTENT (delimited) to
  stdout in addition to the `Evidence (local): file:///` line, in both
  `-LocalOnly` and normal modes.
- ANSI escape sequences in the artifact are stripped from the echoed output.
- ArtifactReference (binary/UI): raw content NOT echoed (link-only preserved).
- `-SkipDisplay`: content NOT echoed but `file:///` link line still printed.
- All instruction docs updated to require + enforce the display; ASCII-only,
  no project leakage.
- `Invoke-Pester -Path .github/skills/evidence-capture/tests/` all green.

## Implementation checklist (bite-sized tasks)

1. [ ] RED: extend Publish-Evidence.Tests.ps1 with four tests
   (inline content echoed; ANSI stripped; ArtifactReference NOT echoed;
   -SkipDisplay suppresses echo but keeps link). Observe RED.
2. [ ] GREEN: add `-SkipDisplay` switch + inline content echo (ANSI-stripped)
   to Publish-Evidence.ps1 Inline path; echo in both LocalOnly and normal modes.
3. [ ] Update evidence-capture/SKILL.md: add "Result display" contract +
   compliance checklist item; document `-SkipDisplay` opt-out.
4. [ ] Update dev-loop.agent.md Phase 5b: mandatory "Display the result" step;
   harden "hard gate, never skipped by agent"; document NL opt-out -> -SkipDisplay;
   update "When the Loop Is Complete".
5. [ ] Update dev-loop-phase-gate/SKILL.md: after-Phase-5b gate item for the
   displayed result.
6. [ ] Update copilot-instructions.md + CLAUDE.md: mandatory Result display
   field in Task Complete Summary; remove soft "omit" escape for it; note opt-out.
7. [ ] Verify: Pester green; manual helper run (echo, -SkipDisplay, binary);
   scan changed files for leakage + non-ASCII.