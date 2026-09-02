#!/usr/bin/env node
// Behavior tests for value-aware secret checks and policy-sourced names
// (issue #297, Stage 4).
//
// Zero-dep, runs with `node har-secrets-value.test.js`. Exits non-zero on
// first failure.
//
// The defect: `REDACTION_PREFIXES = ['redacted-', '<']` tested with a
// case-sensitive `startsWith`, so a value of literally `REDACTED` -- the most
// obvious spelling of "already handled" there is -- was reported as a live
// credential. A gate that reports its own redactions is the noise that
// destroys its authority, which is how the three real leaks survived a run
// that produced 1134 findings.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const secrets = require(path.join(__dirname, 'har-secrets.js'));
const policyModule = require(path.join(__dirname, 'har-policy.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-secrets-value-'));

function loadPolicy(project) {
    const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
    if (project) {
        fs.writeFileSync(path.join(dir, policyModule.POLICY_FILENAME), JSON.stringify(project));
    }
    return policyModule.loadPolicy({ startDir: dir, stopAt: dir });
}

// A live-looking value under a known secret name: long enough to clear the
// plausible-secret floor and not shaped like any sentinel.
const LIVE = 'AbCdEfGhIjKl012345';

// --- 1. Sentinels are recognised however they are spelled. ---
{
    const sentinels = [
        'REDACTED', 'redacted', 'Redacted', 'ReDaCtEd',
        '<Redacted>', '<AccountId>', '<DisplayName>',
        'redacted-abc123', 'REDACTED-ABC123', 'Redacted-Abc123',
    ];
    for (const value of sentinels) {
        assert.strictEqual(secrets.isRedacted(value), true,
            `1.a: ${JSON.stringify(value)} was not recognised as a redaction sentinel -- ` +
            `a gate that reports its own redactions trains its readers to ignore it`);
        assert.strictEqual(secrets.isUnredactedSecret('fb_dtsg', value), false,
            `1.b: ${JSON.stringify(value)} under a known secret name was reported as a live credential`);
    }
}

// --- 2. A live value under the same name still reports. ---
// The point of loosening the sentinel test is to remove noise, not to open a
// hole: anything that is not recognisably a redaction is still a finding.
{
    assert.strictEqual(secrets.isUnredactedSecret('fb_dtsg', LIVE), true,
        '2.a: a live credential under a known secret name stopped being reported');
    assert.strictEqual(secrets.isRedacted(LIVE), false, '2.b');

    // Values that merely CONTAIN a sentinel word are not redactions.
    for (const value of ['not-redacted-at-all-x9', 'myredacted-token-value']) {
        assert.strictEqual(secrets.isRedacted(value), false,
            `2.c: ${JSON.stringify(value)} was treated as a redaction because it contains the word`);
    }
}

// --- 3. Short values stay exempt. ---
// A verifier that flags `client_mutation_id: "1"` trains its readers to ignore
// it, and an ignored gate is worse than no gate.
{
    assert.strictEqual(secrets.isUnredactedSecret('fb_dtsg', '1'), false, '3.a');
    assert.strictEqual(secrets.isUnredactedSecret('c_user', '0'), false, '3.b');
}

// --- 4. The default names still match the historical list, exactly. ---
// Stage 1 lifted these into har-policy.default.json and Stage 4 makes that
// file the source. The list below is written out longhand ON PURPOSE: pinning
// the lift against either module would compare a value to itself once both
// derive from the same file, and the whole risk of the lift is that it
// silently narrows the scrub.
{
    const HISTORICAL_FIELDS = [
        'fb_dtsg', 'lsd', 'jazoest',
        '__spin_r', '__spin_b', '__spin_t', '__hs', '__hsi', '__csr', '__hsdp', '__req', '__rev',
        'c_user', 'xs', 'datr', 'fr', 'sb', 'mid', 'ig_did', 'ds_user_id',
        'sessionid', 'csrftoken',
    ];
    // ADDED with the auth-flow stage (issue #378). Until then every capture
    // the pipeline had seen was of an already-authenticated session, so the
    // list named only post-login state and a capture of a LOGIN sailed through
    // the gate with its password envelope intact, labelled `(verified)`.
    // Enumerated here, longhand, for the same reason as the names above: this
    // count is the tripwire that makes any change to the list deliberate and
    // visible in a diff.
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
    const HISTORICAL_HEADERS = [
        'x-fb-lsd', 'x-asbd-id', 'x-ig-app-id', 'x-instagram-rupload-params',
        // ADDED with the scrubber's structural-node stage (issue #297). The
        // corpus measurement found a live `x-csrftoken` in a "scrubbed"
        // artifact: the CSRF token's cookie spelling was on the field list and
        // its header spelling was on neither, so the header was gated by
        // nothing and redacted by nothing.
        'x-csrftoken',
    ];
    for (const name of [...HISTORICAL_FIELDS, ...AUTH_FLOW_FIELDS]) {
        assert.strictEqual(secrets.isKnownSecretField(name), true,
            `4.a: secret field '${name}' stopped being recognised after the lift`);
    }
    for (const name of HISTORICAL_HEADERS) {
        assert.strictEqual(secrets.isKnownSecretHeader(name), true,
            `4.b: secret header '${name}' stopped being recognised after the lift`);
    }
    assert.strictEqual(secrets.KNOWN_SECRET_FIELD_NAMES.size,
        HISTORICAL_FIELDS.length + AUTH_FLOW_FIELDS.length,
        '4.c: the default secret-field list changed size; if that is intended, update this test');
    assert.strictEqual(secrets.KNOWN_SECRET_HEADER_NAMES.size, HISTORICAL_HEADERS.length,
        '4.d: the default secret-header list changed size; if that is intended, update this test');
}

