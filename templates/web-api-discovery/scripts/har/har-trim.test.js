#!/usr/bin/env node
// Behavior tests for trim-har-capture.js (issue #435).
//
// A capture store is gigabytes of fonts, images and beacons wrapped around a
// few hundred kilobytes of the calls anyone cares about. Until now the only way
// to make a capture smaller was to extract a reference, which also SCRUBS it --
// a one-way door, because a scrubbed artifact cannot be re-scrubbed with a
// corrected profile. So the real choice was "keep gigabytes" or "lose the
// ability to reprocess", and everyone kept the gigabytes.
//
// This command drops the cruft and leaves the capture RAW.
//
// THE CONSTRAINT THAT MATTERS MOST: it must never touch the original. This is a
// lossy, irreversible operation against the only ground truth that exists about
// someone else's API, applied to files that cannot be re-recorded. Every other
// property here is secondary to that one.
//
// Zero-dep, runs with `node har-trim.test.js`.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const trim = path.join(__dirname, 'trim-har-capture.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-trim-'));

let passed = 0;
function test(name, fn) { fn(); passed++; }

function run(args) {
    const r = spawnSync(process.execPath, [trim, ...args], { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function entry(overrides = {}) {
    const req = Object.assign({
        method: 'GET', url: 'https://example.invalid/thing', httpVersion: 'HTTP/1.1',
        headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
    }, overrides.request);
    const res = Object.assign({
        status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
        redirectURL: '', headersSize: -1, bodySize: -1,
        content: { size: 2, mimeType: 'application/json', text: '{}' },
    }, overrides.response);
    const e = { startedDateTime: '2026-08-26T00:00:00.000Z', time: 1, request: req, response: res,
        cache: {}, timings: { send: 0, wait: 1, receive: 0 } };
    if (overrides._resourceType) e._resourceType = overrides._resourceType;
    return e;
}

function apiEntry() {
    return entry({
        _resourceType: 'xhr',
        request: { method: 'POST', url: 'https://api.example.invalid/v1/posts',
            postData: { mimeType: 'application/json', text: '{"message":"hello"}' } },
    });
}
function imageEntry() {
    return entry({
        _resourceType: 'image',
        request: { url: 'https://cdn.example.invalid/logo.png' },
        response: { content: { size: 900, mimeType: 'image/png', text: 'x'.repeat(900) } },
    });
}
function beaconEntry() {
    return entry({ _resourceType: 'ping', request: { url: 'https://example.invalid/beacon' } });
}

function writeCapture(name, entries) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'raw.har');
    fs.writeFileSync(p, JSON.stringify({
        log: { version: '1.2', creator: { name: 'test', version: '1' }, entries },
    }, null, 2));
    return p;
}

const readEntries = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).log.entries;

// ---------------------------------------------------------------------------
// The original is sacred
// ---------------------------------------------------------------------------

test('the original capture is byte-for-byte untouched', () => {
    // THE ASSERTION THIS COMMAND LIVES OR DIES BY. A trim that damaged the raw
    // would destroy the only recording of traffic that cannot be replayed, and
    // it would do so silently, since the output would look fine.
    const src = writeCapture('untouched', [apiEntry(), imageEntry(), beaconEntry()]);
    const before = sha(src);

    const out = path.join(path.dirname(src), 'trimmed.har');
    const r = run(['--in', src, '--out', out]);
    assert.strictEqual(r.code, 0, r.stderr);

    assert.strictEqual(sha(src), before, 'the original was modified');
    assert.ok(fs.existsSync(out), 'no output was written');
});

test('it refuses to write over the input, whatever the caller asks', () => {
    // In-place would be a one-way door with no undo. There is deliberately no
    // flag for it: the caller removes the original as a separate act, after
    // looking at what came out.
    const src = writeCapture('inplace', [apiEntry(), imageEntry()]);
    const before = sha(src);

    const r = run(['--in', src, '--out', src]);
    assert.notStrictEqual(r.code, 0, 'writing over the input was allowed');
    assert.strictEqual(sha(src), before, 'the input was overwritten anyway');
});

