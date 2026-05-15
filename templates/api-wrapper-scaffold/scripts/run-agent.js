#!/usr/bin/env node
/*
 * run-agent.js -- thin orchestrator for the api-wrapper-scaffold pipeline.
 *
 * Chains: sanitize-har -> verify-scrub -> detect-auth -> generate-wrapper.
 * Prints a clear "==> Stage N: <name>" banner before each step; exits with
 * the first failing stage's exit code. Zero dependencies.
 *
 * Usage:
 *   node run-agent.js --har <path> --out <dir> --project <Name> --namespace <Ns>
 *                     [--base-url <https://x>] [--salt <salt>]
 *                     [--authors <s>] [--description <s>]
 *                     [--repository-url <s>] [--package-tags <s>]
 *                     [--fixed-time <iso8601>]
 *
 * Exit codes:
 *   0 -- all four stages succeeded
 *   2 -- usage / argument error
 *   N -- exit code of the first failing sub-step (passed through unchanged)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
        '[--base-url <https://x>] [--salt <salt>] [--authors <s>] [--description <s>] ' +
        '[--repository-url <s>] [--package-tags <s>] [--fixed-time <iso8601>]\n');
    process.exit(2);
}

function runStage(label, cmd, cmdArgs) {
    process.stdout.write(`==> Stage: ${label}\n`);
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

    const scriptsDir = __dirname;
    const sanitize = path.join(scriptsDir, 'sanitize-har.js');
    const verify   = path.join(scriptsDir, 'verify-scrub.js');
    const detect   = path.join(scriptsDir, 'detect-auth.js');
    const generate = path.join(scriptsDir, 'generate-wrapper.js');

    const salt = args.salt || 'run-agent-default-salt';
    const fixedTime = args['fixed-time'] || '2026-01-01T00:00:00.000Z';

    // Stage 1: sanitize the HAR (legacy regex + typed PII pipeline).
    runStage('sanitize-har', process.execPath, [
        sanitize,
        '--in', har,
        '--out', scrubbedHar,
        '--subs', legacySubs,
        '--salt', salt,
        '--pii-subs', piiSubs,
        '--fixed-time', fixedTime,
    ]);

    // Stage 2: verify-scrub confirms no plaintext PII / token leaked.
    runStage('verify-scrub', process.execPath, [verify, '--in', scrubbedHar]);

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

    process.stdout.write(`==> Done. Wrapper project written to ${outDir}\n`);
}

main();
