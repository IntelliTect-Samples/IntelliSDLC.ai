#!/usr/bin/env node
// Behavior tests for reading captures larger than a JavaScript string, through
// the ONE boundary every stage uses (issue #450, per-stage migration).
//
// #538 landed a streaming engine and moved the trim onto it. Every other stage
// still opened a capture through `readHarDocument`, whose body was
// `JSON.parse(fs.readFileSync(...))` -- so the 1.7 GB capture that motivated
// the issue was still unreadable by the capture summary, the catalogue
// measurement, the auth detector and the descriptor annotation. This suite pins
// the two halves of the fix:
//
//   1. the boundary itself no longer builds the file as one string, so a
//      capture past the string limit READS -- whole, for the stages that
//      genuinely need the document; and
//   2. the stages that only WALK entries stream them and retain the answer,
//      never the entries, so their memory does not scale with the capture.
//
// Memory is measured, not inspected: each stage runs in a child process under a
// heap cap far below the capture's size, and the old whole-document read runs
// under the same cap and is REQUIRED to fail. Without that ablation, "the stage
// passed" is indistinguishable from "the cap was never binding".
//
// Zero-dep, runs with `node har-large-capture-read.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const harDocument = require(path.join(__dirname, 'har-document.js'));
const { readHarDocument, iterateHarEntries, HarFormatError } = harDocument;

const SCRIPTS = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, '..', '..', '..', '..', '.github', 'agents', 'tests', 'fixtures', 'har');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-large-read-'));

let ran = 0;
let failures = 0;
function test(name, fn) {
    ran += 1;
    try {
        fn();
    } catch (e) {
        failures += 1;
        process.stderr.write(`FAIL: ${name}\n  ${(e && e.stack) || e}\n`);
    }
}

// ---------------------------------------------------------------------------
// A large capture shaped like a real one: many entries, several hosts, and ONE
// entry carrying a bearer token, so the auth detector has exactly one signal to
// find in a haystack it cannot hold.
// ---------------------------------------------------------------------------

const HOSTS = ['api.example.test', 'cdn.example.test', 'auth.example.test'];
const BEARER_AT = 7;

function entryFor(i, filler) {
    const headers = [{ name: 'accept', value: 'application/json' }];
    if (i === BEARER_AT) headers.push({ name: 'Authorization', value: 'Bearer aaa.bbb.ccc' });
    return {
        startedDateTime: '2026-08-28T03:25:44.000Z',
        request: {
            method: i % 5 === 0 ? 'POST' : 'GET',
            url: `https://${HOSTS[i % HOSTS.length]}/v1/items/${i % 11}`,
            headers,
            bodySize: 0,
        },
        response: { status: 200, headers: [], content: { size: filler.length, mimeType: 'text/plain', text: filler } },
    };
}

function writeLargeCapture(file, targetBytes) {
    const fd = fs.openSync(file, 'w');
    let n = 0;
    try {
        fs.writeSync(fd, '{\n  "log": {\n    "version": "1.2",\n    "creator": { "name": "t", "version": "1" },\n    "entries": [\n');
        const filler = 'y'.repeat(2048);
        let written = 0;
        let buf = '';
        while (written < targetBytes) {
            const chunk = (n === 0 ? '' : ',\n') + '      ' + JSON.stringify(entryFor(n, filler));
            buf += chunk;
            written += chunk.length;
            n += 1;
            if (buf.length > 8 * 1024 * 1024) { fs.writeSync(fd, buf); buf = ''; }
        }
        fs.writeSync(fd, buf + '\n    ]\n  }\n}\n');
    } finally {
        fs.closeSync(fd);
    }
    return n;
}

const BIG = path.join(tmp, 'big.har');
const BIG_ENTRIES = writeLargeCapture(BIG, 150 * 1024 * 1024);
const CAP = '--max-old-space-size=64';

/** Runs `source` in a child under the heap cap; returns parsed stdout, or throws with its stderr. */
function underCap(name, source, args) {
    const script = path.join(tmp, name);
    fs.writeFileSync(script, source, 'utf8');
    const r = spawnSync(process.execPath, [CAP, script, ...(args || [])], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`${name} exited ${r.status} under ${CAP}: ${(r.stderr || '').slice(0, 600)}`);
    }
    return JSON.parse(r.stdout);
}

