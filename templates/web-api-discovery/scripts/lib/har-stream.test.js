#!/usr/bin/env node
// Behavior tests for har-stream.js -- reading and writing a HAR that is larger
// than a JavaScript string (issue #450).
//
// Zero-dep, runs with `node har-stream.test.js`. Exits non-zero when anything
// fails.
//
// WHAT THESE TESTS ARE FOR, and it is not "the scanner parses JSON". Node's own
// JSON.parse is the oracle for that, and it is used as one throughout: every
// round trip is compared against what JSON.parse/JSON.stringify would have
// produced on the same file. What cannot be borrowed from Node is the part that
// actually broke -- reading a document in pieces without the pieces changing
// the answer -- so that is what is pinned:
//
//  1. CHUNK BOUNDARIES. The reader is run at chunk sizes of one to seven bytes,
//     so every boundary lands somewhere awkward: inside a string, between a
//     backslash and the byte it escapes, inside a multi-byte character, between
//     a closing bracket and the brace after it. A scanner that keeps state in a
//     local instead of across reads passes at 1 MiB and fails here. Section 1's
//     ablation proves the fixtures discriminate, by running a deliberately
//     naive scanner over them and requiring it to FAIL.
//  2. BYTE IDENTITY. "Streaming must not alter what is read" is the issue's
//     own verification criterion, and it is only a claim until a capture that
//     fits in memory round trips to exactly the bytes the old whole-document
//     path produced. Including the key ORDER of the envelope, which is where a
//     rebuilt-rather-than-preserved envelope gives itself away.
//  3. LOUD FAILURE. A file with no log.entries must throw, with a code. It must
//     never yield zero entries -- that is the defect of the adjacent issue
//     #423, and a reader that returns an empty iterator for an unrecognised
//     file re-creates it here.
//  4. MEMORY. The issue says to confirm by measurement, not by reading the
//     code. Section 5 runs the reader in a child process with a 64 MB heap
//     cap over a ~150 MB capture, and runs the OLD whole-document read in the
//     same child as the ablation. Streaming passes; the old path dies. Without
//     the ablation, "it passed" would not distinguish a streaming reader from
//     a machine with enough memory to not care.

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hs = require(path.join(__dirname, 'har-stream.js'));

const tmpRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'har-stream-test-')));
let failures = 0;
let ran = 0;

function test(name, fn) {
    ran++;
    try {
        fn();
    } catch (e) {
        failures++;
        process.stderr.write('FAIL: ' + name + '\n  ' + (e && e.message) + '\n');
    }
}

let seq = 0;
function writeFixture(text) {
    const p = path.join(tmpRoot, 'fixture-' + (seq++) + '.har');
    fs.writeFileSync(p, text, 'utf8');
    return p;
}

// Every fixture is written as JSON.stringify(doc, null, 2) so the byte-identity
// oracle has something to compare against, EXCEPT where a test is specifically
// about a different on-disk shape.
function fixtureFrom(doc) {
    return writeFixture(JSON.stringify(doc, null, 2));
}

// The chunk sizes that matter. 1 through 7 put a boundary at every offset
// modulo a small prime; the default is included so a bug that only appears when
// a whole entry lands inside one chunk is not hidden by the small sizes.
const CHUNK_SIZES = [1, 2, 3, 4, 5, 6, 7, 64, hs.DEFAULT_CHUNK_SIZE];

function readAll(file, chunkSize) {
    const doc = hs.openHarDocument(file, { chunkSize });
    return { envelope: doc.envelope, entries: Array.from(doc.entries()) };
}

// ---------------------------------------------------------------------------
// The documents under test. Each one exists because of a specific way a byte
// scanner can be wrong, named in its own comment.

