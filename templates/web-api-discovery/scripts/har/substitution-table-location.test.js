#!/usr/bin/env node
// Behavior tests for where the substitution tables land (issue #294).
//
// The substitution tables are keyed by the plaintext values the scrub
// replaced, which makes them a reverse lookup table of live credentials.
// They used to default into the scrubbed output directory -- the one the
// operator has been told receives "scrubbed, verified artifacts only" and
// which is tracked by git. They are recorder state, not a deliverable, so
// they belong beside the raw capture in the gitignored `.har-captures/`
// tree instead.
//
// These tests assert on the LOCATION only. No fixture here contains a
// real-looking credential value, and no assertion prints a table's contents.
//
// Zero-dep, runs with `node substitution-table-location.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { initProtectedRepo } = require(path.join(__dirname, 'har-test-repo.js'));

const sanitize = path.join(__dirname, 'sanitize-har.js');
// realpath: os.tmpdir() can be an 8.3 short path on Windows, which git
// resolves differently than node does.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subs-location-')));

const LEGACY_TABLE = '.har-substitutions.json';
const PII_TABLE = '.substitutions.json';
const CAPTURES_DIR = '.har-captures';

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

function makeProject(name) {
    // Since #318 the scrub verifies that a derived destination is genuinely
    // ignored rather than trusting its name, so these fixtures are real
    // repositories configured the way a consumer's is -- otherwise they would
    // describe a configuration the tooling refuses to run in.
    const dir = initProtectedRepo(path.join(tmp, name));
    fs.writeFileSync(path.join(dir, '.har-profile.json'),
        JSON.stringify({ salt: 'subs-location-salt', literals: {} }, null, 2));
    return dir;
}

// A capture with something worth substituting, so both tables are non-empty
// and their location is actually exercised. The address is a documentation
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

// --- 1. A capture read from a session directory writes its tables there. ---
{
    const dir = makeProject('from-session');
    const sessionDir = path.join(dir, CAPTURES_DIR, 'example.invalid', '2026-01-01-120000');
    const harIn = writeHar(path.join(sessionDir, 'raw.har'));
    const outDir = path.join(dir, 'docs', 'har-reference', 'example.invalid');
    const outPath = path.join(outDir, 'scrubbed.har');

    const r = runNode(sanitize, ['--in', harIn, '--out', outPath], dir);
    assert.strictEqual(r.code, 0, '1.a: sanitize failed: ' + r.stderr);
    assert.ok(fs.existsSync(outPath), '1.b: the scrubbed HAR was not written');

    assert.ok(!has(outDir, LEGACY_TABLE),
        '1.c: ' + LEGACY_TABLE + ' landed in the committable output path');
    assert.ok(!has(outDir, PII_TABLE),
        '1.d: ' + PII_TABLE + ' landed in the committable output path');
    assert.ok(has(sessionDir, LEGACY_TABLE),
        '1.e: ' + LEGACY_TABLE + ' was not written beside the raw capture');
    assert.ok(has(sessionDir, PII_TABLE),
        '1.f: ' + PII_TABLE + ' was not written beside the raw capture');
}

// --- 2. A capture read from anywhere else still never uses the output path. ---
{
    // The samples/ convention derives the output directory from the input, so
    // before #294 both tables landed in samples/har/ -- tracked, and named as
    // though it were the safe directory. With no session directory to fall
    // back on the tables go under a `.har-captures/` beside the input, which
    // the synced .gitignore block covers at any depth.
    const dir = makeProject('from-samples');
    const harIn = writeHar(path.join(dir, 'samples', 'har-original', 'capture.har'));
    const outDir = path.join(dir, 'samples', 'har');

    const r = runNode(sanitize, ['--in', harIn], dir);
    assert.strictEqual(r.code, 0, '2.a: sanitize failed: ' + r.stderr);
    assert.ok(fs.existsSync(path.join(outDir, 'capture.har')), '2.b: the scrubbed HAR was not written');

    assert.ok(!has(outDir, LEGACY_TABLE), '2.c: ' + LEGACY_TABLE + ' landed in the output path');
    assert.ok(!has(outDir, PII_TABLE), '2.d: ' + PII_TABLE + ' landed in the output path');

    const fallback = path.join(dir, 'samples', 'har-original', CAPTURES_DIR);
    assert.ok(has(fallback, LEGACY_TABLE),
        '2.e: ' + LEGACY_TABLE + ' is not under a gitignored ' + CAPTURES_DIR + '/');
    assert.ok(has(fallback, PII_TABLE),
        '2.f: ' + PII_TABLE + ' is not under a gitignored ' + CAPTURES_DIR + '/');
}

// --- 3. Explicit paths still win, and nothing is written to the default. ---
{
    // extract-har-reference.js and run-agent.js both pass explicit paths into
    // a temp working directory they delete afterwards. Defaulting elsewhere
    // must not have taken that away.
    const dir = makeProject('explicit');
    const sessionDir = path.join(dir, CAPTURES_DIR, 'example.invalid', '2026-01-01-120000');
    const harIn = writeHar(path.join(sessionDir, 'raw.har'));
    const work = path.join(dir, 'work');
    fs.mkdirSync(work, { recursive: true });
    const subs = path.join(work, 'subs.json');
    const piiSubs = path.join(work, 'pii-subs.json');

    const r = runNode(sanitize, [
        '--in', harIn, '--out', path.join(dir, 'out', 'scrubbed.har'),
        '--subs', subs, '--pii-subs', piiSubs,
    ], dir);
    assert.strictEqual(r.code, 0, '3.a: sanitize failed: ' + r.stderr);
    assert.ok(fs.existsSync(subs), '3.b: --subs was ignored');
    assert.ok(fs.existsSync(piiSubs), '3.c: --pii-subs was ignored');
    assert.ok(!has(sessionDir, LEGACY_TABLE),
        '3.d: an explicit --subs still wrote the default table into the session directory');
    assert.ok(!has(sessionDir, PII_TABLE),
        '3.e: an explicit --pii-subs still wrote the default table into the session directory');
}

// --- 4. Usage no longer advertises the output directory as the default. ---
{
    const dir = makeProject('usage');
    const r = runNode(sanitize, [], dir);
    const usage = r.stderr + r.stdout;
    assert.ok(!/<out-dir>[\\/]\.har-substitutions\.json/.test(usage),
        '4.a: usage still documents the output directory as the substitution table default:\n' + usage);
    assert.ok(!/<out-dir>[\\/]\.substitutions\.json/.test(usage),
        '4.b: usage still documents the output directory as the PII table default:\n' + usage);
    assert.ok(usage.includes(CAPTURES_DIR),
        '4.c: usage does not say where the substitution tables go now:\n' + usage);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All substitution-table-location tests passed');