test('it refuses to clobber an existing output rather than silently replacing it', () => {
    const src = writeCapture('clobber', [apiEntry()]);
    const out = path.join(path.dirname(src), 'already-here.har');
    fs.writeFileSync(out, 'PRECIOUS');

    const r = run(['--in', src, '--out', out]);
    assert.notStrictEqual(r.code, 0, 'an existing output was clobbered');
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'PRECIOUS');
});

// ---------------------------------------------------------------------------
// What it keeps and drops
// ---------------------------------------------------------------------------

test('it keeps API calls and drops assets and beacons', () => {
    const src = writeCapture('basic', [apiEntry(), imageEntry(), beaconEntry(), apiEntry()]);
    const out = path.join(path.dirname(src), 'trimmed.har');
    assert.strictEqual(run(['--in', src, '--out', out]).code, 0);

    const kept = readEntries(out);
    assert.strictEqual(kept.length, 2);
    assert.ok(kept.every((e) => e.request.url.includes('/v1/posts')));
});

test('an entry carrying a request body is NEVER dropped, whatever it claims to be', () => {
    // THE FALSIFIER. A request body is the half of a capture that cannot be
    // reconstructed and the half a reference exists to preserve. If a
    // misleading content-type could get one dropped, this command would
    // silently destroy exactly what the store is kept for.
    const disguised = entry({
        _resourceType: 'image',
        request: {
            method: 'POST', url: 'https://api.example.invalid/v1/upload',
            postData: { mimeType: 'image/png', text: 'name=value&other=thing' },
        },
        response: { content: { size: 3, mimeType: 'image/png', text: 'png' } },
    });

    const src = writeCapture('disguised', [disguised, imageEntry()]);
    const out = path.join(path.dirname(src), 'trimmed.har');
    assert.strictEqual(run(['--in', src, '--out', out]).code, 0);

    const kept = readEntries(out);
    assert.ok(kept.some((e) => e.request.url.includes('/v1/upload')),
        'an entry with a request body was dropped');
});

test('kept + dropped equals scanned, and the run says so', () => {
    // Asserted against the ARITHMETIC THE TOOL REPORTS, not against a digit
    // appearing somewhere in its output. An earlier version matched /3/, which
    // that output satisfies three times over -- including in a line driven
    // straight off `entries.length` rather than by the classifier at all -- so
    // it could not fail on the property its name promises.
    const src = writeCapture('counts', [apiEntry(), imageEntry(), beaconEntry(), apiEntry()]);
    const out = path.join(path.dirname(src), 'trimmed.har');
    const r = run(['--in', src, '--out', out]);

    const m = /entries scanned = (\d+) kept \+ (\d+) dropped/.exec(r.stdout);
    assert.ok(m, `the run does not report the kept/dropped split:\n${r.stdout}`);
    const kept = Number(m[1]);
    const dropped = Number(m[2]);

    assert.strictEqual(kept + dropped, 4, 'the reported split does not account for every entry');
    assert.strictEqual(kept, readEntries(out).length,
        'the reported kept count disagrees with what was actually written');
    assert.strictEqual(dropped, 2);
});

test('a beacon carrying a body is still dropped', () => {
    // THE LIMIT OF "a request body outranks the label", and why that rule is
    // scoped rather than absolute.
    //
    // `navigator.sendBeacon` exists to ship a payload, so most real beacons
    // CARRY a body. An unscoped rule would keep all of them -- and beacon
    // volume is a large part of why a capture reaches 1.6 GB, so it would
    // quietly gut the one thing this command is for.
    //
    // The distinction is what the label describes. `image` describes what came
    // BACK, and the browser can be wrong about a POST that merely answered with
    // one. `ping` describes how the request was SENT: telemetry by
    // construction, and not wrong in that way.
    const beaconWithBody = entry({
        _resourceType: 'ping',
        request: {
            method: 'POST', url: 'https://example.invalid/beacon',
            postData: { mimeType: 'application/json', text: '{"event":"scroll","ms":1200}' },
        },
    });

    const src = writeCapture('beacon-body', [apiEntry(), beaconWithBody]);
    const out = path.join(path.dirname(src), 'trimmed.har');
    assert.strictEqual(run(['--in', src, '--out', out]).code, 0);

    const kept = readEntries(out);
    assert.strictEqual(kept.length, 1, 'a beacon carrying a body was kept');
    assert.ok(kept[0].request.url.includes('/v1/posts'));
});