const DOCS = {
    // Structural bytes inside string VALUES. A scanner that counts braces
    // without tracking strings finds the entries array in the wrong place, or
    // never closes it.
    'braces in strings': {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [
                { text: '{"not":"structure"} [ ] { }' },
                { text: ']]]}}}' },
            ],
        },
    },
    // Escapes. `\"` must not close the string and `\\` must not escape the
    // quote after it -- the classic off-by-one that a chunk boundary between
    // the two bytes exposes.
    'escaped quotes and backslashes': {
        log: {
            version: '1.2',
            entries: [
                { text: 'he said \\"stop\\" and left' },
                { text: 'trailing backslash: \\' },
                { text: '\\\\"' },
                { text: '\\\\\\\\' },
            ],
        },
    },
    // Multi-byte UTF-8. The argument that a byte scanner is safe rests on every
    // structural byte being below 0x80; this is the fixture that would catch it
    // being wrong, with a boundary landing mid-character at chunk size 1-3.
    'multi-byte characters': {
        log: {
            version: '1.2',
            entries: [
                { text: 'café über naïve' },
                { text: '日本語 中文 한국어' },
                { text: '😀🌍🤖 emoji beyond the BMP' },
            ],
        },
    },
    // An `entries` array INSIDE an entry, at the same nesting depth the real one
    // sits at. A scanner matching on depth rather than on the key path locks
    // onto this one and reports the capture as two entries.
    'a decoy entries array inside an entry': {
        log: {
            version: '1.2',
            entries: [
                {
                    request: { url: 'https://example.invalid/a' },
                    response: { content: { text: '{"log":{"entries":[{"decoy":1},{"decoy":2}]}}' } },
                },
                { request: { url: 'https://example.invalid/b' } },
            ],
        },
    },
    // A decoy `entries` key that appears BEFORE the real one in byte order.
    // This is what defeats the obvious shortcut -- find the first `"entries"`
    // and take the array after it -- and it is the fixture the ablation below
    // relies on, because the key PATH is the only thing that tells the two
    // apart.
    'a decoy entries key before the real one': {
        log: {
            version: '1.2',
            comment: { entries: [{ decoy: 1 }, { decoy: 2 }] },
            entries: [{ a: 1 }, { b: 2 }],
        },
    },
    // A decoy that is real nested JSON rather than a string, which is the
    // harder version of the same mistake.
    'a decoy entries array as real structure': {
        log: {
            version: '1.2',
            entries: [
                { body: { log: { entries: [{ decoy: 1 }, { decoy: 2 }, { decoy: 3 }] } } },
            ],
        },
    },
    // `entries` NOT last in `log`. This is what catches an envelope that is
    // rebuilt by deleting the key and putting it back, which silently moves it
    // to the end and makes every round trip a diff.
    'entries followed by more envelope keys': {
        log: {
            version: '1.2',
            entries: [{ a: 1 }, { b: 2 }],
            pages: [{ id: 'page_1', title: 'after the entries' }],
            comment: 'trailing envelope key',
        },
    },
    // Empty. Legal, and the one case where the writer must emit `[]` on one
    // line rather than an opened-and-closed block.
    'an empty entries array': {
        log: { version: '1.2', entries: [], comment: 'nothing recorded' },
    },
    // Scalars and nulls as entries. Not a real HAR, but the element tracker
    // must not assume every element opens with a brace.
    'scalar elements': {
        log: { version: '1.2', entries: [1, 'two', null, true, 3.5, [4], { five: 5 }] },
    },
    // A mitmproxy-shaped envelope: same HAR 1.2 structure, different creator,
    // pages present. Pinned so neither this reader nor anything built on it
    // regresses into assuming the Playwright shape is the only one it reads.
    // Invented hosts; no real capture content.
    'a mitmproxy-shaped envelope': {
        log: {
            version: '1.2',
            creator: { name: 'mitmproxy', version: '12.2.3', comment: 'hardump' },
            pages: [],
            entries: [
                { startedDateTime: '2026-01-01T00:00:00.000Z', request: { method: 'GET', url: 'https://example.invalid/one' } },
                { startedDateTime: '2026-01-01T00:00:01.000Z', request: { method: 'POST', url: 'https://example.invalid/two' } },
            ],
        },
    },
};

