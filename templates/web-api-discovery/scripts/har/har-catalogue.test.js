#!/usr/bin/env node
// Behavior tests for har-catalogue.js -- the measurement half (issue #379).
//
// The catalogue was prose in a markdown table, so a row's claims about a
// reference could be checked for EXISTENCE and never for TRUTH. Four
// references shipped carrying a 29-character placeholder where the request
// payload belonged, under rows describing request-side behaviour, and passed a
// dedicated guard, an independent review and a merge.
//
// `measureReference` is what makes the difference: it opens the .har the row
// names and computes the row's factual half from the file, so a claim and the
// artifact can be compared rather than assumed to agree.
//
// Zero-dep, runs with `node har-catalogue.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cat = require(path.join(__dirname, 'har-catalogue.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-catalogue-'));

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FORM_BODY = 'message=hello+world&tags%5B0%5D=100000123456789&audience=SELF';
// The exact placeholder that shipped in four references. Named here so the
// test says what it is reproducing, not so the code may special-case it --
// har-catalogue recognises GRAMMARS, never a known sentinel.
const HOLLOW_BODY = 'REDACTED_FORM_URLENCODED_BODY';

function entry(overrides = {}) {
    const req = Object.assign({
        method: 'GET',
        url: 'https://api.example.invalid/v1/things',
        httpVersion: 'HTTP/1.1',
        headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
    }, overrides.request);
    const res = Object.assign({
        status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
        headers: [], cookies: [], redirectURL: '', headersSize: -1, bodySize: -1,
        content: { size: 2, mimeType: 'application/json', text: '{}' },
    }, overrides.response);
    return {
        startedDateTime: '2026-08-26T00:00:00.000Z', time: 1,
        request: req, response: res, cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    };
}

function postEntry(bodyText, url, mimeType) {
    return entry({
        request: {
            method: 'POST',
            url: url || 'https://api.example.invalid/v1/posts',
            postData: {
                mimeType: mimeType || 'application/x-www-form-urlencoded',
                text: bodyText,
            },
        },
    });
}

function writeHar(name, entries) {
    const p = path.join(tmp, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
        log: { version: '1.2', creator: { name: 'test', version: '1' }, entries },
    }, null, 2));
    return p;
}

// ---------------------------------------------------------------------------
// measureReference -- the facts a row may not disagree with
// ---------------------------------------------------------------------------

test('measures entry count, methods, endpoints and request bodies from the file', () => {
    const p = writeHar('mixed.har', [
        postEntry(FORM_BODY),
        postEntry(FORM_BODY),
        entry(),
    ]);
    const facts = cat.measureReference(p);

    assert.strictEqual(facts.EntryCount, 3);
    assert.deepStrictEqual(facts.Methods, ['GET', 'POST']);
    assert.deepStrictEqual(facts.Endpoints, [
        'api.example.invalid/v1/posts',
        'api.example.invalid/v1/things',
    ]);
    assert.strictEqual(facts.RequestBodies, 2);
});

test('methods and endpoints are unique and sorted, so the facts are order-independent', () => {
    // Same traffic, recorded in a different order. A capture is a recording:
    // if the recomputed facts moved with the ordering, every re-capture would
    // dirty the catalogue and the guard would cry wolf on a real reference.
    const a = cat.measureReference(writeHar('order-a.har', [
        postEntry(FORM_BODY), entry(), postEntry(FORM_BODY),
    ]));
    const b = cat.measureReference(writeHar('order-b.har', [
        entry(), postEntry(FORM_BODY), postEntry(FORM_BODY),
    ]));

    assert.deepStrictEqual(a.Methods, b.Methods);
    assert.deepStrictEqual(a.Endpoints, b.Endpoints);
});

