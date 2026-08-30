#!/usr/bin/env node
// Behavior test for the PII replacement pass's COMPLEXITY (issue #326).
//
// Zero-dep, runs with `node pii-scrub-complexity.test.js`. Exits non-zero on
// first failure.
//
// The defect. `scrubPii` detects a set of distinct PII values, then replaces
// them. The replacement pass used to walk the whole replacement list for every
// string it touched -- one `escapeRe` + `new RegExp` + full-string `replace`
// per (value, string) pair. Distinct detected values grow with body size, so
// the two factors multiplied and the pass went quadratic: a 6.3 MB JSON list
// response took over 45 s while the other 314 entries of the same capture took
// ~10 s together, and a 27.8 MB capture did not finish in 420 s.
//
// Why the assertion is a RATIO and not a wall clock. An absolute threshold
// encodes the speed of the machine that wrote it, so it goes red on a loaded
// CI runner and green on a fast one regardless of the code. The defect here is
// a complexity class, not a constant, so the test compares the SAME code
// against ITSELF at two input sizes. Noise scales both measurements together
// and cancels; only a change in the growth curve moves the ratio.
//
// The fixture must carry MANY DISTINCT detectable values. A large body of
// repeated filler does not reproduce this at all -- it yields one replacement
// -- which is why the fixture varies every record instead of repeating one.
//
// No real captured data appears here and no detected value is ever printed:
// the fixture is generated arithmetically from a counter.

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

// --- synthetic fixture -------------------------------------------------
// A paginated "list everything" JSON response: the shape #297 requirement 7
// deliberately keeps whole rather than truncating.

const FIRST = ['Alice', 'Bob', 'Carla', 'Dmitri', 'Elena', 'Farid', 'Greta', 'Hiro', 'Inez', 'Jonas'];
const LAST = ['Alvarez', 'Bennett', 'Chen', 'Duarte', 'Egan', 'Fontaine', 'Gupta', 'Halvorsen', 'Ibarra', 'Jansen'];
const CITY = ['Springfield', 'Rivertown', 'Lakeview', 'Fairhaven', 'Northport', 'Westfield'];
const STREET = ['Maple', 'Oak', 'Pine', 'Cedar', 'Walnut', 'Chestnut'];
const REGION = ['CA', 'NY', 'TX', 'WA', 'OR', 'AZ'];

function record(i) {
    const f = FIRST[(i * 7) % FIRST.length];
    const l = LAST[(i * 13) % LAST.length];
    return {
        id: 100000 + i,
        fullName: `${f} ${l}-${i}`,
        email: `${f.toLowerCase()}.${l.toLowerCase()}${i}@sample-fixture.example`,
        phone: `+1206${String(5550000 + (i % 10000)).padStart(7, '0')}`,
        streetAddress: `${100 + (i % 8900)} ${STREET[i % STREET.length]} Street ${i}`,
        city: `${CITY[i % CITY.length]} ${i}`,
        region: REGION[i % REGION.length],
        postalCode: String(90000 + (i % 9000)),
        dob: `19${70 + (i % 30)}-0${1 + (i % 9)}-1${i % 10}`,
        lastLoginIp: `10.${i % 250}.${(i * 3) % 250}.${(i * 7) % 250}`,
        lat: 47.6 + (i % 100) / 1000,
        lng: -122.3 - (i % 100) / 1000
    };
}

function bodyOfAtLeast(bytes) {
    const items = [];
    for (let i = 0; ; i++) {
        items.push(record(i));
        if (i % 16 === 0 && JSON.stringify(items).length >= bytes) break;
    }
    return JSON.stringify({ page: 1, total: items.length, items });
}

function harOfAtLeast(bytes) {
    return {
        log: {
            version: '1.2',
            entries: [{
                request: {
                    method: 'GET',
                    url: 'https://api.example.test/v1/accounts?page=1',
                    headers: [{ name: 'Accept', value: 'application/json' }],
                    queryString: [{ name: 'page', value: '1' }]
                },
                response: {
                    status: 200,
                    headers: [{ name: 'Content-Type', value: 'application/json' }],
                    content: { mimeType: 'application/json', text: bodyOfAtLeast(bytes) }
                }
            }]
        }
    };
}

// Best-of-N: the minimum is the measurement least polluted by a scheduling
// hiccup or a GC pause landing inside the window.
function bestOf(n, makeHar) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
        const har = makeHar();
        const t0 = process.hrtime.bigint();
        pii.scrubPii(har);
        const t1 = process.hrtime.bigint();
        best = Math.min(best, Number(t1 - t0) / 1e6);
    }
    return best;
}

const SMALL_BYTES = 32 * 1024;
const LARGE_BYTES = 256 * 1024;   // 8x the small fixture
const SIZE_FACTOR = LARGE_BYTES / SMALL_BYTES;

// Linear growth puts the ratio at ~8. The quadratic pass this test was written
// against measured ~38 on the same fixture. 16 -- twice linear, less than half
// the defect -- leaves room for constant-factor noise in both directions
// without admitting a return to quadratic.
const MAX_RATIO = 2 * SIZE_FACTOR;

console.log('pii-scrub-complexity');

