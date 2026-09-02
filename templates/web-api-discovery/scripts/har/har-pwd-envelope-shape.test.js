#!/usr/bin/env node
// Behavior tests for the password-envelope SHAPE rule (issue #395).
//
// Zero-dep, runs with `node har-pwd-envelope-shape.test.js`. Exits non-zero on
// the first failure.
//
// WHAT THIS PINS, and why it is not a duplicate of #378's tests.
//
// #378 (PR #389) fixed the KEY-NAME control: `secretFields` gained the
// auth-flow names, and the gate now walks form-encoded parameters, so a login
// body under `enc_password` / `sensitive_string_value` is reached. That is one
// control. The envelope itself -- `#PWD_BROWSER:<v>:<unix>:<base64>` -- was
// still invisible to the SHAPE control, which is the control that does not
// care what the field is called.
//
// The two fail differently, and the value is reachable when only the name
// control is defeated: a provider renames the field, the envelope travels as a
// bare form parameter, or another product adopts the same envelope under a
// name nobody listed. In each case the value is unmistakably a password
// envelope and nothing looks at it.
//
// THE TRAP, which #378's own ablation ran into: with BOTH controls live, the
// name control reports first, so a test that puts the envelope under
// `enc_password` passes whether or not the shape rule exists. Every assertion
// below therefore uses a field name that is BENIGN -- `client_note`, deliberately
// not in `secretFields` -- and section 1 asserts that the name control is silent
// on it. If the shape rule is removed, sections 2-6 fail; nothing here can pass
// on the name control's behalf.
//
// NOTHING in this file is a real credential. Every value is synthetic and
// generated here, and no assertion message ever prints a detected value or the
// envelope's marker -- a failure report that quotes the value merely relocates
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
const tmp = makeTempRepo('har-shape-fixture-');

// --- Synthetic values. Shaped like the real thing, generated here. ---

// Meta's client-side password envelope. Self-identifying: it announces what it
// is in its own first token, which is what makes it a shape at all.
const ENVELOPE = '#PWD_BROWSER:5:1767225600:U3ludGhldGljRml4dHVyZUNpcGhlcnRleHRGb3JUZXN0aW5nT25seU5vdEFSZWFsQ3JlZGVudGlhbEFBQUFBQQ';
// The same envelope format under a different product label. Instagram and
// Messenger ship `#PWD_INSTAGRAM_BROWSER` and `#PWD_MSGR`; the label is the
// product, not the format.
const ENVELOPE_INSTAGRAM = '#PWD_INSTAGRAM_BROWSER:10:1767225601:U3ludGhldGljU2Vjb25kRml4dHVyZUNpcGhlcnRleHRGb3JUZXN0T25seQ';
// A short ciphertext. #378 measured surviving envelopes at 120, 39 and ELEVEN
// characters, so a rule that demands a long tail misses two of the three it
// was written for.
const ENVELOPE_SHORT = '#PWD_BROWSER:0:1767225602:U2hvcnRDaXBo';

// A field name that is NOT in `secretFields` and never will be. Section 1
// proves the name control cannot see it; everything after that depends on it.
const BENIGN_FIELD = 'client_note';

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

function writeProfile() {
    const p = path.join(tmp, '.har-profile.json');
    fs.writeFileSync(p, JSON.stringify({ salt: 'test-salt', literals: {} }, null, 2));
    return p;
}

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

// A report must never carry the value OR its marker. Checked as a helper so
// every gate-output assertion in this file applies the same rule.
function assertReportIsQuiet(label, report, ...values) {
    for (const v of values) {
        assert.ok(!report.includes(v) && !report.includes(encodeURIComponent(v)),
            `${label}: the gate printed a detected value -- a report that quotes the ` +
            'credential relocates the leak into the log that reports it');
    }
    assert.ok(!report.includes('#PWD_'),
        `${label}: the gate printed the envelope marker, which names the credential format ` +
        'in the log even when the ciphertext is withheld');
}

