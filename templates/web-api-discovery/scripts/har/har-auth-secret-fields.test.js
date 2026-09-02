#!/usr/bin/env node
// Behavior tests for auth-flow secret field names (issue #378).
//
// Zero-dep, runs with `node har-auth-secret-fields.test.js`. Exits non-zero on
// the first failure.
//
// The defect this pins: every capture the pipeline had ever seen was of an
// ALREADY-AUTHENTICATED session, so `har-policy.default.json`'s `secretFields`
// carried only post-login session state (`fb_dtsg`, `c_user`, `xs`, ...). A
// capture of a LOGIN is a new input class, and none of the three controls
// could see the credential in it:
//
//   * the key-name control had no `password` / `enc_password` /
//     `sensitive_string_value` / `verificationCode` entry;
//   * the shape control sees a prefixed, colon-delimited ~120-character
//     envelope -- not a JWT, not long hex, not bearer-shaped;
//   * the literal control covers the operator's own identifiers, not their
//     password.
//
// So the scrub ran, redacted everything it knew about, and the gate reported
// `(verified)` over an output still carrying a credential-bearing value. The
// "verified" label is what makes this more than cosmetic: it is the operator's
// licence to commit the file.
//
// NOTHING in this file is a real credential. Every value below is synthetic,
// and no assertion message ever prints a detected value -- a failure report
// that quotes the offending value merely relocates the leak into the log.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const secrets = require(path.join(__dirname, 'har-secrets.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));
const { makeTempRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));

const scriptsDir = __dirname;
const sanitize = path.join(scriptsDir, 'sanitize-har.js');
const verify = path.join(scriptsDir, 'verify-scrub.js');

// The scrub refuses a substitution-table destination git will not confirm is
// ignored (issue #318), so the fixture root is a real repository configured
// the way a consumer's is.
const tmp = makeTempRepo('har-auth-secret-fields-');

function writeProfile(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '.har-profile.json');
    fs.writeFileSync(p, JSON.stringify({ salt: 'test-salt', literals: {} }, null, 2));
    return p;
}

