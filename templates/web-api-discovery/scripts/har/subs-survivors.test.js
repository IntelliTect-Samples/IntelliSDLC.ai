#!/usr/bin/env node
// Behavior tests for the substitution-table post-condition (issue #475).
//
// Zero-dep, runs with `node subs-survivors.test.js`. Exits non-zero on the
// first failure.
//
// WHAT THIS PINS
//
// A key in the substitution table is the scrubber's own statement that the
// value it names must be replaced. #475 measured the scrubber writing such a
// key and then leaving the value standing: 119 occurrences of one cookie
// value, 116 replaced and 3 left inside a 5.38 MB response body; 128
// occurrences of one field value, 1 replaced. `verify-scrub.js` passed both
// runs, because it asks about SHAPES and about profile LITERALS and neither
// question reaches a value whose only evidence is "the scrubber already said
// so".
//
// Two properties, and they are not the same property:
//
//   1. THE SWEEP. Every occurrence of an original this run substituted is
//      replaced, wherever it appears. The survivors carry no name the policy
//      knows and no shape any pattern matches, so no name-reach fix (#484,
//      #330, #487) can ever reach them -- only the scrubber's own record of
//      the value can.
//   2. THE POST-CONDITION. If one survives anyway, the run writes NOTHING and
//      exits non-zero. A sweep without a guard regresses silently; a guard
//      without a sweep refuses every affected capture forever.
//
// And one absolute rule, which #475 learned the expensive way: the table's
// keys ARE the plaintext credential store. Iterating them is fine, emitting
// them is not. Section 5 asserts that nothing this feature prints contains a
// survivor.
//
// NOTHING here is a real credential. Every value is synthetic, typed in this
// file, and no assertion message prints one.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const secrets = require(path.join(__dirname, 'har-secrets.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));
const { makeTempRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));
const survivors = require(path.join(__dirname, 'subs-survivors.js'));

const sanitize = path.join(__dirname, 'sanitize-har.js');

const tmp = makeTempRepo('subs-survivors-');

// --- Synthetic values, typed here. ----------------------------------------
// Survivor A's shape: 24 characters of mixed-case alphanumerics. Deliberately
// NOT hex, NOT a UUID, NOT a JWT -- so no PATTERNS entry in sanitize-har.js
// can match it, and the only thing that knows it is a secret is the cookie
// name it arrived under.
const COOKIE_VALUE = 'Sy7nQkTv2Xb9RmLp4Wz0Hc6A';
// A known secret cookie name, so the scrub records a table entry for it.
const COOKIE_NAME = 'datr';
// The benign response-body key the same value also travels under. Nothing in
// the policy knows this name; section 1 proves it.
const BENIGN_KEY = 'tracking_ref';

const profilePath = path.join(tmp, '.har-profile.json');
fs.writeFileSync(profilePath, JSON.stringify({ salt: 'test-salt', literals: {} }, null, 2));

let passed = 0;
function ok(label) { passed++; void label; }

function runNode(script, args) {
    try {
        const out = execFileSync(process.execPath, [script, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return {
            code: e.status === undefined || e.status === null ? 1 : e.status,
            stdout: e.stdout ? e.stdout.toString() : '',
            stderr: e.stderr ? e.stderr.toString() : '',
        };
    }
}

/**
 * A capture carrying one cookie in the request header and the SAME value,
 * bare, in a response body -- survivor A, reduced to its essentials.
 */
function makeHar(responseBody) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [
                {
                    startedDateTime: '2026-01-01T00:00:00.000Z',
                    time: 1,
                    request: {
                        method: 'GET', url: 'https://example.invalid/api/feed',
                        httpVersion: 'HTTP/1.1',
                        headers: [{ name: 'Cookie', value: `${COOKIE_NAME}=${COOKIE_VALUE}; sid=9` }],
                        queryString: [], cookies: [], headersSize: -1, bodySize: 0,
                    },
                    response: {
                        status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
                        headers: [], cookies: [],
                        content: {
                            size: responseBody.length, mimeType: 'application/json',
                            text: responseBody,
                        },
                        redirectURL: '', headersSize: -1, bodySize: responseBody.length,
                    },
                    cache: {}, timings: { send: 0, wait: 1, receive: 0 },
                },
            ],
        },
    };
}