// ---------------------------------------------------------------------------
// 1. Chunk boundaries do not change the answer.

for (const [name, doc] of Object.entries(DOCS)) {
    const file = fixtureFrom(doc);
    const expected = JSON.parse(fs.readFileSync(file, 'utf8')).log.entries;

    test('entries read identically at every chunk size: ' + name, () => {
        for (const chunkSize of CHUNK_SIZES) {
            const got = readAll(file, chunkSize).entries;
            assert.deepStrictEqual(got, expected,
                'chunk size ' + chunkSize + ' changed the entries');
        }
    });

    test('the envelope keeps entries in its original position: ' + name, () => {
        const { envelope } = readAll(file, 3);
        const whole = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepStrictEqual(Object.keys(envelope.log), Object.keys(whole.log),
            'log key ORDER must survive -- a rebuilt envelope moves entries to the end');
        assert.deepStrictEqual(envelope.log.entries, [],
            'the placeholder is an empty array, not the entries themselves');
        // Every other envelope key is the real value, not a placeholder.
        for (const k of Object.keys(whole.log)) {
            if (k === 'entries') continue;
            assert.deepStrictEqual(envelope.log[k], whole.log[k], k + ' survived');
        }
    });
}

// The ablation for section 1: a scanner that ignores string state. If the
// fixtures above did not actually contain boundary hazards, this would pass
// too, and section 1 would be proving nothing.
function naiveEntries(file) {
    const text = fs.readFileSync(file, 'utf8');
    const at = text.indexOf('"entries"');
    if (at === -1) return [];
    const open = text.indexOf('[', at);
    let depth = 0;
    let i = open;
    for (; i < text.length; i += 1) {
        const c = text[i];
        if (c === '[' || c === '{') depth += 1;
        else if (c === ']' || c === '}') {
            depth -= 1;
            if (depth === 0) break;
        }
    }
    return JSON.parse(text.slice(open, i + 1));
}

test('ABLATION: a string-blind scanner gets the hazardous fixtures wrong', () => {
    // Chosen because each defeats the naive scanner for a DIFFERENT reason:
    // the first because structural bytes inside a string value unbalance its
    // depth count, the second because it takes the first `"entries"` key it
    // finds rather than the one at the right path. A hazard that the naive
    // scanner happens to survive would silently weaken this ablation, so the
    // count is asserted rather than the disjunction.
    const hazards = ['braces in strings', 'a decoy entries key before the real one'];
    let wrong = 0;
    for (const name of hazards) {
        const file = fixtureFrom(DOCS[name]);
        const expected = JSON.parse(fs.readFileSync(file, 'utf8')).log.entries;
        let got;
        try {
            got = naiveEntries(file);
        } catch {
            wrong += 1;
            continue;
        }
        try {
            assert.deepStrictEqual(got, expected);
        } catch {
            wrong += 1;
        }
    }
    assert.strictEqual(wrong, hazards.length,
        'every hazardous fixture must defeat the naive scanner, or it is not a hazard');
});

// ---------------------------------------------------------------------------
// 2. Byte identity: streaming must not alter what is read.

for (const [name, doc] of Object.entries(DOCS)) {
    test('a streamed write is byte-identical to JSON.stringify: ' + name, () => {
        const file = fixtureFrom(doc);
        const expected = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2);
        const out = path.join(tmpRoot, 'out-' + (seq++) + '.har');
        const opened = hs.openHarDocument(file, { chunkSize: 5 });
        hs.writeHarDocument(out, opened.envelope, opened.entries());
        const actual = fs.readFileSync(out, 'utf8');
        assert.strictEqual(actual, expected, 'round trip changed the bytes');
    });
}

