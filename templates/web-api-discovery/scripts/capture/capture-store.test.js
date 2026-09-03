#!/usr/bin/env node
// Behavior tests for the one walk over a capture store (issues #386 / #387).
//
// WHAT THESE PIN, AND WHY EACH IS A SEPARATE ASSERTION.
//
// The walk that already existed -- `listSessionDirs`, the enumeration
// `resolveSession` uses -- understood exactly one shape: `<root>/<host>/<stamp>`
// holding a `session.json`. Measured against a real 88-capture store, that
// shape silently misses two whole populations, and "silently" is the defect:
// the operator asks for the store and gets a subset with nothing said.
//
//   LEGACY   six date-stamped session directories at the captures ROOT,
//            written before the host layer existed. A host-scoped walk never
//            descends to them.
//   FOREIGN  five mitmproxy dumps with a `raw.mitm` and no `session.json`.
//            They must be NAMED and DECLINED -- not fed to a HAR scrub that
//            cannot say whose traffic it is, and not passed over in silence
//            either.
//
// A COUNT WOULD NOT CATCH ANY OF THIS. "5 captures found" is equally true when
// the five are the wrong five, so every assertion below names the CLASS a
// specific directory landed in and fails by naming the class it should have
// had.
//
// The legacy/current distinction is tested from two directions on purpose:
// classifying by DEPTH FROM THE WALK'S START would call every capture "legacy"
// the moment an operator narrowed to one host folder -- which is the supported
// way to filter by host, so it would be wrong most of the time it mattered.
//
// Zero-dep, runs with `node capture-store.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require(path.join(__dirname, 'capture-store.js'));
const captureHar = require(path.join(__dirname, 'capture-har.js'));

const failures = [];
function section(name, fn) {
    try { fn(); } catch (e) {
        failures.push(`[block ${name}] ` + (e && e.message ? e.message : String(e)));
    }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-store-'));

function writeHar(p) {
    fs.writeFileSync(p, JSON.stringify({
        log: { version: '1.2', creator: { name: 'fixture', version: '1' }, entries: [] }
    }));
}

/** A capture directory. `opts.session` false makes it somebody else's capture. */
function makeCapture(dir, opts = {}) {
    fs.mkdirSync(dir, { recursive: true });
    if (opts.mitm) fs.writeFileSync(path.join(dir, 'raw.mitm'), 'not-a-har');
    if (opts.raw !== false) writeHar(path.join(dir, 'raw.har'));
    if (opts.session !== false) {
        fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
            uri: 'https://www.example.test/secret-magic-link-token',
            describe: 'fixture',
            sessionDir: dir,
            endedUtc: opts.ended === false ? undefined : '2026-01-01T00:01:00.000Z'
        }));
    }
    if (opts.scrubbed) writeHar(path.join(dir, 'scrubbed.har'));
    if (opts.rejected) writeHar(path.join(dir, 'scrubbed.rejected.har'));
    if (opts.catalogue) fs.writeFileSync(path.join(dir, 'catalogue.json'), '[]');
    return dir;
}

// The fixture store, shaped like the real one that was measured.
const root = path.join(tmp, '.har-captures');
const hostA = path.join(root, 'www.example.test');
const hostB = path.join(root, 'www.other.test');

const current = makeCapture(path.join(hostA, '2026-01-02-000001'));
const done = makeCapture(path.join(hostA, '2026-01-02-000002'), { scrubbed: true, catalogue: true });
const quarantined = makeCapture(path.join(hostA, '2026-01-02-000003'), { rejected: true });
const legacy = makeCapture(path.join(root, '2026-01-01-000001'));
const mitm = makeCapture(path.join(hostB, '2026-01-03-000001'), { session: false, mitm: true });
const orphanRaw = makeCapture(path.join(hostB, '2026-01-03-000002'), { session: false });

// Directories and files that are NOT captures, which is the population the
// counts depend on being excluded.
fs.mkdirSync(path.join(root, '_analysis'), { recursive: true });
fs.writeFileSync(path.join(root, 'CAPTURES-MANIFEST.md'), '# notes');
fs.mkdirSync(path.join(root, '_rescued'), { recursive: true });
fs.writeFileSync(path.join(root, '_rescued', 'catalogue.json'), '[]');

