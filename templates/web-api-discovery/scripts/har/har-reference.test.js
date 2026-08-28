#!/usr/bin/env node
// Behavior tests for the HAR reference catalogue tooling (issue #255, Part A).
//
// A capture is the only thing in a repo that is ground truth about someone
// else's API. Keeping one is worth doing properly: the extractor produces a
// reference that can be diffed against a fresh capture, and the verifier is
// the CI gate that says the committed reference is still safe and still
// complete.
//
// Both scripts exist because the manual version of each shipped a defect:
// a reference whose request bodies had been truncated to nothing (and so
// proved nothing), and a commit message claiming "all keys preserved" that
// was false for that same file. Hence: request bodies are NEVER truncated,
// and the reference is verified by PARSING it, not by trusting the report of
// the step that produced it.
//
// Zero-dep, runs with `node har-reference.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const scriptsDir = __dirname;
const extract = path.join(scriptsDir, 'extract-har-reference.js');
const verifyRef = path.join(scriptsDir, 'verify-har-reference.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-reference-'));

const ACCOUNT_ID = '100000123456789';

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

function makeProject(name) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'reference-test-salt',
        literals: { [ACCOUNT_ID]: '<AccountId>' },
    }, null, 2));
    return dir;
}

function entry(overrides) {
    const req = Object.assign({
        method: 'POST', url: 'https://example.invalid/api', httpVersion: 'HTTP/1.1',
        headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0,
    }, overrides.request);
    const res = Object.assign({
        status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
        content: { size: 2, mimeType: 'application/json', text: '{}' },
        redirectURL: '', headersSize: -1, bodySize: 2,
    }, overrides.response);
    return {
        startedDateTime: '2026-08-26T00:00:00.000Z', time: 1,
        request: req, response: res, cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    };
}

function writeRaw(dir, entries) {
    const p = path.join(dir, 'raw.har');
    fs.writeFileSync(p, JSON.stringify({
        log: { version: '1.2', creator: { name: 'test', version: '1' }, entries },
    }, null, 2));
    return p;
}

// A request body long enough that any cap would visibly bite.
const LONG_FIELD_VALUE = 'x'.repeat(200000);
const LONG_BODY = 'doc_id=9&variables=' + encodeURIComponent(JSON.stringify({
    payload: LONG_FIELD_VALUE, actor_id: '1',
}));
const LONG_RESPONSE = JSON.stringify({ blob: 'y'.repeat(200000) });

// --- 1. A selector is mandatory; there is no "extract everything" default. ---
{
    const dir = makeProject('no-selector');
    const raw = writeRaw(dir, [entry({})]);
    const r = runNode(extract, ['--in', raw, '--provider', 'acme', '--action', 'ping'], dir);
    assert.strictEqual(r.code, 2, '1.a: extracting without a selector should be a usage error');
    assert.ok(/--match/.test(r.stderr), '1.b: the failure does not name the missing selector');
}