test('a write reflects a FILTERED entry stream, and stays well-formed', () => {
    const file = fixtureFrom(DOCS['a mitmproxy-shaped envelope']);
    const out = path.join(tmpRoot, 'filtered.har');
    const opened = hs.openHarDocument(file, { chunkSize: 7 });
    const kept = [];
    const source = (function* () {
        for (const e of opened.entries()) {
            if (e.request && e.request.method === 'GET') { kept.push(e); yield e; }
        }
    })();
    const res = hs.writeHarDocument(out, opened.envelope, source);
    assert.strictEqual(res.entries, 1, 'one entry survived the filter');
    const back = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepStrictEqual(back.log.entries, kept);
    assert.strictEqual(back.log.creator.name, 'mitmproxy', 'the envelope came along');
    // And the filtered document is itself byte-identical to what the old
    // whole-document path would have written for the same result.
    const whole = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expected = JSON.stringify(
        Object.assign({}, whole, { log: Object.assign({}, whole.log, { entries: kept }) }), null, 2);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), expected);
});

test('a source document that is NOT pretty-printed still round trips', () => {
    // The pipeline's own trim writes pretty-printed output, so stage two always
    // receives it -- but a recorder may write compact, and the reader must not
    // depend on the whitespace it happens to see.
    const doc = DOCS['entries followed by more envelope keys'];
    const compact = writeFixture(JSON.stringify(doc));
    const opened = hs.openHarDocument(compact, { chunkSize: 2 });
    assert.deepStrictEqual(Array.from(opened.entries()), doc.log.entries);
    const out = path.join(tmpRoot, 'from-compact.har');
    hs.writeHarDocument(out, opened.envelope, opened.entries());
    assert.strictEqual(fs.readFileSync(out, 'utf8'), JSON.stringify(doc, null, 2),
        'output formatting comes from the writer, not from the input');
});

test('the committed HAR fixtures round trip byte-identically', () => {
    // Real files rather than invented ones: these are what the pipeline's other
    // suites assert against, so a reader that changed them would be caught
    // everywhere at once -- but only after the change had landed.
    const dir = path.join(__dirname, '..', '..', '..', '..',
        '.github', 'agents', 'tests', 'fixtures', 'har');
    if (!fs.existsSync(dir)) {
        throw new Error('fixture directory not found at ' + dir
            + ' -- this test is about REAL captures and silently skipping it '
            + 'would make it a test that can never fail');
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.har'));
    assert.ok(files.length >= 5, 'expected the committed fixture corpus, found ' + files.length);
    let checked = 0;
    for (const f of files) {
        const file = path.join(dir, f);
        const whole = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!whole || !whole.log || !Array.isArray(whole.log.entries)) continue;
        const opened = hs.openHarDocument(file, { chunkSize: 3 });
        assert.deepStrictEqual(Array.from(opened.entries()), whole.log.entries, f + ' entries');
        const out = path.join(tmpRoot, 'committed-' + f);
        hs.writeHarDocument(out, opened.envelope, opened.entries());
        assert.strictEqual(fs.readFileSync(out, 'utf8'), JSON.stringify(whole, null, 2), f + ' bytes');
        checked += 1;
    }
    assert.ok(checked >= 5, 'expected to have checked at least 5 real captures, checked ' + checked);
});

// ---------------------------------------------------------------------------
// 3. Loud failure. Never a zero.

test('a JSON document that is not a HAR throws rather than yielding nothing', () => {
    const file = writeFixture(JSON.stringify({ notAHar: true, items: [1, 2, 3] }, null, 2));
    let caught = null;
    try {
        hs.openHarDocument(file, { chunkSize: 4 });
    } catch (e) {
        caught = e;
    }
    assert.ok(caught, 'a file with no log.entries must not open successfully');
    assert.strictEqual(caught.name, 'HarStreamError');
    assert.strictEqual(caught.code, hs.codes.ENTRIES_NOT_FOUND);
    assert.ok(caught.message.includes(file), 'the operator is told WHICH file');
});

test('log.entries that is an OBJECT is not mistaken for the array', () => {
    const file = writeFixture(JSON.stringify({ log: { version: '1.2', entries: { a: 1 } } }, null, 2));
    assert.throws(() => hs.openHarDocument(file, { chunkSize: 4 }),
        (e) => e.code === hs.codes.ENTRIES_NOT_FOUND);
});

