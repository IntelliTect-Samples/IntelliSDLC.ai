#!/usr/bin/env node
// Behavior tests for what the scrub does with a capture too large to read
// whole (issue #528).
//
// Zero-dep, runs with `node sanitize-har-size-limit.test.js`. Exits non-zero
// when anything fails.
//
// THE SESSION THIS IS ABOUT. An operator recorded an 816 MB capture of a live,
// fragile account -- human-paced, deliberately rationed real writes and reads,
// not cheaply repeatable. The browsing finished, the recorder handed off to the
// scrub, and the scrub said:
//
//     Cannot create a string longer than 0x1fffffe8 characters
//
// Nothing shareable came out. The raw is the credential-bearing artifact by
// design, so what the operator was left holding was the one copy that must not
// be committed or shared. The expensive part was already spent.
//
// So the behavior pinned here is not "it fails". It failed before. It is:
//
//  1. The refusal NAMES the file, its size and the limit. The old text named
//     none of the three and required the reader to already know `0x1fffffe8` is
//     Node's string ceiling to interpret it at all.
//  2. The refusal comes FIRST, before profile and policy loading, so the
//     unreadable-size fact is not reported behind some other setup failure.
//  3. Nothing is written and the raw is not touched. A refusal that damaged the
//     only surviving copy of an unrepeatable capture would be worse than the
//     defect.
//
// AN OVERSIZED FILE COSTS MILLISECONDS HERE. `ftruncate` sets a file's length
// without writing its contents, so a 600 MB input exists in about 15 ms. The
// scrub must refuse it on the `statSync` alone -- if this suite ever becomes
// slow, that is the regression: something started reading the file.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { initProtectedRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));
const captureSize = require(path.join(__dirname, '..', 'lib', 'capture-size.js'));

const sanitize = path.join(__dirname, 'sanitize-har.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-size-')));

let failures = 0;
let ran = 0;

function test(name, fn) {
    ran++;
    try {
        fn();
    } catch (e) {
        failures++;
        process.stderr.write('FAIL: ' + name + '\n  ' + e.message + '\n');
        if (e.stack) process.stderr.write(e.stack.split('\n').slice(1, 4).join('\n') + '\n');
    }
}

