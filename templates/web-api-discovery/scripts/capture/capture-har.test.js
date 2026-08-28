#!/usr/bin/env node
// Behavior tests for capture-har.js -- the record/scrub/catalogue pipeline
// (issue #281).
//
// Zero-dep, runs with `node capture-har.test.js`. Exits non-zero on first
// failure. Nothing here launches a browser: the Playwright wiring is a thin
// adapter over pure functions, and it is those functions that are pinned.
//
// The controlling rules, each tied to a defect the issue names:
//
//  - The incremental recorder is a REAL fallback, not a degraded stub. A
//    window close must yield a genuine HAR 1.2 document, so failed requests,
//    binary bodies and real timings all have to survive it.
//  - Raw captures are confined to `.har-captures/` BY CONSTRUCTION. The
//    output path receives only scrubbed artifacts, so no flag can aim a
//    credential-bearing capture at a committable directory.
//  - Cataloguing is never silently dropped. Whoever runs it -- the calling
//    agent, the `claude` CLI, or nobody -- is recorded.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const capture = require(path.join(__dirname, 'capture-har.js'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-har-test-'));

// Tests are queued and awaited in order rather than run on the spot: several
// of them are async, and a runner that called fn() without awaiting would
// report a rejected assertion as a pass -- the exact failure mode a test
// harness must not have.
const queued = [];
function test(name, fn) {
    queued.push({ name, fn });
}

async function run() {
    let passed = 0;
    for (const { name, fn } of queued) {
        try {
            await fn();
            passed++;
        } catch (e) {
            process.stderr.write(`FAIL: ${name}\n  ${e.message}\n`);
            if (e.stack) process.stderr.write(e.stack.split('\n').slice(1, 4).join('\n') + '\n');
            process.exit(1);
        }
    }
    return passed;
}

function tmpDir(name) {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ---------------------------------------------------------------------------
// Stage 1 -- the incremental recorder is full-fidelity
// ---------------------------------------------------------------------------

// A minimal stand-in for Playwright's Request/Response. Only the surface
// buildEntry actually consumes is modelled; a fake that mirrored the whole API
// would pin the fake, not the code.
function fakeRequest(overrides) {
    return Object.assign({
        method: 'GET',
        url: 'https://example.com/api/thing?id=7&q=a%20b',
        headers: { 'user-agent': 'test', cookie: 'sid=abc; theme=dark' },
        httpVersion: 'HTTP/2.0',
        postDataBuffer: null,
        postMimeType: ''
    }, overrides);
}

function fakeResponse(overrides) {
    return Object.assign({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json', 'content-length': '13' },
        httpVersion: 'HTTP/2.0'
    }, overrides);
}

test('buildEntry emits a HAR entry for a finished request', () => {
    const entry = capture.buildEntry({
        request: fakeRequest(),
        response: fakeResponse(),
        timing: { send: 1.5, wait: 20.25, receive: 3 },
        body: Buffer.from('{"ok":true}', 'utf8')
    });
    assert.strictEqual(entry.request.method, 'GET');
    assert.strictEqual(entry.response.status, 200);
    assert.ok(entry.startedDateTime, 'startedDateTime is required by HAR 1.2');
});

test('buildEntry records a failed request instead of dropping it', () => {
    // SKILL.md: failure paths are "frequently the highest-value entries".
    // Listening on `response` drops them entirely -- there is no response.
    const entry = capture.buildEntry({
        request: fakeRequest({ method: 'POST', url: 'https://example.com/api/publish' }),
        response: null,
        failure: { errorText: 'net::ERR_CONNECTION_REFUSED' },
        timing: null,
        body: null
    });
    assert.strictEqual(entry.request.url, 'https://example.com/api/publish');
    // HAR has no "no response" shape; status 0 is the established convention.
    assert.strictEqual(entry.response.status, 0);
    assert.match(JSON.stringify(entry), /ERR_CONNECTION_REFUSED/,
        'the failure reason is the whole value of a failed entry');
});

test('buildEntry base64-encodes a body that is not valid UTF-8', () => {
    // `body.toString('utf8')` silently mangles any non-UTF8 body -- the
    // replacement character is lossy and irreversible, so a captured image or
    // protobuf payload becomes unusable without a word of warning.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const entry = capture.buildEntry({
        request: fakeRequest(),
        response: fakeResponse({ headers: { 'content-type': 'image/png' } }),
        timing: null,
        body: binary
    });
    assert.strictEqual(entry.response.content.encoding, 'base64');
    assert.deepStrictEqual(
        Buffer.from(entry.response.content.text, 'base64'), binary,
        'a binary body must round-trip byte-for-byte');
});

