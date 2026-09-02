#!/usr/bin/env node
// Behavior tests for "API calls are the default selection" (issue #410).
//
// `extract-har-reference.js` used to REFUSE to run without `--match`, on the
// reasoning that which entries matter is a judgement a tool cannot make. Asked
// directly for a regex, the operator said: "I couldn't provide a regex. All I
// know is that the focus should be on the API calls, not the fonts, images,
// etc." -- which is a mechanical classification, not a judgement.
//
// What these tests pin, and why each one is here rather than a count:
//
//   A COUNT CANNOT CATCH A MISCLASSIFICATION. "7 of 412 entries" is equally
//   true when the 7 are the wrong 7. So every selection assertion below names
//   the KIND that survived -- the set of `_resourceType` values in the written
//   reference, or the set of response content types -- and fails by naming the
//   kind that should not be there.
//
// Zero-dep, runs with `node har-api-default.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const extract = path.join(__dirname, 'extract-har-reference.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-api-default-'));

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
        salt: 'api-default-test-salt', literals: {},
    }, null, 2));
    return dir;
}

/**
 * A HAR entry. `resourceType`, when given, is written as Playwright writes it
 * (`_resourceType`); omit it to get the mitmproxy shape, which carries no such
 * field at all.
 */
function entry({ url = 'https://example.invalid/api', resourceType, mimeType = 'application/json',
    text = '{"ok":true}', post = null, method = 'GET', status = 200 } = {}) {
    const e = {
        startedDateTime: '2026-09-02T00:00:00.000Z', time: 1,
        request: {
            method, url, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [],
            headersSize: -1, bodySize: post ? post.text.length : 0,
        },
        response: {
            status, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
            content: mimeType === null
                ? { size: 0 }
                : { size: (text || '').length, mimeType, text: text === null ? undefined : text },
            redirectURL: '', headersSize: -1, bodySize: (text || '').length,
        },
        cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    };
    if (post) e.request.postData = post;
    if (resourceType !== undefined) e._resourceType = resourceType;
    return e;
}

function writeRaw(dir, entries, name = 'raw.har') {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify({
        log: { version: '1.2', creator: { name: 'test', version: '1' }, entries },
    }, null, 2));
    return p;
}

// Each numbered block runs inside `section`, which CATCHES its failure and
// keeps going. Node stops at the first failed assert, and with a dozen blocks
// pinning one classifier that means a single broken category masks every other
// assertion -- which is exactly what an ablation run needs to see separately.
// Failures are collected and all of them are printed at the end.
const failures = [];
function section(name, fn) {
    try { fn(); } catch (e) {
        // The block number as well as the assertion's own label: an assertion
        // that throws before reaching a labelled `assert` (a bad fixture, a
        // missing output file) would otherwise be reported with no location.
        failures.push(`[block ${name}] ` + (e && e.message ? e.message : String(e)));
    }
}

const readRef = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).log.entries;
const resourceTypesIn = (entries) => [...new Set(entries.map((e) => e._resourceType))].sort();
const mimesIn = (entries) => [...new Set(entries.map(
    (e) => ((e.response && e.response.content && e.response.content.mimeType) || '(none)')))].sort();
const urlsIn = (entries) => entries.map((e) => e.request.url);

