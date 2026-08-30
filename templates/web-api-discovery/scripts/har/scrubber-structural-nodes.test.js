#!/usr/bin/env node
// Behaviour tests for the scrubber's STRUCTURAL nodes (issue #297, scrubber stage).
// Zero-dep, runs with `node scrubber-structural-nodes.test.js`.
//
// The defect, measured on a real capture corpus: HAR stores the same datum in
// two places, and the scrubber covered exactly one side of each pair -- and not
// the same side each time. On four entries of one capture the SAME secret
// appeared twice: a redaction sentinel in `postData.text` and the live value in
// `postData.params[]`.
//
//   data       structured                        raw
//   cookies    request.cookies[]    scrubbed     Cookie header      LIVE
//   form body  postData.params[]    LIVE         postData.text      scrubbed
//   query      request.queryString[]  LIVE       --
//
// The invariant these tests pin: where HAR stores a value in two places, BOTH
// copies are redaction sentinels after a scrub, or neither is. The decision is
// a pure function of (name, value) and the merged policy, so the two spellings
// of one datum cannot disagree.
//
// No assertion message ever contains a secret value -- only node paths, names
// and counts. A test failure that quotes the value relocates the leak into CI.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeTempRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));
const harSecrets = require(path.join(__dirname, 'har-secrets.js'));

const scriptsDir = __dirname;
const sanitize = path.join(scriptsDir, 'sanitize-har.js');
const verify = path.join(scriptsDir, 'verify-scrub.js');

const tmp = makeTempRepo('scrubber-structural-nodes-');

// SYNTHETIC values. They are shaped like the real thing -- a CSRF token, a
// session cookie -- and are not real: nothing here was ever a credential.
const LSD = 'AVqSyntheticLsdToken01';
const JAZOEST = '22107';
const CSRF = 'SyntheticCsrfTok01';
const SESSIONID = '12345%3ASyntheticSession%3A17%3AAYdSyntheticTail';
// A comma inside a cookie value is what the `Cookie`-header scrub tripped on:
// its pair regex stopped at the comma, saw a 4-character token, and left the
// whole value in the clear -- while `request.cookies[]` scrubbed all of it.
const RUR_COOKIE = '"CLN,12345,1800000000:SyntheticRurTail"';
const APP_TOKEN = 'SyntheticAppIdToken77';

const SECRETS = { LSD, JAZOEST, CSRF, SESSIONID, RUR_COOKIE, APP_TOKEN };

function writeProfile(dir, salt) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '.har-profile.json');
    fs.writeFileSync(p, JSON.stringify({ salt, literals: {} }, null, 2));
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

