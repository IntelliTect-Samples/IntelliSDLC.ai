#!/usr/bin/env node
// Behavior tests for the capture read boundary (issue #423).
//
// THE DEFECT, stated as the operator experiences it: a capture the tooling
// cannot read reports as a capture containing nothing. Every gate downstream
// is then honest about a corpus that is silently short -- `buildDigest`
// produces no groups, the catalogue guard blames the catalogue, a generated
// api.json describes a provider as though those sessions never happened, and
// nothing anywhere says "this file is in a format I do not read".
//
// WHAT THE ISSUE SUPPOSED, AND WHAT IS ACTUALLY TRUE. #423 was filed believing
// mitmproxy `hardump` exports were an unreadable second format. They are not:
// they are standard HAR 1.2, `log.entries` and all, and they read correctly.
// The first test below is that fact, pinned, so nobody re-introduces a
// Playwright-only assumption on the strength of the original report. The real
// trigger is narrower and was found by running the issue's own falsifier: a
// file that parses as JSON but is NOT a HAR folds to zero entries and exits 0.
//
// WHAT MUST NOT REGRESS, in one sentence: an unrecognised capture fails
// loudly, and a genuinely empty one stays distinguishable from it. Those are
// different facts about the world and a single `[]` told the operator neither.
//
// Each CLI assertion checks the exit code AND the message. An exit code alone
// passes for any crash, including one this guard had nothing to do with --
// which is how a guard gets credit for a stack trace.
//
// Zero-dep, runs with `node har-unreadable-capture.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const harDocument = require(path.join(__dirname, 'har-document.js'));
const { readHarDocument, parseHarDocument, iterateHarEntries, HarFormatError } = harDocument;

const FIXTURES = path.join(__dirname, '..', '..', '..', '..', '.github', 'agents', 'tests', 'fixtures', 'har');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-unreadable-'));

let passed = 0;
function test(name, fn) { fn(); passed++; }

function write(name, contents) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 4), 'utf8');
    return p;
}

function run(script, args) {
    const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}

// The shapes an operator actually has on disk.
const NOT_A_HAR = { flows: [{ request: { method: 'GET' } }], recordedBy: 'something else' };
const HAR_WITHOUT_ENTRIES = { log: { version: '1.2', creator: { name: 'x', version: '1' } } };
const ENTRIES_NOT_A_LIST = { log: { version: '1.2', entries: { '0': {} } } };
const EMPTY_BUT_A_HAR = { log: { version: '1.2', creator: { name: 'x', version: '1' }, entries: [] } };

// ---------------------------------------------------------------------------
// The premise the issue was filed on, pinned as the FACT it turned out to be
// ---------------------------------------------------------------------------

test('a pretty-printed mitmproxy capture reads its full entry count, not zero', () => {
    // This is the whole of the "format support" half of #423. mitmproxy writes
    // HAR 1.2 with the same envelope Playwright writes; the only things that
    // differ are `log.creator.name` and the whitespace. A reader that needed
    // teaching a second shape was solving a problem that does not exist, and
    // this fixture is here so a future change cannot quietly create one.
    const doc = readHarDocument(path.join(FIXTURES, 'mitmproxy-pretty.har'));
    assert.strictEqual(doc.entries.length, 3);
    assert.strictEqual(doc.document.log.creator.name, 'mitmproxy');
    assert.deepStrictEqual(doc.entries.map((e) => e.request.method), ['GET', 'POST', 'GET']);
});

test('a Playwright capture reads the same way, through the same one reader', () => {
    const doc = readHarDocument(path.join(FIXTURES, 'rest-3endpoints.har'));
    assert.ok(doc.entries.length > 0, 'the Playwright fixture read as empty');
    assert.ok(Array.isArray(doc.entries));
});

// ---------------------------------------------------------------------------
// The defect: unrecognised must fail, empty must not
// ---------------------------------------------------------------------------

test('JSON that is not a HAR fails loudly instead of reading as zero entries', () => {
    const p = write('not-a-har.json', NOT_A_HAR);
    assert.throws(() => readHarDocument(p), (e) => {
        assert.ok(e instanceof HarFormatError, `threw ${e.constructor.name}, not HarFormatError`);
        assert.strictEqual(e.code, 'not-a-har');
        return true;
    });
});