// --- 2. Zero matches fails loudly instead of writing an empty reference. ---
{
    const dir = makeProject('no-match');
    const raw = writeRaw(dir, [entry({})]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--match', 'never-appears-anywhere', '--out', out], dir);
    assert.strictEqual(r.code, 3, '2.a: zero matches should exit 3');
    assert.ok(!fs.existsSync(out), '2.b: an empty reference was written -- it would look authoritative and prove nothing');
}

// --- 3. The selector matches on URL or on body. ---
{
    const dir = makeProject('selects');
    const raw = writeRaw(dir, [
        entry({ request: { url: 'https://example.invalid/keep/me' } }),
        entry({ request: { url: 'https://example.invalid/other' } }),
        entry({
            request: {
                url: 'https://example.invalid/other',
                postData: { mimeType: 'application/x-www-form-urlencoded', text: 'op=keepme' },
            },
        }),
    ]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--match', 'keep.?me', '--out', out], dir);
    assert.strictEqual(r.code, 0, '3.a: extraction failed: ' + r.stderr);

    const ref = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(ref.log.entries.length, 2, '3.b: expected the URL match and the body match, got ' + ref.log.entries.length);
}

// --- 4. Request bodies are NEVER truncated; response bodies are capped. ---
{
    const dir = makeProject('truncation');
    const raw = writeRaw(dir, [entry({
        request: {
            url: 'https://example.invalid/graphql',
            bodySize: LONG_BODY.length,
            postData: { mimeType: 'application/x-www-form-urlencoded', text: LONG_BODY },
        },
        response: {
            content: { size: LONG_RESPONSE.length, mimeType: 'application/json', text: LONG_RESPONSE },
            bodySize: LONG_RESPONSE.length,
        },
    })]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--match', 'graphql', '--out', out, '--max-response-bytes', '1024'], dir);
    assert.strictEqual(r.code, 0, '4.a: extraction failed: ' + r.stderr);

    const ref = JSON.parse(fs.readFileSync(out, 'utf8'));
    const e = ref.log.entries[0];
    assert.ok(e.request.postData.text.includes(LONG_FIELD_VALUE.slice(0, 1000)),
        '4.b: the request body was truncated -- a reference that cannot be replayed proves nothing');
    assert.ok(!('truncated' in e.request.postData),
        '4.c: a request body carries a truncation marker; requests are never capped');
    assert.ok(e.response.content.text.length <= 1024,
        '4.d: the response body was not capped, got ' + e.response.content.text.length);
    assert.ok(e.response.content.truncated && e.response.content.truncated.originalBytes === LONG_RESPONSE.length,
        '4.e: the capped response does not record what was dropped');
}

// --- 5. Decoded postData.params[] make an encoded body greppable by field name. ---
{
    const dir = makeProject('decoded-params');
    const body = 'doc_id=9&variables=' + encodeURIComponent(JSON.stringify({ actor_role: 'owner' }));
    const raw = writeRaw(dir, [entry({
        request: {
            url: 'https://example.invalid/graphql',
            bodySize: body.length,
            postData: { mimeType: 'application/x-www-form-urlencoded', text: body },
        },
    })]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--match', 'graphql', '--out', out], dir);
    assert.strictEqual(r.code, 0, '5.a: extraction failed: ' + r.stderr);

    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes('actor_role'),
        '5.b: the reference is not greppable for a nested field name -- decoded params were not emitted');

    const params = JSON.parse(text).log.entries[0].request.postData.params;
    assert.ok(Array.isArray(params), '5.c: postData.params[] missing');
    assert.deepStrictEqual(params.map((p) => p.name), ['doc_id', 'variables'], '5.d: params do not mirror the body');
    assert.ok(params[1].value.includes('"actor_role"'), '5.e: the params value was not decoded');
}

// --- 6. The default output path carries provider AND action AND date. ---
// The directory is invisible the moment the file is opened in an editor tab,
// attached to an issue, or pasted into a diff -- so the filename repeats it.
{
    const dir = makeProject('default-path');
    const raw = writeRaw(dir, [entry({ request: { url: 'https://example.invalid/login' } })]);
    const r = runNode(extract, ['--in', raw, '--match', 'login', '--provider', 'acme', '--action', 'login-flow-2fa'], dir);
    assert.strictEqual(r.code, 0, '6.a: extraction failed: ' + r.stderr);

    const refDir = path.join(dir, 'acme');
    const files = fs.readdirSync(refDir).filter((f) => f.endsWith('.har'));
    assert.strictEqual(files.length, 1, '6.b: expected exactly one reference file, got ' + files.length);
    assert.ok(/^acme-login-flow-2fa-\d{4}-\d{2}-\d{2}\.har$/.test(files[0]),
        '6.c: filename does not follow <provider>-<action>-<yyyy-MM-dd>.har: ' + files[0]);
    assert.ok(r.stdout.includes('catalogue'),
        '6.d: the extractor does not remind the operator to add the catalogue row naming what they did');
}

// --- 7. The verifier passes a reference the extractor just produced. ---
{
    const dir = path.join(tmp, 'default-path');
    const r = runNode(verifyRef, [], dir);
    assert.strictEqual(r.code, 0, '7.a: the verifier rejected a freshly extracted reference:\n' + r.stderr);
    assert.ok(r.stdout.includes(dir), '7.b: the verifier did not default to the current directory');
}

// --- 7b. The walk skips the raw captures and the dependency tree. ---
{
    // The verifier walks the current directory by default, and .har-captures/
    // sits right there holding the UNSCRUBBED capture. Walking into it reports
    // the raw's secrets as violations of the reference -- gating the one file
    // that is deliberately never committed, and burying the real findings.
    // node_modules is excluded for size rather than secrecy.
    const dir = path.join(tmp, 'default-path');
    const raw = { log: { entries: [entry({
        request: {
            url: 'https://example.invalid/login',
            headers: [{ name: 'authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl' }]
        }
    })] } };
    for (const sub of [path.join('.har-captures', 'example.invalid', '2026-01-01-120000'),
                       path.join('node_modules', 'something')]) {
        const d = path.join(dir, sub);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'raw.har'), JSON.stringify(raw));
    }

    const r = runNode(verifyRef, [], dir);
    assert.strictEqual(r.code, 0,
        '7b.a: the verifier walked into .har-captures/ or node_modules:\n' + r.stderr);
    assert.ok(!/har-captures|node_modules/.test(r.stderr + r.stdout),
        '7b.b: the excluded directories must not appear in the report at all');
}

// --- 8. Gate: a truncated request body. ---
{
    const dir = makeProject('gate-truncated');
    const refDir = path.join(dir, 'acme');
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, 'acme-x-2026-08-26.har'), JSON.stringify({
        log: {
            entries: [entry({
                request: {
                    bodySize: 5000,
                    postData: {
                        mimeType: 'application/json', text: '{"a":',
                        truncated: { originalBytes: 5000 },
                    },
                },
            })],
        },
    }));
    const r = runNode(verifyRef, [], dir);
    assert.strictEqual(r.code, 3, '8.a: a truncated request body was accepted');
    assert.ok(/truncat/i.test(r.stderr), '8.b: the failure does not name truncation:\n' + r.stderr);
}

