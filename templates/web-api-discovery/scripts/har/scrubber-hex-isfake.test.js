#!/usr/bin/env node
// Behavior tests for sanitize-har / verify-scrub hex-fake marker (issue #85).
// Zero-dep, runs with `node scrubber-hex-isfake.test.js`. Exits non-zero on first failure.
//
// Before this fix: sanitize-har emits a hex64 fake that is itself a valid
// hex64 string with no distinguishing marker, and verify-scrub flags every
// hex64 as a leak. The pair is unsatisfiable for hex64-bearing inputs.
//
// After this fix: hex64 fakes are prefixed with a deterministic sentinel
// (`f00ded`) and hex32 fakes with `deaf00`, so verify-scrub can tell a
// fake from a real source value.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeTempRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));

const scriptsDir = __dirname;
const sanitize = path.join(scriptsDir, 'sanitize-har.js');
const verify = path.join(scriptsDir, 'verify-scrub.js');

// The scrub refuses a substitution-table destination git will not confirm
// is ignored (issue #318), so the fixture root is a real repository
// configured the way a consumer's is.
const tmp = makeTempRepo('scrubber-hex-isfake-');

// The salt and the literal map now live in the operator's gitignored
// `.har-profile.json` (issue #255); `--salt` was retired so that one profile
// serves every HAR script instead of four separate flags.
function writeProfile(dir, salt, literals) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '.har-profile.json');
    fs.writeFileSync(p, JSON.stringify({ salt, literals: literals || {} }, null, 2));
    return p;
}


function writeHar(name, content) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, JSON.stringify(content, null, 2));
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

function makeHar(payloadString) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [
                {
                    startedDateTime: '2026-01-01T00:00:00.000Z',
                    time: 1,
                    request: { method: 'GET', url: 'https://example.invalid/api', httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
                    response: {
                        status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                        content: { size: payloadString.length, mimeType: 'application/json', text: payloadString },
                        redirectURL: '', headersSize: -1, bodySize: payloadString.length,
                    },
                    cache: {}, timings: { send: 0, wait: 1, receive: 0 },
                },
            ],
        },
    };
}

// --- 1. Source HAR containing an uppercase hex64 string passes verify-scrub after sanitize. ---
{
    // Uppercase to mirror Google Voice device-ID hashes that exposed the bug.
    const SRC_HEX64 = '44D9BBD00F0D42B4993055A5E83B35EEF1CEC3C5B9244406E0EABC848B456D4C';
    const harIn = writeHar('with-hex64.har', makeHar(`{"deviceId":"${SRC_HEX64}"}`));
    const harOut = path.join(tmp, 'with-hex64.scrubbed.har');
    const subs = path.join(tmp, 'with-hex64.subs.json');

    const s = runNode(sanitize, ['--in', harIn, '--out', harOut, '--subs', subs, '--profile', writeProfile(tmp, 'test-salt'), '--fixed-time', '2026-01-01T00:00:00.000Z']);
    assert.strictEqual(s.code, 0, `sanitize-har failed: ${s.stderr || s.stdout}`);

    const scrubbed = fs.readFileSync(harOut, 'utf8');
    // The original uppercase hex64 must not appear verbatim.
    assert.ok(!scrubbed.includes(SRC_HEX64), '1.a: source hex64 leaked into scrubbed output');

    // verify-scrub must accept the scrubbed file as clean.
    const v = runNode(verify, ['--in', harOut]);
    assert.strictEqual(v.code, 0, `1.b: verify-scrub flagged the sanitize-har output as leaky:\n${v.stderr || v.stdout}`);
}

// --- 2. Source HAR containing an uppercase hex32 string also passes round-trip. ---
{
    const SRC_HEX32 = 'A1B2C3D4E5F6789012345678ABCDEF01';
    const harIn = writeHar('with-hex32.har', makeHar(`{"token":"${SRC_HEX32}"}`));
    const harOut = path.join(tmp, 'with-hex32.scrubbed.har');
    const subs = path.join(tmp, 'with-hex32.subs.json');

    const s = runNode(sanitize, ['--in', harIn, '--out', harOut, '--subs', subs, '--profile', writeProfile(tmp, 'test-salt'), '--fixed-time', '2026-01-01T00:00:00.000Z']);
    assert.strictEqual(s.code, 0, `2.a: sanitize-har failed: ${s.stderr || s.stdout}`);

    const scrubbed = fs.readFileSync(harOut, 'utf8');
    assert.ok(!scrubbed.includes(SRC_HEX32), '2.b: source hex32 leaked into scrubbed output');

    const v = runNode(verify, ['--in', harOut]);
    assert.strictEqual(v.code, 0, `2.c: verify-scrub flagged hex32 sanitize-har output as leaky:\n${v.stderr || v.stdout}`);
}

// --- 3. A real (non-fake) hex64 injected directly into a "scrubbed" file is still caught. ---
{
    // This guards against regressing the leak detector itself: even with the
    // sentinel-prefix change, an UPPERCASE hex64 (i.e. a real source value
    // that bypassed sanitize-har) must still be reported by verify-scrub.
    const REAL_HEX64 = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
    const harOut = writeHar('manually-bad.har', makeHar(`{"deviceId":"${REAL_HEX64}"}`));

    const v = runNode(verify, ['--in', harOut]);
    assert.strictEqual(v.code, 3, `3: verify-scrub failed to flag a real (non-prefixed) hex64 as a leak`);
    assert.ok(/hex64/.test(v.stderr), `3: expected hex64 leak in stderr: ${v.stderr}`);
}

// --- 4. Sentinel is deterministic: same input + same salt -> same fake. ---
{
    const SRC = 'F00DCAFE00000000F00DCAFE00000000F00DCAFE00000000F00DCAFE00000000';
    const har1 = writeHar('det-1.har', makeHar(`{"k":"${SRC}"}`));
    const har2 = writeHar('det-2.har', makeHar(`{"k":"${SRC}"}`));
    const out1 = path.join(tmp, 'det-1.scrubbed.har');
    const out2 = path.join(tmp, 'det-2.scrubbed.har');
    const subs1 = path.join(tmp, 'det-1.subs.json');
    const subs2 = path.join(tmp, 'det-2.subs.json');

    runNode(sanitize, ['--in', har1, '--out', out1, '--subs', subs1, '--profile', writeProfile(tmp, 'salt-A'), '--fixed-time', '2026-01-01T00:00:00.000Z']);
    runNode(sanitize, ['--in', har2, '--out', out2, '--subs', subs2, '--profile', writeProfile(tmp, 'salt-A'), '--fixed-time', '2026-01-01T00:00:00.000Z']);

    const s1 = fs.readFileSync(out1, 'utf8');
    const s2 = fs.readFileSync(out2, 'utf8');
    assert.strictEqual(s1, s2, '4: scrubbed outputs differ for identical input + identical salt');
}

console.log('All scrubber-hex-isfake tests passed');
