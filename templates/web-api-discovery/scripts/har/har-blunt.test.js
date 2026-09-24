#!/usr/bin/env node
// Behavior tests for issue #511 -- blunt what the scrub could not clean, never
// withhold the artifact.
//
// Zero-dep, runs with `node har-blunt.test.js`.
//
// The ORACLE is the gate itself. Every "is it gone?" question below is asked of
// `verify-scrub.js`'s own `collectFindings` + `classifyFindings`, never of a
// regex written here: a test that re-derived what the gate blocks would pass
// against a blunting pass and a gate that had drifted apart, which is the one
// failure this pass exists to prevent.
//
// Every value is synthetic -- typed here, captured nowhere.

'use strict';

const assert = require('assert');
const path = require('path');

const blunt = require(path.join(__dirname, 'har-blunt.js'));
const verify = require(path.join(__dirname, 'verify-scrub.js'));
const shapes = require(path.join(__dirname, 'har-shapes.js'));
const secrets = require(path.join(__dirname, 'har-secrets.js'));
const harPolicy = require(path.join(__dirname, 'har-policy.js'));

const SALT = 'test-salt-not-a-real-one';
const HEX32 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_HEX32 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const TOKEN = 'tok_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c';
const CARD = '4111111111111111';

const policy = harPolicy.loadDefaultPolicy();

function har(...entries) {
    return { log: { version: '1.2', creator: { name: 't', version: '0' }, entries } };
}

function entry(opts = {}) {
    return {
        request: {
            method: 'POST',
            url: opts.url || 'https://example.test/api',
            headers: opts.headers || [],
            queryString: [],
            cookies: [],
            postData: opts.postData,
        },
        response: {
            status: 200,
            headers: [],
            cookies: [],
            content: { mimeType: 'application/json', text: opts.body || '{}' },
        },
    };
}

function gatingIn(doc, p = policy) {
    return verify.classifyFindings(verify.collectFindings(doc, p)).gating;
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        console.error(`FAIL: ${name}`);
        throw e;
    }
}

// 1. A secret-class shape finding the scrub left standing is blunted, the gate
//    is clean afterwards, and the rest of the body keeps its exact bytes.
test('hex32 in a JSON body is blunted in place', () => {
    const body = `{"a":1,"jsmods":{"require":[["${HEX32}","x"]]},"z":"keep me"}`;
    const doc = har(entry({ body }));
    assert.ok(gatingIn(doc).length > 0, 'precondition: the gate blocks the unblunted capture');

    const result = blunt.bluntHar(doc, { policy, salt: SALT });

    assert.deepStrictEqual(gatingIn(doc), [], 'the gate must be clean after blunting');
    const text = doc.log.entries[0].response.content.text;
    assert.ok(!text.includes(HEX32), 'the value is gone');
    assert.ok(text.startsWith('{"a":1,"jsmods":{"require":[["<BLUNTED:hex32:'), 'blunted IN PLACE');
    assert.ok(text.endsWith('","x"]]},"z":"keep me"}'), 'every other byte is kept');
    assert.strictEqual(result.values, 1);
    assert.strictEqual(result.unblunted.length, 0);
    // The record names the field the gate named, not just the body it sat in.
    assert.strictEqual(doc.log[blunt.RECORD_KEY].findings[0].keyPath,
        'response.content.text.jsmods.require[0][0]');
});

// 2. The gate groups by value and reports ONE location. Blunting by that
//    location alone would leave every other occurrence standing.
test('every occurrence of the value is blunted, not only the reported one', () => {
    const doc = har(
        entry({ body: `{"k":"${HEX32}"}`, headers: [{ name: 'x-trace', value: HEX32 }] }),
        entry({ url: `https://example.test/p?h=${HEX32}` }));
    blunt.bluntHar(doc, { policy, salt: SALT });
    assert.ok(!JSON.stringify(doc.log.entries).includes(HEX32));
    assert.deepStrictEqual(gatingIn(doc), []);
    const rec = doc.log[blunt.RECORD_KEY];
    const hexRows = rec.findings.filter((f) => f.kind === 'hex32');
    assert.strictEqual(hexRows.reduce((n, f) => n + f.occurrences, 0), 3);
});

