#!/usr/bin/env node
// Behavior tests for the password-envelope SCRUB rule (issue #407).
//
// Zero-dep, runs with `node har-pwd-envelope-scrub.test.js`. Exits non-zero on
// the first failure.
//
// WHAT THIS PINS, and why it is the other half of #395.
//
// #395 (PR #404) added `pwd-envelope` to `har-shapes.js`, so the GATE catches
// the envelope by SHAPE, under any field name. It did not touch the SCRUBBER,
// and the two are not symmetric for this kind: `sanitize-har.js` shape-scrubs
// `jwt`, `hex64`, `hex32` and `upload-handle` with no field name involved, so
// for those kinds an unnamed secret is redacted automatically and the gate then
// passes with no operator action. `pwd-envelope` had no such entry, so an
// envelope under a name the policy does not know BLOCKED with no automatic
// remedy -- a correct refusal with no route out except naming the field, which
// is the very control that failed.
//
// THE TRAP, inherited from #378 and #395: with both controls live the NAME
// control acts first, so an envelope placed under `enc_password` is scrubbed
// whether or not a shape rule exists and a shape test there passes for the
// wrong reason. Every assertion below uses `client_note`, a benign name, and
// section 1 proves no name-based control can see it. Ablate the PATTERNS entry
// in `sanitize-har.js` and sections 2, 3, 4, 5, 6 and 10 fail; nothing here can
// pass on the name control's behalf.
//
// NOTHING here is a real credential. Every value is synthetic and generated in
// this file, and no assertion message ever prints a detected value or the
// envelope marker -- a failure report that quotes the value merely relocates
// the leak into the log that reports it. Presence and a count are the whole
// reportable fact.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const shapes = require(path.join(__dirname, 'har-shapes.js'));
const secrets = require(path.join(__dirname, 'har-secrets.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));
const { makeTempRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));

const sanitize = path.join(__dirname, 'sanitize-har.js');
const verify = path.join(__dirname, 'verify-scrub.js');

// The scrub refuses a substitution-table destination git will not confirm is
// ignored (issue #318), so the fixture root is a real repository.
const tmp = makeTempRepo('har-scrub-fixture-');

// --- Synthetic values, generated here. ---
const ENVELOPE = '#PWD_BROWSER:5:1767225600:U3ludGhldGljRml4dHVyZUNpcGhlcnRleHRGb3JTY3J1YlRlc3RPbmx5Tm90UmVhbA';
const ENVELOPE_INSTAGRAM = '#PWD_INSTAGRAM_BROWSER:10:1767225601:U3ludGhldGljU2Vjb25kRml4dHVyZUZvclNjcnViVGVzdA';
// #378 measured surviving envelopes at 120, 39 and ELEVEN ciphertext
// characters. A scrub that only reaches the long one leaves two of three.
const ENVELOPE_SHORT = '#PWD_BROWSER:0:1767225602:U2hvcnRDaXBo';

// NOT in `secretFields`, and section 1 proves it. Everything after depends on
// this: it is what makes a pass here evidence of the SHAPE rule.
const BENIGN_FIELD = 'client_note';

// The scrubber's own replacement shape. Spelled out here rather than imported
// so this fails when the sentinel silently changes on either side.
const FAKE_RE = /^#PWD_REDACTED:0:0:[0-9a-f]{24}$/;

function makeHar(postText) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [
                {
                    startedDateTime: '2026-01-01T00:00:00.000Z',
                    time: 1,
                    request: {
                        method: 'POST', url: 'https://login.example.invalid/api/login',
                        httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [],
                        headersSize: -1, bodySize: postText.length,
                        postData: { mimeType: 'application/x-www-form-urlencoded', text: postText },
                    },
                    response: {
                        status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [],
                        cookies: [],
                        content: { size: 2, mimeType: 'application/json', text: '{}' },
                        redirectURL: '', headersSize: -1, bodySize: 2,
                    },
                    cache: {}, timings: { send: 0, wait: 1, receive: 0 },
                },
            ],
        },
    };
}

function writeHar(name, content) {
    const p = path.join(tmp, `${name}.har`);
    fs.writeFileSync(p, JSON.stringify(content, null, 2));
    return p;
}

const profilePath = path.join(tmp, '.har-profile.json');
fs.writeFileSync(profilePath, JSON.stringify({ salt: 'test-salt', literals: {} }, null, 2));

