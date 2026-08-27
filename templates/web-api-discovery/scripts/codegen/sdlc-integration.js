// sdlc-integration.js -- optional final stage of run-agent.js that pulls the
// IntelliSDLC.ai shared SDLC instructions/skills/agents into the freshly
// generated wrapper project (issue #56).
//
// Pure-Node stdlib. Deterministic, side-effect-free helpers are exported for
// direct testing; runSdlcStage() performs the spawn.
//
// Discovery order:
//   1. argScript -- explicit --sdlc-script <path> CLI flag
//   2. env.IntelliSDLC_AI_PATH -- local clone of IntelliSDLC.ai
//   3. sibling: <parent-of-scaffoldRepoRoot>/IntelliSDLC.ai/Pull-SDLC.ai.ps1
//
// Default behavior when no flag is given and stdin is not a TTY: skip the
// stage and print a one-line manual-run hint. This keeps the pipeline fully
// unattended-safe (e.g., the PR #55 e2e test).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MANUAL_HINT =
    'To pull the IntelliSDLC.ai shared SDLC instructions later, run:\n' +
    '  git clone https://github.com/IntelliTect-Samples/IntelliSDLC.ai\n' +
    '  pwsh -NoProfile -File ./IntelliSDLC.ai/Pull-SDLC.ai.ps1   # invoke from the project root';

function parseSdlcFlags(args, isTTY) {
    const yes = args['sdlc-yes'] === true;
    const no  = args['no-sdlc']  === true;
    if (yes && no) {
        return { mode: 'error', error: '--sdlc-yes and --no-sdlc are mutually exclusive' };
    }
    if (yes) return { mode: 'yes' };
    if (no)  return { mode: 'no', reason: '--no-sdlc' };
    if (!isTTY) return { mode: 'no', reason: 'non-interactive default' };
    return { mode: 'prompt' };
}

function discoverSdlcScript({ argScript, env, scaffoldRepoRoot }) {
    if (argScript) {
        return { path: path.resolve(argScript), source: 'arg', exists: fs.existsSync(argScript) };
    }
    const envPath = env && env.IntelliSDLC_AI_PATH;
    if (envPath && String(envPath).length > 0) {
        const candidate = path.join(envPath, 'Pull-SDLC.ai.ps1');
        return { path: candidate, source: 'env', exists: fs.existsSync(candidate) };
    }
    if (scaffoldRepoRoot) {
        const sibling = path.join(path.dirname(scaffoldRepoRoot), 'IntelliSDLC.ai', 'Pull-SDLC.ai.ps1');
        if (fs.existsSync(sibling)) {
            return { path: sibling, source: 'sibling', exists: true };
        }
    }
    return null;
}

function sdlcIntegrationReadmeSection() {
    const lines = [];
    lines.push('## SDLC Integration');
    lines.push('');
    lines.push('This project can be kept in sync with the shared');
    lines.push('[IntelliSDLC.ai](https://github.com/IntelliTect-Samples/IntelliSDLC.ai)');
    lines.push('instructions, skills, and agents (the `@dev-loop` workflow, behavior-first');
    lines.push('testing skill, evidence-capture skill, pre-commit infrastructure, etc.).');
    lines.push('');
    lines.push('### One-time setup');
    lines.push('');
    lines.push('From the project root:');
    lines.push('');
    lines.push('```bash');
    lines.push('git clone https://github.com/IntelliTect-Samples/IntelliSDLC.ai ../IntelliSDLC.ai');
    lines.push('pwsh -NoProfile -File ../IntelliSDLC.ai/Pull-SDLC.ai.ps1');
    lines.push('```');
    lines.push('');
    lines.push('`Pull-SDLC.ai.ps1` adds an `sdlc.ai` git remote and merges the upstream');
    lines.push('instructions into your repo on first run.');
    lines.push('');
    lines.push('### Keeping in sync');
    lines.push('');
    lines.push('Re-run the same command periodically. The script preserves consumer-owned');
    lines.push('files across syncs -- `project.instructions.md`, `CLAUDE.project.md`,');
    lines.push('`README.md`, and `.gitignore` are never overwritten by upstream changes.');
    lines.push('');
    return lines.join('\n');
}