test('the failure names the file and the shape it found, so the operator can tell what it is', () => {
    const p = write('flows-dump.json', NOT_A_HAR);
    let message = '';
    try { readHarDocument(p); } catch (e) { message = e.message; }
    assert.ok(message.includes('flows-dump.json'), `message does not name the file: ${message}`);
    assert.ok(/log\.entries/.test(message), `message does not say what was missing: ${message}`);
    // Top-level keys are SHAPE. "this is a flows dump" and "this is corrupt"
    // are different problems with different repairs, and a message that named
    // neither sent the operator to read the file by hand.
    assert.ok(/flows/.test(message) && /recordedBy/.test(message),
        `message does not name the top-level keys: ${message}`);
});

test('the failure quotes no captured VALUE, only key names', () => {
    // A raw capture holds live credentials. An error message is printed to a
    // terminal, pasted into an issue and swept into CI logs -- it is the last
    // place a captured value should surface.
    const p = write('secretish.json', { sessionToken: 'tok_live_SHOULD_NEVER_APPEAR', other: 1 });
    let message = '';
    try { readHarDocument(p); } catch (e) { message = e.message; }
    assert.ok(message.includes('sessionToken'), 'the key name should be named');
    assert.ok(!message.includes('tok_live_SHOULD_NEVER_APPEAR'), `the VALUE leaked into the message: ${message}`);
});

test('a HAR whose log carries no entries fails rather than folding to []', () => {
    const p = write('no-entries.har', HAR_WITHOUT_ENTRIES);
    assert.throws(() => readHarDocument(p), (e) => e instanceof HarFormatError && e.code === 'not-a-har');
});

test('entries that are not a list fail rather than iterating as nothing', () => {
    const p = write('entries-object.har', ENTRIES_NOT_A_LIST);
    assert.throws(() => readHarDocument(p), (e) => e instanceof HarFormatError && e.code === 'not-a-har');
});

test('a file that is not JSON at all fails as not-json, a different fact', () => {
    const p = write('garbage.har', 'GET /a HTTP/1.1\r\n\r\n');
    assert.throws(() => readHarDocument(p), (e) => e instanceof HarFormatError && e.code === 'not-json');
});

test('a missing file fails as unreadable, and says which file', () => {
    const p = path.join(tmp, 'absent.har');
    let caught = null;
    try { readHarDocument(p); } catch (e) { caught = e; }
    assert.ok(caught instanceof HarFormatError);
    assert.strictEqual(caught.code, 'unreadable');
    assert.ok(caught.message.includes('absent.har'));
});

test('a genuinely empty capture reads as zero entries WITHOUT failing', () => {
    // The distinction this whole issue exists to restore. "I read it and there
    // was nothing in it" and "I could not read it" are different sentences and
    // the operator acts on them differently.
    const p = write('empty.har', EMPTY_BUT_A_HAR);
    const doc = readHarDocument(p);
    assert.strictEqual(doc.entries.length, 0);
});

test('parseHarDocument reports the label it was given rather than a path it never saw', () => {
    assert.throws(() => parseHarDocument('{"flows":[]}', 'stdin'), (e) => {
        assert.ok(e.message.includes('stdin'));
        return e instanceof HarFormatError;
    });
});

// ---------------------------------------------------------------------------
// The entry-at-a-time surface -- #450 swaps its internals for a streaming
// generator, so it has to exist before the call sites are migrated onto it.
// ---------------------------------------------------------------------------

test('entries can be walked one at a time, and the walk fails on an unreadable capture too', () => {
    const good = path.join(FIXTURES, 'mitmproxy-pretty.har');
    const seen = [];
    for (const entry of iterateHarEntries(good)) seen.push(entry.request.method);
    assert.deepStrictEqual(seen, ['GET', 'POST', 'GET']);

    const bad = write('walk-not-a-har.json', NOT_A_HAR);
    assert.throws(() => { for (const entry of iterateHarEntries(bad)) { void entry; } },
        (e) => e instanceof HarFormatError && e.code === 'not-a-har');
});

