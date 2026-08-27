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

// --- 10. A literal that contains another is replaced first, whatever the order. ---
// Declaring the surname before the full name used to let the short literal
// consume its substring, leaving `Ada ` stranded next to a sentinel -- a
// partial-name leak that nothing reported, because the long literal recorded
// no hit. Whose fault the ordering was does not matter: the operator should
// not have to know.
{
    const declaredShortFirst = [
        { literal: 'Lovelace', sentinel: '<Surname>' },
        { literal: 'Ada Lovelace', sentinel: '<FullName>' },
    ];
    const { text, hits } = lit.applyLiteralPass('owner is Ada Lovelace, cc Lovelace', declaredShortFirst);

    assert.ok(!text.includes('Ada '), `10.a: a name fragment survived:\n${text}`);
    assert.ok(text.includes('<FullName>'), '10.b: the longer literal never matched');
    assert.ok(text.includes('<Surname>'), '10.c: the standalone surname was not replaced');
    assert.strictEqual(hits.find((h) => h.sentinel === '<FullName>').count, 1, '10.d: full name hit not counted');
}

// --- 11. Literals are matched in their JSON-escaped spelling too. ---
// The pass runs over the SERIALIZED document, where a quote is `\\"`. Matching
// only the raw spelling misses every literal containing one -- and names, the
// most common literal after an id, routinely contain quotes or non-ASCII.
{
    const NAME = 'Ada "Countess" Lovelace';
    const serialized = JSON.stringify({ owner: NAME });
    const { text } = lit.applyLiteralPass(serialized, [{ literal: NAME, sentinel: '<DisplayName>' }]);
    assert.ok(!text.includes('Countess'), `11.a: the JSON-escaped spelling was not matched:\n${text}`);

    const UNICODE = 'Ada Lovelace — owner';
    const escapedUnicode = '{"o":"Ada Lovelace \\u2014 owner"}';
    const r2 = lit.applyLiteralPass(escapedUnicode, [{ literal: UNICODE, sentinel: '<Owner>' }]);
    assert.ok(r2.text.includes('<Owner>'), '11.b: a \\uXXXX-escaped literal was not matched');
}

// --- 12. A later literal must not match inside an earlier one's sentinel. ---
// Sentinels are readable words, so `Name` occurs inside `<DisplayName>`. A
// second pass matching there yields `<Display<ShortHandle>>` -- a marker that
// no longer reads as a redaction, and a hit count inflated by a match that
// was never in the capture.
{
    const { text, hits } = lit.applyLiteralPass(
        '"owner":"Ada Lovelace","short":"Name"',
        [{ literal: 'Ada Lovelace', sentinel: '<DisplayName>' }, { literal: 'Name', sentinel: '<ShortHandle>' }]);

    assert.strictEqual(text, '"owner":"<DisplayName>","short":"<ShortHandle>"',
        `12.a: a sentinel was corrupted by a later literal:\n${text}`);
    assert.strictEqual(hits.find((h) => h.sentinel === '<ShortHandle>').count, 1,
        '12.b: the hit count counted a match inside a sentinel');
}

// --- 13. No placeholder machinery leaks into the output. ---
{
    const { text } = lit.applyLiteralPass('id=100000123456789', LITERALS);
    assert.ok(!/har-literal:/.test(text), `13: an internal placeholder survived into the output:\n${text}`);
}

console.log('All har-literals tests passed');