// --- 9. Gate: an unredacted credential header. ---
{
    const dir = makeProject('gate-credential');
    const refDir = path.join(dir, 'acme');
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, 'acme-x-2026-08-26.har'), JSON.stringify({
        log: { entries: [entry({ request: { headers: [{ name: 'x-fb-lsd', value: 'AVliveToken' }] } })] },
    }));
    const r = runNode(verifyRef, [], dir);
    assert.strictEqual(r.code, 3, '9.a: an unredacted credential header was accepted');
    assert.ok(r.stderr.includes('x-fb-lsd'), '9.b: the failure does not name the offending header');
    assert.ok(!r.stderr.includes('AVliveToken'), '9.c: the failure echoed the credential value');
}

// --- 10. Gate: a secret nested inside a JSON-valued parameter. ---
{
    const dir = makeProject('gate-nested');
    const refDir = path.join(dir, 'acme');
    fs.mkdirSync(refDir, { recursive: true });
    const nested = encodeURIComponent(JSON.stringify({ lsd: 'AVnestedLive' }));
    fs.writeFileSync(path.join(refDir, 'acme-x-2026-08-26.har'), JSON.stringify({
        log: {
            entries: [entry({
                request: {
                    postData: {
                        mimeType: 'application/x-www-form-urlencoded',
                        text: 'variables=' + nested,
                        params: [{ name: 'variables', value: nested }],
                    },
                },
            })],
        },
    }));
    const r = runNode(verifyRef, [], dir);
    assert.strictEqual(r.code, 3, '10.a: a secret nested in a JSON-valued parameter was accepted');
    assert.ok(!r.stderr.includes('AVnestedLive'), '10.b: the failure echoed the nested secret');
}

