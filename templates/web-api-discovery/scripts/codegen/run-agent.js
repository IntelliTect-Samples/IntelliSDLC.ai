#!/usr/bin/env node
/*
 * run-agent.js -- thin orchestrator for the web-api-discovery pipeline.
 *
 * Chains: sanitize-har -> verify-scrub -> detect-auth -> generate-wrapper.
 * Prints a clear "==> Stage N: <name>" banner before each step; exits with
 * the first failing stage's exit code. Zero dependencies.
 *
 * Usage:
 *   node run-agent.js --har <path> --out <dir> --project <Name> --namespace <Ns>
 *                     [--base-url <https://x>] [--profile <path>]
 *                     [--authors <s>] [--description <s>]
 *                     [--repository-url <s>] [--package-tags <s>]
 *                     [--fixed-time <iso8601>]
 *                     [--sdlc-script <path>] [--sdlc-yes | --no-sdlc]
 *
 * SDLC integration (optional final stage): when --sdlc-yes is passed and a
 * Pull-SDLC.ai.ps1 script is discovered (via --sdlc-script, IntelliSDLC_AI_PATH,
 * or a sibling clone), the script is invoked with cwd=<out> to pull shared
 * IntelliSDLC.ai instructions into the freshly generated project. Default in
 * non-interactive mode (no TTY) is to skip the stage and print a one-line hint.
 *
 * Exit codes:
 *   0 -- all stages succeeded
 *   2 -- usage / argument error (incl. mutually exclusive SDLC flags)
 *   N -- exit code of the first failing sub-step (passed through unchanged)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sdlc = require('./sdlc-integration.js');
const harProfile = require('../har/har-profile.js');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) {
            process.stderr.write(`run-agent: unexpected positional arg '${a}'\n`);
            process.exit(2);
        }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) { out[key] = true; }
        else { out[key] = next; i++; }
    }
    return out;
}

function usage(msg) {
    if (msg) process.stderr.write(`run-agent: ${msg}\n`);
    process.stderr.write(
        'usage: node run-agent.js --har <path> --out <dir> --project <Name> --namespace <Ns> ' +
        '[--base-url <https://x>] [--profile <path>] [--authors <s>] [--description <s>] ' +
        '[--repository-url <s>] [--package-tags <s>] [--fixed-time <iso8601>]\n');
    process.exit(2);
}

let transcriptPath = null;
function transcript(line) {
    if (!transcriptPath) return;
    try { fs.appendFileSync(transcriptPath, line + '\n', 'utf8'); } catch { /* best-effort */ }
}