// A capture with one of everything Playwright labels, plus a resource type
// this script has never heard of.
function playwrightMix() {
    return [
        entry({ resourceType: 'xhr', url: 'https://example.invalid/api/posts' }),
        entry({ resourceType: 'fetch', url: 'https://example.invalid/graphql', method: 'POST',
            post: { mimeType: 'application/x-www-form-urlencoded', text: 'doc_id=9' } }),
        entry({ resourceType: 'websocket', url: 'wss://example.invalid/live', mimeType: 'x-unknown' }),
        entry({ resourceType: 'document', url: 'https://example.invalid/callback',
            mimeType: 'text/html', text: '<html>ok</html>' }),
        entry({ resourceType: 'image', url: 'https://example.invalid/a.png', mimeType: 'image/png', text: 'PNG' }),
        entry({ resourceType: 'image', url: 'https://example.invalid/b.jpg', mimeType: 'image/jpeg', text: 'JPG' }),
        entry({ resourceType: 'font', url: 'https://example.invalid/f.woff2', mimeType: 'font/woff2', text: 'FNT' }),
        entry({ resourceType: 'stylesheet', url: 'https://example.invalid/s.css', mimeType: 'text/css', text: 'a{}' }),
        entry({ resourceType: 'script', url: 'https://example.invalid/app.js',
            mimeType: 'text/javascript', text: 'void 0' }),
        entry({ resourceType: 'media', url: 'https://example.invalid/v.mp4', mimeType: 'video/mp4', text: 'MP4' }),
        entry({ resourceType: 'ping', url: 'https://example.invalid/beacon', mimeType: 'text/plain', text: '' }),
        entry({ resourceType: 'eventsource', url: 'https://example.invalid/stream', mimeType: 'text/event-stream' }),
    ];
}

// --- 1. No selector: the default keeps API traffic and nothing else. --------
// Asserted on KIND, not on count: the failure message names the resource type
// that should not have survived.
section('1', () => {
    const dir = makeProject('default-keeps-api');
    const raw = writeRaw(dir, playwrightMix());
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--out', out], dir);
    assert.strictEqual(r.code, 0, '1.a: a run with no --match must succeed: ' + r.stderr);

    const kinds = resourceTypesIn(readRef(out));

    // The specific bans come FIRST so that an ablation reports the kind that
    // actually leaked, rather than the whole-set mismatch swallowing it.
    for (const banned of ['image', 'font', 'stylesheet', 'script', 'media']) {
        assert.ok(!kinds.includes(banned),
            `1.b: a '${banned}' entry is in the committed reference -- the static-asset drop is broken`);
    }
    assert.ok(!kinds.includes('ping'), '1.c: a beacon is in the committed reference');
    assert.deepStrictEqual(kinds, ['document', 'eventsource', 'fetch', 'websocket', 'xhr'],
        '1.d: the WRONG KIND of entry survived the default classification. Expected exactly ' +
        'xhr/fetch/websocket/document plus the unmodelled type; got: ' + kinds.join(', '));
});