const byDir = (list) => new Map(list.map((e) => [e.dir, e]));

// ---------------------------------------------------------------------------
// 1 -- the three input classes, each named rather than counted
// ---------------------------------------------------------------------------
section('1', () => {
    const found = byDir(store.listCaptureDirs(root));

    assert.strictEqual(found.get(current) && found.get(current).captureClass, store.CLASS_SESSION,
        '1.a: a <host>/<stamp> capture is not classed as recorder output');

    assert.ok(found.has(legacy),
        '1.b: a date-stamped session directory AT THE CAPTURES ROOT was not found at all -- ' +
        'this is the population a host-scoped walk misses, six of them in the measured store');
    assert.strictEqual(found.get(legacy).captureClass, store.CLASS_LEGACY,
        '1.c: the legacy capture was found but not distinguished from the host layout');

    assert.ok(found.has(mitm),
        '1.d: a mitmproxy capture was skipped SILENTLY -- it must be named and declined');
    assert.strictEqual(found.get(mitm).captureClass, store.CLASS_FOREIGN,
        '1.e: a capture with no session.json was treated as recorder output');
    assert.ok(/raw\.mitm/.test(found.get(mitm).reason),
        '1.f: the declined capture does not say WHY it was declined: ' + found.get(mitm).reason);

    // A raw.har with no session beside it is the same problem wearing the
    // recorder's file name: nothing says whose traffic it is.
    assert.strictEqual(found.get(orphanRaw).captureClass, store.CLASS_FOREIGN,
        '1.g: a raw.har with no session.json was accepted as recorder output');
});

// ---------------------------------------------------------------------------
// 2 -- what is NOT a capture stays out of the counts
// ---------------------------------------------------------------------------
section('2', () => {
    const dirs = store.listCaptureDirs(root).map((e) => e.dir);
    for (const notACapture of ['_analysis', '_rescued']) {
        assert.ok(!dirs.includes(path.join(root, notACapture)),
            `2.a: ${notACapture} has neither a session nor a raw and is not a capture, but it was listed`);
    }
    assert.strictEqual(dirs.length, 6,
        '2.b: the store holds exactly six captures; found ' + dirs.length + ': ' + dirs.join(', '));
});

// ---------------------------------------------------------------------------
// 3 -- legacy is a fact about the PATH, not about where the walk started
// ---------------------------------------------------------------------------
section('3', () => {
    // Narrowing to one host is how host filtering works -- there is no --host
    // option and there does not need to be. A depth-based classifier would
    // call every one of these "legacy" here.
    const fromHost = byDir(store.listCaptureDirs(hostA));
    assert.strictEqual(fromHost.get(current) && fromHost.get(current).captureClass, store.CLASS_SESSION,
        '3.a: narrowing the walk to a host folder re-classified its captures as legacy');
    assert.strictEqual(fromHost.size, 3,
        '3.b: pointing at one host must find that host\'s captures and no others, found ' + fromHost.size);

    // And the same directory, asked for on its own, is still what it was.
    const fromItself = store.listCaptureDirs(current);
    assert.strictEqual(fromItself.length, 1,
        '3.c: pointing at a single session directory should describe exactly it');
    assert.strictEqual(fromItself[0].captureClass, store.CLASS_SESSION,
        '3.d: a session directory asked for by itself changed class');
    assert.strictEqual(store.listCaptureDirs(legacy)[0].captureClass, store.CLASS_LEGACY,
        '3.e: a legacy capture asked for by itself changed class');
});

