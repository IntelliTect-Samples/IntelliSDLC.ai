#!/usr/bin/env node
// Behavior tests for how the PII replacement pass ARBITRATES between detected
// values that overlap each other (issue #326).
//
// Zero-dep, runs with `node pii-scrub-overlap.test.js`. Exits non-zero on
// first failure.
//
// Two values can overlap in two different ways, and only one of them is
// obvious:
//
//   NESTED / PREFIX   "Casey Stone" and "Casey" -- they share a start
//                     position, and the longer one must win there.
//   STAGGERED         "Ann Marie" and "Marie Louise Johnson" inside
//                     "contacted Ann Marie Louise Johnson yesterday" -- they
//                     share characters at DIFFERENT start positions, and the
//                     shorter one starts EARLIER.
//
// A left-to-right scanner that arbitrates only among candidates sharing a
// start position handles the first and fails the second: it matches the
// earlier-starting "Ann Marie", consumes the "Marie" that the longer value
// needed, and never scans the rest. The tail "Louise Johnson" -- real detected
// PII -- then ships in the clear, and the substitutions table records a
// replacement that is nowhere in the body.
//
// The rule these tests pin: a higher-priority (longer) value wins WHEREVER it
// occurs, regardless of what shorter value happens to start earlier. That is
// what a priority-ordered global replace does, and it is the behaviour the
// fast implementation has to reproduce.
//
// No real captured data appears here and no detected value is ever printed:
// every fixture is built from a synthetic token pool chosen to be disjoint
// from the faker's own name lists, so a surviving fragment cannot be confused
// with a fake.

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

function harWithNames(names, note) {
    return {
        log: {
            entries: [{
                request: { method: 'POST', url: 'https://api.example.test/v1/x', headers: [], queryString: [] },
                response: {
                    status: 200,
                    headers: [],
                    content: {
                        mimeType: 'application/json',
                        text: JSON.stringify({ items: names.map(n => ({ fullName: n })), note })
                    }
                }
            }]
        }
    };
}

console.log('pii-scrub-overlap');

// --- 1. the staggered case, spelled out --------------------------------

check('a longer value wins over a shorter one that starts earlier', () => {
    const har = harWithNames(['Ann Marie', 'Marie Louise Johnson'],
        'contacted Ann Marie Louise Johnson yesterday about the account');
    pii.scrubPii(har);
    const note = JSON.parse(har.log.entries[0].response.content.text).note;

    // Every multi-token fragment of either original must be gone. "Louise
    // Johnson" is the one a start-position-only scanner leaves behind.
    for (const fragment of ['Ann Marie', 'Marie Louise', 'Louise Johnson', 'Marie Louise Johnson']) {
        assert.ok(
            !note.includes(fragment),
            'a multi-token fragment of a detected name survived the scrub '
            + `(${fragment.split(' ').length} tokens)`
        );
    }
});

check('the substitutions table describes the body it produced', () => {
    const har = harWithNames(['Ann Marie', 'Marie Louise Johnson'],
        'contacted Ann Marie Louise Johnson yesterday about the account');
    const { substitutions } = pii.scrubPii(har);
    const text = har.log.entries[0].response.content.text;
    for (const s of substitutions) {
        assert.ok(
            text.includes(s.replacement),
            `the table records a ${s.type} replacement that is nowhere in the scrubbed body`
        );
    }
});

// --- 2. a reference implementation, and a fuzz against it ---------------
//
// The oracle below is the slow, obvious version of the rule: walk the values
// in priority order and, for each, claim every occurrence in the ORIGINAL text
// that no higher-priority value already claimed. That is a priority-ordered
// global replace with the self-overwriting removed. It is O(values x text) and
// exists only to be correct, not fast.
//
// Comparing the shipped implementation against it over randomised fixtures is
// what catches an arbitration bug: a hand-written expectation only covers the
// shape its author thought of, and the shape missed here was staggered overlap.

const WORD_RE = /[A-Za-z0-9_]/;
function isWordChar(ch) { return ch !== undefined && WORD_RE.test(ch); }

// Mirrors the grouping and ordering scrubPii applies to its detections.
function replacementsFor(har) {
    const byKey = new Map();
    for (const d of pii.detectPii(JSON.parse(JSON.stringify(har)))) {
        const key = `${d.type}${d.value}`;
        if (!byKey.has(key)) {
            byKey.set(key, { type: d.type, value: String(d.value), replacement: pii.fakeFor(d.type, d.value) });
        }
    }
    return Array.from(byKey.values()).sort((a, b) => b.value.length - a.value.length);
}

function needlesFor(replacements) {
    const out = [];
    for (const r of replacements) {
        const v = String(r.value);
        if (v.length === 0) continue;
        out.push({ s: v, rep: r.replacement, boundary: /^[A-Za-z]+( [A-Za-z]+)*$/.test(v) });
        const encoded = encodeURIComponent(v);
        if (encoded !== v) out.push({ s: encoded, rep: encodeURIComponent(r.replacement), boundary: false });
    }
    return out;
}