test('buildEntry leaves a UTF-8 body as text, with no encoding field', () => {
    // base64-encoding everything would make the reference ungreppable, which
    // is most of what a committed reference is for.
    const entry = capture.buildEntry({
        request: fakeRequest(),
        response: fakeResponse(),
        timing: null,
        body: Buffer.from('{"ok":true}', 'utf8')
    });
    assert.strictEqual(entry.response.content.text, '{"ok":true}');
    assert.strictEqual(entry.response.content.encoding, undefined);
});

test('buildEntry does not cap a large body', () => {
    // The old 256 KB cap silently truncated exactly the payloads worth having.
    const big = Buffer.alloc(300 * 1024, 0x61);
    const entry = capture.buildEntry({
        request: fakeRequest(),
        response: fakeResponse(),
        timing: null,
        body: big
    });
    assert.strictEqual(entry.response.content.size, big.length);
    assert.strictEqual(entry.response.content.text.length, big.length);
});

test('buildEntry carries real timings rather than -1 placeholders', () => {
    const entry = capture.buildEntry({
        request: fakeRequest(),
        response: fakeResponse(),
        timing: { send: 1.5, wait: 20.25, receive: 3 },
        body: null
    });
    assert.strictEqual(entry.timings.send, 1.5);
    assert.strictEqual(entry.timings.wait, 20.25);
    assert.strictEqual(entry.timings.receive, 3);
    assert.strictEqual(entry.time, 24.75, 'time is the sum of the phases');
});

test('buildEntry decodes queryString and cookies', () => {
    // A percent-encoded query is not greppable; the decoded copy is what makes
    // a reference searchable for a field name.
    const entry = capture.buildEntry({
        request: fakeRequest(),
        response: fakeResponse(),
        timing: null,
        body: null
    });
    const q = entry.request.queryString;
    assert.deepStrictEqual(q.find((p) => p.name === 'id'), { name: 'id', value: '7' });
    assert.deepStrictEqual(q.find((p) => p.name === 'q'), { name: 'q', value: 'a b' });
    assert.ok(entry.request.cookies.some((c) => c.name === 'sid' && c.value === 'abc'));
});

test('buildEntry captures a binary request body via postDataBuffer', () => {
    const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    const entry = capture.buildEntry({
        request: fakeRequest({
            method: 'POST',
            postDataBuffer: payload,
            postMimeType: 'application/octet-stream'
        }),
        response: fakeResponse(),
        timing: null,
        body: null
    });
    assert.strictEqual(entry.request.postData.encoding, 'base64');
    assert.deepStrictEqual(Buffer.from(entry.request.postData.text, 'base64'), payload);
});

test('buildEntry reports honest sizes rather than -1', () => {
    const entry = capture.buildEntry({
        request: fakeRequest(),
        response: fakeResponse(),
        timing: null,
        body: Buffer.from('{"ok":true}', 'utf8')
    });
    assert.ok(entry.request.headersSize > 0);
    assert.strictEqual(entry.response.bodySize, 11);
});

// ---------------------------------------------------------------------------
// Stage 2 -- one artifact: raw.har always
// ---------------------------------------------------------------------------

function writeLog(dir, entries) {
    const p = path.join(dir, 'raw.ndjson');
    fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    return p;
}