test('a placeholder standing in for a request body does not count as one', () => {
    // THE FALSIFIER'S FOUNDATION. All four hollow references carry exactly
    // this: a POST whose payload is a short sentinel. If it counted here, the
    // row would still be able to claim request-side behaviour and the whole
    // structured catalogue would buy nothing.
    const facts = cat.measureReference(writeHar('hollow.har', [postEntry(HOLLOW_BODY)]));

    assert.strictEqual(facts.EntryCount, 1);
    assert.deepStrictEqual(facts.Methods, ['POST']);
    assert.strictEqual(facts.RequestBodies, 0);
    assert.strictEqual(facts.RequestBytes, 0);
});

test('recognises a body by GRAMMAR, not by a list of known placeholders', () => {
    // The sentinel that prompted #358 was emitted by no tool in this pipeline,
    // and the next one will be spelled differently. A body is a body when it
    // belongs to a wire grammar.
    const unknownSentinel = writeHar('unknown-sentinel.har', [postEntry('body removed by hand')]);
    assert.strictEqual(cat.measureReference(unknownSentinel).RequestBodies, 0);

    const realJson = writeHar('real-json.har', [
        postEntry('{"message":"hello"}', undefined, 'application/json'),
    ]);
    assert.strictEqual(cat.measureReference(realJson).RequestBodies, 1);
});

test('counts request and response bytes, and counts only bodies that are bodies', () => {
    const facts = cat.measureReference(writeHar('bytes.har', [
        postEntry(FORM_BODY),
        postEntry(HOLLOW_BODY),
    ]));

    // One real body contributes; the placeholder contributes nothing, so
    // `RequestBodies: 0, RequestBytes: 0` cannot be read as "small payload".
    assert.strictEqual(facts.RequestBodies, 1);
    assert.strictEqual(facts.RequestBytes, Buffer.byteLength(FORM_BODY));
    assert.strictEqual(facts.ResponseBytes, Buffer.byteLength('{}') * 2);
});

test('collapses ids in endpoints the same way the capture digest does', () => {
    // buildCatalogueScaffold writes `Endpoints` from the digest's path
    // template. If this recomputed them any other way, every scaffolded row
    // would fail the guard the moment it was committed -- the two must share
    // one function, not two implementations that agree today.
    const facts = cat.measureReference(writeHar('ids.har', [
        entry({ request: { url: 'https://api.example.invalid/v1/posts/1234567890' } }),
        entry({ request: { url: 'https://api.example.invalid/v1/posts/9876543210' } }),
    ]));

    assert.deepStrictEqual(facts.Endpoints, ['api.example.invalid/v1/posts/{id}']);
});

test('reports a reference it cannot read rather than measuring nothing', () => {
    // Returning zeroes for an unreadable file would let a deleted or corrupt
    // reference pass as "a reference with no entries".
    assert.throws(
        () => cat.measureReference(path.join(tmp, 'does-not-exist.har')),
        /does-not-exist\.har/);

    const bad = path.join(tmp, 'not-json.har');
    fs.writeFileSync(bad, 'this is not a HAR');
    assert.throws(() => cat.measureReference(bad), /not-json\.har/);
});

test('a HAR with no entries measures as empty rather than throwing', () => {
    const facts = cat.measureReference(writeHar('empty.har', []));
    assert.strictEqual(facts.EntryCount, 0);
    assert.deepStrictEqual(facts.Methods, []);
    assert.strictEqual(facts.RequestBodies, 0);
});

// ---------------------------------------------------------------------------
// listReferences -- what the catalogue must account for
// ---------------------------------------------------------------------------

test('finds references in provider subdirectories and beside the catalogue', () => {
    // Both layouts are live: provider subdirectories upstream today, flat
    // beside the catalogue in the shape #379 draws. A guard that saw only one
    // would report every reference in the other as uncatalogued.
    const dir = path.join(tmp, 'refs');
    fs.mkdirSync(path.join(dir, 'facebook'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'flat-2026-08-26.har'), '{}');
    fs.writeFileSync(path.join(dir, 'facebook', 'facebook-login-2026-08-26.har'), '{}');

    assert.deepStrictEqual(cat.listReferences(dir).sort(), [
        'facebook/facebook-login-2026-08-26.har',
        'flat-2026-08-26.har',
    ]);
});

console.log(`All har-catalogue tests passed (${passed} assertions)`);