// --- 5. A project policy adds and subtracts names. ---
{
    const policy = loadPolicy({
        secretFields: ['x-my-app-token'],
        notSecretFields: ['x-asbd-id'],
    });

    assert.strictEqual(secrets.isKnownSecretField('x-my-app-token', policy), true,
        '5.a: a name the project declared secret was not recognised');
    assert.strictEqual(secrets.isUnredactedSecret('x-my-app-token', LIVE, policy), true,
        '5.b: a project-declared secret name did not gate a live value');

    assert.strictEqual(secrets.isKnownSecretHeader('x-asbd-id', policy), false,
        '5.c: a header the project vetoed is still treated as a secret');
    assert.strictEqual(secrets.isUnredactedSecret('x-asbd-id', LIVE, policy), false,
        '5.d: a vetoed header still reported');

    // Defaults survive the override -- appending, not replacing.
    assert.strictEqual(secrets.isKnownSecretField('fb_dtsg', policy), true,
        '5.e: a project policy replaced the default secret names instead of appending');
}

// --- 6. No policy means the defaults, unchanged. ---
// Every caller that has not been wired to the policy yet keeps exactly today's
// behaviour, so this stage cannot weaken a gate by omission.
{
    assert.strictEqual(secrets.isKnownSecretField('fb_dtsg'), true, '6.a');
    assert.strictEqual(secrets.isKnownSecretField('x-my-app-token'), false,
        '6.b: a name no default declares was treated as secret with no policy loaded');
}

// --- 7. The walk honours the policy and the sentinel test. ---
{
    const policy = loadPolicy({ secretFields: ['x-my-app-token'] });
    const har = {
        log: {
            entries: [{
                request: {
                    headers: [
                        { name: 'x-my-app-token', value: LIVE },
                        { name: 'fb_dtsg', value: 'REDACTED' },
                        { name: 'x-fb-lsd', value: LIVE },
                    ],
                },
            }],
        },
    };

    const withPolicy = [];
    secrets.walkForUnredactedSecrets(har, (name) => withPolicy.push(name), { policy });
    assert.ok(withPolicy.includes('x-my-app-token'),
        '7.a: the walk did not apply the project policy');
    assert.ok(withPolicy.includes('x-fb-lsd'), '7.b: the walk lost a default secret header');
    assert.ok(!withPolicy.includes('fb_dtsg'),
        '7.c: the walk reported a value of REDACTED as a live credential');

    // Called the old way -- two positional arguments -- it still works.
    const legacy = [];
    secrets.walkForUnredactedSecrets(har, (name) => legacy.push(name));
    assert.ok(legacy.includes('x-fb-lsd') && !legacy.includes('fb_dtsg'),
        '7.d: the two-argument call shape used by both verifiers broke');
    assert.ok(!legacy.includes('x-my-app-token'),
        '7.e: a project-only name was matched with no policy passed');
}

// --- 8. No report ever carries the value. ---
{
    const har = { log: { entries: [{ request: { headers: [{ name: 'fb_dtsg', value: LIVE }] } }] } };
    const messages = [];
    secrets.walkForUnredactedSecrets(har, (name, where) => messages.push(`${name} ${where}`));
    assert.ok(messages.length > 0, '8.a: nothing was reported to check');
    for (const m of messages) {
        assert.ok(!m.includes(LIVE), '8.b: a report carried the credential value');
    }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All har-secrets-value tests passed');