// --- 11. Gate: a forbidden literal, named by sentinel and never echoed. ---
{
    const dir = makeProject('gate-literal');
    const refDir = path.join(dir, 'acme');
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, 'acme-x-2026-08-26.har'), JSON.stringify({
        log: { entries: [entry({ request: { url: 'https://example.invalid/u/' + ACCOUNT_ID } })] },
    }));
    const r = runNode(verifyRef, [], dir);
    assert.strictEqual(r.code, 3, '11.a: a forbidden literal was accepted');
    assert.ok(r.stderr.includes('<AccountId>'), '11.b: the failure does not name the violated sentinel');
    assert.ok(!r.stderr.includes(ACCOUNT_ID), '11.c: the failure echoed the literal into the CI log');
}

// --- 12. An empty reference directory is reported, not silently passed. ---
{
    const dir = makeProject('gate-empty');
    const r = runNode(verifyRef, [], dir);
    assert.notStrictEqual(r.code, 0, '12: a missing reference directory should not report success');
}

// --- 13. Gate: a shape-detected secret with no known name and no literal. ---
// The four name/literal gates only catch what somebody named or declared. A
// per-session bearer token or a third party's email in a response body is
// neither, and a committed reference is exactly where such a value would sit
// unnoticed. The reference gate must be at least as strong as the gate on the
// scrubbed HAR it came from.
{
    const dir = makeProject('gate-shapes');
    const refDir = path.join(dir, 'acme');
    fs.mkdirSync(refDir, { recursive: true });
    const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsaXZlLXVzZXIifQ.s1gnatureV4lueHere_x';
    fs.writeFileSync(path.join(refDir, 'acme-x-2026-08-26.har'), JSON.stringify({
        log: { entries: [entry({ response: { content: { size: 1, mimeType: 'application/json',
            text: JSON.stringify({ token: JWT, notify: 'someone@thirdparty.example' }) } } })] },
    }));
    const r = runNode(verifyRef, [], dir);
    assert.strictEqual(r.code, 3, '13.a: a raw JWT in a committed reference was accepted');
    assert.ok(!r.stderr.includes(JWT), '13.b: the failure echoed the token');
    assert.ok(/jwt/i.test(r.stderr), '13.c: the failure does not name what kind of leak it found');
}

// --- 14. The extractor refuses to write a reference it knows still leaks. ---
// Its own post-processing can REVEAL a literal: decoding a parameter to emit
// `postData.params[]` peels one layer of encoding off, so a value the scrub
// could not see becomes visible in the file being written. Reporting that on
// stdout and exiting 0 is not a gate -- an automated caller reads the exit
// code, sees success, and commits the reference.
{
    const dir = makeProject('extract-leaks');
    const NAME = 'Ada Lovelace';
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'reference-test-salt',
        literals: { [NAME]: '<DisplayName>' },
    }, null, 2));

    // Encoded three times: deeper than the spellings the scrub pass covers, so
    // it survives sanitize-har untouched. Decoding it once to emit
    // postData.params[] brings it back within reach of the check.
    const buried = encodeURIComponent(encodeURIComponent(encodeURIComponent(NAME)));
    const body = 'doc_id=9&payload=' + buried;
    const raw = writeRaw(dir, [entry({
        request: {
            url: 'https://example.invalid/graphql',
            bodySize: body.length,
            postData: { mimeType: 'application/x-www-form-urlencoded', text: body },
        },
    })]);
    const out = path.join(dir, 'ref.har');

    const r = runNode(extract, ['--in', raw, '--match', 'graphql', '--out', out], dir);
    assert.strictEqual(r.code, 3, '14.a: an unscrubbed literal should fail the extraction, got ' + r.code);
    assert.ok(!fs.existsSync(out), '14.b: a reference known to carry a literal was written anyway');
    assert.ok(r.stderr.includes('<DisplayName>'), '14.c: the failure does not name the violated sentinel');
    assert.ok(!r.stderr.includes(NAME), '14.d: the failure echoed the literal');
}

