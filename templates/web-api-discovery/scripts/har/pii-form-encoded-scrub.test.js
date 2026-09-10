#!/usr/bin/env node
// Behavior tests for scrubbing an `application/x-www-form-urlencoded` request
// body, where the payload is PERCENT-ENCODED (issue #479).
//
// Zero-dep, runs with `node pii-form-encoded-scrub.test.js`. Exits non-zero on
// first failure.
//
// THE DEFECT THESE PIN. Detection and replacement used to run over the encoded
// text as if it were plain text. `%22` is an encoded `"`, and its literal
// characters include the digits `22`, so a digit-run detector reading the
// encoded body sees those two digits joined to whatever follows:
//
//     %22<14-digit id>%22        ->  the scanner sees a 16-DIGIT RUN
//
// Sixteen digits is a credit-card length, and roughly one such accidental run
// in ten is Luhn-valid, so the check that exists does not stop it. The 16-digit
// fake is then written over the span -- which includes the `22` INSIDE the
// escape. `%22` becomes `%42`, and the body now decodes with a `B` where its
// delimiting quote used to be:
//
//     {"id":"<id>"}              ->  {"id":B<digits>"}      (no longer JSON)
//
// So there are two failures and the second is the serious one: a false positive
// that spans an escape boundary, and a write that lands inside an escape and
// silently changes the decoded structure.
//
// WHY THE FIXTURES ARE ENCODED. A fixture built from already-decoded JSON takes
// the structural branch of `replaceJsonOrText`, which rebuilds the document and
// cannot corrupt it. It passes before the fix and after, and falsifies nothing.
// Every fixture here is percent-encoded with the value adjacent to an escape,
// because that is the only shape that expresses the defect.
//
// No real captured data appears here. Every digit run is synthetic.

'use strict';

const assert = require('assert');
const path = require('path');
const pii = require(path.join(__dirname, 'pii.js'));

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ok - ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL - ${name}\n    ${err && err.message}`);
    }
}

// A form-encoded POST body carrying one parameter whose value is JSON.
function harWithFormBody(paramName, jsonValue) {
    const encoded = paramName + '=' + encodeURIComponent(JSON.stringify(jsonValue));
    return {
        log: {
            entries: [{
                request: {
                    method: 'POST',
                    url: 'https://api.example.test/v1/x',
                    headers: [{ name: 'content-type', value: 'application/x-www-form-urlencoded' }],
                    queryString: [],
                    postData: { mimeType: 'application/x-www-form-urlencoded', text: encoded }
                },
                response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '{}' } }
            }]
        }
    };
}

function bodyOf(har) { return har.log.entries[0].request.postData.text; }
function decodedParam(har, name) {
    const m = new RegExp('(?:^|&)' + name + '=([^&]*)').exec(bodyOf(har));
    assert.ok(m, `parameter ${name} is missing from the scrubbed body`);
    return decodeURIComponent(m[1]);
}

// A 14-digit identifier which, when preceded by the `22` of an encoded quote,
// forms a Luhn-VALID 16-digit run. That is what makes the false positive
// reachable, so the fixture states it rather than relying on luck.
const ID_14 = '61593494464534';
function luhnOk(s) {
    let sum = 0, alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
        let d = Number(s[i]);
        if (alt) { d *= 2; if (d > 9) d -= 9; }
        sum += d; alt = !alt;
    }
    return sum % 10 === 0;
}

console.log('pii-form-encoded-scrub');

// --- 1. the fixture really does express the defect ----------------------

check('the fixture premise holds: escape digits + id form a Luhn-valid 16-digit run', () => {
    assert.strictEqual(('22' + ID_14).length, 16, 'the run must be credit-card length');
    assert.ok(luhnOk('22' + ID_14),
        'the run must be Luhn-valid, or the detector would reject it and the test would ' +
        'pass for the wrong reason');
    assert.ok(!luhnOk(ID_14) || ID_14.length !== 16,
        'the id alone must not be a card, or the false positive is not what is being tested');
});

// --- 2. the corruption ---------------------------------------------------

check('a form-encoded body still decodes to valid JSON after the scrub', () => {
    const har = harWithFormBody('variables', { id: ID_14 });
    pii.scrubPii(har);
    const decoded = decodedParam(har, 'variables');
    assert.doesNotThrow(() => JSON.parse(decoded),
        'the scrub rewrote the body into something that no longer parses: ' +
        JSON.stringify(decoded));
});

check('no percent-escape is overwritten by a replacement', () => {
    const har = harWithFormBody('variables', { id: ID_14 });
    const before = bodyOf(har);
    pii.scrubPii(har);
    const after = bodyOf(har);
    // Every escape in the original delimited structure; each must still decode
    // to the same character it did before.
    const escapesOf = (s) => (s.match(/%[0-9A-Fa-f]{2}/g) || [])
        .map((e) => decodeURIComponent(e)).join('');
    assert.strictEqual(escapesOf(after), escapesOf(before),
        'a replacement landed inside a %XX sequence and changed the decoded structure');
});

check('the delimiters around the scrubbed value survive', () => {
    const har = harWithFormBody('variables', { id: ID_14 });
    pii.scrubPii(har);
    const decoded = decodedParam(har, 'variables');
    const parsed = JSON.parse(decoded);
    assert.deepStrictEqual(Object.keys(parsed), ['id'], 'the key set must be unchanged');
    assert.strictEqual(typeof parsed.id, 'string',
        'the value must still be a quoted string, not a bare token');
});

// --- 3. the fix must not switch detection off ---------------------------

check('a genuine card inside a form-encoded body is still replaced', () => {
    // FALSIFIER, not a guard -- it fails before the fix too, and for the more
    // serious reason. The escape's `22` extends the card's 16-digit run to 18,
    // and a 16-digit pattern cannot match inside an 18-digit run, so the card
    // is never detected and ships in the clear. The same encoding fault that
    // corrupts a benign id also leaks a real one.
    //
    // NOT 4242424242424242: the scrubber recognises the canonical test card as
    // already-fake and declines to replace it, so that number would fail this
    // test after a correct fix. Luhn-valid, Visa range, not a published test
    // number.
    const CARD = '4539578763621486';
    const har = harWithFormBody('payload', { cardNumber: CARD });
    const { substitutions } = pii.scrubPii(har);
    const decoded = decodedParam(har, 'payload');
    assert.ok(!decoded.includes(CARD), 'the card must not survive the scrub');
    assert.ok(substitutions.some((s) => s.type === 'credit-card'),
        'the card must still be detected and recorded as a substitution');
    assert.doesNotThrow(() => JSON.parse(decoded), 'and the body must still parse');
});

check('a parameter the scrub did not touch is byte-identical', () => {
    const har = harWithFormBody('variables', { id: ID_14 });
    har.log.entries[0].request.postData.text += '&untouched=' + encodeURIComponent('a~b c/d');
    pii.scrubPii(har);
    const m = /(?:^|&)untouched=([^&]*)/.exec(bodyOf(har));
    assert.ok(m, 'the untouched parameter is missing');
    assert.strictEqual(m[1], encodeURIComponent('a~b c/d'),
        'a parameter with no detected value must be re-emitted exactly as it arrived, ' +
        'not round-tripped through a decoder');
});

if (failures) {
    console.error(`\npii-form-encoded-scrub: ${failures} failure(s)`);
    process.exit(1);
}
console.log('All pii-form-encoded-scrub tests passed');