test('an unreadable capture yields NOTHING rather than a partial walk', () => {
    const bad = write('walk-empty-first.json', HAR_WITHOUT_ENTRIES);
    let yielded = 0;
    try { for (const entry of iterateHarEntries(bad)) { void entry; yielded++; } } catch (e) { void e; }
    assert.strictEqual(yielded, 0);
});

test('an engine error becomes the ONE canonical type, and keeps its code', () => {
    // #450's streaming engine cannot import this module to throw its error --
    // this module requires the engine, and an import cycle is the price of
    // both directions. So the engine raises its own error with a stable code
    // and the boundary translates. Two error classes for one condition is how
    // a caller ends up catching half of them.
    for (const code of harDocument.HAR_FORMAT_CODES) {
        const translated = harDocument.fromEngineError({ code, message: 'from the engine' }, 'big.har');
        assert.ok(translated instanceof HarFormatError, `${code} did not become a HarFormatError`);
        assert.strictEqual(translated.code, code);
        assert.ok(translated.message.includes('big.har'));
    }
});

test('a translated refusal always names the file, even when the label collides by accident', () => {
    // The finding that justified the whole dedup being re-examined. The label
    // is skipped only when the detail ALREADY starts with it -- a containment
    // test was satisfied by coincidence, so a label of `a` counted as "already
    // named" inside `cannot read data` and the message came out naming no file
    // at all. That is the single outcome this boundary exists to prevent, so
    // it is pinned against the accidents rather than the happy path.
    const collisions = [
        ['a', 'cannot read data: file corrupt'],
        ['is', 'this file is broken'],
        ['or', 'the entry index is out of order'],
        ['captures', 'something went wrong in captures somewhere'],
    ];
    for (const [label, detail] of collisions) {
        const e = harDocument.fromEngineError({ code: 'not-a-har', message: detail }, label);
        assert.ok(e.message.startsWith(`${label} `),
            `label '${label}' was wrongly treated as already named: ${e.message}`);
    }

    // The degenerate pair, which a prefix test alone still lost. Neither is
    // reachable from a current caller; both are constructible, and this is the
    // function every other stage's refusal goes through, so "no caller does
    // that today" is a reason to pin it rather than to skip it.
    const noLabel = harDocument.fromEngineError({ code: 'not-a-har', message: 'cannot read data' }, '');
    assert.ok(/^the capture cannot be read as a HAR/.test(noLabel.message),
        `a missing label produced a refusal naming nothing: ${noLabel.message}`);

    // An error carrying no message of its own stringifies to `Error`, which a
    // file named `E` is a prefix of.
    const stringified = harDocument.fromEngineError({ code: 'not-a-har', message: 'Error' }, 'E');
    assert.ok(stringified.message.startsWith('E cannot be read as a HAR'),
        `a one-character name was swallowed by the stringified error: ${stringified.message}`);

    // And the real case still dedups, in BOTH spellings the engine uses -- the
    // path followed by a space, and the path followed by a colon.
    for (const detail of [
        'raw.har has no log.entries',
        'raw.har: entry 0 is not valid JSON',
    ]) {
        const e = harDocument.fromEngineError({ code: 'not-a-har', message: detail }, 'raw.har');
        assert.strictEqual(e.message.split('raw.har').length - 1, 1,
            `the file is named more than once: ${e.message}`);
    }
    // Whatever the branch, the common phrase is always there: it is what makes
    // an open-level and an entry-level refusal read as one kind of event.
    for (const [label, detail] of [...collisions, ['raw.har', 'raw.har has no log.entries']]) {
        assert.ok(harDocument.fromEngineError({ code: 'not-a-har', message: detail }, label)
            .message.includes('cannot be read as a HAR'));
    }
});

test('a code the boundary does not know degrades rather than escaping as a foreign type', () => {
    const translated = harDocument.fromEngineError({ code: 'invented-later', message: 'x' }, 'big.har');
    assert.ok(translated instanceof HarFormatError);
    assert.strictEqual(translated.code, 'unreadable');
});