test('an entries array nested somewhere other than log is not accepted', () => {
    const file = writeFixture(JSON.stringify({ data: { log: { entries: [{ a: 1 }] } } }, null, 2));
    assert.throws(() => hs.openHarDocument(file, { chunkSize: 4 }),
        (e) => e.code === hs.codes.ENTRIES_NOT_FOUND);
});

test('a capture truncated inside the entries array says so, distinctly', () => {
    const full = JSON.stringify(DOCS['a mitmproxy-shaped envelope'], null, 2);
    const file = writeFixture(full.slice(0, Math.floor(full.length * 0.7)));
    let caught = null;
    try { hs.openHarDocument(file, { chunkSize: 6 }); } catch (e) { caught = e; }
    assert.ok(caught, 'a truncated capture must not open');
    assert.strictEqual(caught.code, hs.codes.TRUNCATED,
        'truncated is not the same condition as not-a-HAR, and the operator needs the difference');
});

test('an entry that is not valid JSON names its index', () => {
    const file = writeFixture('{\n  "log": {\n    "entries": [\n      {"a":1},\n      {"b":},\n      {"c":3}\n    ]\n  }\n}');
    const opened = hs.openHarDocument(file, { chunkSize: 4 });
    const it = opened.entries();
    assert.deepStrictEqual(it.next().value, { a: 1 }, 'entries before the bad one still arrive');
    let caught = null;
    try { it.next(); } catch (e) { caught = e; }
    assert.ok(caught, 'the malformed entry must throw');
    assert.strictEqual(caught.code, hs.codes.ENTRY_UNPARSEABLE);
    assert.ok(/entry 1\b/.test(caught.message), 'the index is named: ' + caught.message);
});

test('an envelope that is not valid JSON is reported as such', () => {
    const file = writeFixture('{\n  "log": {\n    "version": ,\n    "entries": [{"a":1}]\n  }\n}');
    assert.throws(() => hs.openHarDocument(file, { chunkSize: 4 }),
        (e) => e.code === hs.codes.ENVELOPE_UNPARSEABLE);
});

test('an escaped spelling of the log key is still recognised', () => {
    // JSON permits "log" as a spelling of "log". Nothing here writes that,
    // but a scanner that compared raw bytes would call this file not-a-HAR --
    // a loud answer that is also wrong.
    const file = writeFixture('{\n  "\\u006cog": {\n    "\\u0065ntries": [{"a":1},{"b":2}]\n  }\n}');
    const opened = hs.openHarDocument(file, { chunkSize: 3 });
    assert.deepStrictEqual(Array.from(opened.entries()), [{ a: 1 }, { b: 2 }]);
});

test('a very long string value cannot masquerade as the entries key', () => {
    // The key candidate is capped, so a 1 KB string is never decoded as a key.
    // The cap must not make the real key unreadable, which is what the entries
    // assertion below is for.
    const long = 'x'.repeat(4096);
    const file = fixtureFrom({ log: { version: long, entries: [{ a: 1 }] } });
    const opened = hs.openHarDocument(file, { chunkSize: 5 });
    assert.deepStrictEqual(Array.from(opened.entries()), [{ a: 1 }]);
    assert.strictEqual(opened.envelope.log.version, long);
});

test('the writer refuses an envelope with no log.entries to fill', () => {
    const out = path.join(tmpRoot, 'no-entries.har');
    assert.throws(() => hs.writeHarDocument(out, { log: { version: '1.2' } }, []),
        (e) => e.code === hs.codes.ENTRIES_NOT_FOUND);
});

test('the writer honours an exclusive-create flag', () => {
    const out = path.join(tmpRoot, 'exclusive.har');
    const env = { log: { version: '1.2', entries: [] } };
    hs.writeHarDocument(out, env, [{ a: 1 }], { flag: 'wx' });
    assert.throws(() => hs.writeHarDocument(out, env, [{ a: 1 }], { flag: 'wx' }),
        (e) => e.code === 'EEXIST');
});

