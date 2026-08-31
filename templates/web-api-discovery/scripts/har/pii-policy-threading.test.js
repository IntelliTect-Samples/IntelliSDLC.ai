#!/usr/bin/env node
// End-to-end behavior tests for issue #334: the scrubber and the gate must
// hold ONE definition of "credit card", and the MERGED project policy must
// reach the scrubber.
//
// Two defects, one root.
//
//   1. `har-shapes.js` requires an ASSIGNED issuer identifier at a length that
//      issuer mints (#295 / #316) before calling a Luhn-valid digit run a card.
//      `pii.js` fired on bare Luhn. The gate and the scrubber therefore
//      disagreed, and because `pii.js` drives a REPLACE, the false positives
//      #295 removed from the gate were still being written into committed
//      references as generated fake card numbers. The failure direction is
//      CORRUPTION, not leakage.
//
//   2. The merged policy was never threaded into `scrubPii`, so
//      `fieldTypeFor(key, policy)` was always called with `null`, and
//      `hasAssignedIin` would have been too. A consuming project's `piiFields`
//      and `cardIssuers` were validated, merged, loaded -- and then never
//      consulted by the scrubber. Fixing (1) without (2) would close one drift
//      and open a narrower one of the same class.
//
// WHY THESE TESTS RUN THE REAL PATH. A prior stage shipped a test asserting
// that `fieldTypeFor` merely EXISTS in a policy-taking form. A completely inert
// feature satisfies that: the capability was there and nothing ever passed it a
// policy. So every case here drives `sanitize-har.js` against a fixture project
// and asserts on the SCRUBBED FILE, and every policy case is a PAIR -- the same
// value with and without the project policy file -- so the assertion is about
// reachability, not about a signature.
//
// No real card number appears in this file. `4111111111111111` is the published
// Visa test number; every other run is a deterministic Luhn-valid value with a
// documented or deliberately-unassigned prefix.
//
// Zero-dep, runs with `node pii-policy-threading.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { initProtectedRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));

const pii = require(path.join(__dirname, 'pii.js'));
const sanitize = path.join(__dirname, 'sanitize-har.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pii-policy-threading-')));

// 16 digits, Luhn-valid, prefix `98` -- assigned to no payment network at any
// length. This is the shape of the provider object ids the scrubber has been
// rewriting: card-shaped by arithmetic accident and nothing else.
const UNASSIGNED_LUHN_16 = '9876543210987658';
// The published Visa test number. Assigned IIN, minted length, Luhn-valid.
const PUBLISHED_TEST_VISA = '4111111111111111';
// Luhn-valid, 16 digits, prefix `50` -- Maestro's range, deliberately absent
// from the shipped table because it overlaps Discover and UnionPay and would
// reopen the false-positive surface #295 closed. A project in a Maestro market
// declares it and owns the consequence.
const MAESTRO_16 = '5012777777777770';
const MAESTRO_ISSUER = { brand: 'maestro', prefixes: [[50, 50]], lengths: [16] };

// A city value under a field name the shipped `piiFields` does not list.
// `hometown` is one word, so it is neither an `exact` name nor a qualified tail.
//
// DO NOT "tidy" this spelling. `homeTown` and `home_town` tokenise to
// ["home","town"], and `town` IS a default `city` tail with `home` on its
// qualifier list -- so either of those resolves to `city` with no project
// policy at all, and case 3.a would fail while 3.b passed for the wrong
// reason. The one-word spelling is the whole point of the fixture.
const HOMETOWN_FIELD = 'hometown';
const HOMETOWN_VALUE = 'Zzyzxvale';

let failures = 0;
function check(label, fn) {
    try { fn(); } catch (e) { failures++; console.error(`FAIL ${label}: ${e.message}`); }
}