const req = (rel) => `require(${JSON.stringify(path.join(SCRIPTS, rel))})`;

// The ablation, run once and shared: the old whole-document read of the same
// file under the same cap. Every "streams under the cap" claim below is only a
// claim because this fails.
test('ABLATION: the old whole-document read of the large capture dies under the cap', () => {
    let died = false;
    try {
        underCap('naive.js',
            'const fs = require("fs");\n'
            + 'const doc = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));\n'
            + 'process.stdout.write(JSON.stringify(doc.log.entries.length));\n', [BIG]);
    } catch (e) {
        died = true;
    }
    assert.ok(died, 'the whole-document read fit under the cap, so the cap proves nothing');
});

// ---------------------------------------------------------------------------
// 1. The boundary
// ---------------------------------------------------------------------------

test('iterateHarEntries on a PATH streams: the large capture walks under the cap', () => {
    const out = underCap('walk.js',
        `const hd = ${req('har/har-document.js')};\n`
        + 'let n = 0, post = 0;\n'
        + 'for (const e of hd.iterateHarEntries(process.argv[2])) { n += 1; if (e.request.method === "POST") post += 1; }\n'
        + 'process.stdout.write(JSON.stringify({ n, post }));\n', [BIG]);
    assert.strictEqual(out.n, BIG_ENTRIES);
    assert.strictEqual(out.post, Math.ceil(BIG_ENTRIES / 5));
});

test('readHarDocument reads exactly what JSON.parse reads, key order included', () => {
    // "Streaming must not alter what is read." Compared as serialised text, not
    // deepStrictEqual, because deep equality ignores key ORDER -- and key order
    // is what a stage that re-serialises the document writes back to disk.
    for (const name of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.har'))) {
        const file = path.join(FIXTURES, name);
        let expected;
        try { expected = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; }
        if (!expected || !expected.log || !Array.isArray(expected.log.entries)) continue;
        const read = readHarDocument(file);
        assert.strictEqual(JSON.stringify(read.document), JSON.stringify(expected), `${name} read differently`);
        // One array, not two copies: a stage that edits `entries` and then
        // serialises `document` must see its own edits.
        assert.strictEqual(read.document.log.entries, read.entries, `${name}: entries is not the document's own array`);
    }
});

test('readHarDocument reads a capture past the JavaScript string limit', () => {
    // The issue's own failure, at the boundary. Few, fat entries keep the
    // parsed object cheap while the FILE crosses the limit, which is the only
    // thing this assertion is about.
    const huge = path.join(tmp, 'past-the-limit.har');
    const LIMIT = require('buffer').constants.MAX_STRING_LENGTH;
    const fat = 'z'.repeat(16 * 1024 * 1024);
    const fd = fs.openSync(huge, 'w');
    let count = 0;
    try {
        fs.writeSync(fd, '{"log":{"version":"1.2","entries":[');
        let written = 0;
        while (written <= LIMIT + 1024 * 1024) {
            const chunk = (count === 0 ? '' : ',') + JSON.stringify({ i: count, text: fat });
            fs.writeSync(fd, chunk);
            written += chunk.length;
            count += 1;
        }
        fs.writeSync(fd, ']}}');
    } finally {
        fs.closeSync(fd);
    }
    // Prove the precondition rather than assume it: the old read cannot even
    // produce the string.
    assert.throws(() => fs.readFileSync(huge, 'utf8'), /longer than|string/i,
        'the file is not past the string limit, so this test proves nothing');

    try {
        const read = readHarDocument(huge);
        assert.strictEqual(read.entries.length, count);
        assert.strictEqual(read.entries[count - 1].i, count - 1);
        assert.strictEqual(read.document.log.version, '1.2');
    } finally {
        fs.rmSync(huge, { force: true });
    }
});