function appendTranscript(transcriptPath, line) {
    try {
        fs.appendFileSync(transcriptPath, line + '\n', 'utf8');
    } catch { /* transcript is best-effort */ }
}

function runSdlcStage(opts) {
    const {
        outDir,
        args,
        isTTY,
        env,
        scaffoldRepoRoot,
        transcriptPath,
        stdout = process.stdout,
        stderr = process.stderr,
        spawnImpl = spawnSync,
    } = opts;

    stdout.write('==> Stage: sdlc-integration\n');

    const parsed = parseSdlcFlags(args, isTTY);
    if (parsed.mode === 'error') {
        stderr.write(`run-agent: ${parsed.error}\n`);
        appendTranscript(transcriptPath, 'sdlc-integration: error: ' + parsed.error);
        return { outcome: 'error', exitCode: 2, error: parsed.error };
    }
    if (parsed.mode === 'no') {
        stdout.write(MANUAL_HINT + '\n');
        const msg = 'sdlc-integration: skipped: ' + parsed.reason;
        appendTranscript(transcriptPath, msg);
        stdout.write(msg + '\n');
        return { outcome: 'skipped', exitCode: 0, reason: parsed.reason };
    }
    if (parsed.mode === 'prompt') {
        // Interactive prompts are out of scope for the autonomous test
        // pipeline; the orchestrator only calls runSdlcStage in 'yes' or 'no'
        // modes. If we somehow reach here, treat as non-interactive default.
        stdout.write(MANUAL_HINT + '\n');
        appendTranscript(transcriptPath, 'sdlc-integration: skipped: prompt mode not yet implemented');
        return { outcome: 'skipped', exitCode: 0, reason: 'prompt mode not yet implemented' };
    }

    // mode === 'yes' -> attempt discovery + spawn
    const found = discoverSdlcScript({
        argScript: args['sdlc-script'] || null,
        env: env || process.env,
        scaffoldRepoRoot,
    });

    if (!found || !found.exists) {
        const where = found ? `${found.source}=${found.path}` : 'no source';
        stdout.write(`sdlc-integration: Pull-SDLC.ai.ps1 not found (${where}).\n`);
        stdout.write(MANUAL_HINT + '\n');
        appendTranscript(transcriptPath, 'sdlc-integration: skipped: not found');
        return { outcome: 'skipped', exitCode: 0, reason: 'not found' };
    }

    stdout.write(`sdlc-integration: invoking ${found.path} (source=${found.source}) in ${outDir}\n`);
    const r = spawnImpl('pwsh', ['-NoProfile', '-File', found.path], {
        cwd: outDir,
        stdio: 'inherit',
    });
    if (r.error) {
        stderr.write(`sdlc-integration: failed to spawn pwsh: ${r.error.message}\n`);
        appendTranscript(transcriptPath, 'sdlc-integration: failed: ' + r.error.message);
        return { outcome: 'failed', exitCode: 0, reason: r.error.message };
    }
    if (r.status !== 0) {
        stderr.write(`sdlc-integration: Pull-SDLC.ai.ps1 exited ${r.status}\n`);
        appendTranscript(transcriptPath, 'sdlc-integration: failed: exit ' + r.status);
        // Wrapper is already generated; do not propagate this failure.
        return { outcome: 'failed', exitCode: 0, reason: 'exit ' + r.status };
    }
    appendTranscript(transcriptPath, 'sdlc-integration: completed (source=' + found.source + ')');
    stdout.write('sdlc-integration: completed\n');
    return { outcome: 'completed', exitCode: 0, scriptPath: found.path };
}

module.exports = {
    MANUAL_HINT,
    parseSdlcFlags,
    discoverSdlcScript,
    sdlcIntegrationReadmeSection,
    runSdlcStage,
};