test('every code the streaming engine raises is one the boundary promises', () => {
    // The two modules match on STRING, not on a shared constant, because the
    // boundary requires the engine and a require back would be the cycle both
    // sides were built to avoid. Matching on a string is only safe if something
    // checks it, so this is that check: a code added to the engine and
    // forgotten here fails loudly, instead of quietly degrading to `unreadable`
    // and telling the operator less than the engine knew.
    const engine = require(path.join(__dirname, '..', 'lib', 'har-stream.js'));
    const raised = Object.values(engine.codes);
    assert.ok(raised.length > 0, 'the engine exports no codes to check');
    for (const code of raised) {
        assert.ok(harDocument.HAR_FORMAT_CODES.includes(code),
            `the engine raises '${code}', which the boundary does not promise`);
    }
});

test('truncation is refused at the OPEN, a corrupt entry at the WALK', () => {
    // Pinned because I had this backwards in a comment and a reviewer caught
    // it. A wrong belief about which stage raises what is exactly the kind that
    // survives as a test asserting the opposite of what happens, so the fact is
    // measured here rather than described anywhere.
    //
    // The open locates the entries array by scanning for its closing bracket,
    // so a document that ends mid-entries cannot yield even one entry. Only the
    // per-entry conditions -- a corrupt entry, an entry too large to hold --
    // are unknowable until an individual entry is decoded.
    const engine = require(path.join(__dirname, '..', 'lib', 'har-stream.js'));
    const full = fs.readFileSync(path.join(FIXTURES, 'mitmproxy-pretty.har'), 'utf8');

    const stageOf = (name, text) => {
        const p = write(name, text);
        try {
            const doc = engine.openHarDocument(p);
            try {
                for (const entry of doc.entries()) { void entry; }
            } catch (e) { return { stage: 'walk', code: e.code }; }
        } catch (e) { return { stage: 'open', code: e.code }; }
        return { stage: 'none', code: null };
    };

    assert.deepStrictEqual(
        stageOf('cut-short.har', full.slice(0, Math.floor(full.length * 0.6))),
        { stage: 'open', code: 'truncated' });

    assert.deepStrictEqual(
        stageOf('bad-entry.har', full.replace('"startedDateTime"', 'startedDateTime')),
        { stage: 'walk', code: 'entry-not-json' });
});

test('both stages refuse in the same words, because both go through the boundary', () => {
    // The gap this closes: the engine relays its own message at the walk, so
    // without translation an entry-level failure came out phrased differently
    // from an open-level one -- two voices for one condition, in the command
    // whose whole job is the largest captures.
    const full = fs.readFileSync(path.join(FIXTURES, 'mitmproxy-pretty.har'), 'utf8');
    const out = path.join(tmp, 'never-written.har');

    for (const [name, text] of [
        ['trim-cut-short.har', full.slice(0, Math.floor(full.length * 0.6))],
        ['trim-bad-entry.har', full.replace('"startedDateTime"', 'startedDateTime')],
    ]) {
        const p = write(name, text);
        const r = run('trim-har-capture.js', ['--in', p, '--out', out]);
        assert.strictEqual(r.code, 1, `${name} did not exit 1: ${r.all}`);
        assert.ok(r.all.includes(p), `${name}: the refusal does not name the file: ${r.all}`);
        // The discriminator. Without translation the engine's own message is
        // relayed verbatim at the walk and this phrase is absent -- so an exit
        // code and a filename alone would have passed either way, which is the
        // vacuous assertion this suite exists to avoid making.
        assert.ok(r.all.includes('cannot be read as a HAR'),
            `${name}: the refusal did not come through the boundary: ${r.all}`);
        // And the file is named ONCE. Printing the path twice in one sentence
        // reads as a bug in the tool reporting the bug.
        assert.strictEqual(r.all.split(p).length - 1, 1,
            `${name}: the file is named more than once: ${r.all}`);
        assert.ok(!fs.existsSync(out), `${name}: wrote an output for a capture it refused`);
    }
});