test('a walk refuses a corrupt entry AT that entry, as the one canonical error', () => {
    // The contract streaming can keep, stated as it is: a capture refused at the
    // OPEN (not a HAR, truncated, broken envelope) yields nothing; an entry that
    // does not parse is only knowable when the walk reaches it.
    const p = path.join(tmp, 'corrupt-third.har');
    fs.writeFileSync(p, '{"log":{"entries":[{"a":1},{"a":2},{"a":oops},{"a":4}]}}', 'utf8');
    const seen = [];
    let caught = null;
    try { for (const e of iterateHarEntries(p)) seen.push(e.a); } catch (e) { caught = e; }
    assert.deepStrictEqual(seen, [1, 2]);
    assert.ok(caught instanceof HarFormatError, `threw ${caught && caught.constructor.name}`);
    assert.strictEqual(caught.code, 'entry-not-json');
    assert.ok(caught.message.includes('corrupt-third.har'), caught.message);
});

test('a walk over a truncated capture yields nothing and says truncated', () => {
    const p = path.join(tmp, 'cut.har');
    fs.writeFileSync(p, '{"log":{"entries":[{"a":1},{"a":2},{"a"', 'utf8');
    const seen = [];
    let caught = null;
    try { for (const e of iterateHarEntries(p)) seen.push(e); } catch (e) { caught = e; }
    assert.strictEqual(seen.length, 0);
    assert.ok(caught instanceof HarFormatError);
    assert.strictEqual(caught.code, 'truncated');
});

// ---------------------------------------------------------------------------
// 2. The walk-only stages, each under the cap
// ---------------------------------------------------------------------------

test('the capture summary counts entries and hosts of the large capture under the cap', () => {
    const out = underCap('summary.js',
        `const c = ${req('capture/capture-har.js')};\n`
        + 'process.stdout.write(JSON.stringify(c.summarize(process.argv[2])));\n', [BIG]);
    assert.strictEqual(out.parseError, undefined, `summary reported: ${out.parseError}`);
    assert.strictEqual(out.entries, BIG_ENTRIES);
    assert.deepStrictEqual(out.hosts, [...HOSTS].sort());
});

test('the capture summary still records an unreadable capture as parseError, never as zero', () => {
    const c = require(path.join(SCRIPTS, 'capture', 'capture-har.js'));
    const p = path.join(tmp, 'flows.json');
    fs.writeFileSync(p, JSON.stringify({ flows: [] }), 'utf8');
    const s = c.summarize(p);
    assert.strictEqual(s.entries, undefined);
    assert.ok(/log\.entries/.test(s.parseError || ''), `parseError was ${s.parseError}`);
});

test('the catalogue measurement of the large capture runs under the cap', () => {
    const out = underCap('measure.js',
        `const c = ${req('har/har-catalogue.js')};\n`
        + 'process.stdout.write(JSON.stringify(c.measureReference(process.argv[2])));\n', [BIG]);
    assert.strictEqual(out.EntryCount, BIG_ENTRIES);
    assert.deepStrictEqual(out.Methods, ['GET', 'POST']);
    assert.strictEqual(out.ResponseBytes, BIG_ENTRIES * 2048);
    assert.strictEqual(out.RequestBodies, 0);
});

test('the auth detector finds the one bearer entry in the large capture under the cap', () => {
    const r = spawnSync(process.execPath, [CAP, path.join(SCRIPTS, 'har', 'detect-auth.js'), BIG], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `detect-auth exited ${r.status}: ${(r.stderr || '').slice(0, 600)}`);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.authModel, 'bearer');
    assert.strictEqual(out.evidence[0].url, entryFor(BEARER_AT, '').request.url);
});

test('the auth detector still refuses a file that is not a HAR', () => {
    const p = path.join(tmp, 'not-a-har.json');
    fs.writeFileSync(p, JSON.stringify({ flows: [] }), 'utf8');
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'har', 'detect-auth.js'), p], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.ok(/log\.entries/.test(r.stderr), r.stderr);
});

// ---------------------------------------------------------------------------

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
    process.stderr.write(`\n${failures} of ${ran} large-capture read tests FAILED\n`);
    process.exitCode = 1;
} else {
    process.stdout.write(`All large-capture read tests passed (${ran})\n`);
}