function runSanitize(harPath, cwd) {
    try {
        const out = execFileSync(process.execPath, [sanitize, '--in', harPath], {
            encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
    }
}

/**
 * A fixture project: a git repo whose .gitignore protects the substitution
 * tables (#318), a profile supplying the salt, and optionally the project
 * policy under test.
 */
function makeProject(name, projectPolicy) {
    const dir = path.join(tmp, name);
    initProtectedRepo(dir);
    fs.mkdirSync(path.join(dir, 'samples', 'har-original'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.har-profile.json'),
        JSON.stringify({ salt: 'test-salt', literals: {} }, null, 2));
    if (projectPolicy) {
        fs.writeFileSync(path.join(dir, '.har-policy.project.json'),
            JSON.stringify(projectPolicy, null, 2));
    }
    return dir;
}

/** Scrub a one-entry HAR whose JSON response body is `body`; return the output text. */
function scrub(name, projectPolicy, body) {
    const dir = makeProject(name, projectPolicy);
    const harPath = path.join(dir, 'samples', 'har-original', 'capture.har');
    fs.writeFileSync(harPath, JSON.stringify({
        log: {
            version: '1.2', creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z', time: 1,
                request: {
                    method: 'GET', url: 'https://example.invalid/api', httpVersion: 'HTTP/1.1',
                    headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                    content: { size: 0, mimeType: 'application/json', text: JSON.stringify(body) },
                    redirectURL: '', headersSize: -1, bodySize: 0,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    }, null, 2));
    const r = runSanitize(harPath, dir);
    assert.strictEqual(r.code, 0, `sanitize failed in ${name}: ${r.stderr}`);
    return fs.readFileSync(path.join(dir, 'samples', 'har', 'capture.har'), 'utf8');
}

// --- 1. The scrubber uses the gate's predicate. -------------------------
//
// A Luhn-valid 16-digit run with an UNASSIGNED prefix is an object id, not a
// card. The gate stopped flagging it in #295; the scrubber must stop rewriting
// it. This is the corruption case, and it is the bulk of what the corpus
// measurement counts.
//
// THE FIELD NAME IS DELIBERATELY NOT AN IDENTIFIER FIELD. These cases test
// the CARD PREDICATE, and the fixture used to say `objectId`, which the
// shipped `identifierFields` matches on `*id`. Once #360 landed, 1.a and 2.a
// passed whether or not the predicate did anything -- the field name alone
// was sufficient -- and 2.b, which requires a REPLACEMENT, failed for a
// reason that had nothing to do with `cardIssuers`. `ledgerRef` matches no
// identifier pattern and no `piiFields` name, so the predicate is once again
// the only thing that decides these three.
check('1.a unassigned IIN survives the scrub', () => {
    const out = scrub('unassigned-iin', null, { ledgerRef: UNASSIGNED_LUHN_16 });
    assert.ok(out.includes(UNASSIGNED_LUHN_16),
        'a Luhn-valid run with an unassigned issuer prefix was rewritten as a card');
});

// ...and tightening must not blind the scrubber to a real card.
check('1.b a published test card is still replaced', () => {
    const out = scrub('published-visa', null, { card: PUBLISHED_TEST_VISA });
    assert.ok(!out.includes(PUBLISHED_TEST_VISA),
        'an assigned-IIN, minted-length, Luhn-valid card was left in the output');
});

// --- 2. A project `cardIssuers` range reaches the SCRUBBER. -------------
//
// The pair is the point. `hasAssignedIin` has taken a policy since #316, so
// observing that it accepts one proves nothing about whether the scrubber ever
// supplies it. Only the difference between these two runs does.
check('2.a without the project policy, a Maestro run is not a card', () => {
    const out = scrub('maestro-default', null, { ledgerRef: MAESTRO_16 });
    assert.ok(out.includes(MAESTRO_16),
        'the shipped table claimed a range it deliberately does not carry');
});

check('2.b a project cardIssuers range makes the scrubber replace it', () => {
    const out = scrub('maestro-policy',
        { schemaVersion: 1, cardIssuers: [MAESTRO_ISSUER] },
        { ledgerRef: MAESTRO_16 });
    assert.ok(!out.includes(MAESTRO_16),
        'the merged policy never reached the scrubber: a project-declared issuer '
        + 'range is honoured by the gate and ignored by the replace');
});

// --- 3. A project `piiFields` name reaches the SCRUBBER. ----------------
//
// `fieldTypeFor(key, policy)` was always called with null, so the entire
// project field-name surface was inert on the scrub side. Same pair shape.
check('3.a without the project policy, an unlisted field name is left alone', () => {
    const out = scrub('piifields-default', null, { [HOMETOWN_FIELD]: HOMETOWN_VALUE });
    assert.ok(out.includes(HOMETOWN_VALUE),
        'the shipped dictionary claimed a field name it does not list');
});

check('3.b a project piiFields name makes the scrubber replace the value', () => {
    const out = scrub('piifields-policy',
        { schemaVersion: 1, piiFields: { city: { exact: [HOMETOWN_FIELD] } } },
        { [HOMETOWN_FIELD]: HOMETOWN_VALUE });
    assert.ok(!out.includes(HOMETOWN_VALUE),
        'the merged policy never reached the scrubber: a project-declared PII '
        + 'field name was validated, merged, loaded and then never consulted');
});

// --- 4. A float is not a card, on BOTH sides. ---------------------------
//
// Unifying the CHECK while leaving the PATTERN divergent is the same defect
// one layer down. `har-shapes.js` carries lookarounds that keep a digit run
// which is part of a DECIMAL NUMBER out of the card slot (#292/#293); this
// module carried a bare `/\b\d{13,19}\b/g`. The reasoning that
// `hasAssignedIin` makes the lookarounds redundant -- that a fractional part
// starts with digits no issuer owns -- holds only until the run happens to
// begin with an assigned IIN at a minted length, which is exactly the case
// the lookarounds exist for.
//
// `4000000000006` is 13 digits, Visa prefix `4`, a length Visa mints, and
// Luhn-valid. Embedded in a float, the gate passes it clean and the scrubber
// rewrote it -- corruption, in a case the gate already guards. Reachable
// anywhere `detectInString` scans: headers, cookies, query params, the URL,
// or a non-JSON body. Any price, amount or coordinate-as-string is exposed.
const CARD_SHAPED_INTEGER_PART = '4000000000006';

check('4.a the integer part of a float is not rewritten', () => {
    const out = scrub('float-integer-part', null, { price: CARD_SHAPED_INTEGER_PART + '.45' });
    assert.ok(out.includes(CARD_SHAPED_INTEGER_PART + '.45'),
        'a decimal number was rewritten as a card by the scrubber, in a case the gate passes clean');
});

check('4.b the fractional part of a float is not rewritten', () => {
    const out = scrub('float-fraction-part', null, { time: '168.' + CARD_SHAPED_INTEGER_PART });
    assert.ok(out.includes('168.' + CARD_SHAPED_INTEGER_PART),
        'the fractional part of a decimal number was rewritten as a card');
});

// --- 5. Differential: the gate and the scrubber cannot disagree. ---------
//
// The two properties above are about two specific values. This is about the
// PAIR OF DEFINITIONS: over a corpus of deliberately awkward candidates, the
// set of runs `har-shapes.js` calls a card and the set `pii.js` calls a card
// must be identical. A generator that cannot express a shape cannot falsify
// it, so the corpus is built to include the shapes that broke each half --
// decimals on both sides of the point, lengths at and past the boundary,
// assigned and unassigned prefixes, and runs pressed against punctuation.
//
// Compared by FINGERPRINT, never by value, so a failure names nothing.
{
    const shapes = require(path.join(__dirname, 'har-shapes.js'));

    function luhnRun(prefix, len, nonce) {
        const base = BigInt(prefix + String(nonce).padStart(len - prefix.length, '0'));
        for (let i = 0n; i < 500n; i++) {
            const s = (base + i).toString().padStart(len, '0');
            if (s.length === len && s.startsWith(prefix)
                && shapes.luhnValid(s)) return s;
        }
        return null;
    }

    const runs = [];
    // Assigned prefixes at minted lengths, unassigned prefixes, and lengths
    // just outside what the issuer mints (`4` at 17 is no more a Visa than
    // `98` at 16 is anything).
    for (const [prefix, len] of [
        ['4', 13], ['4', 16], ['4', 19], ['4', 17], ['51', 16], ['2221', 16],
        ['37', 15], ['6011', 16], ['62', 16], ['36', 14], ['3528', 18],
        ['98', 16], ['17', 16], ['12', 16], ['9', 13], ['80', 18], ['77', 19],
        ['4242', 16], ['00', 15],
    ]) {
        for (let n = 0; n < 3; n++) {
            const v = luhnRun(prefix, len, n);
            if (v) runs.push(v);
        }
    }

    // Each run, in every awkward surrounding that has ever mattered.
    const texts = [];
    for (const r of runs) {
        texts.push(r);
        texts.push(r + '.45');            // integer part of a float
        texts.push('168.' + r);           // fractional part of a float
        texts.push('0.' + r + '.9');      // both at once
        texts.push('id=' + r + '&x=1');   // query-string context
        texts.push('value: ' + r + '.');  // sentence punctuation, not a decimal
        texts.push('[' + r + ',' + r + ']');
        texts.push('/' + r + '/photos');  // path segment
    }

    // Compared as SETS of fingerprints: the question is which VALUES each side
    // classifies as a card, not how many times each counts an occurrence. The
    // two layers legitimately differ on multiplicity -- the gate reports one
    // leak per match, the scrubber groups by unique value before replacing.
    function uniqueSorted(xs) { return [...new Set(xs)].sort().join('|'); }

    function gateFingerprints(text) {
        return uniqueSorted(shapes.findLeaks(text, null)
            .filter((l) => l.kind === 'credit-card')
            .map((l) => l.fingerprint));
    }

    function scrubFingerprints(text) {
        // A request HEADER, so the candidate reaches `detectInString` as raw
        // text -- the same thing the gate scans, and one of the paths the
        // float defect was reachable through. A body would be JSON-parsed
        // first, and a JSON *number* is string-scanned by neither side, which
        // would make this a test of the walk rather than of the predicate.
        const har = { log: { version: '1.2', creator: { name: 't', version: '1' }, entries: [{
            request: { method: 'GET', url: 'https://example.invalid/',
                headers: [{ name: 'x-candidate', value: text }], queryString: [], cookies: [] },
            response: { status: 200, statusText: 'OK', headers: [], cookies: [],
                content: { mimeType: 'application/json', text: '{}' } },
        }] } };
        return uniqueSorted(pii.detectPii(har)
            .filter((d) => d.type === 'credit-card')
            .map((d) => shapes.fingerprint(d.value)));
    }

    check('5.a the gate and the scrubber agree on every candidate', () => {
        const disagreements = [];
        for (const text of texts) {
            const g = gateFingerprints(text);
            const s = scrubFingerprints(text);
            if (g !== s) {
                // Report the SHAPE of the disagreement, never the text.
                const count = (x) => x.split('|').filter(Boolean).length;
                disagreements.push(`len=${text.length} gate=${count(g)} scrub=${count(s)}`);
            }
        }
        assert.strictEqual(disagreements.length, 0,
            `${disagreements.length}/${texts.length} candidates classified differently by the `
            + `gate and the scrubber; first: ${disagreements[0]}`);
    });
}

if (failures > 0) {
    console.error(`pii-policy-threading: ${failures} case(s) failed`);
    process.exit(1);
}
console.log('All pii-policy-threading tests passed (9).');
