#!/usr/bin/env node
// Behavior tests for issue #529 -- the typed-PII reach pass rewriting digits
// it was never asked to touch, including the scrubber's OWN sentinels.
//
// Zero-dep, runs with `node scrub-coordinate-reach.test.js`. Exits non-zero on
// the first failure.
//
// WHAT THIS PINS.
//
// A coordinate is detected only as a NUMBER at a `geo-lat` / `geo-lng` field,
// and `replaceInJson` replaces it by FIELD NAME alone -- it says so itself:
// "a number has no string form to enrol". The replacement index enrolled one
// anyway, so every string in the document was scanned for the TEXT of each
// coordinate. A map payload carrying small integer coordinates therefore
// enrolled needles like `5`, `-1` and `48`, each replaced by `0` wherever it
// occurred: in URLs, in hashes, and inside the `redacted-<hex>` sentinel the
// scrub had just written. A mangled sentinel no longer matches the gate's
// `SENTINEL_RE`, so the gate reported the scrubber's own redaction as an
// unredacted secret and quarantined a clean capture.
//
// THE ORACLE IS THE REAL GATE. Asserting `text.includes('redacted-')` would
// pass for a scrub that never redacted the token at all, and would say nothing
// about whether the capture is accepted. So the assertions run
// `verify-scrub.js` and read its exit code, and separately compare the
// surviving URL text against the input.
//
// WHY INTEGER COORDINATES. With ordinary float coordinates (`47.6205`) the
// needles are long enough that they match nothing else, and every assertion
// here passes on the broken code. The defect needs a coordinate whose decimal
// spelling occurs incidentally in other text, which is what a bounding box or
// a whole-degree marker produces.
//
// NOTHING here is a real credential. The access token is synthetic.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { makeTempRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));
const secrets = require(path.join(__dirname, 'har-secrets.js'));

const sanitize = path.join(__dirname, 'sanitize-har.js');
const verify = path.join(__dirname, 'verify-scrub.js');

// The scrub refuses a substitution-table destination git will not confirm is
// ignored (#318), so the fixture root is a real repository.
const tmp = makeTempRepo('scrub-coordinate-reach-');
const profilePath = path.join(tmp, '.har-profile.json');
fs.writeFileSync(profilePath, JSON.stringify({ salt: 'coordinate-reach-salt', literals: {} }, null, 2));

// A synthetic map-tile client token, generated here. Its NAME is what gets it
// redacted; the value carries no shape the scrub needs to recognise.
const ACCESS_TOKEN = 'pk.eyJ1IjoidGVzdGZpeHR1cmUiLCJhIjoiY2oxMjM0NTY3ODkwIn0.QWxpY2VBbmRCb2I';
const TILE_URL = 'https://tiles.example.invalid/v4/example.satellite.json'
    + '?secure&access_token=' + ACCESS_TOKEN;
const ASSET_URL = 'https://cdn.example.invalid/b670b0320a3189d8d82a221b2ee01877381d3bb5'
    + '/assets/locales/en.json?width=786&height=1148';

// Whole-degree and two-digit coordinates: the spellings that also occur inside
// a version segment, a content hash and a pixel dimension. The negative
// longitudes matter as much as the positive latitudes -- `-1` is the needle
// that ate the hyphen out of `redacted-1...` in the reported capture, which is
// what turned a recognisable sentinel into a value the gate reads as live.
const MARKERS = [
    { latitude: 5, longitude: -1 },
    { latitude: 48, longitude: 11 },
    { latitude: 2, longitude: -8 },
    { latitude: 4, longitude: -7 },
    { latitude: 3, longitude: -9 },
    { latitude: 6, longitude: -2 },
    { latitude: 7, longitude: -3 },
    { latitude: 8, longitude: -4 },
    { latitude: 9, longitude: -5 },
    { latitude: 1, longitude: -6 },
];