function runStage(label, cmd, cmdArgs) {
    process.stdout.write(`==> Stage: ${label}\n`);
    transcript(`stage: ${label}: started`);
    const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
    if (r.error) {
        process.stderr.write(`run-agent: failed to spawn ${cmd}: ${r.error.message}\n`);
        process.exit(1);
    }
    if (r.status !== 0) {
        process.stderr.write(`run-agent: stage '${label}' failed with exit code ${r.status}\n`);
        process.exit(r.status);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h) usage();
    if (!args.har) usage('missing --har');
    if (!args.out) usage('missing --out');
    if (!args.project) usage('missing --project');
    if (!args.namespace) usage('missing --namespace');

    // Validate mutually-exclusive SDLC flags up-front so we fail fast (exit 2)
    // before doing any expensive HAR processing.
    if (args['sdlc-yes'] === true && args['no-sdlc'] === true) {
        process.stderr.write('run-agent: --sdlc-yes and --no-sdlc are mutually exclusive\n');
        process.exit(2);
    }

    const har = path.resolve(args.har);
    if (!fs.existsSync(har)) {
        process.stderr.write(`run-agent: --har file not found: ${har}\n`);
        process.exit(1);
    }

    const outDir = path.resolve(args.out);
    fs.mkdirSync(outDir, { recursive: true });

    // Working files live next to the output so a re-run is hermetic and the
    // user can inspect intermediates without hunting through /tmp.
    const work = path.join(outDir, '.run-agent');
    fs.mkdirSync(work, { recursive: true });
    const scrubbedHar = path.join(work, 'scrubbed.har');
    const legacySubs  = path.join(work, 'substitutions.legacy.json');
    const piiSubs     = path.join(work, 'substitutions.json');
    const authJson    = path.join(work, 'auth.json');
    // Transcript captures stage outcomes for post-hoc inspection and tests.
    // Truncated on each run; contents are intentionally timestamp-free to
    // preserve determinism of the working directory (the .run-agent folder
    // is already excluded from emitted-output parity checks).
    transcriptPath = path.join(work, 'transcript.log');
    fs.writeFileSync(transcriptPath, '', 'utf8');

    // The scripts tree is grouped by concern (issue #279): the scrub /
    // extract / classify tools live under har/, the emitters under codegen/.
    const scriptsDir = path.join(__dirname, '..');
    const harDir   = path.join(scriptsDir, 'har');
    const sanitize = path.join(harDir, 'sanitize-har.js');
    const verify   = path.join(harDir, 'verify-scrub.js');
    const detect   = path.join(harDir, 'detect-auth.js');
    const generate = path.join(__dirname, 'generate-wrapper.js');

    // The salt and the literal -> sentinel map come from the operator's
    // gitignored profile. There is no fallback: a default salt would make the
    // faker table predictable across projects, and a default literal map would
    // mean the literal-value scrub control silently does nothing.
    let profile;
    try {
        profile = harProfile.loadProfile({ profilePath: args.profile, startDir: outDir });
    } catch (e) {
        process.stderr.write(`run-agent: ${e.message}
`);
        process.exit(2);
    }

    const fixedTime = args['fixed-time'] || '2026-01-01T00:00:00.000Z';

    // Stage 1: sanitize the HAR (legacy regex + typed PII pipeline).
    runStage('sanitize-har', process.execPath, [
        sanitize,
        '--in', har,
        '--out', scrubbedHar,
        '--subs', legacySubs,
        '--profile', profile.path,
        '--pii-subs', piiSubs,
        '--fixed-time', fixedTime,
    ]);

    // Stage 2: verify-scrub confirms no plaintext PII / token leaked.
    runStage('verify-scrub', process.execPath, [verify, '--in', scrubbedHar, '--profile', profile.path]);

    // Stage 3: detect-auth -- emits {authModel, evidence[]} to stdout.
    process.stdout.write('==> Stage: detect-auth\n');
    const detectRes = spawnSync(process.execPath, [detect, scrubbedHar], { encoding: 'utf8' });
    if (detectRes.status !== 0) {
        process.stderr.write(detectRes.stderr || '');
        process.stderr.write(`run-agent: stage 'detect-auth' failed with exit code ${detectRes.status}\n`);
        process.exit(detectRes.status);
    }
    const detectJson = (detectRes.stdout || '').trim();
    fs.writeFileSync(authJson, detectJson + '\n', 'utf8');
    process.stdout.write(detectJson + '\n');
    let authModel = 'cookie';
    try { authModel = JSON.parse(detectJson).authModel || 'cookie'; } catch { /* keep default */ }
    if (authModel === 'unknown') authModel = 'cookie';

    // Stage 4: generate-wrapper.
    const genArgs = [
        generate,
        '--har', scrubbedHar,
        '--out', outDir,
        '--project-name', args.project,
        '--namespace', args.namespace,
        '--base-url', args['base-url'] || 'https://app.example.com',
        '--auth-model', authModel,
        '--authors', args.authors || 'IntelliTect',
        '--description', args.description || (args.project + ' wrapper'),
        '--repository-url', args['repository-url'] || ('https://github.com/example/' + args.project),
        '--package-tags', args['package-tags'] || 'example;api;wrapper',
    ];
    runStage('generate-wrapper', process.execPath, genArgs);

    // Stage 5 (optional): SDLC integration. Default is a no-op when stdin is
    // not a TTY -- preserves the unattended-safety contract of e2e tests.
    // scaffoldRepoRoot points at the IntelliSDLC.ai checkout that contains
    // this scaffold (used for the sibling-discovery fallback).
    const scaffoldRepoRoot = path.resolve(scriptsDir, '..', '..', '..');
    const sdlcResult = sdlc.runSdlcStage({
        outDir,
        args,
        isTTY: !!(process.stdin && process.stdin.isTTY),
        env: process.env,
        scaffoldRepoRoot,
        transcriptPath,
    });
    if (sdlcResult.outcome === 'error') {
        process.exit(sdlcResult.exitCode || 2);
    }

    process.stdout.write(`==> Done. Wrapper project written to ${outDir}\n`);
}

main();