// 3. Same value, same sentinel -- across entries -- so a reader can still see
//    that two requests carried the same token. Different values differ.
test('the sentinel is deterministic per value and distinct across values', () => {
    const doc = har(entry({ body: `{"a":"${HEX32}"}` }), entry({ body: `{"b":"${HEX32}","c":"${OTHER_HEX32}"}` }));
    blunt.bluntHar(doc, { policy, salt: SALT });
    const s = (t) => t.match(/<BLUNTED:[^>]+>/g);
    const a = s(doc.log.entries[0].response.content.text);
    const b = s(doc.log.entries[1].response.content.text);
    assert.strictEqual(a[0], b[0]);
    assert.notStrictEqual(b[0], b[1]);
});

// 4. The sentinel must be something the gate itself will never flag -- no
//    shape pattern matches it, and the named-credential check reads it as
//    redacted. Asked of the gate's own predicates.
test('the sentinel is invisible to every gate detector', () => {
    const sentinel = blunt.sentinelFor('hex32', HEX32, SALT);
    assert.deepStrictEqual(shapes.findLeaks(sentinel, policy), []);
    assert.ok(secrets.isRedacted(sentinel));
    assert.ok(!sentinel.includes(HEX32));
});

// 5. The advisory-exclusion test #454 deferred. Identity evidence by SHAPE
//    alone does not gate, so it is not blunted: blunting it is how 1413 trip
//    ids lost their reference the first time. The capture comes out
//    byte-identical and carries no record.
test('an advisory-only capture is left byte-identical', () => {
    const doc = har(entry({ body: `{"trip_ref":"${CARD}"}` }));
    const before = JSON.stringify(doc);
    const result = blunt.bluntHar(doc, { policy, salt: SALT });
    assert.strictEqual(JSON.stringify(doc), before);
    assert.strictEqual(result.values, 0);
    assert.strictEqual(doc.log[blunt.RECORD_KEY], undefined);
});

// 6. A waived secret has left the gate by an operator's signed decision. It
//    is not blunted either.
test('a waived finding is not blunted', () => {
    const waived = clone(policy);
    waived.waivers = [{ kind: 'hex32', fingerprint: shapes.fingerprint(HEX32), reason: 'build hash' }];
    const doc = har(entry({ body: `{"k":"${HEX32}"}` }));
    const before = JSON.stringify(doc);
    blunt.bluntHar(doc, { policy: waived, salt: SALT });
    assert.strictEqual(JSON.stringify(doc), before);
});

// 7. A known secret NAME still readable in the clear: the value goes, the
//    name stays, so the reference still says which header carried it.
test('a known-secret header value is blunted and its name kept', () => {
    const doc = har(entry({ headers: [{ name: 'x-csrftoken', value: TOKEN }] }));
    assert.ok(gatingIn(doc).some((f) => f.kind === 'known-secret'), 'precondition');
    blunt.bluntHar(doc, { policy, salt: SALT });
    const h = doc.log.entries[0].request.headers[0];
    assert.strictEqual(h.name, 'x-csrftoken');
    assert.ok(!h.value.includes(TOKEN));
    assert.deepStrictEqual(gatingIn(doc), []);
});

// 8. A known secret nested inside a form-encoded body: only that parameter is
//    rewritten, through the same traversal both engines share.
test('a known secret inside an encoded body is blunted without flattening the body', () => {
    const inner = encodeURIComponent(JSON.stringify({ fb_dtsg: TOKEN, keep: 'yes' }));
    const doc = har(entry({ postData: { mimeType: 'application/x-www-form-urlencoded', text: `a=1&variables=${inner}&b=2` } }));
    assert.ok(gatingIn(doc).length > 0, 'precondition');
    blunt.bluntHar(doc, { policy, salt: SALT });
    const text = doc.log.entries[0].request.postData.text;
    assert.ok(text.startsWith('a=1&variables='));
    assert.ok(text.endsWith('&b=2'));
    assert.ok(!decodeURIComponent(text).includes(TOKEN));
    assert.deepStrictEqual(gatingIn(doc), []);
});

// 9. A hit seen only in the percent-DECODED view has no bytes to replace in
//    place. It blunts its whole containing value -- fidelity is lost, never
//    the secret -- and the record says so.
test('a hit visible only once decoded blunts its whole containing value', () => {
    const encoded = `%${HEX32.charCodeAt(0).toString(16)}${HEX32.slice(1)}`;
    const doc = har(entry({ url: `https://example.test/p?q=${encoded}` }));
    assert.ok(gatingIn(doc).length > 0, 'precondition');
    const result = blunt.bluntHar(doc, { policy, salt: SALT });
    assert.deepStrictEqual(gatingIn(doc), []);
    const rec = doc.log[blunt.RECORD_KEY];
    assert.ok(rec.findings.some((f) => f.mode === 'whole-value'));
    assert.ok(result.bytes > 0);
});