function scrub(name, responseBody) {
    const harIn = path.join(tmp, `${name}.har`);
    fs.writeFileSync(harIn, JSON.stringify(makeHar(responseBody), null, 2));
    const harOut = path.join(tmp, `${name}.scrubbed.har`);
    const subsPath = path.join(tmp, `${name}.subs.json`);
    const r = runNode(sanitize, ['--in', harIn, '--out', harOut,
        '--subs', subsPath, '--pii-subs', path.join(tmp, `${name}.pii-subs.json`),
        '--profile', profilePath, '--fixed-time', '2026-01-01T00:00:00.000Z']);
    return {
        run: r,
        out: harOut,
        subsPath,
        exists: fs.existsSync(harOut),
        text: fs.existsSync(harOut) ? fs.readFileSync(harOut, 'utf8') : '',
    };
}

function countOf(haystack, needle) {
    if (!needle) return 0;
    let n = 0;
    let i = haystack.indexOf(needle);
    while (i !== -1) { n++; i = haystack.indexOf(needle, i + needle.length); }
    return n;
}

// --- 1. THE ISOLATION -----------------------------------------------------
// GUARD, not a falsifier. Everything below claims the SWEEP removed the value
// from the response body. That claim is only observable while no name-based
// and no shape-based control can reach it there.
{
    assert.strictEqual(secrets.isKnownSecretField(BENIGN_KEY), false,
        `1.a: '${BENIGN_KEY}' is a known secret field name, so section 2 would pass on ` +
        'the name control and the sweep would be untested');
    assert.ok(policyModule.loadDefaultPolicy().secretFields
        .map((n) => n.toLowerCase()).includes(COOKIE_NAME),
        `1.b: '${COOKIE_NAME}' is no longer a known secret name, so the scrub records no ` +
        'table entry for it and there is nothing for the sweep to act on');
    assert.ok(!/^[0-9a-fA-F]+$/.test(COOKIE_VALUE),
        '1.c: the fixture value became hex-shaped, so the PATTERNS sweep would remove it ' +
        'from the response body and section 2 would no longer observe the substitution sweep');
    ok('isolation');
}

// --- 2. THE FALSIFIER: no occurrence of a substituted original survives ----
// This is #475 survivor A. Before the fix the value is replaced in the Cookie
// header and left standing in the response body; after it, nowhere.
{
    const body = JSON.stringify({
        items: [{ id: 1, [BENIGN_KEY]: COOKIE_VALUE }, { id: 2, [BENIGN_KEY]: COOKIE_VALUE }],
        note: `seen ${COOKIE_VALUE} earlier`,
    });
    const r = scrub('survivor-a', body);
    assert.strictEqual(r.run.code, 0,
        `2.a: sanitize-har failed: ${r.run.stderr || r.run.stdout}`);
    assert.strictEqual(countOf(r.text, COOKIE_VALUE), 0,
        `2.b: ${countOf(r.text, COOKIE_VALUE)} occurrence(s) of a value the scrub's own ` +
        'substitution table says must be replaced survived in the output');

    // ... and the replacement really is there, at all three body sites plus
    // the header. A sweep that DELETED the value would also satisfy 2.b.
    const subs = JSON.parse(fs.readFileSync(r.subsPath, 'utf8'));
    const fakes = Object.values(subs);
    assert.strictEqual(fakes.length, 1,
        `2.c: expected exactly one table entry, got ${fakes.length}`);
    assert.strictEqual(countOf(r.text, fakes[0]), 4,
        `2.d: the replacement appears ${countOf(r.text, fakes[0])} time(s); the header and ` +
        'three response-body sites should all carry the same fake');
    ok('sweep removes survivors');
}