function runNode(script, args) {
    try {
        const out = execFileSync(process.execPath, [script, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
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

function makeHar({ postText, mimeType = 'application/x-www-form-urlencoded' }) {
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
                        postData: { mimeType, text: postText },
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

function scrub(name, input) {
    const harIn = writeHar(name, input);
    const harOut = path.join(tmp, `${name}.scrubbed.har`);
    const subs = path.join(tmp, `${name}.subs.json`);
    const s = runNode(sanitize, ['--in', harIn, '--out', harOut, '--subs', subs,
        '--profile', writeProfile(tmp), '--fixed-time', '2026-01-01T00:00:00.000Z']);
    assert.strictEqual(s.code, 0, `${name}: sanitize-har failed: ${s.stderr || s.stdout}`);
    return { text: fs.readFileSync(harOut, 'utf8'), input: harIn, output: harOut };
}

// --- Synthetic values. Shaped like the real thing, generated here. ---

// Meta's client-side password envelope: `#PWD_BROWSER:<v>:<unix>:<base64>`.
// Prefixed, colon-delimited and only ~120 base64 characters, so no shape
// pattern matches it -- which is exactly why it survived byte-identical.
const ENVELOPE = '#PWD_BROWSER:5:1767225600:U3ludGhldGljRml4dHVyZUNpcGhlcnRleHRGb3JUZXN0aW5nT25seU5vdEFSZWFsQ3JlZGVudGlhbEFBQUFBQQ';
// Contains characters that percent-encode, so the wire body is a form-encoded
// string the gate has to decode before it can see the field name at all.
const PLAINTEXT_PASSWORD = 'synthetic fixture passphrase 9137!';
const OTP_CODE = '481902';
const ATTEMPT_STATE = 'QXR0ZW1wdFN0YXRlU3ludGhldGljRml4dHVyZVZhbHVlTm90UmVhbA';

// --- 1. The policy names the auth-flow fields. -----------------------------
// Written out longhand on purpose: reading the list back out of the module
// under test would compare a value to itself, and the whole risk here is that
// the list silently fails to name the class of field this issue is about.
{
    const AUTH_FLOW_FIELDS = [
        'password', 'passwd', 'enc_password', 'encpass',
        'old_password', 'new_password', 'current_password', 'confirm_password',
        'sensitive_string_value',
        'verificationCode', 'approvals_code', 'two_factor_identifier',
        'encryptedContext', 'remember_token',
        'otp', 'otp_code', 'totp', 'mfa_code', 'one_time_code', 'security_code',
        'client_secret', 'refresh_token', 'access_token', 'id_token',
        'auth_token', 'api_key', 'apikey',
    ];
    const defaults = policyModule.loadDefaultPolicy().secretFields.map((n) => n.toLowerCase());
    for (const name of AUTH_FLOW_FIELDS) {
        assert.ok(defaults.includes(name.toLowerCase()),
            `1.a: '${name}' is not a secretField -- a login capture's credential ` +
            `travels under it and no shape pattern matches it`);
        assert.strictEqual(secrets.isKnownSecretField(name), true,
            `1.b: isKnownSecretField('${name}') is false, so neither the scrubber ` +
            `nor the gate would act on it`);
    }
}

// --- 2. Matching is case-insensitive and EXACT, never a substring. ---------
// `password_reset_url` is a link, not a credential; redacting it would be the
// noise that trains an operator to ignore the gate.
{
    for (const spelling of ['VerificationCode', 'VERIFICATIONCODE', 'EncryptedContext', 'PASSWORD']) {
        assert.strictEqual(secrets.isKnownSecretField(spelling), true,
            `2.a: '${spelling}' was not recognised -- the wire spelling of a field name ` +
            `is the provider's choice, not ours`);
    }
    for (const benign of ['password_reset_url', 'passwordless', 'has_password', 'passwordPolicy']) {
        assert.strictEqual(secrets.isKnownSecretField(benign), false,
            `2.b: '${benign}' was treated as a secret name by substring, not exact match`);
    }
}

// --- 3. The gate REPORTS a live password envelope. -------------------------
// This is the reported defect: verify-scrub said `(verified)` over an output
// that still contained one.
{
    const found = [];
    secrets.walkForUnredactedSecrets(
        { entries: [{ enc_password: { sensitive_string_value: ENVELOPE } }] },
        (name) => found.push(name));
    assert.ok(found.includes('sensitive_string_value'),
        '3.a: the walk did not report a live password envelope under ' +
        "`sensitive_string_value` -- the provider's own name for the field");

    const plain = [];
    secrets.walkForUnredactedSecrets(
        { entries: [{ username: 'someone', password: PLAINTEXT_PASSWORD }] },
        (name) => plain.push(name));
    assert.ok(plain.includes('password'),
        '3.b: a PLAINTEXT password was not reported -- the sharper case, since ' +
        'that value is directly replayable as a credential');
}

// --- 4. The scrubber removes the envelope from a nested encoded body. ------
// The field is `input.enc_password.sensitive_string_value`, nested inside a
// percent-encoded `variables` JSON blob, which is where the flat key-name
// passes cannot see it.
{
    const variables = JSON.stringify({
        input: {
            enc_password: { sensitive_string_value: ENVELOPE },
            client_mutation_id: '1',
        },
    });
    const body = 'fb_api_req_friendly_name=useCDSWebLoginMutation'
        + `&variables=${encodeURIComponent(variables)}`
        + '&doc_id=1234567890';
    const { text, output } = scrub('meta-login', makeHar({ postText: body }));

    assert.ok(!text.includes(encodeURIComponent(ENVELOPE)),
        '4.a: the password envelope survived the scrub inside the encoded `variables` blob');
    assert.ok(!text.includes(ENVELOPE),
        '4.b: the password envelope survived the scrub in its raw spelling');
    assert.ok(text.includes('doc_id=1234567890'),
        '4.c: an unrelated form field was destroyed by the redaction');

    const v = runNode(verify, ['--in', output]);
    assert.strictEqual(v.code, 0,
        `4.d: verify-scrub flagged its own redaction of the envelope: ${v.stderr || v.stdout}`);
}

// --- 5. The gate FAILS on the raw capture. --------------------------------
// A gate that passes the unscrubbed input is the `(verified)` label the issue
// is actually about.
{
    const raw = writeHar('meta-login-raw', makeHar({
        postText: `variables=${encodeURIComponent(JSON.stringify({
            input: { enc_password: { sensitive_string_value: ENVELOPE } },
        }))}`,
    }));
    const v = runNode(verify, ['--in', raw]);
    assert.notStrictEqual(v.code, 0,
        '5.a: verify-scrub reported a capture carrying a live password envelope as clean');
    const report = `${v.stdout}${v.stderr}`;
    assert.ok(report.includes('sensitive_string_value'),
        '5.b: the gate failed without naming the field that carries the credential');
    assert.ok(!report.includes(ENVELOPE) && !report.includes('#PWD_BROWSER'),
        '5.c: the gate printed the detected value -- a report that quotes the ' +
        'credential relocates the leak into the log');
}

// --- 6. A plaintext login body is scrubbed. -------------------------------
// The sharper case: a provider that sends the password with no envelope at
// all, where the same gap leaks a directly reusable credential.
{
    const body = `username=fixture-user&password=${encodeURIComponent(PLAINTEXT_PASSWORD)}&remember=true`;
    const { text, output, input } = scrub('plaintext-login', makeHar({ postText: body }));
    assert.ok(!text.includes(PLAINTEXT_PASSWORD) && !text.includes(encodeURIComponent(PLAINTEXT_PASSWORD)),
        '6.a: a plaintext password survived the scrub');
    assert.ok(text.includes('remember=true'),
        '6.b: an unrelated form field was destroyed by the redaction');

    const v = runNode(verify, ['--in', output]);
    assert.strictEqual(v.code, 0,
        `6.c: verify-scrub flagged its own redaction of a plaintext password: ${v.stderr || v.stdout}`);

    // The gate must fail on the RAW body too. A form body is ONE string of
    // `k=v&k=v`, so `password` is a parameter name and not an object key --
    // the walk has to split the body to see it at all, exactly as the
    // scrubber does. Gate reporting less than the scrubber redacts is how a
    // file gets labelled `(verified)` over a credential.
    const raw = runNode(verify, ['--in', input]);
    assert.notStrictEqual(raw.code, 0,
        '6.d: verify-scrub reported a raw form body carrying a plaintext password as clean');
    const rawReport = `${raw.stdout}${raw.stderr}`;
    assert.ok(rawReport.includes('password'),
        '6.e: the gate failed without naming the field that carries the credential');
    assert.ok(!rawReport.includes(PLAINTEXT_PASSWORD)
        && !rawReport.includes(encodeURIComponent(PLAINTEXT_PASSWORD)),
        '6.f: the gate printed the detected value -- a report that quotes the ' +
        'credential relocates the leak into the log');
}

// --- 7. Second-factor material is covered too. ----------------------------
// An MFA code and the attempt-state tokens that travel with it are single-use
// but replayable inside their window, and they are the other half of what a
// login capture contains.
{
    const { text } = scrub('two-factor', makeHar({
        postText: `verificationCode=${OTP_CODE}`
            + `&two_factor_identifier=${ATTEMPT_STATE}`
            + `&encryptedContext=${ATTEMPT_STATE}`
            + '&keep_me=visible',
    }));
    assert.ok(!text.includes(`verificationCode=${OTP_CODE}`),
        '7.a: an MFA verification code survived the scrub');
    assert.ok(!text.includes(ATTEMPT_STATE),
        '7.b: 2FA attempt-state material survived the scrub');
    assert.ok(text.includes('keep_me=visible'),
        '7.c: an unrelated form field was destroyed by the redaction');
}

console.log('All har-auth-secret-fields tests passed');