// ---------------------------------------------------------------------------
// 4. Entries can be walked more than once, and the second walk agrees.

test('entries() may be called twice and gives the same answer', () => {
    const file = fixtureFrom(DOCS['a mitmproxy-shaped envelope']);
    const opened = hs.openHarDocument(file, { chunkSize: 4 });
    assert.deepStrictEqual(Array.from(opened.entries()), Array.from(opened.entries()));
});

// ---------------------------------------------------------------------------
// 5. Memory does not scale with file size -- measured, not inspected.

test('a capture far larger than the heap cap streams, while the old path dies', () => {
    // ~150 MB of many small entries. Big enough that holding the whole document
    // cannot fit in a 64 MB heap, small enough to build in a few seconds.
    const big = path.join(tmpRoot, 'big.har');
    const fd = fs.openSync(big, 'w');
    try {
        fs.writeSync(fd, '{\n  "log": {\n    "version": "1.2",\n    "entries": [\n');
        const filler = 'y'.repeat(1024);
        const target = 150 * 1024 * 1024;
        let written = 0;
        let n = 0;
        let buf = '';
        while (written < target) {
            const entry = JSON.stringify({ i: n, text: filler });
            const chunk = (n === 0 ? '' : ',\n') + '      ' + entry;
            buf += chunk;
            written += chunk.length;
            n += 1;
            if (buf.length > 8 * 1024 * 1024) { fs.writeSync(fd, buf); buf = ''; }
        }
        fs.writeSync(fd, buf + '\n    ]\n  }\n}\n');
    } finally {
        fs.closeSync(fd);
    }
    const size = fs.statSync(big).size;
    assert.ok(size > 100 * 1024 * 1024, 'the measurement needs a genuinely large file, got ' + size);

    const streamScript = path.join(tmpRoot, 'measure-stream.js');
    fs.writeFileSync(streamScript,
        'const hs = require(' + JSON.stringify(path.join(__dirname, 'har-stream.js')) + ');\n'
        + 'let n = 0, last = null;\n'
        + 'for (const e of hs.openHarDocument(process.argv[2]).entries()) { n += 1; last = e.i; }\n'
        + 'const peak = Math.round(process.memoryUsage().heapUsed / 1048576);\n'
        + 'process.stdout.write(JSON.stringify({ n, last, peak }));\n', 'utf8');

    const naiveScript = path.join(tmpRoot, 'measure-naive.js');
    fs.writeFileSync(naiveScript,
        'const fs = require("fs");\n'
        + 'const doc = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));\n'
        + 'process.stdout.write(String(doc.log.entries.length));\n', 'utf8');

    const CAP = ['--max-old-space-size=64'];
    let streamed = null;
    try {
        streamed = JSON.parse(execFileSync(process.execPath, CAP.concat([streamScript, big]),
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
        throw new Error('streaming read failed under a 64 MB heap cap: '
            + ((e.stderr || '') + (e.message || '')).slice(0, 400));
    }
    assert.ok(streamed.n > 100000, 'expected a lot of entries, got ' + streamed.n);
    assert.strictEqual(streamed.last, streamed.n - 1, 'the last entry is the last one written');
    assert.ok(streamed.peak < 64, 'heap stayed inside the cap: ' + streamed.peak + ' MB');

    // The ablation. Without this, "streaming passed" would be indistinguishable
    // from "the cap was never binding".
    let naiveFailed = false;
    try {
        execFileSync(process.execPath, CAP.concat([naiveScript, big]),
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
        naiveFailed = true;
    }
    assert.ok(naiveFailed,
        'the whole-document read must fail under the same cap, or the cap proves nothing');
});

// ---------------------------------------------------------------------------

if (failures) {
    process.stderr.write('\n' + failures + ' of ' + ran + ' har-stream tests FAILED\n');
    process.exitCode = 1;
} else {
    process.stdout.write('All har-stream tests passed (' + ran + ')\n');
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { void err; }