// --- 3. The sweep reaches a JSON-ESCAPED spelling --------------------------
// A response body is a STRING inside the HAR, so a value carrying a quote or a
// backslash appears escaped in the serialized document. A sweep written over
// the serialized text would miss it; one written over the parsed leaves does
// not.
{
    const body = JSON.stringify({ [BENIGN_KEY]: COOKIE_VALUE, quoted: `"${COOKIE_VALUE}"` });
    const r = scrub('escaped', body);
    assert.strictEqual(r.run.code, 0,
        `3.a: sanitize-har failed: ${r.run.stderr || r.run.stdout}`);
    assert.strictEqual(countOf(r.text, COOKIE_VALUE), 0,
        '3.b: a substituted original survived inside a JSON-escaped spelling');
    ok('escaped spelling');
}

// --- 4. Idempotence: a document with nothing to sweep is not rewritten -----
// The sweep must be a no-op on content it has no table entry for. Without
// this, "removes every survivor" could be satisfied by a pass that rewrites
// unrelated text -- which is #529's defect, in the pass this issue adds.
{
    const body = JSON.stringify({ note: 'version 4 of 1148 items', path: '/v4/tiles.json' });
    const r = scrub('idempotent', body);
    assert.strictEqual(r.run.code, 0,
        `4.a: sanitize-har failed: ${r.run.stderr || r.run.stdout}`);
    const out = JSON.parse(r.text).log.entries[0].response.content.text;
    assert.strictEqual(out, body,
        '4.b: the sweep rewrote a response body holding no substituted original');
    ok('idempotence');
}

// --- 5. Nothing this feature emits carries a value ------------------------
// The report is a PLACE and a COUNT. A post-condition written to find leaked
// credentials that prints one has relocated the leak into its own report.
{
    const body = JSON.stringify({ [BENIGN_KEY]: COOKIE_VALUE });
    const r = scrub('quiet', body);
    for (const [stream, text] of [['stdout', r.run.stdout], ['stderr', r.run.stderr]]) {
        assert.ok(!text.includes(COOKIE_VALUE),
            `5.a: sanitize-har printed a substituted original on ${stream}`);
    }
    ok('quiet report');
}

// --- 6. THE GUARD sees a survivor the sweep did not remove ---------------
// The post-condition is tested on its own, against a document built to hold a
// survivor, because through the CLI the sweep runs first and there is nothing
// left for it to find -- which is the whole point of shipping both halves. A
// guard is for the day a pass is added downstream of the sweep, and it has to
// be observed directly to be observed at all.
{
    const original = 'Kp3xTn8LqW2vBz5RdY7M';
    const entry = {
        key: `cookie:${COOKIE_NAME}:${original}`, kind: 'cookie', name: COOKIE_NAME,
        original, replacement: 'redacted-0123456789abcdef01234567',
    };
    const har = {
        log: {
            entries: [
                {
                    request: { url: `https://example.invalid/?ref=${original}` },
                    response: { content: { text: `{"a":"${original}","b":"${original}"}` } },
                },
            ],
        },
    };
    const found = survivors.findSurvivors(har, [entry]);
    assert.strictEqual(found.length, 2,
        `6.a: expected two locations, got ${found.length}`);
    const byPath = new Map(found.map((f) => [f.keyPath, f]));
    assert.ok(byPath.has('request.url'), '6.b: the URL survivor was not located');
    assert.strictEqual(byPath.get('response.content.text').count, 2,
        '6.c: two occurrences in one leaf must be counted, not collapsed to one');
    for (const f of found) {
        assert.strictEqual(f.entryIndex, 0, '6.d: the finding lost its entry index');
        assert.strictEqual(f.namespace, `cookie:${COOKIE_NAME}`,
            '6.e: the finding lost its key namespace');
        assert.strictEqual(f.length, original.length,
            '6.f: the finding lost the length of what survived');
    }
    ok('guard locates survivors');
}