test('the codes an operator is told apart stay told apart', () => {
    // Each of these is a different sentence to a human and a different repair.
    // Collapsing any pair of them would be the same mistake as the `[]` this
    // whole issue is about, one level down.
    for (const code of ['not-json', 'not-a-har', 'envelope-not-json', 'truncated',
        'entry-not-json', 'entry-too-large']) {
        assert.ok(harDocument.HAR_FORMAT_CODES.includes(code), `${code} is no longer promised`);
    }
});

// ---------------------------------------------------------------------------
// The stages, as an operator runs them
// ---------------------------------------------------------------------------

test('detect-auth no longer answers "HAR contained no entries" for a file it cannot read', () => {
    const p = write('auth-not-a-har.json', NOT_A_HAR);
    const r = run('detect-auth.js', [p]);
    assert.notStrictEqual(r.code, 0, `detect-auth exited ${r.code} on a non-HAR`);
    assert.ok(/log\.entries/.test(r.all), `no message explaining the refusal: ${r.all}`);
    assert.ok(!/contained no entries/.test(r.stdout), 'still reports the file as empty');
});

test('verify-scrub does not certify a file it could not read as having 0 blocking leaks', () => {
    // The worst of the silent zeroes: a scrub gate issuing a clean bill of
    // health on a document it never understood.
    const p = write('scrub-not-a-har.json', NOT_A_HAR);
    const r = run('verify-scrub.js', ['--in', p]);
    assert.notStrictEqual(r.code, 0, `verify-scrub exited ${r.code} on a non-HAR`);
    assert.ok(!/0 blocking leaks/.test(r.stdout), `still printed a pass: ${r.stdout}`);
    assert.ok(/log\.entries/.test(r.all), `no message explaining the refusal: ${r.all}`);
});

test('verify-scrub still sweeps a malformed file rather than skipping it', () => {
    // A gate that skipped what it could not parse is a gate anyone could
    // bypass by malforming the file. The refusal must be additional to the
    // sweep, never instead of it.
    const leaky = write('garbage-with-secret.har', 'not json at all, authorization: Bearer abcdefghijklmnop');
    const r = run('verify-scrub.js', ['--in', leaky]);
    assert.notStrictEqual(r.code, 0);
    assert.ok(!/0 blocking leaks/.test(r.stdout));
});

test('generate-api-document refuses a reference whose entries are missing', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'apidoc-'));
    fs.writeFileSync(path.join(dir, 'reference.har'), JSON.stringify(HAR_WITHOUT_ENTRIES), 'utf8');
    const r = run('generate-api-document.js', ['--dir', dir]);
    assert.notStrictEqual(r.code, 0, `generate-api-document exited ${r.code}`);
    assert.ok(/log\.entries/.test(r.all), `no message explaining the refusal: ${r.all}`);
});

test('trim-har-capture keeps the refusal it already had', () => {
    const p = write('trim-not-a-har.json', NOT_A_HAR);
    const out = path.join(tmp, 'trimmed-never-written.har');
    const r = run('trim-har-capture.js', ['--in', p, '--out', out]);
    assert.notStrictEqual(r.code, 0);
    assert.ok(!fs.existsSync(out), 'wrote an output for a capture it could not read');
});

// ---------------------------------------------------------------------------
// One definition, not nine
// ---------------------------------------------------------------------------

test('every stage that reads a capture from disk goes through the one reader', () => {
    // Nine scripts shared the `|| []` fold. Nine repairs that agree today are
    // how a guard and the thing it guards drift into disagreeing about what a
    // HAR is -- and #450 replaces this module's internals with a streaming
    // engine, which only works if there is exactly one place to replace.
    const stages = [
        'detect-auth.js',
        'extract-har-reference.js',
        'generate-api-document.js',
        'har-catalogue.js',
        'trim-har-capture.js',
        'verify-har-reference.js',
        'verify-scrub.js',
        'audit-scrub-drift.js',
    ];
    for (const stage of stages) {
        const source = fs.readFileSync(path.join(__dirname, stage), 'utf8');
        assert.ok(/har-document/.test(source), `${stage} does not use the shared capture reader`);
    }
});

console.log(`All har-unreadable-capture tests passed (${passed} assertions)`);
