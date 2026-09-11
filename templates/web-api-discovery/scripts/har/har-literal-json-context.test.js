#!/usr/bin/env node
// Behavior tests for the literal pass and JSON value context (issue #482).
//
// Zero-dep, runs with `node har-literal-json-context.test.js`. Exits non-zero on
// first failure.
//
// THE DEFECT. `applyLiteralPass` runs over the SERIALIZED HAR as text and
// substitutes an angle-bracket sentinel for each profile literal. It has no idea
// what JSON context the value sat in. When the literal was a quoted string the
// result is well formed:
//
//     "userId":"<literal>"          ->  "userId":"<FacebookUserId>"     valid
//
// When it was a bare JSON NUMBER it is not, because a sentinel is not a JSON
// token:
//
//     "productIdentifier":<literal> ->  "productIdentifier":<FacebookUserId>
//                                                                       INVALID
//
// WHY THE FIXTURES NEST. A HAR carries response and request bodies as STRINGS,
// so an inner JSON document appears in the serialization with its quotes
// escaped (`\"id\":1`). A fix that emits a bare `"` would be correct at the top
// level and would itself corrupt the inner document, so the quoting has to match
// the depth it is inserted at. A single-level fixture cannot express that, and
// would pass against a fix that is wrong one level down.
//
// No real captured data appears here; every literal is synthetic.

'use strict';

const assert = require('assert');
const path = require('path');
const harLiterals = require(path.join(__dirname, 'har-literals.js'));

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

const LITERAL = '61593494464534';
// `literals` is the ARRAY shape har-profile.js produces, not the map the
// profile file spells it as.
const LITERALS = [{ literal: LITERAL, sentinel: '<TestUserId>' }];
const pass = (text) => harLiterals.applyLiteralPass(text, LITERALS).text;

console.log('har-literal-json-context');

// --- 1. the top-level bare number, which is the reported defect ----------

check('a bare JSON number is replaced with a QUOTED sentinel', () => {
    const before = JSON.stringify({ productIdentifier: Number(LITERAL), other: null });
    const after = pass(before);
    assert.doesNotThrow(() => JSON.parse(after),
        'the document no longer parses: ' + after);
    assert.strictEqual(JSON.parse(after).productIdentifier, '<TestUserId>',
        'the sentinel must land as the value, quoted');
});

check('a quoted string value keeps exactly one pair of quotes', () => {
    // Guard: the fix must not double-quote what was already a string.
    const before = JSON.stringify({ userId: LITERAL });
    const after = pass(before);
    assert.doesNotThrow(() => JSON.parse(after), 'no longer parses: ' + after);
    assert.strictEqual(JSON.parse(after).userId, '<TestUserId>');
});

check('a literal in the MIDDLE of a string is not quoted again', () => {
    // Guard, and the reason "the character before it is a quote" is not a
    // sufficient test: here it is an ordinary character on both sides.
    const before = JSON.stringify({ note: 'id=' + LITERAL + ' seen' });
    const after = pass(before);
    assert.doesNotThrow(() => JSON.parse(after), 'no longer parses: ' + after);
    assert.strictEqual(JSON.parse(after).note, 'id=<TestUserId> seen');
});

// --- 2. the nesting the fix has to survive -------------------------------

check('a bare number inside an EMBEDDED json body is quoted at the right depth', () => {
    // This is the shape a HAR actually has: a body carried as a string.
    const inner = JSON.stringify({ productIdentifier: Number(LITERAL) });
    const before = JSON.stringify({ log: { entries: [{ response: { content: { text: inner } } }] } });
    const after = pass(before);

    assert.doesNotThrow(() => JSON.parse(after),
        'the OUTER document no longer parses: ' + after);
    const innerAfter = JSON.parse(after).log.entries[0].response.content.text;
    assert.doesNotThrow(() => JSON.parse(innerAfter),
        'the outer parses but the EMBEDDED body does not: ' + innerAfter);
    assert.strictEqual(JSON.parse(innerAfter).productIdentifier, '<TestUserId>');
});