// --- 1. THE ISOLATION. The name control is blind to the benign field. ------
// This section is the reason the rest of the file means anything. With both
// controls live the name control reports FIRST, so a shape test placed under
// `enc_password` passes for the wrong reason. Everything below uses
// `client_note`, and here is the proof that no name-based control can see it.
{
    assert.strictEqual(secrets.isKnownSecretField(BENIGN_FIELD), false,
        `1.a: '${BENIGN_FIELD}' is a known secret FIELD NAME, so every assertion in ` +
        'this file could pass on the name control and the shape rule would be untested');

    const named = [];
    secrets.walkForUnredactedSecrets(
        { entries: [{ [BENIGN_FIELD]: ENVELOPE }] }, (name) => named.push(name));
    assert.deepStrictEqual(named, [],
        '1.b: the key-name walk reported the envelope under a benign field name -- the ' +
        'isolation this file depends on is gone, and the shape rule is no longer observed');

    const defaults = policyModule.loadDefaultPolicy().secretFields.map((n) => n.toLowerCase());
    assert.ok(!defaults.includes(BENIGN_FIELD),
        `1.c: '${BENIGN_FIELD}' was added to secretFields, which silently converts every ` +
        'shape assertion below into a second test of the name control');
}

// --- 2. The shape control, standalone, catches the envelope. ---------------
// `findLeaks` is handed TEXT. It has no field, no key path, no HAR: there is
// no name for it to key on, so a finding here can only be the shape rule.
{
    const hits = shapes.findLeaks(`{"${BENIGN_FIELD}":"${ENVELOPE}"}`);
    assert.strictEqual(hits.length, 1,
        `2.a: the shape control found ${hits.length} things in a self-identifying password ` +
        'envelope; it is prefixed, colon-delimited and short, so no JWT / hex / bearer ' +
        'pattern reaches it and only a rule written for it can');
    assert.strictEqual(hits[0].kind, 'pwd-envelope', '2.b: the finding is not the envelope kind');
    assert.strictEqual(hits[0].class, 'secret',
        '2.c: a password envelope is a credential, not an identity -- an identity-class ' +
        'finding only advises, and this must fail the run');
    assert.strictEqual(hits[0].gating, true,
        '2.d: with no policy the strictest reading must apply, and this finding did not gate');
    assert.ok(!Object.values(hits[0]).includes(ENVELOPE),
        '2.e: the finding carries the matched value; findings carry a fingerprint, never the text');
}

// --- 3. The label is the product, not the format. -------------------------
// `#PWD_BROWSER` is Facebook web. Instagram and Messenger send the same
// envelope under their own labels, and a rule pinned to one product's spelling
// would miss its sibling on the very next capture.
{
    for (const [label, value] of [['instagram', ENVELOPE_INSTAGRAM], ['short ciphertext', ENVELOPE_SHORT]]) {
        const hits = shapes.findLeaks(`{"${BENIGN_FIELD}":"${value}"}`)
            .filter((l) => l.kind === 'pwd-envelope');
        assert.strictEqual(hits.length, 1,
            `3.a: the ${label} envelope was not recognised -- #378 measured surviving ` +
            'envelopes at 120, 39 and 11 ciphertext characters under more than one label');
    }
}

// --- 4. Precision. The prefix is conclusive; the neighbours are not. -------
// The argument for this rule is that no benign value begins with that token.
// That claim is only worth anything if the rule actually demands the whole
// structure -- label, version, timestamp, ciphertext -- rather than a `#` and
// some optimism.
{
    const NOT_ENVELOPES = [
        // A documentation anchor, which is the ordinary use of a `#` prefix.
        '#PWD_BROWSER',
        // The marker with no structure behind it.
        '#PWD_BROWSER:',
        // A URL fragment naming a page section.
        'https://example.invalid/docs#pwd-reset-flow',
        // A colon-delimited log line that merely mentions the subject.
        'INFO:auth:5:1767225600:password check ok',
        // A hash-prefixed CSS colour and an issue reference, both common in bodies.
        '#ff8800',
        '#395 comment about a password field',
        // Two numeric fields and a base64 tail, but no self-labelling prefix:
        // that is the whole evidence, and without it this is just punctuation.
        'PWD_BROWSER:5:1767225600:U3ludGhldGljVmFsdWVOb3RBbkVudmVsb3Bl',
    ];
    for (const value of NOT_ENVELOPES) {
        const hits = shapes.findLeaks(`{"note":${JSON.stringify(value)}}`)
            .filter((l) => l.kind === 'pwd-envelope');
        assert.strictEqual(hits.length, 0,
            '4.a: a benign value was reported as a password envelope; a rule that cries ' +
            'wolf is the failure mode that teaches an operator to ignore the gate ' +
            `(case index ${NOT_ENVELOPES.indexOf(value)}, value withheld)`);
    }
}