test('assembleFromLog writes a genuine HAR 1.2 document', () => {
    const dir = tmpDir('assemble');
    const log = writeLog(dir, [
        capture.buildEntry({ request: fakeRequest(), response: fakeResponse(), timing: null, body: null }),
        capture.buildEntry({ request: fakeRequest(), response: fakeResponse(), timing: null, body: null })
    ]);
    const out = path.join(dir, 'raw.har');
    const result = capture.assembleFromLog(log, out);

    assert.strictEqual(result.entries, 2);
    const har = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(har.log.version, '1.2');
    assert.strictEqual(har.log.entries.length, 2);
});

test('the assembled HAR is not labelled a degraded recovery artifact', () => {
    // Both recorders now run and exactly one survives; the assembled document
    // is a first-class capture, so a banner telling the reader to distrust it
    // is simply false.
    const dir = tmpDir('no-banner');
    const log = writeLog(dir, [
        capture.buildEntry({ request: fakeRequest(), response: fakeResponse(), timing: null, body: null })
    ]);
    const out = path.join(dir, 'raw.har');
    capture.assembleFromLog(log, out);
    const text = fs.readFileSync(out, 'utf8');

    assert.doesNotMatch(text, /RECOVERY ARTIFACT/);
    assert.doesNotMatch(text, /best-effort/i);
    assert.doesNotMatch(text, /Prefer a clean re-capture/i);
});

test('assembleFromLog salvages the rest when the final line was truncated', () => {
    // An abrupt ending mid-write leaves a partial line. Losing the whole
    // capture to one bad line would defeat the fallback's purpose.
    const dir = tmpDir('truncated');
    const log = writeLog(dir, [
        capture.buildEntry({ request: fakeRequest(), response: fakeResponse(), timing: null, body: null })
    ]);
    fs.appendFileSync(log, '{"startedDateTime":"2026-01-01T12:00:09Z","req', 'utf8');
    const out = path.join(dir, 'raw.har');
    const result = capture.assembleFromLog(log, out);

    assert.strictEqual(result.entries, 1);
    assert.strictEqual(result.dropped, 1);
    assert.match(JSON.parse(fs.readFileSync(out, 'utf8')).log.comment, /truncated/);
});

// ---------------------------------------------------------------------------
// Stage 3 -- raw captures are confined to .har-captures/
// ---------------------------------------------------------------------------

test('the raw capture path ignores the output path entirely', () => {
    // The leak this closes: .gitignore documented that pointing the capture
    // directory elsewhere put an unignored, credential-bearing capture one
    // `git add -A` away from a commit. No flag can do that any more.
    const resolved = capture.resolveSessionPaths({
        outputPath: path.join(tmpRoot, 'docs', 'har-reference'),
        capturesRoot: path.join(tmpRoot, '.har-captures'),
        stamp: '2026-01-01-120000'
    });
    assert.ok(resolved.harPath.startsWith(path.join(tmpRoot, '.har-captures')),
        'raw.har must live under the fixed captures root');
    assert.ok(!resolved.harPath.includes('har-reference'),
        'the raw capture must never be written under the output path');
    assert.ok(resolved.outputPath.includes('har-reference'));
});

test('start rejects an attempt to redirect the raw capture directory', () => {
    // --dir was the redirect. `start` must not silently accept and ignore it
    // either: an operator who passes it believes the raw moved.
    assert.ok(!capture.START_OPTIONS.includes('dir'),
        'start must not accept --dir; the raw location is fixed');
    assert.ok(capture.START_OPTIONS.includes('output-path'));
    assert.ok(!capture.START_OPTIONS.includes('storage-state'),
        'storage state is auto-discovered, not an option');
});

// ---------------------------------------------------------------------------
// Stage 4 -- port auto-fallback
// ---------------------------------------------------------------------------

test('findFreePort returns the requested port when it is free', async () => {
    const port = await capture.findFreePort(45871);
    assert.strictEqual(port, 45871);
});

