#!/usr/bin/env node
// Behavior tests for the substitution-table destination gate (issue #318).
//
// substitution-table-location.test.js pins WHERE the tables go. These pin
// WHETHER they are written at all: the destination has to be verifiably
// gitignored, and a destination that merely looks right is refused.
//
// Case 1 is the reproduction from the issue verbatim in shape -- a capture
// corpus in a directory named `har-captures` (no leading dot) outside any
// repository, with --out directed somewhere else entirely. Before this gate
// the scrub created a nested `.har-captures/` inside the capture tree and
// wrote both tables into it, unprotected.
//
// These tests assert on exit codes, on which files exist, and on message
// text. No fixture contains a real credential and no assertion prints a
// table's contents.
//
// Zero-dep, runs with `node substitution-table-gitignore.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sanitize = path.join(__dirname, 'sanitize-har.js');
// realpath: os.tmpdir() can be an 8.3 short path on Windows, which git
// resolves differently than node does.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subs-gate-')));

const LEGACY_TABLE = '.har-substitutions.json';
const PII_TABLE = '.substitutions.json';
const CAPTURES_DIR = '.har-captures';

// What generate-wrapper.js writes into a scaffolded consumer's root
// .gitignore (SCAFFOLD_GITIGNORE_ENTRIES). Kept literal rather than imported
// so this suite pins the behavior an operator actually gets, and a change to
// that list shows up here as a failure instead of passing silently.
const SCAFFOLD_GITIGNORE = [
    'Samples/HAR-Original/',
    'Samples/MobileApp-Binaries/',
    '.har-profile.json',
    '.har-substitutions.json',
    '.substitutions.json',
    '.har-captures/',
    '',
].join('\n');

function runNode(script, args, cwd) {
    try {
        const out = execFileSync(process.execPath, [script, ...args], {
            encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
    }
}

// `gitignore === null` means: do not make this a repository at all.
function makeProject(name, gitignore) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.har-profile.json'),
        JSON.stringify({ salt: 'subs-gate-salt', literals: {} }, null, 2));
    if (gitignore !== null) {
        execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
        fs.writeFileSync(path.join(dir, '.gitignore'), gitignore, 'utf8');
    }
    return dir;
}

// A capture with something worth substituting, so both tables are non-empty
// and the destination is actually exercised. The address is a documentation
// example, not a credential.
function writeHar(target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({
        log: {
            version: '1.2', creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z', time: 1,
                request: {
                    method: 'POST', url: 'https://example.invalid/api', httpVersion: 'HTTP/1.1',
                    headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
                    postData: { mimeType: 'application/json', text: '{"contact":"jane.doe@example.com"}' },
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                    content: { size: 0, mimeType: 'application/json', text: '{}' },
                    redirectURL: '', headersSize: -1, bodySize: 0,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    }, null, 2));
    return target;
}

const has = (dir, name) => fs.existsSync(path.join(dir, name));

// Nothing below this root may have been created by a refused run.
function assertNoTablesUnder(root, label) {
    const found = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name === LEGACY_TABLE || e.name === PII_TABLE) found.push(p);
        }
    })(root);
    assert.strictEqual(found.length, 0,
        `${label}: a refused run still wrote ${found.length} substitution table(s): ${found.join(', ')}`);
}

// --- 1. The reproduction from the issue: a capture tree outside any repo. ---
{
    const dir = makeProject('repro-no-repo', null);
    const captureTree = path.join(dir, 'har-captures', 'example.invalid', '2026-01-01-120000');
    const harIn = writeHar(path.join(captureTree, 'raw.har'));
    const outPath = path.join(dir, 'elsewhere', 'scrubbed.har');

    const r = runNode(sanitize, ['--in', harIn, '--out', outPath], dir);

    assert.strictEqual(r.code, 1,
        '1.a: the scrub succeeded outside a work tree instead of refusing:\n' + r.stdout + r.stderr);
    assertNoTablesUnder(dir, '1.b');
    assert.ok(!fs.existsSync(path.join(captureTree, CAPTURES_DIR)),
        '1.c: a refused run still created a nested ' + CAPTURES_DIR + '/ in the capture tree');
    assert.ok(!fs.existsSync(outPath),
        '1.d: a refused run still wrote the scrubbed output -- the gate must run before any write');
    assert.ok(/refus/i.test(r.stderr),
        '1.e: the failure does not say it refused:\n' + r.stderr);
}

// --- 2. Inside a repo, but nothing in .gitignore covers the destination. ---
{
    const dir = makeProject('repo-uncovered', '# no scrub entries here\n');
    const sessionDir = path.join(dir, CAPTURES_DIR, 'example.invalid', '2026-01-01-120000');
    const harIn = writeHar(path.join(sessionDir, 'raw.har'));
    const outPath = path.join(dir, 'out', 'scrubbed.har');

    const r = runNode(sanitize, ['--in', harIn, '--out', outPath], dir);

    assert.strictEqual(r.code, 1,
        '2.a: a .har-captures directory that is not actually ignored was accepted:\n' + r.stdout + r.stderr);
    assertNoTablesUnder(dir, '2.b');
    assert.ok(!fs.existsSync(outPath), '2.c: a refused run still wrote the scrubbed output');
    assert.ok(r.stderr.includes('.gitignore'),
        '2.d: the refusal does not name the remedy (.gitignore):\n' + r.stderr);
}

