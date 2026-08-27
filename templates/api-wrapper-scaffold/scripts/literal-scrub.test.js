#!/usr/bin/env node
// End-to-end behavior tests for the two-control scrub (issue #255, Part B).
//
// Control 1 -- key-name scrubbing, extended to reach INSIDE a percent-encoded
// JSON parameter. Control 2 -- literal-value scrubbing over the identifiers
// the operator knows they are exposing, supplied by the gitignored
// `.har-profile.json` and never defaulted.
//
// Also covers B.3 (placeholders are not credentials) and the retirement of
// `--salt` in favour of the profile.
//
// Zero-dep, runs with `node literal-scrub.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const scriptsDir = __dirname;
const sanitize = path.join(scriptsDir, 'sanitize-har.js');
const verify = path.join(scriptsDir, 'verify-scrub.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'literal-scrub-'));

const ACCOUNT_ID = '100000123456789';
const DISPLAY_NAME = 'Ada Lovelace';

function runNode(script, args, cwd) {
    try {
        const out = execFileSync(process.execPath, [script, ...args], {
            encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
    }
}

function makeProject(name, opts) {
    const literals = opts && 'literals' in opts ? opts.literals : undefined;
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, 'samples', 'har-original'), { recursive: true });
    if (literals !== null) {
        const map = literals || { [ACCOUNT_ID]: '<AccountId>', [DISPLAY_NAME]: '<DisplayName>' };
        fs.writeFileSync(
            path.join(dir, '.har-profile.json'),
            JSON.stringify({ salt: 'test-salt', literals: map }, null, 2));
    }
    return dir;
}

function writeHar(dir, entryOverrides) {
    const p = path.join(dir, 'samples', 'har-original', 'capture.har');
    const har = {
        log: {
            version: '1.2', creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z', time: 1,
                request: Object.assign({
                    method: 'POST', url: 'https://example.invalid/api', httpVersion: 'HTTP/1.1',
                    headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
                }, entryOverrides.request),
                response: Object.assign({
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                    content: { size: 0, mimeType: 'application/json', text: '{}' },
                    redirectURL: '', headersSize: -1, bodySize: 0,
                }, entryOverrides.response),
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    };
    fs.writeFileSync(p, JSON.stringify(har, null, 2));
    return p;
}

function scrubbedPath(dir) {
    return path.join(dir, 'samples', 'har', 'capture.har');
}

// --- 1. A secret nested inside a percent-encoded JSON parameter is redacted. ---
// The wire body is percent-encoded, so no flat pattern matches it, and `lsd`
// never appears in the form's own parameter list -- only a decoded walk finds it.
{
    const dir = makeProject('nested-json');
    const variables = JSON.stringify({ actor_id: '1', session: { lsd: 'AVnestedSecret' } });
    const harIn = writeHar(dir, {
        request: {
            postData: {
                mimeType: 'application/x-www-form-urlencoded',
                text: 'doc_id=123&variables=' + encodeURIComponent(variables),
            },
        },
    });
    const r = runNode(sanitize, ['--in', harIn], dir);
    assert.strictEqual(r.code, 0, '1.a: sanitize failed: ' + r.stderr);

    const out = fs.readFileSync(scrubbedPath(dir), 'utf8');
    assert.ok(!out.includes('AVnestedSecret'), '1.b: nested lsd leaked verbatim:\n' + out);
    assert.ok(!out.includes(encodeURIComponent('AVnestedSecret')), '1.c: nested lsd leaked percent-encoded');
    assert.ok(out.includes('doc_id=123'), '1.d: an unrelated parameter was damaged');
}

// --- 2. The literal pass covers URL, headers, request body and response body. ---
{
    const dir = makeProject('literals');
    const harIn = writeHar(dir, {
        request: {
            url: 'https://example.invalid/p?id=' + ACCOUNT_ID,
            headers: [{ name: 'x-actor', value: ACCOUNT_ID }],
            postData: {
                mimeType: 'application/x-www-form-urlencoded',
                text: 'target_id=' + ACCOUNT_ID + '&name=' + encodeURIComponent(DISPLAY_NAME),
            },
        },
        response: {
            content: {
                size: 1, mimeType: 'application/json',
                text: JSON.stringify({ default_actor: { id: ACCOUNT_ID }, name: DISPLAY_NAME }),
            },
        },
    });
    const r = runNode(sanitize, ['--in', harIn], dir);
    assert.strictEqual(r.code, 0, '2.a: sanitize failed: ' + r.stderr);

    const out = fs.readFileSync(scrubbedPath(dir), 'utf8');
    assert.ok(!out.includes(ACCOUNT_ID), '2.b: the account id survived -- three names, one value:\n' + out);
    assert.ok(!out.includes(DISPLAY_NAME) && !out.includes(encodeURIComponent(DISPLAY_NAME)),
        '2.c: the display name survived');
    // The account id reaches the literal pass and becomes its sentinel. A
    // display name may not: the typed-PII pass recognizes person names and
    // swaps in a format-preserving fake first. Either way the identifier is
    // gone -- which is what 2.b and 2.c assert -- but only the value no
    // earlier control claimed carries the sentinel.
    assert.ok(out.includes('<AccountId>'), '2.d: the account id sentinel is missing');
}

// --- 3. No profile is a hard failure that names the file. `--salt` is gone. ---
{
    const dir = makeProject('no-profile', { literals: null });
    const harIn = writeHar(dir, {});
    const r = runNode(sanitize, ['--in', harIn, '--profile', path.join(dir, 'nope.json')], dir);
    assert.notStrictEqual(r.code, 0, '3.a: sanitize succeeded without a profile');
    assert.ok(/har-profile\.json|nope\.json/.test(r.stderr),
        '3.b: failure did not name the profile:\n' + r.stderr);

    const usage = runNode(sanitize, [], dir);
    assert.ok(!/--salt/.test(usage.stderr), '3.c: --salt is still advertised:\n' + usage.stderr);
    assert.ok(/--profile/.test(usage.stderr), '3.d: usage does not mention --profile');
}

// --- 4. Output paths derive from the documented samples/ convention. ---
{
    const dir = makeProject('derived-paths');
    const harIn = writeHar(dir, {});
    const r = runNode(sanitize, ['--in', harIn], dir);
    assert.strictEqual(r.code, 0, '4.a: sanitize failed: ' + r.stderr);
    assert.ok(fs.existsSync(scrubbedPath(dir)), '4.b: scrubbed HAR not written to samples/har/');
    assert.ok(fs.existsSync(path.join(dir, 'samples', 'har', '.har-substitutions.json')),
        '4.c: substitution map not written beside the output');
}

// --- 5. verify-scrub fails on a forbidden literal WITHOUT echoing it. ---
{
    const dir = makeProject('forbidden');
    const leaky = path.join(dir, 'leaky.har');
    fs.writeFileSync(leaky, JSON.stringify({ log: { entries: [{ note: 'owner ' + ACCOUNT_ID }] } }));

    const r = runNode(verify, ['--in', leaky], dir);
    assert.notStrictEqual(r.code, 0, '5.a: verify-scrub passed a HAR containing a forbidden literal');
    const all = r.stderr + r.stdout;
    assert.ok(!all.includes(ACCOUNT_ID),
        '5.b: verify-scrub echoed the literal into its own output:\n' + all);
    assert.ok(all.includes('<AccountId>'), '5.c: verify-scrub did not name the sentinel that was violated');
}

// --- 6. Placeholders and counters are not flagged (B.3). ---
{
    const dir = makeProject('placeholders');
    const clean = path.join(dir, 'clean.har');
    fs.writeFileSync(clean, JSON.stringify({
        log: { entries: [{ body: '{"client_mutation_id":"1","actor_id":"0","count":12}' }] },
    }));
    const r = runNode(verify, ['--in', clean], dir);
    assert.strictEqual(r.code, 0, '6: placeholder values were flagged as leaks:\n' + r.stderr);
}

// --- 7. verify-scrub accepts a HAR the new sanitize path produced. ---
{
    const dir = path.join(tmp, 'literals');
    const r = runNode(verify, ['--in', scrubbedPath(dir)], dir);
    assert.strictEqual(r.code, 0, '7: verify-scrub flagged its own scrubber output:\n' + r.stderr);
}

// --- 8. PII that is percent-encoded in a URL is scrubbed too. ---
// Detection finds the value in the decoded queryString entry, but the URL
// carries the same value percent-encoded. Replacing only the raw spelling
// leaves the encoded copy readable -- the same "one value, several
// spellings" failure the literal pass exists to close.
{
    const dir = makeProject('encoded-pii', { literals: {} });
    const phone = '+14155551234';
    const harIn = writeHar(dir, {
        request: {
            method: 'GET',
            url: 'https://example.invalid/u?phone=' + encodeURIComponent(phone),
            queryString: [{ name: 'phone', value: phone }],
        },
    });
    const r = runNode(sanitize, ['--in', harIn], dir);
    assert.strictEqual(r.code, 0, '8.a: sanitize failed: ' + r.stderr);

    const out = fs.readFileSync(scrubbedPath(dir), 'utf8');
    assert.ok(!out.includes(encodeURIComponent(phone)),
        '8.b: the percent-encoded phone survived in the URL:\n' + out);

    const v = runNode(verify, ['--in', scrubbedPath(dir)], dir);
    assert.strictEqual(v.code, 0, '8.c: verify-scrub still sees a leak:\n' + v.stderr);
}

// --- 9. A large body scrubs in linear time, and still gives up its secrets. ---
// Media and GraphQL captures routinely carry bodies in the hundreds of KB.
// An unbounded `[chars]+@` local part backtracks quadratically over a long
// non-matching run, which turns a 200 KB body into a 30-second scan and a
// real capture into an unusable one.
{
    const dir = makeProject('large-body', { literals: {} });
    const filler = 'x'.repeat(200000);
    const body = JSON.stringify({ blob: filler, contact: 'owner@example.com' });
    const harIn = writeHar(dir, {
        request: {
            bodySize: body.length,
            postData: { mimeType: 'application/json', text: body },
        },
    });

    const started = Date.now();
    const r = runNode(sanitize, ['--in', harIn], dir);
    const elapsedMs = Date.now() - started;

    assert.strictEqual(r.code, 0, '9.a: sanitize failed: ' + r.stderr);
    assert.ok(elapsedMs < 30000,
        '9.b: scrubbing a 200 KB body took ' + elapsedMs + 'ms -- that is quadratic, not linear');

    const out = fs.readFileSync(scrubbedPath(dir), 'utf8');
    assert.ok(!out.includes('owner@example.com'),
        '9.c: the email buried in a large body was not scrubbed');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All literal-scrub tests passed');