test('findFreePort falls forward past a busy port', async () => {
    const net = require('net');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(45872, '127.0.0.1', resolve));
    try {
        const port = await capture.findFreePort(45872);
        assert.notStrictEqual(port, 45872, 'a busy port must not be a hard error any more');
        assert.ok(port > 45872);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

// ---------------------------------------------------------------------------
// Stage 5 -- storage state auto-discovery
// ---------------------------------------------------------------------------

test('a storage state above the working directory is discovered', () => {
    const root = tmpDir('discover');
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const state = path.join(root, '.har-storage-state.json');
    fs.writeFileSync(state, '{"cookies":[]}', 'utf8');

    assert.strictEqual(capture.discoverStorageState(nested), state);
});

test('an absent storage state is not an error', () => {
    const root = tmpDir('no-state');
    assert.strictEqual(capture.discoverStorageState(root, root), null);
});

// ---------------------------------------------------------------------------
// Stage 7 -- digest
// ---------------------------------------------------------------------------

function har(entries) {
    return { log: { version: '1.2', creator: {}, entries } };
}

test('the digest groups entries by host, method, path template and status', () => {
    // The digest exists so an AI can segment a multi-hundred-MB capture
    // without re-parsing it. Ids in a path are what make two calls to the same
    // operation look like two operations, so they have to be templated away.
    const digest = capture.buildDigest(har([
        { startedDateTime: '2026-01-01T12:00:00Z', time: 10, request: { method: 'GET', url: 'https://api.example.com/v1/posts/1234' }, response: { status: 200, content: { mimeType: 'application/json' } } },
        { startedDateTime: '2026-01-01T12:00:01Z', time: 10, request: { method: 'GET', url: 'https://api.example.com/v1/posts/9876' }, response: { status: 200, content: { mimeType: 'application/json' } } }
    ]));
    const group = digest.groups.find((g) => g.method === 'GET');
    assert.strictEqual(group.count, 2, 'two calls to one operation are one group');
    assert.match(group.pathTemplate, /\{id\}|\{\w+\}/);
    assert.strictEqual(group.host, 'api.example.com');
    assert.strictEqual(group.status, 200);
});

test('the digest reports timing gaps that suggest action boundaries', () => {
    // A human pausing between actions is the only signal in the traffic that
    // says "a new action started here".
    const digest = capture.buildDigest(har([
        { startedDateTime: '2026-01-01T12:00:00Z', time: 5, request: { method: 'GET', url: 'https://api.example.com/a' }, response: { status: 200, content: {} } },
        { startedDateTime: '2026-01-01T12:00:01Z', time: 5, request: { method: 'GET', url: 'https://api.example.com/b' }, response: { status: 200, content: {} } },
        { startedDateTime: '2026-01-01T12:00:31Z', time: 5, request: { method: 'POST', url: 'https://api.example.com/c' }, response: { status: 201, content: {} } }
    ]));
    assert.ok(digest.gaps.length >= 1, 'a 30s pause is an action boundary');
    const gap = digest.gaps[0];
    assert.ok(gap.seconds >= 29);
    assert.strictEqual(gap.beforeIndex, 1);
});

test('the digest records content types and payload shapes, not payloads', () => {
    // A digest that embedded bodies would be as big as the capture, and would
    // carry the credentials the confinement rule exists to contain.
    const digest = capture.buildDigest(har([
        {
            startedDateTime: '2026-01-01T12:00:00Z', time: 5,
            request: { method: 'POST', url: 'https://api.example.com/v1/posts', postData: { mimeType: 'application/json', text: '{"title":"x","secret":"sk-live-abcdefghijklmnop"}' } },
            response: { status: 201, content: { mimeType: 'application/json', text: '{"id":1,"title":"x"}' } }
        }
    ]));
    const group = digest.groups[0];
    assert.deepStrictEqual(group.requestShape.sort(), ['secret', 'title']);
    assert.deepStrictEqual(group.responseShape.sort(), ['id', 'title']);
    assert.doesNotMatch(JSON.stringify(digest), /sk-live-abcdefghijklmnop/,
        'the digest must carry shapes, never values');
});

// ---------------------------------------------------------------------------
// Stage 7 -- the catalogue scaffold
// ---------------------------------------------------------------------------

test('the catalogue scaffold has one Observed row per group', () => {
    const digest = capture.buildDigest(har([
        { startedDateTime: '2026-01-01T12:00:00Z', time: 5, request: { method: 'GET', url: 'https://api.example.com/a' }, response: { status: 200, content: {} } },
        { startedDateTime: '2026-01-01T12:00:01Z', time: 5, request: { method: 'POST', url: 'https://api.example.com/b' }, response: { status: 201, content: {} } }
    ]));
    const rows = capture.buildCatalogueScaffold(digest, { capturedUtc: '2026-01-01T12:00:00Z' });

    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
        assert.strictEqual(row.Status, 'Observed',
            'nothing is Exercised until an AI has actually extracted a reference for it');
        assert.strictEqual(row.HarFile, null);
        assert.ok(Array.isArray(row.Methods) && Array.isArray(row.Endpoints));
        assert.ok(Object.prototype.hasOwnProperty.call(row, 'Action'));
        assert.ok(Object.prototype.hasOwnProperty.call(row, 'Description'));
        assert.strictEqual(row.CapturedUtc, '2026-01-01T12:00:00Z');
    }
});

test('the catalogue is dated to the recording, not to the processing run', () => {
    // Defaulting capturedUtc to "now" dates every row to the scrub instead of
    // the capture, which answers "how old is this evidence of their API" with
    // the wrong number -- and that question is most of why the date is in the
    // filename convention at all.
    const digest = capture.buildDigest(
        har([{ startedDateTime: '2026-01-01T12:00:00Z', time: 5, request: { method: 'GET', url: 'https://api.example.com/a' }, response: { status: 200, content: {} } }]),
        { capturedUtc: '2026-01-01T12:00:00Z' });
    assert.strictEqual(digest.capturedUtc, '2026-01-01T12:00:00Z');
    // The scaffold inherits it rather than stamping its own clock.
    assert.strictEqual(capture.buildCatalogueScaffold(digest)[0].CapturedUtc, '2026-01-01T12:00:00Z');
});

// ---------------------------------------------------------------------------
// Stage 7b -- who runs the catalogue phase
// ---------------------------------------------------------------------------

test('an agent-driven run leaves the catalogue to the calling agent', () => {
    // Shelling out to a second AI from inside one is absurd; the agent that
    // launched the capture reads the digest itself.
    const decision = capture.decideCatalogueRunner({
        env: { CLAUDECODE: '1' },
        isTty: false,
        claudeOnPath: true
    });
    assert.strictEqual(decision.delegatedTo, 'agent');
    assert.strictEqual(decision.pending, true);
});

test('a human interactive run shells out to the claude CLI', () => {
    const decision = capture.decideCatalogueRunner({
        env: {},
        isTty: true,
        claudeOnPath: true
    });
    assert.strictEqual(decision.delegatedTo, 'claude-cli');
    assert.strictEqual(decision.pending, false);
});

test('with no runner available the step is reported, never silently dropped', () => {
    const decision = capture.decideCatalogueRunner({
        env: {},
        isTty: true,
        claudeOnPath: false
    });
    assert.strictEqual(decision.delegatedTo, 'none');
    assert.strictEqual(decision.pending, true);
    assert.ok(decision.promptPath, 'the operator must be told the prompt to run');
});

test('the catalogue prompt is a file, not a literal buried in the driver', () => {
    // One source of truth: the shell-out reads it and SKILL.md points an agent
    // at the same file, so the two can never drift.
    const promptPath = path.join(__dirname, 'catalogue-prompt.md');
    assert.ok(fs.existsSync(promptPath), 'catalogue-prompt.md must exist');
    const text = fs.readFileSync(promptPath, 'utf8');
    assert.match(text, /digest\.json/);
    assert.match(text, /extract-har-reference\.js/);
    assert.match(text, /verify-har-reference\.js/);
    assert.match(text, /Observed/);
});

// ---------------------------------------------------------------------------

run().then((passed) => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.stdout.write(`All capture-har tests passed (${passed})\n`);
}).catch((e) => {
    process.stderr.write(`capture-har.test.js: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
});
