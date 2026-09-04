#!/usr/bin/env node
// The unretained-request-body descriptor must not become a channel that
// bypasses the scrub or the gate (issue #442, constraints 2 and 3).
//
// Zero-dep, runs with `node har-body-descriptor-scrub.test.js`.
//
// A `filename` IS CAPTURED DATA. `emily-watson-2019-birthday.jpg` carries a
// person, a date and an occasion, and it arrives in the HAR through a node
// nothing in the scrub pipeline knew about until #442 added it. Two of the
// three walks that have to reach it are SELECTIVE NODE LISTS, not generic
// descents, so "we added a field and the scrub picked it up" is a claim that
// has to be tested rather than assumed:
//
//   sanitize-har.js `walk`             generic -- reached it already
//   pii.js detect/replace              selective -- EXTENDED by #442
//   audit-scrub-drift.js emitEntryStrings  selective -- EXTENDED by #442
//   har-shapes.js collectEntryStrings (the gate)  generic -- reached it already
//
// And the descriptor's OWN keys must never be mistaken for captured field
// names. That is the #369/#374 bug -- a HAR envelope property read as a field
// somebody's API chose -- and a new `_`-prefixed structure full of keys named
// `filename`, `fieldName` and `length` is precisely the shape it lived in.

'use strict';

const assert = require('assert');
const path = require('path');

const pii = require('./pii.js');
const harPolicy = require('./har-policy.js');
const harShapes = require('./har-shapes.js');
const audit = require('./audit-scrub-drift.js');
const { DESCRIPTOR_KEY: KEY } = require('../capture/request-body-descriptor.js');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const policy = harPolicy.loadPolicy({ startDir: __dirname });

// A capture whose ONLY personal data is inside the descriptor. Nothing else in
// the entry carries it, so anything found is found through the descriptor.
const PERSON = 'Emily Watson';
const EMAIL = 'emily.watson@example.com';

function harWithDescriptor(extra) {
    return {
        log: {
            version: '1.2',
            entries: [{
                startedDateTime: '2026-09-04T09:27:59.000Z',
                request: {
                    method: 'POST',
                    url: 'https://i.instagram.com/rupload_igphoto/1234',
                    headers: [{ name: 'content-length', value: '203573' }],
                    queryString: [],
                    cookies: [],
                    bodySize: -1,
                    [KEY]: Object.assign({
                        bodyRetained: false,
                        declaredLength: 203573,
                        retainedLength: 0,
                        mimeType: 'multipart/form-data; boundary=B7',
                        parts: [{
                            order: 0,
                            fieldName: 'upload_file',
                            filename: `${PERSON} 2019 birthday.jpg`,
                            contentType: 'image/jpeg',
                            length: 203100,
                            complete: true,
                        }],
                    }, extra || {}),
                },
                response: { status: 200, headers: [], cookies: [], content: { size: 0, mimeType: '' } },
                cache: {},
                timings: {},
            }],
        },
    };
}

// --- constraint 2: the descriptor is SCRUBBED ------------------------------

// A `filename` in the descriptor gets EXACTLY the treatment a `filename` in a
// captured request body gets. That equivalence is the claim worth pinning: the
// hazard #442 names is the descriptor becoming a channel that BYPASSES the
// scrub, and bypass means "treated more leniently than the same value in the
// body would be". It does not mean the descriptor is scrubbed harder than the
// rest of the capture.
//
// It also records a real limit honestly. A bare person name at a key the
// policy does not type -- `filename`, `caption`, anything -- is not detected by
// the typed-PII pass ANYWHERE in a HAR today; only a typed key (`full_name`)
// or a self-evident shape (an email, a card, a phone) is. So a filename
// spelled `Emily Watson 2019 birthday.jpg` survives the scrub, in the
// descriptor and in a request body alike. That is a property of the PII
// engine's context rules, not a hole this descriptor opened, and the test says
// so rather than asserting a stronger claim that would silently start failing
// the day the engine changes.
function bodyWithFilename(value) {
    return {
        log: {
            entries: [{
                request: {
                    method: 'POST', url: 'https://i.instagram.com/rupload_igphoto/1234',
                    headers: [], queryString: [], cookies: [],
                    postData: { mimeType: 'application/json', text: JSON.stringify({ filename: value }) },
                },
                response: { status: 200, headers: [], cookies: [], content: { text: '' } },
            }],
        },
    };
}

