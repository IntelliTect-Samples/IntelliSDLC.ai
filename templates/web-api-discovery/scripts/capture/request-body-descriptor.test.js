#!/usr/bin/env node
// Behavior tests for the unretained-request-body descriptor (issue #442).
//
// Zero-dep, runs with `node request-body-descriptor.test.js`.
//
// THE FALSIFIER is `chunked upload is distinguishable from a bodyless GET`.
// It fails on the code as it stood before this change, because before it there
// was nothing to tell them apart with: HAR reports `bodySize: 0` for both, and
// neither carries `postData`.
//
// The measured shape under test is real. Read read-only from
// `www.instagram.com/2026-09-04-092759`, the two `rupload_igvideo` POSTs that
// carried a 19 MB and a 52 MB video both read `"bodySize": 0` with no
// `postData`, while their own `content-length` headers said 19299725 and
// 52164051. The fixtures below are synthetic but keep those numbers.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('./request-body-descriptor.js');
const capture = require('./capture-har.js');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const KEY = D.DESCRIPTOR_KEY;

// --- fixtures ---------------------------------------------------------------

// The exact shape of an Instagram chunked video upload leg.
function chunkedUploadRequest(entityLength) {
    return {
        method: 'POST',
        url: 'https://i.instagram.com/rupload_igvideo/fb_uploader_1234',
        headers: {
            'content-length': String(entityLength),
            'x-entity-length': String(entityLength),
            'x-entity-name': 'fb_uploader_1234',
            offset: '0',
        },
        postDataBuffer: null,
        postMimeType: '',
    };
}