// --- 15. A literal containing JSON-escapable characters is still scrubbed. ---
// The literal pass runs over the SERIALIZED document, where a quote is `\"`
// and a non-ASCII character may be `\uXXXX`. Matching only the raw spelling
// silently misses every literal that contains one -- and names, the most
// common literal after an id, routinely do.
{
    const dir = makeProject('escaped-literal');
    const NAME = 'Ada "Countess" Lovelace';
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'reference-test-salt',
        literals: { [NAME]: '<DisplayName>' },
    }, null, 2));

    const raw = writeRaw(dir, [entry({
        request: { url: 'https://example.invalid/graphql' },
        response: {
            content: { size: 60, mimeType: 'application/json', text: JSON.stringify({ owner: NAME }) },
        },
    })]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--match', 'graphql', '--out', out], dir);
    assert.strictEqual(r.code, 0, '15.a: extraction failed: ' + r.stderr);

    const written = fs.readFileSync(out, 'utf8');
    assert.ok(!written.includes('Countess'),
        '15.b: a literal containing a quote survived the serialized-document pass:\n' + written);
}

// --- 16. Gate: a shape secret hidden inside a percent-encoded parameter. ---
// The scrubbed-HAR gate scans a percent-decoded view of the file. The
// reference gate must too, or the file that actually ships is checked more
// weakly than the intermediate it came from.
{
    const dir = makeProject('gate-encoded-shape');
    const refDir = path.join(dir, 'acme');
    fs.mkdirSync(refDir, { recursive: true });
    const nested = encodeURIComponent(JSON.stringify({ notify: 'someone@thirdparty.example' }));
    fs.writeFileSync(path.join(refDir, 'acme-x-2026-08-26.har'), JSON.stringify({
        log: {
            entries: [entry({
                request: {
                    postData: { mimeType: 'application/x-www-form-urlencoded', text: 'variables=' + nested },
                },
            })],
        },
    }));
    const r = runNode(verifyRef, [], dir);
    assert.strictEqual(r.code, 3, '16.a: a percent-encoded email in a reference was accepted');
    assert.ok(!r.stderr.includes('thirdparty'), '16.b: the failure echoed the address');
}

// --- 17. No exit path strands the unscrubbed staging directory. ---
// The temp working directory holds the SELECTED, UNSCRUBBED entries, written
// before the scrub runs. The failure paths after that point are exactly the
// ones most likely to leave real credentials in the OS temp directory -- and
// they are hard to provoke from outside, so the invariant is checked two
// ways: a real run leaves nothing behind, and no exit between creating the
// directory and discarding it skips the cleanup.
{
    const dir = makeProject('cleanup');
    const countStaging = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('har-reference-')).length;
    const before = countStaging();

    const raw = writeRaw(dir, [entry({ request: { url: 'https://example.invalid/graphql' } })]);
    const r = runNode(extract, ['--in', raw, '--match', 'graphql', '--out', path.join(dir, 'ref.har')], dir);
    assert.strictEqual(r.code, 0, '17.a: extraction failed: ' + r.stderr);
    assert.strictEqual(countStaging(), before, '17.b: a successful run left its staging directory behind');

    // The window runs from creating the staging directory to the point it is
    // discarded on the success path. `failAndDiscard`'s own definition sits
    // inside it, so exclude the one bare `fail(` it legitimately contains.
    const source = fs.readFileSync(extract, 'utf8');
    const from = source.indexOf('const work = fs.mkdtempSync');
    const to = source.indexOf('const serialized = JSON.stringify');
    // Without this, a rename on either side would leave indexOf returning -1,
    // the slice would degenerate, and the assertion below would pass while
    // checking nothing -- the exact failure mode a static test invites.
    assert.ok(from >= 0 && to > from,
        '17.c: the staging window anchors no longer match the source; this check has stopped checking anything');
    const guarded = source.slice(from, to);
    assert.ok(/uncaughtException/.test(guarded),
        '17.d: nothing catches a throw between creating and discarding the staging directory');
    const definitionBody = guarded.slice(
        guarded.indexOf('const failAndDiscard'), guarded.indexOf('};', guarded.indexOf('const failAndDiscard')));
    const bareFails = (guarded.replace(definitionBody, '').match(/(?<!AndDiscard)\bfail\(/g) || []);
    assert.deepStrictEqual(bareFails, [],
        '17.c: an exit path between creating and discarding the staging directory calls bare fail(), '
        + 'which strands the unscrubbed entries in the temp directory');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All har-reference tests passed');