// ---------------------------------------------------------------------------
// 3b -- a directory that is DECLINED must not take its contents with it
// ---------------------------------------------------------------------------
section('3b', () => {
    // A stray `raw.har` sitting at HOST level is enough to make that directory
    // look like somebody else's capture. If being declined also stopped the
    // walk descending, one stray file would hide every capture under that host
    // -- silently, which is the failure mode this whole classification exists
    // to remove. Declining is a statement about the directory, never about the
    // tree below it.
    //
    // A recorder session is different and DOES stop the descent: its own
    // scrub output lives inside it, and a `<stamp>/` directory is a leaf by
    // construction.
    fs.writeFileSync(path.join(hostA, 'raw.har'), '{}');
    try {
        const found = byDir(store.listCaptureDirs(root));
        assert.strictEqual(found.get(hostA) && found.get(hostA).captureClass, store.CLASS_FOREIGN,
            '3b.a: a host directory holding a stray raw.har should be declined');
        assert.ok(found.has(current),
            '3b.b: declining the host directory hid every capture underneath it');
        assert.ok(found.has(done) && found.has(quarantined),
            '3b.c: the rest of the host went missing behind one stray file');
    } finally {
        fs.unlinkSync(path.join(hostA, 'raw.har'));
    }
});

// ---------------------------------------------------------------------------
// 4 -- the artifact facts the resume check is built on
// ---------------------------------------------------------------------------
section('4', () => {
    const found = byDir(store.listCaptureDirs(root));
    assert.strictEqual(found.get(done).scrubbed, true, '4.a: an existing scrubbed.har was not reported');
    assert.strictEqual(found.get(done).catalogue, true, '4.b: an existing catalogue.json was not reported');
    assert.strictEqual(found.get(current).scrubbed, false, '4.c: an unprocessed capture reported a scrub');

    // A QUARANTINED SCRUB IS NOT A PROCESSED CAPTURE. There is no verified
    // artifact and nothing was promoted, so `scrubbed` must stay false or the
    // batch would skip exactly the capture the leak gate refused.
    assert.strictEqual(found.get(quarantined).scrubbed, false,
        '4.d: a quarantined scrub was reported as a completed one -- resume would skip a REJECTED capture');
    assert.strictEqual(found.get(quarantined).rejected, true,
        '4.e: the quarantined scrub was not reported at all, so triage has nothing to go on');
});

// ---------------------------------------------------------------------------
// 5 -- never a captured value
// ---------------------------------------------------------------------------
section('5', () => {
    // The fixture's session.json carries a start URI with a token in its path,
    // which is exactly the shape this pipeline must never echo. Host and stamp
    // are permitted; the URI is not, at any depth of the record.
    const serialised = JSON.stringify(store.listCaptureDirs(root));
    assert.ok(!/secret-magic-link-token/.test(serialised),
        '5.a: the inventory carries the capture start URI, which can hold a live token');
});

// ---------------------------------------------------------------------------
// 6 -- ONE walk: capture-har.js reads this same enumeration
// ---------------------------------------------------------------------------
section('6', () => {
    // The point of #387's narrowing. If these two ever disagree, the store has
    // two notions of what a capture is -- which is the defect the subsystem
    // exists to avoid, and no amount of testing the batch alone would show it.
    const sessions = store.listSessionDirs(root).map((e) => e.dir).sort();
    const recorderSaw = store.listCaptureDirs(root)
        .filter((e) => e.captureClass !== store.CLASS_FOREIGN)
        .map((e) => e.dir).sort();
    assert.deepStrictEqual(sessions, recorderSaw,
        '6.a: the session view and the classified view disagree about the store');

    assert.ok(!sessions.includes(mitm),
        '6.b: a foreign capture reached the recorder\'s session list, where stop/status/catalogue would act on it');
    assert.ok(sessions.includes(legacy),
        '6.c: a legacy capture is still invisible to the recorder\'s own enumeration');

    // And `resolveSession` -- the function every entry point resolves through
    // -- answers over the same population. Newest by STAMP, so the legacy
    // capture (an older stamp) must not win.
    const resolved = captureHar.resolveSession({ dir: root });
    assert.ok(sessions.includes(resolved),
        '6.d: resolveSession answered with something the shared walk does not list: ' + resolved);
    // 2026-01-02-000003 is the newest RECORDER session; the two 2026-01-03
    // directories are foreign and must not be resolvable at all.
    assert.strictEqual(resolved, quarantined,
        '6.e: resolveSession no longer picks the newest recorder capture by stamp, got ' + resolved);
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length > 0) {
    for (const f of failures) console.error('FAILED ' + f);
    console.error(`${failures.length} capture-store assertion(s) failed`);
    process.exit(1);
}
console.log('All capture-store tests passed');