// Warm the JIT so the small measurement is not paying compilation the large
// one has already amortised -- that alone would understate the ratio.
bestOf(1, () => harOfAtLeast(8 * 1024));

const small = bestOf(3, () => harOfAtLeast(SMALL_BYTES));
const large = bestOf(3, () => harOfAtLeast(LARGE_BYTES));
const ratio = large / small;

console.log(`  ${SMALL_BYTES / 1024} KB -> ${small.toFixed(1)} ms`);
console.log(`  ${LARGE_BYTES / 1024} KB -> ${large.toFixed(1)} ms`);
console.log(`  ratio ${ratio.toFixed(1)}x for ${SIZE_FACTOR}x the input (limit ${MAX_RATIO}x)`);

check('scrub cost grows no worse than ~linearly in body size', () => {
    assert.ok(
        ratio <= MAX_RATIO,
        `${SIZE_FACTOR}x the body cost ${ratio.toFixed(1)}x the time (limit ${MAX_RATIO}x) -- `
        + 'the replacement pass is superlinear in the number of distinct detected values again'
    );
});

// --- semantics the fast path must preserve ------------------------------
// Guards on the replacement pass itself, so a future rewrite for speed cannot
// quietly drop a substitution or pick the wrong one.

check('the whole body is scrubbed, not a prefix of it', () => {
    const har = harOfAtLeast(64 * 1024);
    pii.scrubPii(har);
    const text = har.log.entries[0].response.content.text;
    assert.ok(!/@sample-fixture\.example/.test(text), 'an original email survived the scrub');
    assert.ok(/@example\.invalid/.test(text), 'no fake email was written');
    assert.ok(!/"phone":"\+1206/.test(text), 'an original phone number survived the scrub');
});

check('an overlapping value is replaced longest-first, not shortest-first', () => {
    // "Casey Stone" contains "Casey"; both are person-name detections. Replacing
    // the short one first would corrupt the long one into a half-fake string.
    const har = {
        log: {
            entries: [{
                request: { method: 'POST', url: 'https://api.example.test/v1/x', headers: [], queryString: [] },
                response: {
                    status: 200,
                    headers: [],
                    content: {
                        mimeType: 'application/json',
                        text: JSON.stringify({ items: [{ name: 'Casey Stone' }, { name: 'Casey' }] })
                    }
                }
            }]
        }
    };
    const { substitutions } = pii.scrubPii(har);
    const out = JSON.parse(har.log.entries[0].response.content.text);
    assert.ok(!/Casey/.test(JSON.stringify(out)), 'an original name fragment survived');
    assert.strictEqual(
        substitutions.filter(s => s.type === 'person-name').length, 2,
        'expected one substitution per distinct name'
    );
    assert.notStrictEqual(
        out.items[0].name, out.items[1].name,
        'the two distinct names collapsed onto one fake'
    );
});

check('a fake is never re-scrubbed into a different fake', () => {
    // The single pass replaced a sequential one, and the sequential one had a
    // latent bug this pins closed: each value scanned the text AFTER earlier
    // values had already written their fakes into it, so a value that happened
    // to occur inside an emitted fake overwrote part of it. The HAR then held a
    // string that was neither an original nor the replacement the substitutions
    // table recorded -- a table that does not describe its own artifact.
    //
    // Reproduced here with the faker's own vocabulary: "Ann Kimura" fakes to a
    // name whose first word is itself one of the detected names in the fixture.
    const har = {
        log: {
            entries: [{
                request: { method: 'POST', url: 'https://api.example.test/v1/x', headers: [], queryString: [] },
                response: {
                    status: 200,
                    headers: [],
                    content: {
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            items: [{ fullName: 'Ann Kimura' }, { fullName: 'Avery' }],
                            note: 'ref Ann Kimura and Avery'
                        })
                    }
                }
            }]
        }
    };
    const { substitutions } = pii.scrubPii(har);
    const text = har.log.entries[0].response.content.text;
    for (const s of substitutions) {
        assert.ok(
            text.includes(s.replacement),
            `the substitutions table records a ${s.type} replacement that is not in the scrubbed body`
        );
    }
    const out = JSON.parse(text);
    assert.strictEqual(
        out.note, `ref ${out.items[0].fullName} and ${out.items[1].fullName}`,
        'the free-text copy of a name does not match the fake written into its own field'
    );
});

check('a percent-encoded spelling of a value is scrubbed too', () => {
    const har = {
        log: {
            entries: [{
                request: {
                    method: 'GET',
                    url: 'https://api.example.test/v1/x?phone=%2B12065551234',
                    headers: [],
                    queryString: [{ name: 'phone', value: '+12065551234' }]
                },
                response: { status: 200, headers: [], content: { mimeType: 'text/plain', text: 'ok' } }
            }]
        }
    };
    pii.scrubPii(har);
    const url = har.log.entries[0].request.url;
    assert.ok(!url.includes('2B12065551234'), 'the encoded spelling of the phone number survived');
    assert.ok(/%2B1555/.test(url), 'the encoded spelling was not replaced with an encoded fake');
});

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nAll pii-scrub-complexity tests passed');