// The redundancy fixture: every secret below appears in BOTH the structured
// node and the raw one, exactly as a recorder emits it.
function redundantHar() {
    const cookiePairs = [
        ['sessionid', SESSIONID],
        ['csrftoken', CSRF],
        ['rur', RUR_COOKIE],
    ];
    const cookieHeader = cookiePairs.map((pair) => pair[0] + '=' + pair[1]).join('; ');
    const formText = 'lsd=' + LSD + '&jazoest=' + JAZOEST + '&doc_id=1234567890';
    return {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z',
                time: 1,
                request: {
                    method: 'POST',
                    url: 'https://example.invalid/api/graphql/?lsd=' + LSD,
                    httpVersion: 'HTTP/1.1',
                    headers: [
                        { name: 'Cookie', value: cookieHeader },
                        { name: 'x-csrftoken', value: CSRF },
                        { name: 'x-ig-app-id', value: APP_TOKEN },
                        { name: 'content-type', value: 'application/x-www-form-urlencoded' },
                    ],
                    queryString: [{ name: 'lsd', value: LSD }],
                    cookies: cookiePairs.map((pair) => ({ name: pair[0], value: pair[1] })),
                    postData: {
                        mimeType: 'application/x-www-form-urlencoded',
                        text: formText,
                        params: [
                            { name: 'lsd', value: LSD },
                            { name: 'jazoest', value: JAZOEST },
                            { name: 'doc_id', value: '1234567890' },
                        ],
                    },
                    headersSize: -1, bodySize: formText.length,
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
                    headers: [
                        { name: 'set-cookie', value: 'csrftoken=' + CSRF + '; Path=/; Domain=.example.invalid; Secure' },
                    ],
                    cookies: [{ name: 'csrftoken', value: CSRF, path: '/', domain: '.example.invalid' }],
                    content: { size: 2, mimeType: 'application/json', text: '{}' },
                    redirectURL: '', headersSize: -1, bodySize: 2,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    };
}

function scrubFixture(label) {
    const inPath = path.join(tmp, label + '.har');
    const outPath = path.join(tmp, label + '.scrubbed.har');
    fs.writeFileSync(inPath, JSON.stringify(redundantHar(), null, 2));
    const s = runNode(sanitize, [
        '--in', inPath, '--out', outPath,
        '--subs', path.join(tmp, label + '.subs.json'),
        '--pii-subs', path.join(tmp, label + '.pii-subs.json'),
        '--profile', writeProfile(tmp, 'structural-salt'),
        '--fixed-time', '2026-01-01T00:00:00.000Z',
    ]);
    assert.strictEqual(s.code, 0, 'sanitize-har failed: ' + (s.stderr || s.stdout));
    const text = fs.readFileSync(outPath, 'utf8');
    return { outPath, text, har: JSON.parse(text) };
}

// A cookie header pair, by name, without ever returning anything a caller
// might print alongside the cookie's identity.
function headerCookieValue(headerValue, cookieName) {
    if (typeof headerValue !== 'string') return null;
    for (const segment of headerValue.split(';')) {
        const eq = segment.indexOf('=');
        if (eq < 0) continue;
        if (segment.slice(0, eq).trim().toLowerCase() === cookieName) return segment.slice(eq + 1).trim();
    }
    return null;
}

function pairValue(pairs, name) {
    const hit = (pairs || []).find((p) => p && String(p.name).toLowerCase() === name);
    return hit ? hit.value : null;
}

function headerValue(headers, name) {
    const hit = (headers || []).find((h) => h && String(h.name).toLowerCase() === name);
    return hit ? hit.value : null;
}

// "Is this a sentinel?" is the scrubber's own definition, shared with the
// gate -- not a second opinion invented here.
function isSentinel(value) {
    return harSecrets.isRedacted(value);
}

const first = scrubFixture('redundant');
const scrubbedText = first.text;
const entry = first.har.log.entries[0];
const req = entry.request;
const res = entry.response;

const failures = [];
function check(ok, message) {
    if (!ok) failures.push(message);
}

// --- 1. The critical pair: postData.text and postData.params[] agree. ---
{
    const paramLsd = pairValue(req.postData.params, 'lsd');
    const paramJazoest = pairValue(req.postData.params, 'jazoest');
    check(isSentinel(paramLsd), '1.a: request.postData.params[lsd] is not a redaction sentinel');
    check(isSentinel(paramJazoest), '1.b: request.postData.params[jazoest] is not a redaction sentinel');
    check(!req.postData.text.includes(LSD), '1.c: the lsd secret survives in request.postData.text');
    check(!req.postData.text.includes('jazoest=' + JAZOEST), '1.d: the jazoest secret survives in request.postData.text');
    // The point of the pair invariant: one sentinel and one live value is the
    // failure mode measured in the field, so assert the two copies MATCH rather
    // than merely that each is non-empty.
    const textLsd = /lsd=([^&]*)/.exec(req.postData.text);
    check(!!textLsd && textLsd[1] === paramLsd,
        '1.e: request.postData.text and request.postData.params[lsd] hold different values -- one copy escaped the scrub');
}

// --- 2. Query string is scrubbed by name, like the body it mirrors. ---
{
    check(isSentinel(pairValue(req.queryString, 'lsd')),
        '2.a: request.queryString[lsd] is not a redaction sentinel');
    check(!req.url.includes(LSD), '2.b: the lsd secret survives in request.url');
}

// --- 3. Cookie header and request.cookies[] agree, pair for pair. ---
{
    const header = headerValue(req.headers, 'cookie');
    for (const name of ['sessionid', 'csrftoken', 'rur']) {
        const structured = pairValue(req.cookies, name);
        const raw = headerCookieValue(header, name);
        check(isSentinel(structured), '3.a: request.cookies[' + name + '] is not a redaction sentinel');
        check(isSentinel(raw), '3.b: the ' + name + ' pair of the Cookie header is not a redaction sentinel');
        check(structured === raw,
            '3.c: request.cookies[' + name + '] and the Cookie header disagree -- one copy escaped the scrub');
    }
}

// --- 4. Set-Cookie header and response.cookies[] agree. ---
{
    const setCookie = headerValue(res.headers, 'set-cookie');
    const raw = headerCookieValue(setCookie, 'csrftoken');
    const structured = pairValue(res.cookies, 'csrftoken');
    check(isSentinel(structured), '4.a: response.cookies[csrftoken] is not a redaction sentinel');
    check(isSentinel(raw), '4.b: the csrftoken pair of the Set-Cookie header is not a redaction sentinel');
    check(structured === raw, '4.c: response.cookies[csrftoken] and the Set-Cookie header disagree');
    // Cookie ATTRIBUTES are not secrets and must survive: a scrubbed Path or
    // Domain makes the artifact useless as documentation of the protocol.
    check(/Path=\//.test(setCookie), '4.d: the Set-Cookie Path attribute was mangled by the scrub');
    check(/Domain=\.example\.invalid/.test(setCookie), '4.e: the Set-Cookie Domain attribute was mangled by the scrub');
}

// --- 5. Secret headers named by the policy are scrubbed. ---
{
    check(isSentinel(headerValue(req.headers, 'x-csrftoken')),
        '5.a: the x-csrftoken header is not a redaction sentinel');
    check(isSentinel(headerValue(req.headers, 'x-ig-app-id')),
        '5.b: a policy-named secret header is not a redaction sentinel');
}

// --- 6. Nothing that was secret is anywhere in the file, under any spelling. ---
{
    for (const label of Object.keys(SECRETS)) {
        check(!scrubbedText.includes(SECRETS[label]),
            '6: the ' + label + ' secret survives somewhere in the scrubbed document');
    }
}

// --- 7. Non-secret structure survives: the scrub documents a protocol. ---
{
    check(pairValue(req.postData.params, 'doc_id') === '1234567890',
        '7.a: a non-secret form parameter was redacted');
    check(req.postData.text.includes('doc_id=1234567890'),
        '7.b: a non-secret form parameter was redacted in postData.text');
}

// --- 8. The gate agrees the artifact is clean. ---
{
    const v = runNode(verify, ['--in', first.outPath]);
    check(v.code === 0, '8: verify-scrub rejected the scrubbed artifact:\n' + (v.stderr || v.stdout));
}

// --- 9. A project policy ADDING a secret field name reaches the scrubber. ---
// The scrubber built its field list from the DEFAULT policy at module load, so
// a name a project added was gated by the verifiers and never redacted. One
// merged policy, or the two definitions drift again.
{
    const projectDir = path.join(tmp, 'project-policy');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.har-policy.project.json'),
        JSON.stringify({ schemaVersion: 1, secretFields: ['x_project_token'] }, null, 2));

    const PROJECT_TOKEN = 'SyntheticProjectToken9';
    const har = redundantHar();
    const request = har.log.entries[0].request;
    request.postData.params.push({ name: 'x_project_token', value: PROJECT_TOKEN });
    request.postData.text += '&x_project_token=' + PROJECT_TOKEN;
    request.queryString.push({ name: 'x_project_token', value: PROJECT_TOKEN });

    const inPath = path.join(projectDir, 'project.har');
    const outPath = path.join(projectDir, 'project.scrubbed.har');
    fs.writeFileSync(inPath, JSON.stringify(har, null, 2));
    const s = runNode(sanitize, [
        '--in', inPath, '--out', outPath,
        '--subs', path.join(tmp, 'project.subs.json'),
        '--pii-subs', path.join(tmp, 'project.pii-subs.json'),
        '--profile', writeProfile(tmp, 'structural-salt'),
        '--fixed-time', '2026-01-01T00:00:00.000Z',
    ]);
    check(s.code === 0, '9.a: sanitize-har failed under a project policy: ' + (s.stderr || s.stdout));
    if (s.code === 0) {
        const out = fs.readFileSync(outPath, 'utf8');
        const parsed = JSON.parse(out);
        check(!out.includes(PROJECT_TOKEN),
            '9.b: a secret name the PROJECT policy added was never redacted by the scrubber');
        check(isSentinel(pairValue(parsed.log.entries[0].request.postData.params, 'x_project_token')),
            '9.c: a project-added secret name is live in request.postData.params[]');
    }
}

// --- 10. A LIVE secret that merely LOOKS redacted is still scrubbed. ---
// "Already redacted" must be decided by IDENTITY -- this run replaced this
// value -- and never by the surface shape of a value that arrived in the
// input. A shape test is a scrub bypass: any provider that masks its own
// values (`REDACTED_FOR_PRIVACY...`), any token wrapped in angle brackets, any
// field that is literally `***`, sails through under a secret field name. It
// is also the false-negative direction, which is the one that ships.
{
    const SENTINEL_SHAPED = 'REDACTED_SESSION_TOKEN_1234567890';
    const ANGLE_SHAPED = '<AVqSyntheticAngleToken0001>';
    assert.ok(harSecrets.isRedacted(SENTINEL_SHAPED) && harSecrets.isRedacted(ANGLE_SHAPED),
        '10.pre: the fixture values no longer look like redaction sentinels, so this test proves nothing');

    const cookieHeader = 'sessionid=' + SENTINEL_SHAPED + '; csrftoken=' + ANGLE_SHAPED;
    const formText = 'lsd=' + SENTINEL_SHAPED + '&fb_dtsg=' + ANGLE_SHAPED + '&doc_id=1234567890';
    const CRLF = String.fromCharCode(13, 10);
    const MULTIPART_BODY = [
        '------Boundary42',
        'Content-Disposition: form-data; name="lsd"',
        '',
        SENTINEL_SHAPED,
        '------Boundary42--',
        '',
    ].join(CRLF);
    const har = {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z',
                time: 1,
                request: {
                    method: 'POST',
                    url: 'https://example.invalid/api/graphql/?lsd=' + SENTINEL_SHAPED,
                    httpVersion: 'HTTP/1.1',
                    headers: [
                        { name: 'Cookie', value: cookieHeader },
                        { name: 'x-csrftoken', value: SENTINEL_SHAPED },
                    ],
                    queryString: [{ name: 'lsd', value: SENTINEL_SHAPED }],
                    cookies: [
                        { name: 'sessionid', value: SENTINEL_SHAPED },
                        { name: 'csrftoken', value: ANGLE_SHAPED },
                    ],
                    postData: {
                        mimeType: 'application/x-www-form-urlencoded',
                        text: formText,
                        params: [
                            { name: 'lsd', value: SENTINEL_SHAPED },
                            { name: 'fb_dtsg', value: ANGLE_SHAPED },
                            { name: 'doc_id', value: '1234567890' },
                        ],
                    },
                    headersSize: -1, bodySize: formText.length,
                    // A multipart body carries its field name in a header and
                    // its value on its own line, so no `name=value` pattern
                    // sees it -- the same sentinel-shape bypass lived there.
                    _multipart: MULTIPART_BODY,
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
                    headers: [{ name: 'set-cookie', value: 'sessionid=' + SENTINEL_SHAPED + '; Path=/' }],
                    cookies: [{ name: 'sessionid', value: SENTINEL_SHAPED }],
                    content: { size: 2, mimeType: 'application/json', text: '{}' },
                    redirectURL: '', headersSize: -1, bodySize: 2,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    };

    const inPath = path.join(tmp, 'sentinel-shaped.har');
    const outPath = path.join(tmp, 'sentinel-shaped.scrubbed.har');
    fs.writeFileSync(inPath, JSON.stringify(har, null, 2));
    const s = runNode(sanitize, [
        '--in', inPath, '--out', outPath,
        '--subs', path.join(tmp, 'sentinel-shaped.subs.json'),
        '--pii-subs', path.join(tmp, 'sentinel-shaped.pii-subs.json'),
        '--profile', writeProfile(tmp, 'structural-salt'),
        '--fixed-time', '2026-01-01T00:00:00.000Z',
    ]);
    check(s.code === 0, '10.a: sanitize-har failed: ' + (s.stderr || s.stdout));
    if (s.code === 0) {
        const out = fs.readFileSync(outPath, 'utf8');
        const parsed = JSON.parse(out);
        const r = parsed.log.entries[0].request;
        const p = parsed.log.entries[0].response;

        // Every node this scrubber covers, asserted by IDENTITY: the live value
        // is gone. `isSentinel` would pass here whether or not anything
        // happened, which is exactly how a shape test hides a bypass.
        const occurrences = [
            ['request.queryString[lsd]', pairValue(r.queryString, 'lsd')],
            ['request.postData.params[lsd]', pairValue(r.postData.params, 'lsd')],
            ['request.postData.params[fb_dtsg]', pairValue(r.postData.params, 'fb_dtsg')],
            ['request.cookies[sessionid]', pairValue(r.cookies, 'sessionid')],
            ['request.cookies[csrftoken]', pairValue(r.cookies, 'csrftoken')],
            ['the sessionid pair of the Cookie header', headerCookieValue(headerValue(r.headers, 'cookie'), 'sessionid')],
            ['the csrftoken pair of the Cookie header', headerCookieValue(headerValue(r.headers, 'cookie'), 'csrftoken')],
            ['the x-csrftoken header', headerValue(r.headers, 'x-csrftoken')],
            ['response.cookies[sessionid]', pairValue(p.cookies, 'sessionid')],
            ['the sessionid pair of the Set-Cookie header', headerCookieValue(headerValue(p.headers, 'set-cookie'), 'sessionid')],
        ];
        for (const occurrence of occurrences) {
            check(occurrence[1] !== SENTINEL_SHAPED && occurrence[1] !== ANGLE_SHAPED,
                '10.b: a LIVE secret shaped like a redaction sentinel survives at ' + occurrence[0]
                + ' -- the sentinel pre-check is a scrub bypass');
        }
        check(!/lsd=REDACTED_SESSION_TOKEN_1234567890/.test(r.postData.text),
            '10.c: a sentinel-shaped live secret survives in request.postData.text');
        check(!r._multipart.includes(SENTINEL_SHAPED),
            '10.d: a sentinel-shaped live secret survives in a multipart form field');
        check(!out.includes(SENTINEL_SHAPED),
            '10.e: a sentinel-shaped live secret survives somewhere in the scrubbed document');
        check(!out.includes(ANGLE_SHAPED),
            '10.f: an angle-bracketed live secret survives somewhere in the scrubbed document');
    }
}

// --- 11. A value THIS run produced is never substituted a second time. ---
// The property the shape test was protecting, kept -- by identity instead. A
// `Cookie` header is scrubbed pair by pair and then swept again as text, so
// without this the header's fake gets a second, different fake and the two
// spellings of one cookie stop agreeing (case 3.c).
{
    const table = JSON.parse(fs.readFileSync(path.join(tmp, 'redundant.subs.json'), 'utf8'));
    const outputs = new Set(Object.values(table));
    for (const key of Object.keys(table)) {
        // Keys are `kind:name:original` for named scrubs and `kind:original`
        // for shape scrubs. Only the key's ORIGINAL half is examined, and it is
        // never printed -- a message naming it would relocate the leak here.
        const parts = key.split(':');
        const original = (parts[0] === 'field' || parts[0] === 'cookie')
            ? parts.slice(2).join(':')
            : parts.slice(1).join(':');
        check(!outputs.has(original),
            '11: the substitution table has an entry whose ORIGINAL is a fake this run produced'
            + ' (kind ' + parts[0] + ') -- a replacement was fed back through the scrub');
    }
}

if (failures.length) {
    console.error('scrubber-structural-nodes: ' + failures.length + ' failure(s)');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}

console.log('All scrubber-structural-nodes tests passed');