test('FALSIFIER: a filename in a descriptor is scrubbed exactly as one in a request body is', () => {
    for (const value of [
        `${EMAIL}.png`,
        'call-555-867-5309-about-this.jpg',
        `${PERSON} 2019 birthday.jpg`,
    ]) {
        const inDescriptor = harWithDescriptor();
        inDescriptor.log.entries[0].request[KEY].parts[0].filename = value;
        pii.scrubPii(inDescriptor, policy);

        const inBody = bodyWithFilename(value);
        pii.scrubPii(inBody, policy);

        assert.strictEqual(
            inDescriptor.log.entries[0].request[KEY].parts[0].filename,
            JSON.parse(inBody.log.entries[0].request.postData.text).filename,
            `'${value}' is treated differently in the descriptor than in a body -- a bypass`);
    }
});

test('FALSIFIER: an email-shaped filename in a descriptor is scrubbed', () => {
    const har = harWithDescriptor();
    har.log.entries[0].request[KEY].parts[0].filename = `${EMAIL}.png`;
    pii.scrubPii(har, policy);
    const scrubbed = har.log.entries[0].request[KEY].parts[0].filename;
    assert.ok(!scrubbed.includes('emily.watson@example.com'),
        `an email survived inside the descriptor: ${scrubbed}`);
});

test('GUARD: the scrub does not rewrite the descriptor\'s STRUCTURE', () => {
    const har = harWithDescriptor();
    pii.scrubPii(har, policy);
    const d = har.log.entries[0].request[KEY];
    assert.strictEqual(d.bodyRetained, false, 'the load-bearing fact was lost');
    assert.strictEqual(d.declaredLength, 203573);
    assert.strictEqual(d.parts[0].fieldName, 'upload_file',
        'the multipart FIELD NAME was replaced -- our key was read as a person-name field');
    assert.strictEqual(d.parts[0].length, 203100);
    assert.strictEqual(d.parts[0].order, 0);
});

// --- constraint 3: the GATE sees it, without mistaking our keys ------------

test('FALSIFIER: the gate reports a leak that sits only in the descriptor', () => {
    const har = harWithDescriptor();
    // A value the gate's own patterns fire on, placed ONLY in the descriptor.
    har.log.entries[0].request[KEY].parts[0].filename = 'a'.repeat(0) + 'deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef.bin';
    const findings = harShapes.findLeaksInHar(har, policy);
    const inDescriptor = findings.filter((f) => String(f.keyPath || '').includes(KEY));
    assert.ok(inDescriptor.length > 0, 'the gate cannot see inside the descriptor');
});

test('GUARD: the gate never reads a descriptor key as a CAPTURED FIELD NAME', () => {
    const har = harWithDescriptor();
    har.log.entries[0].request[KEY].parts[0].filename = 'deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef.bin';
    const findings = harShapes.findLeaksInHar(har, policy);
    for (const f of findings) {
        if (!String(f.keyPath || '').includes(KEY)) continue;
        assert.strictEqual(f.field || null, null,
            `the gate resolved '${f.field}' as a captured field name from our own envelope key`);
    }
    // Stated directly against the function #369/#374 fixed, too.
    const at = `request.${KEY}.parts[0].filename`;
    assert.strictEqual(harShapes.capturedFieldName(at, at), null);
});

// --- constraint 3: the AUDIT sees it, with field null ----------------------

test('FALSIFIER: the audit walks the descriptor', () => {
    const har = harWithDescriptor();
    const seen = [];
    audit.forEachHarString(har, (entryIndex, keyPath, text, field) => {
        if (String(keyPath).includes(KEY)) seen.push([keyPath, text, field]);
    });
    const filename = seen.find(([k]) => k.endsWith('.filename'));
    assert.ok(filename, 'the audit never visits the descriptor -- a fake placed there is unlocatable');
    assert.ok(filename[1].includes('Emily'));
});

test('GUARD: every descriptor string the audit emits carries field null', () => {
    const har = harWithDescriptor();
    audit.forEachHarString(har, (entryIndex, keyPath, text, field) => {
        if (!String(keyPath).includes(KEY)) return;
        assert.strictEqual(field, null,
            `the audit named '${field}' as a captured field from key path ${keyPath}`);
    });
});

test('GUARD: an entry with no descriptor is unchanged in every walk', () => {
    const har = harWithDescriptor();
    delete har.log.entries[0].request[KEY];
    const before = JSON.stringify(har);
    pii.scrubPii(har, policy);
    assert.strictEqual(JSON.stringify(har), before);
    let touched = 0;
    audit.forEachHarString(har, (i, k) => { if (String(k).includes(KEY)) touched++; });
    assert.strictEqual(touched, 0);
});

// --- run --------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}`);
        console.log(`       ${e.message}`);
    }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (!failed) console.log('All har-body-descriptor-scrub tests passed');
process.exit(failed ? 1 : 0);