function multipartBody(boundary, parts) {
    const chunks = [];
    for (const p of parts) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
        if (p.filename) head += `; filename="${p.filename}"`;
        head += '\r\n';
        if (p.type) head += `Content-Type: ${p.type}\r\n`;
        head += '\r\n';
        chunks.push(Buffer.from(head, 'latin1'));
        chunks.push(Buffer.from(p.content, 'latin1'));
        chunks.push(Buffer.from('\r\n', 'latin1'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
    return Buffer.concat(chunks);
}

// --- the falsifier ----------------------------------------------------------

test('FALSIFIER: a chunked upload is distinguishable from a bodyless GET', () => {
    const upload = capture.buildEntry({ request: chunkedUploadRequest(52164051), response: null });
    const get = capture.buildEntry({
        request: { method: 'GET', url: 'https://example.com/feed', headers: {} },
        response: null,
    });

    // The claim a consumer must be able to make, stated as the consumer would:
    // these two entries do not describe the same fact about a request body.
    const describes = (e) => JSON.stringify({
        bodySize: e.request.bodySize,
        descriptor: e.request[KEY] || null,
    });
    assert.notStrictEqual(describes(upload), describes(get),
        'an unretained 52 MB upload reads exactly like a bodyless GET');

    // And specifically:
    assert.strictEqual(upload.request[KEY].bodyRetained, false);
    assert.strictEqual(upload.request[KEY].declaredLength, 52164051);
    assert.strictEqual(upload.request.bodySize, -1, 'bodySize 0 is the false statement');
    assert.strictEqual(get.request[KEY], undefined);
});

// --- guards -----------------------------------------------------------------

test('GUARD: a request that genuinely has no body still reports having none', () => {
    for (const req of [
        { method: 'GET', url: 'https://example.com/a', headers: {} },
        { method: 'POST', url: 'https://example.com/b', headers: { 'content-length': '0' } },
        { method: 'HEAD', url: 'https://example.com/c', headers: { 'content-type': 'text/html' } },
    ]) {
        const e = capture.buildEntry({ request: req, response: null });
        assert.strictEqual(e.request.bodySize, 0, `${req.method} lost its true bodySize 0`);
        assert.strictEqual(e.request[KEY], undefined, `${req.method} gained a descriptor it should not have`);
        assert.strictEqual(e.request.postData, undefined);
    }
});

test('GUARD: a fully retained body gets no descriptor and keeps its real size', () => {
    const body = Buffer.from('fb_dtsg=x&caption=hello', 'utf8');
    const e = capture.buildEntry({
        request: {
            method: 'POST',
            url: 'https://example.com/graphql',
            headers: { 'content-length': String(body.length), 'content-type': 'application/x-www-form-urlencoded' },
            postDataBuffer: body,
            postMimeType: 'application/x-www-form-urlencoded',
        },
        response: null,
    });
    assert.strictEqual(e.request.bodySize, body.length);
    assert.strictEqual(e.request[KEY], undefined);
    assert.ok(e.request.postData.text.includes('caption=hello'));
});

test('GUARD: transfer-encoding chunked with no content-length declares an UNKNOWN length, not zero', () => {
    const d = D.describeRequestBody({
        headers: { 'transfer-encoding': 'chunked', 'content-type': 'video/mp4' },
        postDataBuffer: null,
    });
    assert.strictEqual(d.bodyRetained, false);
    assert.strictEqual(d.declaredLength, null, 'unknown must not be reported as 0');
    assert.strictEqual(d.transferEncoding, 'chunked');
});

// --- multipart structure ----------------------------------------------------

test('a multipart request records its part structure and NO part contents', () => {
    const boundary = '----WebKitFormBoundaryv0IlteU2';
    const buf = multipartBody(boundary, [
        { name: 'caption', content: 'a day at the lake' },
        { name: 'upload_file', filename: 'IMG_2024.jpg', type: 'image/jpeg', content: 'BINARYPIXELS-SECRET' },
    ]);
    const d = D.describeRequestBody({
        headers: {
            'content-length': String(buf.length + 40000000),
            'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        postDataBuffer: buf,
        postMimeType: `multipart/form-data; boundary=${boundary}`,
    });

    assert.deepStrictEqual(d.parts.map((p) => [p.order, p.fieldName, p.filename, p.contentType, p.length]), [
        [0, 'caption', null, null, 'a day at the lake'.length],
        [1, 'upload_file', 'IMG_2024.jpg', 'image/jpeg', 'BINARYPIXELS-SECRET'.length],
    ]);

    // THE HARD CONSTRAINT: no bytes, no hash, no prefix. The descriptor is
    // searched for any fragment of either part's content.
    const serialized = JSON.stringify(d);
    for (const content of ['a day at the lake', 'BINARYPIXELS-SECRET']) {
        for (let n = 4; n <= content.length; n++) {
            assert.ok(!serialized.includes(content.slice(0, n)),
                `the descriptor carries a ${n}-char prefix of part content`);
        }
    }
});

test('a part whose closing boundary was never seen reports an UNKNOWN length', () => {
    const boundary = 'B1';
    const full = multipartBody(boundary, [
        { name: 'file', filename: 'clip.mp4', type: 'video/mp4', content: 'AAAAAAAAAAAAAAAA' },
    ]);
    const cut = full.slice(0, full.length - 12);
    const parts = D.parseMultipartStructure(cut, boundary);
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0].filename, 'clip.mp4');
    assert.strictEqual(parts[0].length, null, 'a truncated part must not report a measured length');
    assert.strictEqual(parts[0].complete, false);
});

test('an unparseable multipart body reports parts UNKNOWN, not parts NONE', () => {
    const d = D.describeRequestBody({
        headers: { 'content-length': '52164051', 'content-type': 'multipart/form-data; boundary=B9' },
        postDataBuffer: null,
    });
    assert.strictEqual(d.parts, null, 'null is "unknown"; [] would claim there are no parts');
});

// --- attaching to a raw.har this process did not write ----------------------

test('descriptors reach a recordHar-authored raw.har, which this process never builds entries for', () => {
    // What the driver wrote: no descriptor, the false bodySize 0.
    const driverHar = {
        log: {
            version: '1.2',
            entries: [
                {
                    _resourceType: 'fetch',
                    request: {
                        method: 'POST',
                        url: 'https://i.instagram.com/rupload_igvideo/fb_uploader_1234',
                        headers: [{ name: 'content-length', value: '52164051' }],
                        bodySize: 0,
                    },
                    response: { status: 200 },
                },
                {
                    request: {
                        method: 'GET',
                        url: 'https://example.com/feed',
                        headers: [],
                        bodySize: 0,
                    },
                    response: { status: 200 },
                },
            ],
        },
    };
    // What OUR recorder logged for the same session.
    const logged = [capture.buildEntry({ request: chunkedUploadRequest(52164051), response: null })];

    const annotated = D.attachDescriptors(driverHar.log.entries, logged);
    assert.strictEqual(annotated, 1);
    assert.strictEqual(driverHar.log.entries[0].request[KEY].declaredLength, 52164051);
    assert.strictEqual(driverHar.log.entries[0].request.bodySize, -1);
    // The bodyless GET is untouched on BOTH fields.
    assert.strictEqual(driverHar.log.entries[1].request[KEY], undefined);
    assert.strictEqual(driverHar.log.entries[1].request.bodySize, 0);
});

test('repeated legs of one chunked upload each get their own descriptor, in order', () => {
    const legs = [1, 2, 3].map((i) => {
        const req = chunkedUploadRequest(52164051);
        req.headers = Object.assign({}, req.headers, { offset: String(i * 1000) });
        return capture.buildEntry({ request: req, response: null });
    });
    const har = legs.map((l) => ({
        request: {
            method: l.request.method,
            url: l.request.url,
            headers: [{ name: 'content-length', value: '52164051' }],
            bodySize: 0,
        },
    }));
    assert.strictEqual(D.attachDescriptors(har, legs), 3);
    assert.ok(har.every((e) => e.request[KEY] && e.request[KEY].declaredLength === 52164051));
});

test('annotation is idempotent, so the assembled path is a no-op and a second stop cannot double-apply', () => {
    const entry = capture.buildEntry({ request: chunkedUploadRequest(19299725), response: null });
    const assembled = [JSON.parse(JSON.stringify(entry))];
    // The assembled raw.har IS the log, so every entry already carries one.
    assert.strictEqual(D.attachDescriptors(assembled, [entry]), 0);
    assert.strictEqual(assembled[0].request[KEY].declaredLength, 19299725);
    // Running it again changes nothing.
    assert.strictEqual(D.attachDescriptors(assembled, [entry]), 0);
});

test('annotateUnretainedBodies works over files, on BOTH raw.har paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-442-'));
    const logPath = path.join(dir, 'raw.ndjson');
    const entry = capture.buildEntry({ request: chunkedUploadRequest(19299725), response: null });
    fs.writeFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');

    // Path A -- recordHar wrote the file; it has no descriptors.
    const harA = path.join(dir, 'recordhar.har');
    fs.writeFileSync(harA, JSON.stringify({
        log: {
            version: '1.2',
            entries: [{
                request: {
                    method: 'POST',
                    url: 'https://i.instagram.com/rupload_igvideo/fb_uploader_1234',
                    headers: [{ name: 'content-length', value: '19299725' }],
                    bodySize: 0,
                },
            }],
        },
    }), 'utf8');
    assert.deepStrictEqual(capture.annotateUnretainedBodies(harA, logPath), { annotated: 1 });
    const outA = JSON.parse(fs.readFileSync(harA, 'utf8'));
    assert.strictEqual(outA.log.entries[0].request[KEY].declaredLength, 19299725);

    // Path B -- assembled from the very same log.
    const harB = path.join(dir, 'assembled.har');
    capture.assembleFromLog(logPath, harB);
    const beforeB = fs.readFileSync(harB, 'utf8');
    assert.deepStrictEqual(capture.annotateUnretainedBodies(harB, logPath), { annotated: 0 });
    assert.strictEqual(fs.readFileSync(harB, 'utf8'), beforeB, 'the assembled path was rewritten');
    assert.strictEqual(JSON.parse(beforeB).log.entries[0].request[KEY].declaredLength, 19299725);

    // A missing log is not a failure -- it is today's artifact, unannotated.
    assert.strictEqual(capture.annotateUnretainedBodies(harA, path.join(dir, 'nope.ndjson')), null);

    fs.rmSync(dir, { recursive: true, force: true });
});

// --- run --------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`  ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${name}`);
        console.log(`       ${e.message}`);
    }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (!failed) console.log('All request-body-descriptor tests passed');
process.exit(failed ? 1 : 0);