// 10. The record says what was done and where, never what the value was. Its
//     fingerprint is SALTED: the gate's unsalted one is a brute-forceable
//     digest of a live value, fine in a gitignored report, wrong in a file a
//     reference is extracted from (#459).
test('the provenance record carries no value and no unsalted fingerprint', () => {
    const doc = har(entry({ body: `{"k":"${HEX32}"}`, headers: [{ name: 'x-csrftoken', value: TOKEN }] }));
    blunt.bluntHar(doc, { policy, salt: SALT });
    const rec = doc.log[blunt.RECORD_KEY];
    const text = JSON.stringify(rec);
    assert.ok(!text.includes(HEX32) && !text.includes(TOKEN));
    assert.ok(!text.includes(shapes.fingerprint(HEX32)), 'no unsalted fingerprint');
    assert.strictEqual(rec.values, 2);
    for (const f of rec.findings) {
        assert.ok(typeof f.kind === 'string' && Number.isInteger(f.entryIndex));
        assert.ok(/^[0-9a-f]{12}$/.test(f.fingerprint));
        assert.ok(typeof f.debt === 'string' && f.debt.startsWith('#'), 'every kind names its debt issue');
    }
    assert.strictEqual(rec.policyVersion, policy.version);
});

// 11. The record lives in the artifact, and the gate must not read our own
//     annotation as wire data -- nor gate on it.
test('the gate is clean over a blunted artifact, record included', () => {
    const doc = har(entry({ body: `{"k":"${HEX32}"}`, headers: [{ name: 'x-csrftoken', value: TOKEN }] }));
    blunt.bluntHar(doc, { policy, salt: SALT });
    const all = verify.collectFindings(doc, policy);
    assert.deepStrictEqual(verify.classifyFindings(all).gating, []);
});

// 12. A clean capture is not touched at all -- no record, no churn.
test('a clean capture is byte-identical and carries no record', () => {
    const doc = har(entry({ body: '{"ok":true}' }));
    const before = JSON.stringify(doc);
    const result = blunt.bluntHar(doc, { policy, salt: SALT });
    assert.strictEqual(JSON.stringify(doc), before);
    assert.strictEqual(result.values, 0);
});

// 13. Blunting is per entry, so a streamed scrub (#539) can drive it one
//     entry at a time; the entry index it is told is the one it records.
test('bluntEntry records the entry index it was given', () => {
    const e = entry({ body: `{"k":"${HEX32}"}` });
    const r = blunt.bluntEntry(e, 41, { policy, salt: SALT });
    assert.ok(r.findings.length > 0 && r.findings.every((f) => f.entryIndex === 41));
    assert.ok(!e.response.content.text.includes(HEX32));
});

// 14. The real-world refusal: a value spelled with a JSON escape on the wire.
//     `/` + 32 hex is a 36-character hex run in the bytes, so no pattern
//     matches the raw text -- but the PARSED string is `/` + 32 hex, and the
//     gate reads it structurally. Only the one JSON string is rewritten; the
//     body is not flattened.
test('a hit hidden behind a JSON escape blunts only its own string', () => {
    const body = `for (;;);{"jsmods":{"require":[["m\\u002F${HEX32}",1]]},"z":"keep \\u00e9"}`;
    const doc = har(entry({ body }));
    assert.ok(gatingIn(doc).length > 0, 'precondition: the gate blocks it');
    const result = blunt.bluntHar(doc, { policy, salt: SALT });
    assert.deepStrictEqual(gatingIn(doc), []);
    const text = doc.log.entries[0].response.content.text;
    assert.ok(text.startsWith('for (;;);{"jsmods":{"require":[["m/<BLUNTED:hex32:'), text.slice(0, 60));
    assert.ok(text.endsWith('",1]]},"z":"keep \\u00e9"}'), 'every other token keeps its exact bytes');
    assert.ok(result.findings.every((f) => f.mode === 'value'));
});

console.log(`All har-blunt tests passed (${passed})`);