check('a quoted string inside an embedded json body is untouched structurally', () => {
    const inner = JSON.stringify({ userId: LITERAL });
    const before = JSON.stringify({ log: { entries: [{ request: { postData: { text: inner } } }] } });
    const after = pass(before);
    assert.doesNotThrow(() => JSON.parse(after), 'outer broke: ' + after);
    const innerAfter = JSON.parse(after).log.entries[0].request.postData.text;
    assert.doesNotThrow(() => JSON.parse(innerAfter), 'inner broke: ' + innerAfter);
    assert.strictEqual(JSON.parse(innerAfter).userId, '<TestUserId>');
});

// --- 3. array elements, the other bare-value position --------------------

check('a bare number as an ARRAY element is quoted', () => {
    const before = JSON.stringify({ ids: [1, Number(LITERAL), 3] });
    const after = pass(before);
    assert.doesNotThrow(() => JSON.parse(after), 'no longer parses: ' + after);
    assert.deepStrictEqual(JSON.parse(after).ids, [1, '<TestUserId>', 3]);
});

// --- 4. non-JSON text must not acquire quotes ----------------------------

check('a literal in non-JSON text is replaced bare', () => {
    // The pass runs over everything, including bodies that are not JSON at all.
    // Inventing quotes there would corrupt them the other way.
    const before = 'user_id=' + LITERAL + '&next=1';
    assert.strictEqual(pass(before), 'user_id=<TestUserId>&next=1');
});

check('the hit count still reports the sentinel and its occurrences', () => {
    const before = JSON.stringify({ a: Number(LITERAL), b: LITERAL });
    const { hits } = harLiterals.applyLiteralPass(before, LITERALS);
    assert.strictEqual(hits.length, 1, 'one literal, one hit entry');
    assert.strictEqual(hits[0].sentinel, '<TestUserId>');
    assert.strictEqual(hits[0].count, 2, 'both occurrences must be counted');
});

// --- 5. the shape the defect was actually FOUND in -----------------------
//
// Every test above uses LITERAL delimiters, and all of them passed a fix that
// still left the real capture broken. By the time this pass runs, a form
// parameter the scrub rewrote has been re-encoded, so the payload's delimiters
// are `%3A` and `%7D`, not `:` and `}`. A check that only understands literal
// structure cannot see the value it is standing next to.

check('a bare value between PERCENT-ENCODED delimiters is quoted, encoded', () => {
    // `{"productIdentifier":<literal>}` as it appears inside a re-encoded form
    // parameter in the serialized HAR.
    const before = 'variables=%7B%22productIdentifier%22%3A' + LITERAL + '%7D';
    const after = pass(before);
    const decoded = decodeURIComponent(after.slice('variables='.length));
    assert.doesNotThrow(() => JSON.parse(decoded),
        'the encoded payload no longer parses once decoded: ' + decoded);
    assert.strictEqual(JSON.parse(decoded).productIdentifier, '<TestUserId>');
});

check('an encoded STRING value does not gain a second pair of quotes', () => {
    // GUARD, not a falsifier: verified to pass without the encoded-delimiter
    // branch too, because an encoded string value already has its quotes. It
    // guards against a fix that quotes everything in an encoded context.
    const before = 'variables=%7B%22userId%22%3A%22' + LITERAL + '%22%7D';
    const after = pass(before);
    const decoded = decodeURIComponent(after.slice('variables='.length));
    assert.doesNotThrow(() => JSON.parse(decoded), 'no longer parses: ' + decoded);
    assert.strictEqual(JSON.parse(decoded).userId, '<TestUserId>');
});

check('an ordinary encoded form value is still replaced bare', () => {
    // GUARD, also verified passing without the encoded branch. `av=<literal>&...`
    // is a plain form parameter with no JSON around it; `&` and `=` are not JSON
    // delimiters, so nothing may be quoted. This is the case that would break if
    // the encoded check were widened to any `%XX`.
    const before = 'av=' + LITERAL + '&__aaid=0';
    assert.strictEqual(pass(before), 'av=<TestUserId>&__aaid=0');
});

if (failures) {
    console.error(`\nhar-literal-json-context: ${failures} failure(s)`);
    process.exit(1);
}
console.log('All har-literal-json-context tests passed');