// --- 2. An unmodelled resource type is KEPT, not dropped. ------------------
// The safety property of the whole design: only a POSITIVE identification as
// an asset or a beacon drops an entry. A resource type a future Playwright
// invents must not start disappearing silently.
section('2', () => {
    const dir = makeProject('unmodelled-kept');
    const raw = writeRaw(dir, [
        entry({ resourceType: 'preflight', url: 'https://example.invalid/x' }),
        entry({ resourceType: 'image', url: 'https://example.invalid/y.png', mimeType: 'image/png', text: 'P' }),
    ]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--out', out], dir);
    assert.strictEqual(r.code, 0, '2.a: extraction failed: ' + r.stderr);
    assert.deepStrictEqual(resourceTypesIn(readRef(out)), ['preflight'],
        '2.b: an unmodelled resource type was dropped -- an unknown kind must be KEPT, not guessed at');
    assert.ok(/unclassified/.test(r.stdout),
        '2.c: the report does not say the entry was kept as unclassified, so a reviewer cannot see why');
});

// --- 3. The per-category report accounts for EVERY entry. ------------------
// kept + dropped must equal total. A filter that silently loses entries is
// worse than one that keeps too many, so the arithmetic is checked from the
// printed report itself -- the artifact an operator actually reads.
section('3', () => {
    const dir = makeProject('report-arithmetic');
    const entries = playwrightMix();
    const raw = writeRaw(dir, entries);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--out', out], dir);
    assert.strictEqual(r.code, 0, '3.a: extraction failed: ' + r.stderr);

    const kept = [...r.stdout.matchAll(/^ {2}kept {5}(\d+)/gm)].map((m) => Number(m[1]));
    const dropped = [...r.stdout.matchAll(/^ {2}dropped {2}(\d+)/gm)].map((m) => Number(m[1]));
    assert.ok(kept.length > 0 && dropped.length > 0,
        '3.b: the run printed no per-category kept/dropped report:\n' + r.stdout);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    assert.strictEqual(sum(kept) + sum(dropped), entries.length,
        '3.c: kept + dropped != total -- entries vanished between the scan and the report:\n' + r.stdout);
    const total = /^ {2}total {4}(\d+)/m.exec(r.stdout);
    assert.ok(total && Number(total[1]) === entries.length,
        '3.d: the report does not state the number of entries scanned:\n' + r.stdout);

    // The categories are named, with their sub-kinds, or a wrong drop is not
    // reviewable at extraction time -- which is the whole reason it is printed.
    assert.ok(/dropped\s+\d+\s+static assets.*images 2/.test(r.stdout),
        '3.e: the report does not break the dropped assets down by kind:\n' + r.stdout);
    assert.ok(/dropped\s+\d+\s+telemetry \/ beacon/.test(r.stdout),
        '3.f: beacons are not reported as their own category:\n' + r.stdout);
    assert.ok(/kept\s+\d+\s+documents/.test(r.stdout),
        '3.g: documents are not reported as their own kept category:\n' + r.stdout);

    // WHICH SIGNAL decided. Without it an operator cannot tell a capture that
    // was classified by the recorder's own labels from one that fell through
    // to the weaker content-type path.
    assert.ok(/^ {2}basis .*resourceType 12/m.test(r.stdout),
        '3.h: the report does not say every entry was classified by _resourceType:\n' + r.stdout);
});

// --- 4. The report never echoes a captured value. --------------------------
// Counts, kinds and content-type categories only. A report that pastes a URL
// into a terminal log defeats the scrub the reference exists to pass.
section('4', () => {
    const dir = makeProject('report-no-values');
    const secretish = 'sessiontoken9nx2';
    const raw = writeRaw(dir, [
        entry({ resourceType: 'xhr', url: `https://example.invalid/api?t=${secretish}` }),
        entry({ resourceType: 'image', url: `https://example.invalid/${secretish}.png`,
            mimeType: 'image/png', text: 'P' }),
    ]);
    const r = runNode(extract, ['--in', raw, '--out', path.join(dir, 'ref.har')], dir);
    assert.strictEqual(r.code, 0, '4.a: extraction failed: ' + r.stderr);
    assert.ok(!r.stdout.includes(secretish),
        '4.b: the per-category report echoed a captured URL value');
});

// --- 5. The mitmproxy shape: no `_resourceType` anywhere. ------------------
// This is a real capture shape, not a footnote -- a consuming project's store
// holds six such captures, and they carry no Playwright extension fields at
// all. Classification there falls to the request body and the response
// content type.
section('5', () => {
    const dir = makeProject('mitmproxy-shape');
    const entries = [
        entry({ url: 'https://example.invalid/api/trip', mimeType: 'application/json' }),
        entry({ url: 'https://example.invalid/api/create', method: 'POST',
            post: { mimeType: 'application/json', text: '{"name":"x"}' } }),
        entry({ url: 'https://example.invalid/photo.jpg', mimeType: 'image/jpeg', text: 'JPG' }),
        entry({ url: 'https://example.invalid/w.woff2', mimeType: 'font/woff2', text: 'F' }),
        entry({ url: 'https://example.invalid/s.css', mimeType: 'text/css', text: 'a{}' }),
        entry({ url: 'https://example.invalid/app.js', mimeType: 'application/x-javascript', text: 'x' }),
        entry({ url: 'https://example.invalid/clip.mp4', mimeType: 'video/mp4', text: 'M' }),
        entry({ url: 'https://example.invalid/page', mimeType: 'text/html', text: '<html></html>' }),
        entry({ url: 'https://example.invalid/proto', mimeType: 'application/x-protobuf', text: 'p' }),
    ];
    const raw = writeRaw(dir, entries);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--out', out], dir);
    assert.strictEqual(r.code, 0, '5.a: extraction failed: ' + r.stderr);

    const written = readRef(out);
    assert.ok(written.every((e) => e._resourceType === undefined),
        '5.b: precondition -- the fixture is meant to carry no _resourceType');
    assert.deepStrictEqual(mimesIn(written).sort(),
        ['application/json', 'application/x-protobuf', 'text/html'].sort(),
        '5.c: the WRONG KIND survived the content-type fallback. Got: ' + mimesIn(written).join(', '));
    assert.ok(!urlsIn(written).some((u) => /\.(jpg|woff2|css|js|mp4)$/.test(u)),
        '5.d: a static asset survived the content-type fallback: ' + urlsIn(written).join(', '));

    // And the report SAYS the fallback ran. A mitmproxy capture classified
    // silently would look identical to a Playwright one in the log.
    const basis = /^ {2}basis {5}(.*)$/m.exec(r.stdout);
    assert.ok(basis, '5.e: the report does not name which signal classified the capture:\n' + r.stdout);
    assert.ok(!/resourceType/.test(basis[1]),
        '5.f: the report claims _resourceType classified a capture that carries none: ' + basis[1]);
    assert.ok(/contentType/.test(basis[1]) && /requestBody/.test(basis[1]),
        '5.g: the report does not name the content-type and request-body fallbacks: ' + basis[1]);
});

// --- 6. A request body outranks the response content type. ----------------
// The single most interesting entry in an upload capture is a multipart POST
// whose response is an image. Classifying on the response first would drop it.
section('6', () => {
    const dir = makeProject('post-body-wins');
    const raw = writeRaw(dir, [
        entry({ url: 'https://example.invalid/upload', method: 'POST', mimeType: 'image/jpeg', text: 'JPG',
            post: { mimeType: 'multipart/form-data', text: '--b\r\nContent-Disposition: form-data\r\n\r\nx' } }),
        entry({ url: 'https://example.invalid/thumb.jpg', mimeType: 'image/jpeg', text: 'JPG' }),
    ]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--out', out], dir);
    assert.strictEqual(r.code, 0, '6.a: extraction failed: ' + r.stderr);
    assert.deepStrictEqual(urlsIn(readRef(out)), ['https://example.invalid/upload'],
        '6.b: the upload POST was dropped for answering image/jpeg, or the plain image was kept');
});

// --- 7. A bodiless redirect hop is KEPT. ----------------------------------
// A 302 with no content type proves nothing about being an asset, and a
// redirect chain is exactly what an auth flow turns on. `unclassified` keeps
// it. This is the conservative-about-DROPS rule, tested.
section('7', () => {
    const dir = makeProject('redirect-hop');
    const raw = writeRaw(dir, [
        entry({ url: 'https://example.invalid/oauth/authorize', status: 302, mimeType: null, text: null }),
        entry({ url: 'https://example.invalid/logo.svg', mimeType: 'image/svg+xml', text: '<svg/>' }),
    ]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--out', out], dir);
    assert.strictEqual(r.code, 0, '7.a: extraction failed: ' + r.stderr);
    assert.deepStrictEqual(urlsIn(readRef(out)), ['https://example.invalid/oauth/authorize'],
        '7.b: a bodiless redirect hop was dropped -- an auth callback chain would vanish silently');
});

// --- 8. `--match` narrows WITHIN the API set; it never re-admits an asset. --
// This is the decisive test of the chosen semantics. If `--match` REPLACED the
// classification, `--match upload` would drag the image back in -- restoring
// the exact failure the default exists to remove, and only for the operators
// who bothered to narrow.
section('8', () => {
    const dir = makeProject('match-narrows');
    const raw = writeRaw(dir, [
        entry({ resourceType: 'xhr', url: 'https://example.invalid/api/upload/finish' }),
        entry({ resourceType: 'xhr', url: 'https://example.invalid/api/feed' }),
        entry({ resourceType: 'image', url: 'https://example.invalid/upload/preview.png',
            mimeType: 'image/png', text: 'P' }),
    ]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--match', 'upload', '--out', out], dir);
    assert.strictEqual(r.code, 0, '8.a: extraction failed: ' + r.stderr);

    const written = readRef(out);
    assert.deepStrictEqual(urlsIn(written), ['https://example.invalid/api/upload/finish'],
        '8.b: --match did not narrow WITHIN the API set. Either it failed to narrow, or it ' +
        're-admitted the matching image -- got: ' + urlsIn(written).join(', '));
    assert.deepStrictEqual(resourceTypesIn(written), ['xhr'],
        '8.c: a non-API kind reached the reference through --match');
    assert.ok(/narrowed from 2 kept by --match/.test(r.stdout),
        '8.d: the run does not say the selector narrowed an already-classified set:\n' + r.stdout);
});

// --- 9. A selector that only matches dropped entries fails loudly. --------
// And says WHY, in terms of the narrowing semantics -- otherwise the operator
// widens the regex forever against a set the regex was never applied to.
section('9', () => {
    const dir = makeProject('match-only-assets');
    const raw = writeRaw(dir, [
        entry({ resourceType: 'xhr', url: 'https://example.invalid/api/feed' }),
        entry({ resourceType: 'font', url: 'https://example.invalid/brand.woff2',
            mimeType: 'font/woff2', text: 'F' }),
    ]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--match', 'brand', '--out', out], dir);
    assert.strictEqual(r.code, 3, '9.a: a selector matching only dropped entries should exit 3, got ' + r.code);
    assert.ok(!fs.existsSync(out), '9.b: an empty reference was written');
    assert.ok(/narrows within the API set/.test(r.stderr),
        '9.c: the failure does not explain that --match cannot re-admit a dropped asset:\n' + r.stderr);
    assert.ok(/1 API entries of 2 scanned/.test(r.stderr),
        '9.d: the failure does not say how large the API set the selector was applied to was:\n' + r.stderr);
});

// --- 10. A capture with no API traffic at all fails loudly. ---------------
// Distinguished from case 9 on purpose: "there were no API calls" and "your
// selector excluded them all" call for different next actions.
section('10', () => {
    const dir = makeProject('all-assets');
    const raw = writeRaw(dir, [
        entry({ resourceType: 'image', url: 'https://example.invalid/a.png', mimeType: 'image/png', text: 'P' }),
        entry({ resourceType: 'ping', url: 'https://example.invalid/b', mimeType: 'text/plain', text: '' }),
    ]);
    const out = path.join(dir, 'ref.har');
    const r = runNode(extract, ['--in', raw, '--out', out], dir);
    assert.strictEqual(r.code, 3, '10.a: an all-asset capture should exit 3, got ' + r.code);
    assert.ok(!fs.existsSync(out), '10.b: an empty reference was written');
    assert.ok(/was classified as an API call/.test(r.stderr),
        '10.c: the failure does not distinguish "no API calls" from "selector matched nothing":\n' + r.stderr);
    // The report still prints: the counts are most valuable exactly when the
    // run did not produce what the operator expected.
    assert.ok(/dropped\s+\d+\s+static assets/.test(r.stdout),
        '10.d: the per-category report was withheld on the failure path:\n' + r.stdout);
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length > 0) {
    for (const f of failures) console.error('FAILED ' + f);
    console.error(`${failures.length} har-api-default assertion(s) failed`);
    process.exit(1);
}
console.log('All har-api-default tests passed');