// --- 7. No finding, and no line describing one, carries the value ---------
// The absolute rule. Every field of every finding is checked, not just the
// ones this implementation happens to populate today -- the field a detector
// grows next is exactly the one that would carry a value.
{
    const original = 'Zq9wEr4TyU1iOp6AsDfG';
    const entry = {
        key: `field:secret:${original}`, kind: 'field', name: 'secret',
        original, replacement: 'redacted-abcdef0123456789',
    };
    const har = { log: { entries: [{ response: { content: { text: original } } }] } };
    const found = survivors.findSurvivors(har, [entry]);
    assert.strictEqual(found.length, 1, '7.a: expected one finding');
    for (const [k, v] of Object.entries(found[0])) {
        assert.ok(!(typeof v === 'string' && v.includes(original)),
            `7.b: finding field '${k}' carries the surviving value`);
    }
    assert.ok(!survivors.describeSurvivor(found[0]).includes(original),
        '7.c: the operator-facing line quotes the surviving value');
    ok('findings are quiet');
}

// --- 8. Short originals are neither swept nor checked ---------------------
// One floor, shared by both halves, so they can never disagree about which
// originals are in play. A three-character value is a substring of ordinary
// prose and sweeping it would corrupt the capture -- #529's defect, in the
// pass this issue adds.
{
    const short = 'ShortValue12345';
    const entry = {
        key: `field:x:${short}`, kind: 'field', name: 'x', original: short,
        replacement: 'redacted-1111',
    };
    const har = { log: { entries: [{ response: { content: { text: 'ShortValue12345 x ShortValue12345' } } }] } };
    assert.deepStrictEqual(survivors.sweepableEntries([entry]), [],
        '8.a: an original below the shared floor entered the sweep');
    assert.deepStrictEqual(survivors.findSurvivors(har, [entry]), [],
        '8.b: an original below the shared floor was reported as a survivor');
    const before = JSON.stringify(har);
    survivors.applySweep(har, [entry]);
    assert.strictEqual(JSON.stringify(har), before,
        '8.c: the sweep rewrote text on behalf of an original below the floor');
    ok('shared length floor');
}

// --- 9. Overlapping originals: the longest wins, and no fragment is left --
// One original is routinely a substring of another. Replacing the short one
// first leaves a mangled fragment of the long one that no later pass can
// recognise as anything.
{
    const long = 'PrefixAndSuffixValue1234';
    const short = 'AndSuffixValue1234';
    const entries = [
        { key: `field:a:${short}`, kind: 'field', name: 'a', original: short, replacement: 'FAKE-SHORT' },
        { key: `field:b:${long}`, kind: 'field', name: 'b', original: long, replacement: 'FAKE-LONG' },
    ];
    const har = { log: { entries: [{ response: { content: { text: `x ${long} y ${short} z` } } }] } };
    survivors.applySweep(har, entries);
    const text = har.log.entries[0].response.content.text;
    assert.strictEqual(text, 'x FAKE-LONG y FAKE-SHORT z',
        '9.a: overlapping originals were not resolved longest-first');
    assert.deepStrictEqual(survivors.findSurvivors(har, entries), [],
        '9.b: a fragment of an overlapping original survived the sweep');
    ok('longest-first');
}

// --- 10. Non-reversible substitutions are reported, benign ones are not ---
// The table exists to be read backwards. Two unrelated originals sharing one
// replacement makes that ambiguous for the pair. Two originals where one is a
// substring of the other do not: the sweep replaces the longer, and the
// shorter never stands alone.
{
    const mk = (name, original, replacement) =>
        ({ key: `field:${name}:${original}`, kind: 'field', name, original, replacement });

    const ambiguous = survivors.findCollisions([
        mk('a', 'AlphaValue123456', 'SHARED-FAKE'),
        mk('b', 'BetaValue1234567890', 'SHARED-FAKE'),
    ]);
    assert.strictEqual(ambiguous.length, 1, '10.a: an ambiguous pair was not reported');
    assert.deepStrictEqual(ambiguous[0].lengths, [16, 19],
        '10.b: the report lost the lengths that identify the pair');
    assert.ok(!survivors.describeCollision(ambiguous[0]).includes('AlphaValue123456'),
        '10.c: the collision line quotes an original');

    const benign = survivors.findCollisions([
        mk('a', 'CommonValue12345', 'SHARED-FAKE'),
        mk('b', 'xCommonValue12345y', 'SHARED-FAKE'),
    ]);
    assert.deepStrictEqual(benign, [],
        '10.d: a substring collapse -- which is correct -- was reported as a defect');

    assert.deepStrictEqual(
        survivors.findCollisions([mk('a', 'OneValue12345678', 'F1'), mk('b', 'TwoValue12345678', 'F2')]),
        [], '10.e: two distinct replacements were reported as a collision');
    ok('collision detector');
}