// --- 5. The kind is governable, and cannot be turned off. -----------------
// A pattern no policy class names can be neither tuned nor waived, and a
// secret that a consumer may lower to `advise` is a secret that ships.
{
    const policy = policyModule.loadDefaultPolicy();
    assert.strictEqual(policy.classes.secret['pwd-envelope'], 'gate',
        '5.a: the default policy does not declare `pwd-envelope` under classes.secret, so ' +
        'no consumer can tune it and no waiver can cover it');

    const dir = fs.mkdtempSync(path.join(tmp, 'lower-'));
    fs.writeFileSync(path.join(dir, policyModule.POLICY_FILENAME),
        JSON.stringify({ classes: { secret: { 'pwd-envelope': 'advise' } } }));
    assert.throws(() => policyModule.loadPolicy({ startDir: dir, stopAt: dir }),
        '5.b: a project lowered the envelope class to `advise`, which is `off` wearing a hat');
}

// --- 6. END TO END. The gate fails a capture the name control cannot see. --
// This is the falsifier the issue names: a synthetic capture carrying the
// envelope in a field with a benign name, which before the shape rule passed
// the gate as clean and earned the `(verified)` label #378 is about.
{
    const raw = writeHar('benign-named-envelope', makeHar(
        `${BENIGN_FIELD}=${encodeURIComponent(ENVELOPE)}&doc_id=1234567890`));
    const v = runNode(verify, ['--in', raw]);
    assert.notStrictEqual(v.code, 0,
        '6.a: verify-scrub reported a capture carrying a live password envelope as clean ' +
        'because the field holding it had a benign name -- the exact `(verified)` label ' +
        'that made #378 more than cosmetic');
    const report = `${v.stdout}${v.stderr}`;
    // Matched on the FINDING LINE, not anywhere in the output. The report
    // echoes the path of the file it verified, so a substring search over the
    // whole report passes as soon as the fixture directory happens to be named
    // after the rule -- which is how this assertion first passed while
    // `describeLeak` had been ablated to print nothing of the kind at all.
    assert.match(report, /^\s*- pwd-envelope \[secret\]/m,
        '6.b: the gate failed without naming WHICH control fired on the finding line, so ' +
        'an operator cannot tell a password envelope from any other finding');
    assertReportIsQuiet('6.c', report, ENVELOPE);
}

// --- 7. The scrubber's own output is not re-reported. ---------------------
// A gate that fires on the redaction it just made is a gate that can never
// report clean. The envelope under a KNOWN name is scrubbed by #378's control,
// and what replaces it must not be envelope-shaped.
{
    const harIn = writeHar('known-named-envelope', makeHar(
        `enc_password=${encodeURIComponent(ENVELOPE)}&doc_id=1234567890`));
    const harOut = path.join(tmp, 'known-named-envelope.scrubbed.har');
    const s = runNode(sanitize, ['--in', harIn, '--out', harOut,
        '--subs', path.join(tmp, 'known.subs.json'), '--profile', writeProfile(),
        '--fixed-time', '2026-01-01T00:00:00.000Z']);
    assert.strictEqual(s.code, 0, `7.a: sanitize-har failed: ${s.stderr || s.stdout}`);

    const text = fs.readFileSync(harOut, 'utf8');
    assert.ok(!text.includes(ENVELOPE) && !text.includes(encodeURIComponent(ENVELOPE)),
        '7.b: the envelope survived the scrub under a name the policy knows');
    assert.strictEqual(
        shapes.findLeaks(text).filter((l) => l.kind === 'pwd-envelope').length, 0,
        '7.c: the shape rule fired on the scrubbed output, so the scrubber and the gate ' +
        'disagree and no scrubbed file could ever pass');

    const v = runNode(verify, ['--in', harOut]);
    assert.strictEqual(v.code, 0,
        `7.d: verify-scrub flagged its own redaction of the envelope: ${v.stderr || v.stdout}`);
}

console.log('All har-pwd-envelope-shape tests passed');