// --- 3. The #294 behavior, now earned: a properly scaffolded repo. ---
{
    const dir = makeProject('repo-covered', SCAFFOLD_GITIGNORE);
    const sessionDir = path.join(dir, CAPTURES_DIR, 'example.invalid', '2026-01-01-120000');
    const harIn = writeHar(path.join(sessionDir, 'raw.har'));
    const outDir = path.join(dir, 'docs', 'har-reference', 'example.invalid');
    const outPath = path.join(outDir, 'scrubbed.har');

    const r = runNode(sanitize, ['--in', harIn, '--out', outPath], dir);

    assert.strictEqual(r.code, 0, '3.a: sanitize failed in a protected repo: ' + r.stderr);
    assert.ok(fs.existsSync(outPath), '3.b: the scrubbed HAR was not written');
    assert.ok(has(sessionDir, LEGACY_TABLE), '3.c: ' + LEGACY_TABLE + ' was not written beside the raw capture');
    assert.ok(has(sessionDir, PII_TABLE), '3.d: ' + PII_TABLE + ' was not written beside the raw capture');
    assert.ok(!has(outDir, LEGACY_TABLE), '3.e: ' + LEGACY_TABLE + ' landed in the committable output path');
    assert.ok(!has(outDir, PII_TABLE), '3.f: ' + PII_TABLE + ' landed in the committable output path');
}

// --- 4. The gate does not over-refuse a genuinely protected destination. ---
{
    // `har-captures`, no leading dot -- the near-miss from the issue. Note
    // this case does NOT discriminate old behavior from new: deriveSubsDir
    // nests a literal `.har-captures/` segment whatever the outer directory is
    // spelled, so the old name test landed here too and the scaffold covers it
    // either way. What it pins is the other half of the fix -- that checking
    // the property does not cost us the cases the name test got right, and in
    // particular that nobody later "fixes" #318 by matching directory names
    // more strictly, which would refuse this genuinely-ignored destination.
    // Cases 1 and 2 are the ones that discriminate old from new.
    const dir = makeProject('near-miss-covered', SCAFFOLD_GITIGNORE);
    const captureTree = path.join(dir, 'har-captures', 'example.invalid', '2026-01-01-120000');
    const harIn = writeHar(path.join(captureTree, 'raw.har'));
    const outPath = path.join(dir, 'out', 'scrubbed.har');

    const r = runNode(sanitize, ['--in', harIn, '--out', outPath], dir);

    assert.strictEqual(r.code, 0,
        '4.a: a genuinely-ignored destination was refused over its directory name: ' + r.stderr);
    const nested = path.join(captureTree, CAPTURES_DIR);
    assert.ok(has(nested, LEGACY_TABLE) || has(captureTree, LEGACY_TABLE),
        '4.b: ' + LEGACY_TABLE + ' was not written anywhere under the capture tree');
}

// --- 5. An explicit destination is a deliberate act and is not gated. ---
{
    // extract-har-reference.js and run-agent.js both pass explicit paths into
    // a temp working directory outside any repository, which they delete
    // afterwards. Gating those would break both callers.
    const dir = makeProject('explicit-outside-repo', null);
    const harIn = writeHar(path.join(dir, 'captures', 'raw.har'));
    const work = path.join(dir, 'work');
    fs.mkdirSync(work, { recursive: true });
    const subs = path.join(work, 'subs.json');
    const piiSubs = path.join(work, 'pii-subs.json');

    const r = runNode(sanitize, [
        '--in', harIn, '--out', path.join(dir, 'out', 'scrubbed.har'),
        '--subs', subs, '--pii-subs', piiSubs,
    ], dir);

    assert.strictEqual(r.code, 0,
        '5.a: an explicitly named destination outside a repo was refused: ' + r.stderr);
    assert.ok(fs.existsSync(subs), '5.b: --subs was not honored');
    assert.ok(fs.existsSync(piiSubs), '5.c: --pii-subs was not honored');
}

// --- 6. Each table is gated on its own. ---
{
    // Naming one table explicitly says nothing about the other, so the one
    // still falling back to the derived default must be checked -- and the
    // refusal has to name the right flag, or the operator fixes the wrong one.
    const dir = makeProject('mixed', '# no scrub entries here\n');
    const sessionDir = path.join(dir, CAPTURES_DIR, 'example.invalid', '2026-01-01-120000');
    const harIn = writeHar(path.join(sessionDir, 'raw.har'));
    const work = path.join(dir, 'work');
    fs.mkdirSync(work, { recursive: true });
    const subs = path.join(work, 'subs.json');

    const r = runNode(sanitize, [
        '--in', harIn, '--out', path.join(dir, 'out', 'scrubbed.har'), '--subs', subs,
    ], dir);

    assert.strictEqual(r.code, 1,
        '6.a: the derived PII table destination was not gated when --subs was explicit:\n' + r.stderr);
    assert.ok(r.stderr.includes('--pii-subs'),
        '6.b: the refusal does not name the flag that would override it:\n' + r.stderr);
    assert.ok(!fs.existsSync(subs),
        '6.c: the explicitly named table was written even though the run was refused');
    assertNoTablesUnder(dir, '6.d');
}

// --- 7. Usage says the default is verified, not assumed. ---
{
    const dir = makeProject('usage', SCAFFOLD_GITIGNORE);
    const r = runNode(sanitize, [], dir);
    const usage = r.stderr + r.stdout;
    assert.ok(/gitignored/i.test(usage) && /verif/i.test(usage),
        '7.a: usage does not say the default destination is verified gitignored:\n' + usage);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All substitution-table-gitignore tests passed');