// --- 11. A short value under a secret NAME does not become a global edit ---
// The regression this floor exists to prevent, and it is not hypothetical:
// #529 measured a locale bundle whose `"Password"` key holds the UI label
// `"Password"`. The name control redacts that value at its own site, which is
// correct-ish and already argued elsewhere. Sweeping it is not: an eight-
// character English word appears all over a capture, and replacing every
// occurrence turns "Forgot Password?" into a redaction sentinel and corrupts
// the reference document.
//
// One name-captured value damaged one site before this change. Globalizing it
// would damage the whole capture -- a reach fix re-creating the same defect on
// the axis it did not consider.
{
    const body = JSON.stringify({
        Password: 'Password',
        hint: 'Forgot Password?',
        other: 'Confirm Password now',
    });
    const r = scrub('locale-bundle', body);
    assert.strictEqual(r.run.code, 0,
        `11.a: sanitize-har failed: ${r.run.stderr || r.run.stdout}`);
    const out = JSON.parse(JSON.parse(r.text).log.entries[0].response.content.text);
    assert.strictEqual(out.hint, 'Forgot Password?',
        '11.b: the sweep rewrote ordinary prose on behalf of a short value captured ' +
        'by a secret field NAME -- the whole capture is now damaged where one site was');
    assert.strictEqual(out.other, 'Confirm Password now',
        '11.c: the sweep rewrote ordinary prose at a second site');
    ok('short name-captured values are not swept');
}

// --- 12. Both observed survivors are still long enough to be swept ---------
// The floor is a trade, and this is the half that must not be given away:
// #475's two measured survivors are 17 and 24 characters. A floor that
// excluded either would have fixed nothing the issue is about.
{
    assert.ok(survivors.MIN_SWEEPABLE_LENGTH <= 17,
        `12.a: the floor is ${survivors.MIN_SWEEPABLE_LENGTH}, which excludes the ` +
        '17-character field value #475 measured surviving 127 of 128 times');
    assert.ok(survivors.MIN_SWEEPABLE_LENGTH > 8,
        '12.b: the floor admits eight-character values again, which is how an ordinary ' +
        'English word under a secret field name becomes a global edit (section 11)');
    ok('the floor still covers both measured survivors');
}

// --- 13. A fake this run emitted is never swept as if it were an original --
// An identity test, the same discipline as `alreadySubstituted` in the
// scrubber. Two ways a fake could be mistaken for an original: the run
// recorded it in `produced`, or another entry's replacement happens to equal
// it. Both are closed, because the consequence -- rewriting a replacement this
// run just inserted -- is how a scrub corrupts its own sentinels (#529).
{
    const fake = 'redacted-0123456789abcdef';
    const entries = [
        { key: 'field:a:x', kind: 'field', name: 'a', original: fake, replacement: 'SECOND-FAKE' },
        { key: 'field:b:y', kind: 'field', name: 'b', original: 'RealOriginalValue123', replacement: fake },
    ];
    const sweepable = survivors.sweepableEntries(entries);
    assert.deepStrictEqual(sweepable.map((e) => e.original), ['RealOriginalValue123'],
        '13.a: a value that is another entry\'s replacement entered the sweep as an original');

    const viaProduced = survivors.sweepableEntries(
        [{ key: 'field:c:z', kind: 'field', name: 'c', original: fake, replacement: 'OTHER-FAKE' }],
        new Set([fake]));
    assert.deepStrictEqual(viaProduced, [],
        '13.b: a fake this run emitted entered the sweep as an original');
    ok('fakes are never swept');
}