function runNode(script, args) {
    try {
        const out = execFileSync(process.execPath, [script, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return {
            code: e.status ?? 1,
            stdout: e.stdout?.toString() ?? '',
            stderr: e.stderr?.toString() ?? '',
        };
    }
}

// Scrub one form body; return the run result, the output path and its text.
function scrub(name, postText) {
    const harIn = writeHar(name, makeHar(postText));
    const harOut = path.join(tmp, `${name}.scrubbed.har`);
    const s = runNode(sanitize, ['--in', harIn, '--out', harOut,
        '--subs', path.join(tmp, `${name}.subs.json`), '--profile', profilePath,
        '--fixed-time', '2026-01-01T00:00:00.000Z']);
    return { run: s, out: harOut, text: s.code === 0 ? fs.readFileSync(harOut, 'utf8') : '' };
}

// The single form value of a scrubbed fixture, percent-decoded.
function firstParamValue(text) {
    const body = JSON.parse(text).log.entries[0].request.postData.text;
    const first = body.split('&')[0];
    return decodeURIComponent(first.slice(first.indexOf('=') + 1));
}

function assertReportIsQuiet(label, report, ...values) {
    for (const v of values) {
        assert.ok(!report.includes(v) && !report.includes(encodeURIComponent(v)),
            `${label}: the gate printed a detected value -- a report that quotes the ` +
            'credential relocates the leak into the log that reports it');
    }
    assert.ok(!report.includes('#PWD_'),
        `${label}: the gate printed the envelope marker, which names the credential ` +
        'format in the log even when the ciphertext is withheld');
}

// --- 1. THE ISOLATION. The name control is blind to the benign field. ------
// GUARD, not a falsifier: no change to the scrub rule can move it. It is the
// precondition that makes every section below mean what it claims.
{
    assert.strictEqual(secrets.isKnownSecretField(BENIGN_FIELD), false,
        `1.a: '${BENIGN_FIELD}' is a known secret FIELD NAME, so every assertion in ` +
        'this file could pass on the name control and the shape scrub would be untested');

    const named = [];
    secrets.walkForUnredactedSecrets(
        { entries: [{ [BENIGN_FIELD]: ENVELOPE }] }, (name) => named.push(name));
    assert.deepStrictEqual(named, [],
        '1.b: the key-name walk reported the envelope under a benign field name -- the ' +
        'isolation this file depends on is gone, and the scrub rule is no longer observed');

    const defaults = policyModule.loadDefaultPolicy().secretFields.map((n) => n.toLowerCase());
    assert.ok(!defaults.includes(BENIGN_FIELD),
        `1.c: '${BENIGN_FIELD}' was added to secretFields, which silently converts every ` +
        'assertion below into a second test of the name control');
}

// --- 2. THE FALSIFIER. A benign-named envelope is scrubbed. ---------------
// The case issue #407 exists for: it fails before the change and passes after
// it. Under a name the policy does not know, and with the name control proven
// blind by section 1, only a SHAPE rule in `sanitize-har.js` can remove this.
{
    const r = scrub('benign-named', `${BENIGN_FIELD}=${encodeURIComponent(ENVELOPE)}&doc_id=1234567890`);
    assert.strictEqual(r.run.code, 0, `2.a: sanitize-har failed: ${r.run.stderr || r.run.stdout}`);
    assert.ok(!r.text.includes(ENVELOPE) && !r.text.includes(encodeURIComponent(ENVELOPE)),
        '2.b: the envelope survived the scrub under a benign field name, so a capture ' +
        'the gate now blocks still has no automatic remedy -- the whole of #407');
    // Both spellings: the wire text as committed, and the form parameter
    // percent-DECODED, which is the form the gate reaches and the one a
    // flat scan over the file cannot see.
    assert.strictEqual(
        shapes.findLeaks(`${r.text}\n${firstParamValue(r.text)}`)
            .filter((l) => l.kind === 'pwd-envelope').length, 0,
        '2.c: the shape gate still finds an envelope in the scrubbed output; either the ' +
        'scrub missed a spelling or its own fake is being re-reported');
    // The non-secret neighbour survives: a scrub that blanked the whole body
    // would pass 2.b while destroying the capture's usefulness.
    assert.ok(r.text.includes('doc_id=1234567890'),
        '2.d: the scrub removed a benign neighbouring parameter, so 2.b would pass for a ' +
        'rule that simply erases the body');
}

// --- 3. The label is the product, not the format; the tail may be short. ---
// FALSIFIER for the rule's breadth. A scrub pinned to one product label, or
// demanding a long ciphertext, leaves two of the three envelopes #378 measured.
{
    for (const [label, value] of [['instagram', ENVELOPE_INSTAGRAM], ['short-ciphertext', ENVELOPE_SHORT]]) {
        const r = scrub(`benign-${label}`, `${BENIGN_FIELD}=${encodeURIComponent(value)}`);
        assert.strictEqual(r.run.code, 0, `3.a: sanitize-har failed for the ${label} case`);
        assert.ok(!r.text.includes(value) && !r.text.includes(encodeURIComponent(value)),
            `3.b: the ${label} envelope survived the scrub -- the label is the product, ` +
            'not the format, and #378 measured surviving ciphertexts at 120, 39 and 11 ' +
            'characters');
    }
}

// --- 4. The replacement is FORMAT-PRESERVING and sentinel-marked. ---------
// FALSIFIER for the shape of the fake. `upload-handle` is the precedent: a
// consumer that parses the field still sees the tokens it expects. The
// sentinel is what makes section 5 possible at all.
{
    const r = scrub('fake-shape', `${BENIGN_FIELD}=${encodeURIComponent(ENVELOPE)}`);
    assert.strictEqual(r.run.code, 0, '4.a: sanitize-har failed');
    assert.match(firstParamValue(r.text), FAKE_RE,
        '4.b: the replacement is not the sentinel-marked, format-preserving fake this ' +
        'kind promises; har-shapes.js `isFake` keys on that exact spelling and would ' +
        'either re-report the scrubber forever or exempt something it should not');
    // The sentinel must be unreachable by the real format, or it is a hole: a
    // live envelope spelled to match it would be exempted by the gate.
    for (const live of [ENVELOPE, ENVELOPE_INSTAGRAM, ENVELOPE_SHORT]) {
        assert.ok(!FAKE_RE.test(live),
            '4.c: a real-shaped envelope matches the fake sentinel, so the gate would ' +
            'exempt a live credential that merely named itself conveniently');
    }
}

// --- 5. The gate accepts the scrubber's own output. -----------------------
// FALSIFIER for `isFake` in har-shapes.js. A format-preserving fake MATCHES the
// gate pattern, so without the exemption the gate re-reports the redaction it
// just made, on every run, forever, and no scrubbed capture could ever pass.
{
    const r = scrub('gate-accepts', `${BENIGN_FIELD}=${encodeURIComponent(ENVELOPE)}&doc_id=1234567890`);
    assert.strictEqual(r.run.code, 0, '5.a: sanitize-har failed');
    const v = runNode(verify, ['--in', r.out]);
    assert.strictEqual(v.code, 0,
        '5.b: verify-scrub refused the scrubber\'s own redaction of a benign-named ' +
        'envelope, so the capture #407 exists for still has no route to a clean, ' +
        `committable file: ${v.stderr || v.stdout}`);
    // Asserted against the shape table directly as well: the gate could be
    // silent because it never looked, and this cannot be.
    assert.strictEqual(shapes.findLeaks(firstParamValue(r.text)).length, 0,
        '5.c: the shape table reports the scrubber output it is supposed to exempt');
}

// --- 6. DETERMINISM. The same raw scrubs byte-identically. ---------------
// FALSIFIER for the seeding. `fakeFor` derives the fake from HMAC(salt,
// original), so re-scrubbing the same capture under the same policy must
// produce the same bytes. That property is what makes the scrub's overwrite
// semantics safe: a re-run over an existing output changes nothing, so a diff
// is evidence the INPUT changed rather than noise from a random replacement.
{
    const postText = `${BENIGN_FIELD}=${encodeURIComponent(ENVELOPE)}&doc_id=1234567890`;
    const first = scrub('determinism-a', postText);
    const second = scrub('determinism-b', postText);
    assert.strictEqual(first.run.code, 0, '6.a: the first scrub failed');
    assert.strictEqual(second.run.code, 0, '6.a: the second scrub failed');
    assert.strictEqual(first.text, second.text,
        '6.b: two scrubs of the same raw under the same policy differ, so the ' +
        'password-envelope fake is not seeded from the original and re-scrubbing a ' +
        'capture would churn the committed file on every run');
    const value = firstParamValue(first.text);
    assert.match(value, FAKE_RE, '6.c: the value compared for determinism is not the fake');

    // A DIFFERENT original must not collapse onto the same fake: an
    // implementation returning a constant would pass 6.b trivially while
    // erasing the distinction between two credentials.
    const other = scrub('determinism-c', `${BENIGN_FIELD}=${encodeURIComponent(ENVELOPE_INSTAGRAM)}`);
    assert.strictEqual(other.run.code, 0, '6.d: the third scrub failed');
    assert.notStrictEqual(value, firstParamValue(other.text),
        '6.e: two different envelopes scrubbed to the SAME fake, so the replacement is a ' +
        'constant rather than a function of the original and 6.b proves nothing');
}

// --- 7. The known-named path is unchanged. -------------------------------
// GUARD. #378's name control still owns the envelope when the field IS named,
// and the new shape rule must not have displaced it.
{
    const r = scrub('known-named', `enc_password=${encodeURIComponent(ENVELOPE)}&doc_id=1234567890`);
    assert.strictEqual(r.run.code, 0, `7.a: sanitize-har failed: ${r.run.stderr || r.run.stdout}`);
    assert.ok(!r.text.includes(ENVELOPE) && !r.text.includes(encodeURIComponent(ENVELOPE)),
        '7.b: the envelope survived the scrub under a name the policy knows');
    const v = runNode(verify, ['--in', r.out]);
    assert.strictEqual(v.code, 0,
        `7.c: verify-scrub flagged the known-named redaction: ${v.stderr || v.stdout}`);
}

// --- 8. Precision. The scrub does not eat benign text. -------------------
// FALSIFIER for over-reach. The argument for this rule is that no benign value
// begins with that token; a scrub that mangles a CSS colour or a doc anchor is
// how a capture becomes useless and an operator learns to distrust the tool.
{
    const NOT_ENVELOPES = [
        '#PWD_BROWSER',
        '#PWD_BROWSER:',
        'https://example.invalid/docs#pwd-reset-flow',
        'INFO:auth:5:1767225600:password check ok',
        '#ff8800',
        '#407 comment about a password field',
        'PWD_BROWSER:5:1767225600:U3ludGhldGljVmFsdWVOb3RBbkVudmVsb3Bl',
        '#pwd_browser:5:1767225600:U3ludGhldGljTG93ZXJjYXNlTm90T2JzZXJ2ZWQ',
    ];
    for (let i = 0; i < NOT_ENVELOPES.length; i += 1) {
        const r = scrub(`benign-text-${i}`, `note=${encodeURIComponent(NOT_ENVELOPES[i])}`);
        assert.strictEqual(r.run.code, 0, `8.a: sanitize-har failed on case index ${i}`);
        assert.strictEqual(firstParamValue(r.text), NOT_ENVELOPES[i],
            '8.b: the scrub rewrote a benign value as a password envelope ' +
            `(case index ${i}, value withheld)`);
    }
}

// --- 9. The gate still refuses an UNSCRUBBED capture. --------------------
// GUARD, and the one claim #395's section 8.d made that must stay true whatever
// else changes: a file the scrub left the credential in is never labelled
// clean. Nothing in #407 relaxes the gate.
{
    const raw = writeHar('unscrubbed', makeHar(
        `${BENIGN_FIELD}=${encodeURIComponent(ENVELOPE)}&doc_id=1234567890`));
    const v = runNode(verify, ['--in', raw]);
    assert.notStrictEqual(v.code, 0,
        '9.a: the gate reported a RAW capture carrying a live password envelope as clean');
    assertReportIsQuiet('9.b', `${v.stdout}${v.stderr}`, ENVELOPE);
}

// --- 10. ONE DEFINITION OF AN ENVELOPE, IN TWO FILES. -------------------
// FALSIFIER for drift between the halves. The scrubber removes what the gate
// fails on; if the two disagreed about what an envelope IS, one of them would
// be wrong on every capture -- either the scrub misses a spelling the gate
// blocks (a file that can never be committed) or the gate misses one the scrub
// rewrites (a redaction nobody asked for). `har-shapes.js` says the same thing
// about `mac-address` and `RE.mac` in prose; here it is asserted.
//
// The gate's pattern is read LIVE off the exported table; the scrubber's is
// read out of its source, because `sanitize-har.js` is a CLI and exports
// nothing. A textual comparison of two source files would pass on two copies
// of the same mistake -- this compares the object the gate actually runs
// against the text the scrubber actually ships.
//
// The fixtures in sections 2, 3 and 5 exercise both halves, but only over the
// spellings this file happens to carry: a rule widened or narrowed on one side
// alone still passes them. This is the assertion that does not depend on
// having guessed the right fixture.
{
    const gate = shapes.LEAK_PATTERNS.find((p) => p.name === 'pwd-envelope');
    assert.ok(gate, '10.a: the gate no longer carries a pwd-envelope pattern at all');

    const src = fs.readFileSync(sanitize, 'utf8');
    const m = /\{\s*kind:\s*'pwd-envelope',\s*re:\s*\/(.+?)\/([a-z]*)\s*\}/.exec(src);
    assert.ok(m, '10.b: no pwd-envelope PATTERNS entry found in sanitize-har.js, or it is ' +
        'no longer a plain regex literal this assertion can read');

    assert.strictEqual(m[1], gate.re.source,
        '10.c: the scrubber and the gate disagree about what a password envelope IS. ' +
        'One of them is then wrong on every capture: either the scrub misses a spelling ' +
        'the gate blocks, which is a file that can never be committed, or the gate misses ' +
        'one the scrub rewrites');
    assert.strictEqual(m[2], gate.re.flags,
        '10.d: the two patterns carry different flags. `i` in particular doubles the ' +
        'spelling space of the one token the precision argument rests on, and doing that ' +
        'on one side only is the same disagreement as a different pattern');
}

console.log('All har-pwd-envelope-scrub tests passed');
