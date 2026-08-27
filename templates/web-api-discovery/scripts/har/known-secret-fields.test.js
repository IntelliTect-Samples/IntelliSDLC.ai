#!/usr/bin/env node
// Behavior tests for sanitize-har's known-secret-field scrubbing (issue #253).
// Zero-dep, runs with `node known-secret-fields.test.js`. Exits non-zero on
// first failure.
//
// The shape-based PATTERNS in sanitize-har.js (JWT / hex64 / hex32 / UUID /
// email) never match short, non-hex tokens such as CSRF-signing fields
// (`fb_dtsg`, `lsd`), short session cookies (`c_user`, `sb`, `mid`), or
// upload/session handle tokens returned in a response body
// (`{"h":"1:<b64>:<mime>:<token>:e:<expiry>:<sig>"}`). These need to be
// redacted by field identity / shape, not by generic pattern -- see the
// "Capturing traffic reliably" / Phase 8 secret-inventory guidance in
// `.github/skills/web-api-discovery/SKILL.md`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const scriptsDir = __dirname;
const sanitize = path.join(scriptsDir, 'sanitize-har.js');
const verify = path.join(scriptsDir, 'verify-scrub.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'known-secret-fields-'));

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

function makeHar({ cookie, headers = [], postText, responseText }) {
    const reqHeaders = [];
    if (cookie) reqHeaders.push({ name: 'Cookie', value: cookie });
    for (const h of headers) reqHeaders.push(h);

    return {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [
                {
                    startedDateTime: '2026-01-01T00:00:00.000Z',
                    time: 1,
                    request: {
                        method: 'POST', url: 'https://example.invalid/api', httpVersion: 'HTTP/1.1',
                        headers: reqHeaders, queryString: [], cookies: [], headersSize: -1,
                        bodySize: postText ? postText.length : 0,
                        ...(postText ? { postData: { mimeType: 'application/x-www-form-urlencoded', text: postText } } : {}),
                    },
                    response: {
                        status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                        content: { size: (responseText || '').length, mimeType: 'application/json', text: responseText || '{}' },
                        redirectURL: '', headersSize: -1, bodySize: (responseText || '').length,
                    },
                    cache: {}, timings: { send: 0, wait: 1, receive: 0 },
                },
            ],
        },
    };
}

function scrub(name, input) {
    const harIn = writeHar(`${name}.har`, input);
    const harOut = path.join(tmp, `${name}.scrubbed.har`);
    const subs = path.join(tmp, `${name}.subs.json`);
    const s = runNode(sanitize, ['--in', harIn, '--out', harOut, '--subs', subs, '--profile', writeProfile(tmp, 'test-salt'), '--fixed-time', '2026-01-01T00:00:00.000Z']);
    assert.strictEqual(s.code, 0, `${name}: sanitize-har failed: ${s.stderr || s.stdout}`);
    return fs.readFileSync(harOut, 'utf8');
}

// --- 1. Short session cookies (below the 16-char length heuristic) are redacted by name. ---
{
    const out = scrub('short-cookies', makeHar({ cookie: 'c_user=42; xs=abc123; sb=short; mid=Y1234' }));
    assert.ok(!out.includes('c_user=42'), '1.a: c_user leaked despite being a known secret cookie');
    assert.ok(!out.includes('xs=abc123'), '1.b: xs leaked despite being a known secret cookie');
    assert.ok(!out.includes('sb=short'), '1.c: sb leaked despite being a known secret cookie');
    assert.ok(!out.includes('mid=Y1234'), '1.d: mid leaked despite being a known secret cookie');
    // Separators between pairs must survive redaction.
    assert.ok(/c_user=redacted-\S+; xs=redacted-\S+; sb=redacted-\S+; mid=redacted-\S+/.test(out),
        `1.e: cookie separators were not preserved across redaction:\n${out}`);
}

// --- 2. Form-encoded CSRF-signing fields are redacted by name, unrelated fields untouched. ---
{
    const out = scrub('form-fields', makeHar({
        postText: 'fb_dtsg=AQABtoken&lsd=AVshort&jazoest=25123&some_other_field=keep-me',
    }));
    assert.ok(!out.includes('AQABtoken'), '2.a: fb_dtsg value leaked');
    assert.ok(!out.includes('AVshort'), '2.b: lsd value leaked');
    assert.ok(!out.includes('25123'), '2.c: jazoest value leaked');
    assert.ok(out.includes('keep-me'), '2.d: unrelated form field was incorrectly redacted');
}

// --- 3. Known secret headers are redacted regardless of shape. ---
{
    const out = scrub('secret-headers', makeHar({
        headers: [
            { name: 'x-fb-lsd', value: 'shortval' },
            { name: 'x-asbd-id', value: '129477' },
        ],
    }));
    assert.ok(!out.includes('shortval'), '3.a: x-fb-lsd value leaked');
    assert.ok(!out.includes('"value": "129477"'), '3.b: x-asbd-id value leaked');
}

// --- 4. Upload/session handle tokens in a response body are redacted. ---
{
    const HANDLE = '1:abcXYZhandleValue:video/mp4:tok1234567:e:1999999999:sigABCDEFG';
    const out = scrub('upload-handle', makeHar({
        responseText: JSON.stringify({ h: HANDLE }),
    }));
    assert.ok(!out.includes(HANDLE), `4: upload handle token leaked verbatim:\n${out}`);

    const v = runNode(verify, ['--in', path.join(tmp, 'upload-handle.scrubbed.har')]);
    assert.strictEqual(v.code, 0, `4.b: verify-scrub flagged the redacted upload handle: ${v.stderr || v.stdout}`);
}

// --- 5. verify-scrub accepts a HAR scrubbed via the known-field path as clean. ---
{
    const v = runNode(verify, ['--in', path.join(tmp, 'short-cookies.scrubbed.har')]);
    assert.strictEqual(v.code, 0, `5: verify-scrub flagged known-secret-field output as leaky:\n${v.stderr || v.stdout}`);
}

console.log('All known-secret-fields tests passed');