// --- 14. One original, two kinds: the choice is deterministic -------------
// `fakeFor` keys on KIND, so one value substituted as a cookie and again as a
// field legitimately carries two different fakes. The sweep sees text, not
// kinds, so it must pick one -- and the same one every time, or two runs over
// one input produce different bytes. Which one it picks is arbitrary; that it
// is stable is not.
{
    const original = 'SharedAcrossTwoKinds1234';
    const entries = [
        { key: `field:x:${original}`, kind: 'field', name: 'x', original, replacement: 'FIELD-FAKE' },
        { key: `cookie:x:${original}`, kind: 'cookie', name: 'x', original, replacement: 'COOKIE-FAKE' },
    ];
    const first = survivors.sweepableEntries(entries)[0].replacement;
    const reversed = survivors.sweepableEntries(entries.slice().reverse())[0].replacement;
    assert.strictEqual(first, reversed,
        '14.a: the sweep picks a different replacement depending on the order the run ' +
        'happened to record the entries, so one input no longer produces one output');
    ok('deterministic across kinds');
}

// --- 15. A value carrying whitespace is never swept ----------------------
// The rest of the prose axis, and the half a length floor cannot reach. The
// secret field list carries `confirm_password`, `new_password`,
// `security_code` -- exactly the names an i18n bundle reuses as translation
// KEYS -- so a locale string like "Confirm your password" (22 characters) is
// captured by name, clears any sane length floor, and would be swept into
// every other place that sentence appears in the capture.
//
// Whitespace is the discriminator, not length. A credential that travels as a
// bare form or JSON value does not contain a space: cookie values cannot,
// URL-borne tokens cannot, and hex/JWT/UUID shapes cannot. A sentence almost
// always does. The value is still redacted at its own site by the name
// control; it is only the GLOBAL edit that is declined.
{
    const phrase = 'Confirm your password';
    const entry = {
        key: `field:confirm_password:${phrase}`, kind: 'field', name: 'confirm_password',
        original: phrase, replacement: 'redacted-aaaabbbbccccdddd',
    };
    assert.ok(phrase.length > survivors.MIN_SWEEPABLE_LENGTH,
        '15.a: the fixture phrase is below the floor, so this section would pass on the ' +
        'length rule and the whitespace rule would be untested');
    assert.deepStrictEqual(survivors.sweepableEntries([entry]), [],
        '15.b: a name-captured phrase entered the sweep, so every other occurrence of ' +
        'that sentence in the capture becomes a redaction sentinel');

    const har = { log: { entries: [{ response: { content: { text: `Please ${phrase} again` } } }] } };
    const before = JSON.stringify(har);
    survivors.applySweep(har, [entry]);
    assert.strictEqual(JSON.stringify(har), before,
        '15.c: the sweep rewrote a sentence elsewhere in the capture');
    assert.deepStrictEqual(survivors.findSurvivors(har, [entry]), [],
        '15.d: the check reports a survivor the sweep is not allowed to remove, which ' +
        'would refuse every capture carrying the phrase');
    ok('whitespace is never swept');
}

// --- 16. Both measured survivors still pass every sweep rule -------------
// The guard on the two rules above together. #475's survivors are a 24-
// character alphanumeric cookie value and a 17-character punctuated field
// value; neither carries whitespace, so neither rule excludes them.
{
    for (const original of ['Sy7nQkTv2Xb9RmLp4Wz0Hc6A', 'a.b-c_d:e/f+g=h%i']) {
        const entry = { key: `cookie:datr:${original}`, kind: 'cookie', name: 'datr',
            original, replacement: 'redacted-1234567890abcdef' };
        assert.strictEqual(survivors.sweepableEntries([entry]).length, 1,
            `16.a: a ${original.length}-character survivor of the shape #475 measured is ` +
            'no longer swept, so the issue is no longer fixed');
    }
    ok('measured survivors still swept');
}

console.log(`All subs-survivors tests passed (${passed} sections)`);