function oracleReplace(text, replacements) {
    const needles = needlesFor(replacements);
    const claimed = new Uint8Array(text.length);
    const chosen = new Map();
    for (const n of needles) {
        let from = 0;
        for (;;) {
            const at = text.indexOf(n.s, from);
            if (at < 0) break;
            from = at + 1;
            if (n.boundary && (isWordChar(text[at - 1]) || isWordChar(text[at + n.s.length]))) continue;
            let free = true;
            for (let q = at; q < at + n.s.length; q++) { if (claimed[q]) { free = false; break; } }
            if (!free) continue;
            for (let q = at; q < at + n.s.length; q++) claimed[q] = 1;
            chosen.set(at, { len: n.s.length, rep: n.rep });
        }
    }
    let out = '';
    for (let i = 0; i < text.length;) {
        const hit = chosen.get(i);
        if (hit) { out += hit.rep; i += hit.len; } else { out += text[i]; i++; }
    }
    return out;
}

// Tokens deliberately absent from pii.js's FIRST_NAMES / SURNAMES lists, so a
// token appearing in the output is always a survivor and never a fake.
const TOKENS = [
    'Brennik', 'Calvorn', 'Dressel', 'Ferrant', 'Gostyn', 'Halbrek', 'Ivarsen',
    'Jarreth', 'Kollund', 'Merrow', 'Norvell', 'Ostrand', 'Pellham', 'Quarrin'
];

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Builds a chain of tokens and cuts overlapping windows out of it, so the
// generated values necessarily share characters at different start positions.
function makeOverlapFixture(rnd) {
    const chainLen = 4 + Math.floor(rnd() * 4);
    const chain = [];
    for (let i = 0; i < chainLen; i++) chain.push(TOKENS[Math.floor(rnd() * TOKENS.length)]);

    const names = [];
    const windows = 2 + Math.floor(rnd() * 3);
    for (let w = 0; w < windows; w++) {
        const start = Math.floor(rnd() * chainLen);
        const len = 1 + Math.floor(rnd() * Math.min(3, chainLen - start));
        if (len >= 1) names.push(chain.slice(start, start + len).join(' '));
    }
    if (names.length === 0) names.push(chain[0]);

    const parts = ['contacted', chain.join(' '), 'about'];
    if (rnd() < 0.5) parts.push(names[Math.floor(rnd() * names.length)]);
    parts.push('and', chain.slice(0, 2).join(' '), 'again');
    return { har: harWithNames(names, parts.join(' ')), chain };
}

check('matches a priority-ordered reference implementation over randomised overlaps', () => {
    const rnd = mulberry32(20260830);
    let mismatches = 0;
    let firstDetail = null;
    const CASES = 400;
    for (let i = 0; i < CASES; i++) {
        const { har } = makeOverlapFixture(rnd);
        const before = JSON.parse(JSON.stringify(har));
        const note = JSON.parse(before.log.entries[0].response.content.text).note;
        const expected = oracleReplace(note, replacementsFor(before));

        pii.scrubPii(har);
        const actual = JSON.parse(har.log.entries[0].response.content.text).note;

        if (actual !== expected) {
            mismatches++;
            if (firstDetail === null) {
                // Report the SHAPE of the disagreement, never the values.
                let k = 0;
                while (k < actual.length && k < expected.length && actual[k] === expected[k]) k++;
                firstDetail = `case ${i}: diverges at character ${k} `
                    + `(expected length ${expected.length}, got ${actual.length})`;
            }
        }
    }
    assert.strictEqual(
        mismatches, 0,
        `${mismatches}/${CASES} randomised overlap fixtures disagree with the reference `
        + `arbitration -- ${firstDetail}`
    );
});

check('no token of a detected name survives that the reference would have replaced', () => {
    const rnd = mulberry32(981723);
    let leaks = 0;
    const CASES = 400;
    for (let i = 0; i < CASES; i++) {
        const { har } = makeOverlapFixture(rnd);
        const before = JSON.parse(JSON.stringify(har));
        const note = JSON.parse(before.log.entries[0].response.content.text).note;
        const reference = oracleReplace(note, replacementsFor(before));

        pii.scrubPii(har);
        const actual = JSON.parse(har.log.entries[0].response.content.text).note;

        // Any synthetic token present in the output but absent from the
        // reference output is PII this implementation leaked and the reference
        // did not. Counting tokens, never printing them.
        for (const t of TOKENS) {
            const inActual = actual.split(t).length - 1;
            const inReference = reference.split(t).length - 1;
            if (inActual > inReference) leaks++;
        }
    }
    assert.strictEqual(
        leaks, 0,
        `${leaks} name token occurrence(s) across ${CASES} fixtures survived the scrub that the `
        + 'reference arbitration replaced -- the fast path leaks PII the slow one does not'
    );
});

// --- 3. the nested case must keep working ------------------------------

check('a nested value still loses to the longer one that contains it', () => {
    const har = harWithNames(['Brennik Calvorn', 'Brennik'], 'ref Brennik Calvorn and Brennik alone');
    const { substitutions } = pii.scrubPii(har);
    const note = JSON.parse(har.log.entries[0].response.content.text).note;
    assert.ok(!note.includes('Brennik'), 'an original name token survived');
    assert.ok(!note.includes('Calvorn'), 'an original name token survived');
    assert.strictEqual(substitutions.filter(s => s.type === 'person-name').length, 2,
        'expected one substitution per distinct name');
});

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nAll pii-scrub-overlap tests passed');