function makeHar(markers) {
    const body = JSON.stringify({ markers, asset: ASSET_URL });
    return {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z',
                time: 1,
                request: {
                    method: 'GET', url: TILE_URL,
                    httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                    queryString: [
                        { name: 'secure', value: '' },
                        { name: 'access_token', value: ACCESS_TOKEN },
                    ],
                    headersSize: -1, bodySize: 0,
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [],
                    cookies: [],
                    content: { size: body.length, mimeType: 'application/json', text: body },
                    redirectURL: '', headersSize: -1, bodySize: body.length,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    };
}

function runNode(script, args) {
    try {
        const out = execFileSync(process.execPath, [script, ...args],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return {
            code: e.status ?? 1,
            stdout: e.stdout?.toString() ?? '',
            stderr: e.stderr?.toString() ?? '',
        };
    }
}

/** Scrub one fixture and return the scrubbed document, its text, and the path. */
function scrub(name, markers) {
    const harIn = path.join(tmp, name + '.har');
    fs.writeFileSync(harIn, JSON.stringify(makeHar(markers), null, 2));
    const harOut = path.join(tmp, name + '.scrubbed.har');
    const r = runNode(sanitize, ['--in', harIn, '--out', harOut,
        '--subs', path.join(tmp, name + '.subs.json'),
        '--pii-subs', path.join(tmp, name + '.pii-subs.json'),
        '--profile', profilePath, '--fixed-time', '2026-01-01T00:00:00.000Z']);
    assert.strictEqual(r.code, 0,
        '0.a: sanitize-har failed on ' + name + ': ' + (r.stderr || r.stdout));
    const text = fs.readFileSync(harOut, 'utf8');
    return { path: harOut, text, doc: JSON.parse(text) };
}

/** The value the scrub wrote at the `access_token` query parameter. */
function tokenValue(doc) {
    const pair = doc.log.entries[0].request.queryString.find((p) => p.name === 'access_token');
    assert.ok(pair, 'the access_token query pair disappeared from the capture');
    return pair.value;
}

const run = scrub('tiles', MARKERS);
const scrubbedText = run.text;
const harOut = run.path;
const entry = run.doc.log.entries[0];
const scrubbedBody = JSON.parse(entry.response.content.text);

// --- 0. The precondition: the token WAS redacted and the coordinates WERE. --
// Without this, every assertion below would pass for a scrub that did nothing.
{
    assert.ok(!scrubbedText.includes(ACCESS_TOKEN),
        '0.b: the access token survived the scrub, so nothing below is evidence '
        + 'about sentinel corruption');
    for (const marker of scrubbedBody.markers) {
        assert.strictEqual(marker.latitude, 0,
            '0.c: a coordinate was not zeroed, so the reach pass under test never ran');
        assert.strictEqual(marker.longitude, 0,
            '0.d: a coordinate was not zeroed, so the reach pass under test never ran');
    }
}

// --- 1. The gate ACCEPTS the scrubbed capture. -----------------------------
// The whole defect, measured the way the operator meets it: a clean capture
// quarantined because the verifier could no longer recognise the scrubber's
// own redaction.
{
    const v = runNode(verify, ['--in', harOut, '--profile', profilePath]);
    assert.strictEqual(v.code, 0,
        '1.a: the gate rejected a capture whose only secret the scrub had already '
        + 'redacted: ' + (v.stderr || v.stdout));
}

// --- 2. Digits OUTSIDE a detected value are left alone. --------------------
// The corruption is not only a gate problem: it silently rewrote the reference
// document, turning `/v4/` into `/v0/` and a content hash into a different
// hash. A capture that no longer says which API version was called has lost
// the evidence it exists to carry.
{
    const urlHead = entry.request.url.split('access_token=')[0];
    assert.strictEqual(urlHead, TILE_URL.split('access_token=')[0],
        '2.a: the scrub rewrote digits in the request URL outside the redacted '
        + 'value -- the reference no longer records which endpoint was called');
    assert.strictEqual(scrubbedBody.asset, ASSET_URL,
        '2.b: the scrub rewrote digits inside a URL in the response body, so the '
        + 'content hash and the image dimensions it records are fiction');
}

// --- 3. The redaction does not depend on the coordinates beside it. --------
// The luck-free falsifier. Whether 1.a fails on broken code depends on which
// hex the HMAC happened to produce: the gate only stops recognising a sentinel
// when the hyphen in `redacted-<hex>` is eaten, which needs the hex to START
// with an enrolled digit. The corruption itself does not depend on that -- so
// this compares the SAME token scrubbed with and without coordinates in the
// body beside it. A redaction that changes because an unrelated map payload
// was present is the defect, whatever the gate makes of the result.
{
    const control = scrub('tiles-control', []);
    assert.strictEqual(tokenValue(run.doc), tokenValue(control.doc),
        '3.a: the redaction written at access_token changed when coordinates were '
        + 'present elsewhere in the capture -- a later pass is rewriting the '
        + 'scrubber\'s own sentinel');
    assert.ok(secrets.isRedacted(tokenValue(run.doc)),
        '3.b: the value at access_token is not a recognisable redaction sentinel -- '
        + 'a later pass rewrote the marker the scrub wrote');
}

// --- 4. A known-secret finding says WHERE it is. ---------------------------
// The other half of #529, and the half that cost the operator an afternoon:
// 75 of the 81 findings on the reported capture arrived with no entry index
// and no key path, so locating them meant walking a 57 MB document by hand.
// Every other finding kind already reports both; this one threw the location
// away at the callback.
//
// Deliberately a SEPARATE fixture with a live secret. The sections above are
// about a capture the scrub handled correctly, and once it does, it produces
// no findings to inspect.
{
    const live = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    const har = {
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [
                {
                    startedDateTime: '2026-01-01T00:00:00.000Z', time: 1,
                    request: {
                        method: 'GET', url: 'https://example.invalid/clean',
                        httpVersion: 'HTTP/1.1', headers: [], cookies: [], queryString: [],
                        headersSize: -1, bodySize: 0,
                    },
                    response: {
                        status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
                        headers: [], cookies: [],
                        content: { size: 2, mimeType: 'application/json', text: '{}' },
                        redirectURL: '', headersSize: -1, bodySize: 2,
                    },
                    cache: {}, timings: { send: 0, wait: 1, receive: 0 },
                },
                {
                    startedDateTime: '2026-01-01T00:00:01.000Z', time: 1,
                    request: {
                        method: 'GET', url: 'https://example.invalid/tiles',
                        httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                        queryString: [{ name: 'access_token', value: live }],
                        headersSize: -1, bodySize: 0,
                    },
                    response: {
                        status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
                        headers: [], cookies: [],
                        content: { size: 2, mimeType: 'application/json', text: '{}' },
                        redirectURL: '', headersSize: -1, bodySize: 2,
                    },
                    cache: {}, timings: { send: 0, wait: 1, receive: 0 },
                },
            ],
        },
    };
    const leaky = path.join(tmp, 'leaky.har');
    fs.writeFileSync(leaky, JSON.stringify(har, null, 2));
    const v = runNode(verify, ['--in', leaky, '--profile', profilePath]);
    assert.notStrictEqual(v.code, 0,
        '4.a: the gate passed a capture carrying a readable access_token, so there '
        + 'is no finding to inspect');

    const findings = JSON.parse(fs.readFileSync(path.join(tmp, 'scrub-findings.json'), 'utf8'));
    const list = Array.isArray(findings) ? findings : findings.findings;
    const known = list.filter((f) => f.kind === 'known-secret');
    assert.strictEqual(known.length, 1, '4.b: expected exactly one known-secret finding');

    assert.strictEqual(known[0].entryIndex, 1,
        '4.c: the known-secret finding does not say which entry it is in, so an '
        + 'operator has to walk the whole capture to find it');
    assert.ok(typeof known[0].keyPath === 'string' && known[0].keyPath.includes('queryString'),
        '4.d: the known-secret finding does not say where in the entry it is');

    for (const f of list) {
        assert.ok(!JSON.stringify(f).includes(live),
            '4.e: a finding carried the value it found -- the report has relocated '
            + 'the leak into the document written to explain it');
    }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('All scrub-coordinate-reach tests passed');