test('a missing output directory is reported, not thrown', () => {
    // The rule here is "the message, never the stack". extract-har-reference.js
    // creates the parent for exactly this reason; this command dropped that
    // step and leaked an ENOENT trace under an exit code that collides with
    // unrelated failures.
    const src = writeCapture('nodir', [apiEntry(), imageEntry()]);
    const out = path.join(path.dirname(src), 'does', 'not', 'exist', 'trimmed.har');

    const r = run(['--in', src, '--out', out]);
    assert.ok(!/ at .*\.js:\d+/.test(r.stderr), `a stack trace reached the operator:\n${r.stderr}`);
    if (r.code === 0) assert.ok(fs.existsSync(out), 'reported success without writing');
    else assert.match(r.stderr, /trim-har-capture:/);
});

test('the trimmed capture is still a HAR, with the log envelope intact', () => {
    // It must be readable by every tool that reads a raw capture -- that is the
    // entire point of trimming rather than extracting.
    const src = writeCapture('shape', [apiEntry(), imageEntry()]);
    const out = path.join(path.dirname(src), 'trimmed.har');
    run(['--in', src, '--out', out]);

    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(doc.log.version, '1.2');
    assert.ok(doc.log.creator, 'the creator block was lost');
    assert.ok(Array.isArray(doc.log.entries));
});

test('trimming a capture with nothing to drop still produces a valid output', () => {
    const src = writeCapture('allapi', [apiEntry(), apiEntry()]);
    const out = path.join(path.dirname(src), 'trimmed.har');
    assert.strictEqual(run(['--in', src, '--out', out]).code, 0);
    assert.strictEqual(readEntries(out).length, 2);
});

test('it refuses to write an EMPTY capture rather than producing a useless file', () => {
    // Every entry being cruft means the selector or the capture is wrong. A
    // zero-entry HAR passes every downstream gate while proving nothing --
    // exactly the silent-nothing this project keeps meeting.
    const src = writeCapture('allcruft', [imageEntry(), beaconEntry()]);
    const out = path.join(path.dirname(src), 'trimmed.har');

    const r = run(['--in', src, '--out', out]);
    assert.notStrictEqual(r.code, 0, 'an empty trimmed capture was written');
    assert.ok(!fs.existsSync(out), 'an empty output file was left behind');
});

// ---------------------------------------------------------------------------
// Operational shape
// ---------------------------------------------------------------------------

test('a missing input fails with the path, not a stack trace', () => {
    const r = run(['--in', path.join(tmp, 'nope.har'), '--out', path.join(tmp, 'x.har')]);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /nope\.har/);
    assert.ok(!/ at .*\.js:\d+/.test(r.stderr), `a stack trace reached the operator:\n${r.stderr}`);
});

test('an unparseable input fails rather than writing something', () => {
    const dir = path.join(tmp, 'bad');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'raw.har');
    fs.writeFileSync(src, 'this is not a HAR');
    const out = path.join(dir, 'trimmed.har');

    const r = run(['--in', src, '--out', out]);
    assert.notStrictEqual(r.code, 0);
    assert.ok(!fs.existsSync(out));
});

test('it shares one classifier with the extractor rather than a second opinion', () => {
    // Two implementations that agree today are how a filter and the thing it
    // feeds drift into disagreeing about what a beacon is.
    const cls = require(path.join(__dirname, 'har-entry-class.js'));
    const extractorUses = fs.readFileSync(path.join(__dirname, 'extract-har-reference.js'), 'utf8');
    const trimUses = fs.readFileSync(trim, 'utf8');

    assert.ok(/har-entry-class/.test(extractorUses), 'the extractor does not import the shared classifier');
    assert.ok(/har-entry-class/.test(trimUses), 'the trim command does not import the shared classifier');
    assert.strictEqual(typeof cls.classifyEntries, 'function');
});

console.log(`All har-trim tests passed (${passed} assertions)`);
