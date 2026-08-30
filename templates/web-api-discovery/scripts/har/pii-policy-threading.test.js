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
check('1.a unassigned IIN survives the scrub', () => {
    const out = scrub('unassigned-iin', null, { objectId: UNASSIGNED_LUHN_16 });
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
    const out = scrub('maestro-default', null, { objectId: MAESTRO_16 });
    assert.ok(out.includes(MAESTRO_16),
        'the shipped table claimed a range it deliberately does not carry');
});

check('2.b a project cardIssuers range makes the scrubber replace it', () => {
    const out = scrub('maestro-policy',
        { schemaVersion: 1, cardIssuers: [MAESTRO_ISSUER] },
        { objectId: MAESTRO_16 });
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

if (failures > 0) {
    console.error(`pii-policy-threading: ${failures} case(s) failed`);
    process.exit(1);
}
console.log('All pii-policy-threading tests passed (6).');
