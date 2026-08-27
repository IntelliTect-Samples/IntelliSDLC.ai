#!/usr/bin/env node
// Behavior tests for har-literals.js -- the literal-value scrub control
// (issue #255, Part B.2).
//
// Key-name scrubbing can only redact values whose NAME was anticipated. Two
// classes escape it: a secret nested inside a percent-encoded JSON parameter,
// and the same identifier appearing under several names, one of them
// undocumented. Literal-value scrubbing is the second, independent control.
//
// Zero-dep, runs with `node har-literals.test.js`.

'use strict';

const assert = require('assert');
const path = require('path');

const lit = require(path.join(__dirname, 'har-literals.js'));

const LITERALS = [
    { literal: '100000123456789', sentinel: '<AccountId>' },
    { literal: 'Ada Lovelace', sentinel: '<DisplayName>' },
];

// --- 1. Both the raw literal and its percent-encoded form are covered. ---
{
    const forms = lit.encodedForms('Ada Lovelace');
    assert.ok(forms.includes('Ada Lovelace'), '1.a: raw form missing');
    assert.ok(forms.includes('Ada%20Lovelace'), '1.b: percent-encoded form missing');
    assert.ok(forms.includes('Ada+Lovelace'), '1.c: form-encoded (+) variant missing');
}

// --- 2. One sweep over the serialized entry covers URL, headers, request and response. ---
{
    const serialized = JSON.stringify({
        request: {
            url: 'https://example.invalid/p?id=100000123456789',
            headers: [{ name: 'x-actor', value: '100000123456789' }],
            postData: { text: 'target_id=100000123456789&name=Ada+Lovelace' },
        },
        response: { content: { text: '{"default_actor":{"id":"100000123456789"},"name":"Ada Lovelace"}' } },
    });

    const { text, hits } = lit.applyLiteralPass(serialized, LITERALS);
    assert.ok(!text.includes('100000123456789'),
        '2.a: the account id survived somewhere in the serialized entry');
    assert.ok(!text.includes('Ada Lovelace') && !text.includes('Ada+Lovelace'),
        '2.b: the display name survived');
    assert.ok(text.includes('<AccountId>') && text.includes('<DisplayName>'),
        '2.c: sentinels were not substituted in');

    // The id appears under three different names -- that is the whole point:
    // no key list catches `target_id` if nobody knew it existed.
    const idHit = hits.find((h) => h.sentinel === '<AccountId>');
    assert.strictEqual(idHit.count, 4, `2.d: expected 4 account-id occurrences, got ${idHit.count}`);
}

// --- 3. Hits never echo the literal value. ---
{
    const { hits } = lit.applyLiteralPass('id=100000123456789', LITERALS);
    const serializedHits = JSON.stringify(hits);
    assert.ok(!serializedHits.includes('100000123456789'),
        '3: a hit record echoed the literal -- that relocates the leak into CI logs');
}

// --- 4. findLiteralHits detects without mutating, and without echoing. ---
{
    const src = 'https://example.invalid/?id=Ada%20Lovelace';
    const hits = lit.findLiteralHits(src, LITERALS);
    assert.deepStrictEqual(hits.map((h) => h.sentinel), ['<DisplayName>'], '4.a: hit not detected');
    assert.ok(!JSON.stringify(hits).includes('Ada'), '4.b: hit echoed the literal');
    assert.strictEqual(lit.findLiteralHits('nothing here', LITERALS).length, 0,
        '4.c: false positive on clean text');
}

// --- 5. A secret nested inside a percent-encoded JSON parameter is reachable. ---
{
    const nested = { variables: { actor_id: '100000123456789', lsd: 'AVsecret' } };
    const body = 'doc_id=123&variables=' + encodeURIComponent(JSON.stringify(nested.variables));

    const seen = [];
    const out = lit.transformEncodedParams(body, (name, decoded) => {
        seen.push(name);
        return decoded.replace('AVsecret', 'redacted-x');
    });

    assert.deepStrictEqual(seen, ['doc_id', 'variables'], '5.a: not every parameter was visited');
    assert.ok(!out.includes('AVsecret') && !out.includes(encodeURIComponent('AVsecret')),
        `5.b: the nested secret survived:\n${out}`);
    assert.ok(out.includes('redacted-x') || out.includes(encodeURIComponent('redacted-x')),
        '5.c: the transformed value was not written back');
}

// --- 6. Untouched parameters keep their original bytes. ---
{
    const body = 'a=Ada+Lovelace&b=%7B%22k%22%3A1%7D';
    const out = lit.transformEncodedParams(body, (_name, decoded) => decoded);
    assert.strictEqual(out, body, '6: an unchanged parameter was re-encoded, churning the reference');
}

// --- 7. Placeholder values below the minimum length are not secrets (B.3). ---
{
    assert.strictEqual(lit.isPlausibleSecretValue('1'), false, '7.a: counter "1" treated as a secret');
    assert.strictEqual(lit.isPlausibleSecretValue('0'), false, '7.b: placeholder "0" treated as a secret');
    assert.strictEqual(lit.isPlausibleSecretValue(''), false, '7.c: empty value treated as a secret');
    assert.strictEqual(lit.isPlausibleSecretValue('AVsecret'), true, '7.d: real short token exempted');
}

// --- 8. decodeNestedJson recovers an object from a percent-encoded parameter. ---
{
    const encoded = encodeURIComponent(JSON.stringify({ actor_id: '1', nested: { lsd: 'x' } }));
    const decoded = lit.decodeNestedJson(encoded);
    assert.deepStrictEqual(decoded, { actor_id: '1', nested: { lsd: 'x' } }, '8.a: nested JSON not recovered');
    assert.strictEqual(lit.decodeNestedJson('plain-value'), null, '8.b: non-JSON should yield null');
    assert.strictEqual(lit.decodeNestedJson('%ZZ'), null, '8.c: undecodable value should yield null, not throw');
}

// --- 9. An empty literal list is a no-op, not a crash. ---
{
    const { text, hits } = lit.applyLiteralPass('anything', []);
    assert.strictEqual(text, 'anything', '9.a: empty literal list mutated the text');
    assert.deepStrictEqual(hits, [], '9.b: empty literal list reported hits');
}

console.log('All har-literals tests passed');