function runScrub(args, cwd) {
    try {
        const out = execFileSync(process.execPath, [sanitize, ...args], {
            encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return {
            code: e.status ?? 1,
            stdout: e.stdout?.toString() ?? '',
            stderr: e.stderr?.toString() ?? '',
        };
    }
}

/**
 * A file of the requested length whose contents were never written.
 *
 * The point of the exercise is that the scrub decides on the SIZE, so the
 * contents are irrelevant and producing them would make the suite unrunnable.
 */
function sparseFile(filePath, bytes) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(filePath, 'w');
    try { fs.ftruncateSync(fd, bytes); } finally { fs.closeSync(fd); }
    return filePath;
}

const OVERSIZE = captureSize.MAX_STRING_LENGTH + 64 * 1024 * 1024;

function project(name, { withProfile = true } = {}) {
    const dir = path.join(tmp, name);
    initProtectedRepo(dir);
    if (withProfile) {
        fs.writeFileSync(path.join(dir, '.har-profile.json'),
            JSON.stringify({ salt: 'test-salt', literals: {} }, null, 2));
    }
    return dir;
}

// --- 1. The refusal names the file, its size and the limit. ---

test('an oversized capture is refused by name, size and limit', () => {
    const dir = project('named');
    const raw = sparseFile(path.join(dir, '.har-captures', 'session', 'raw.har'), OVERSIZE);

    const r = runScrub(['--in', raw], dir);

    assert.notStrictEqual(r.code, 0, 'a capture that cannot be scrubbed must not exit 0');
    assert.ok(/raw\.har/.test(r.stderr), 'names the file: ' + r.stderr);
    assert.ok(r.stderr.includes(String(OVERSIZE)), 'names the exact size: ' + r.stderr);
    assert.ok(r.stderr.includes(String(captureSize.MAX_STRING_LENGTH)),
        'names the exact limit: ' + r.stderr);
});

test('the refusal does not fall back to the unreadable Node text', () => {
    const dir = project('readable');
    const raw = sparseFile(path.join(dir, '.har-captures', 'session', 'raw.har'), OVERSIZE);

    const r = runScrub(['--in', raw], dir);

    assert.ok(!/0x1fffffe8/.test(r.stderr),
        'the hex constant is the message this issue exists to replace: ' + r.stderr);
    assert.ok(/sanitize-har:/.test(r.stderr),
        'the refusal is attributed to the tool that refused: ' + r.stderr);
});

// --- 2. It refuses first, not behind other setup. ---

test('the size refusal precedes profile and policy loading', () => {
    // No .har-profile.json at all. Without an early size check the operator
    // would be told about the missing profile -- true, fixable, and completely
    // beside the point, because fixing it changes nothing about the capture.
    const dir = project('no-profile', { withProfile: false });
    const raw = sparseFile(path.join(dir, '.har-captures', 'session', 'raw.har'), OVERSIZE);

    const r = runScrub(['--in', raw], dir);

    assert.ok(r.stderr.includes(String(captureSize.MAX_STRING_LENGTH)),
        'the size is what is reported, not the missing profile: ' + r.stderr);
});

// --- 3. Nothing is written, and the raw survives untouched. ---

test('a refused run writes no output and no substitution table', () => {
    const dir = project('nothing-written');
    const rawDir = path.join(dir, '.har-captures', 'session');
    const raw = sparseFile(path.join(rawDir, 'raw.har'), OVERSIZE);
    const out = path.join(dir, 'samples', 'har', 'scrubbed.har');

    const r = runScrub(['--in', raw, '--out', out], dir);

    assert.notStrictEqual(r.code, 0);
    assert.ok(!fs.existsSync(out), 'no scrubbed output may be left behind');
    const strays = fs.readdirSync(rawDir).filter((f) => f !== 'raw.har');
    assert.deepStrictEqual(strays, [],
        'no substitution table beside the raw: ' + strays.join(', '));
});

test('the raw capture is left exactly as it was', () => {
    // The raw is the only surviving copy of an unrepeatable session. A refusal
    // that rewrote, truncated or moved it would be a worse defect than the one
    // being fixed.
    const dir = project('raw-untouched');
    const raw = sparseFile(path.join(dir, '.har-captures', 'session', 'raw.har'), OVERSIZE);
    const before = fs.statSync(raw);

    runScrub(['--in', raw], dir);

    const after = fs.statSync(raw);
    assert.strictEqual(after.size, before.size, 'the raw kept its size');
    assert.strictEqual(after.mtimeMs, before.mtimeMs, 'the raw was not rewritten');
});

// --- 4. The band between the threshold and the ceiling is not silent. ---

test('a capture in the warn band still runs, and is told it may still fail', () => {
    // It reads. It may still not survive being written: the scrubbed form is
    // pretty-printed, so it is larger than the capture it came from, and that
    // failure lands minutes later with the whole walk already done. An operator
    // who was told beforehand can trim first; one who was not sees an
    // arbitrary-looking failure at the end of a long run.
    //
    // The file is sparse and never read past the stat -- what is asserted is
    // the notice, which is decided on the size alone.
    const dir = project('warn-band');
    const raw = sparseFile(path.join(dir, '.har-captures', 'session', 'raw.har'),
        require(path.join(__dirname, '..', 'lib', 'capture-size.js')).WARN_BYTES + 1024);

    const r = runScrub(['--in', raw], dir);

    assert.ok(/approaching/.test(r.stderr), 'the band is named: ' + r.stderr);
    assert.ok(/may still fail/.test(r.stderr),
        'and what may still go wrong is named: ' + r.stderr);
    assert.ok(!/nothing was written/.test(r.stderr),
        'but it is a notice, not a refusal: ' + r.stderr);
});

// --- 5. An ordinary capture is unaffected. ---

test('a capture below the ceiling is not refused', () => {
    const dir = project('ordinary');
    const raw = path.join(dir, '.har-captures', 'session', 'raw.har');
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    fs.writeFileSync(raw, JSON.stringify({
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [],
        },
    }, null, 2), 'utf8');

    const r = runScrub(['--in', raw, '--out', path.join(dir, 'samples', 'har', 'out.har')], dir);

    assert.strictEqual(r.code, 0, 'an ordinary capture still scrubs: ' + r.stderr);
    assert.ok(!/ceiling|single string/.test(r.stderr),
        'and says nothing about size: ' + r.stderr);
});

// ---------------------------------------------------------------------------

if (failures) {
    process.stderr.write('\n' + failures + ' of ' + ran + ' sanitize-har size-limit tests FAILED\n');
    process.exitCode = 1;
} else {
    process.stdout.write('All sanitize-har size-limit tests passed (' + ran + ')\n');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { void err; }
