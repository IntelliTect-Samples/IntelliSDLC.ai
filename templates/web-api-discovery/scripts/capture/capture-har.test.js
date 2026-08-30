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
const { initProtectedRepo } = require(path.join(__dirname, '..', 'har', 'har-test-repo.js'));

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

test('buildEntry distinguishes an empty body from one it could not read', () => {
    // A redirect, a streamed response, or one already discarded yields no
    // body. Reporting bodySize 0 there is a claim -- "the server sent nothing"
    // -- that the recorder cannot support; -1 is HAR's "not available".
    const unread = capture.buildEntry({
        request: fakeRequest(),
        response: fakeResponse(),
        timing: null,
        body: null,
        bodyAvailable: false
    });
    assert.strictEqual(unread.response.bodySize, -1);

    const empty = capture.buildEntry({
        request: fakeRequest(),
        response: fakeResponse({ headers: {} }),
        timing: null,
        body: Buffer.alloc(0),
        bodyAvailable: true
    });
    assert.strictEqual(empty.response.bodySize, 0);
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
// Stage 3 -- raw captures are confined to .har-captures/, and both roots are
// keyed on the captured URI (issue #290)
// ---------------------------------------------------------------------------

test('the raw capture path ignores the output path entirely', () => {
    // The leak this closes: .gitignore documented that pointing the capture
    // directory elsewhere put an unignored, credential-bearing capture one
    // `git add -A` away from a commit. No flag can do that any more.
    const resolved = capture.resolveSessionPaths({
        uri: 'https://app.example.com/login',
        outputPath: path.join(tmpRoot, 'out'),
        capturesRoot: path.join(tmpRoot, '.har-captures'),
        stamp: '2026-01-01-120000'
    });
    assert.ok(resolved.harPath.startsWith(path.join(tmpRoot, '.har-captures')),
        'raw.har must live under the fixed captures root');
    assert.ok(!resolved.harPath.startsWith(resolved.outputPath),
        'the raw capture must never be written under the output path');
});

test('both roots are keyed on the captured host', () => {
    // Two captures against different sites used to collide: scrubbed.har,
    // digest.json and catalogue.json are fixed filenames under one output
    // directory, so the second silently overwrote the first.
    const resolved = capture.resolveSessionPaths({
        uri: 'https://app.example.com/login',
        outputPath: path.join(tmpRoot, 'out'),
        capturesRoot: path.join(tmpRoot, '.har-captures'),
        stamp: '2026-01-01-120000'
    });
    assert.strictEqual(resolved.sessionDir,
        path.join(tmpRoot, '.har-captures', 'app.example.com', '2026-01-01-120000'));
    assert.strictEqual(resolved.outputPath,
        path.join(tmpRoot, 'out', 'app.example.com'));
});

test('outside a repo the output path defaults to the current directory', () => {
    // The cwd default is CORRECT here and must stay byte-for-byte unchanged --
    // tmpRoot is not a repository, so there is no root to anchor to.
    const resolved = capture.resolveSessionPaths({
        uri: 'https://app.example.com/',
        cwd: tmpRoot,
        capturesRoot: path.join(tmpRoot, '.har-captures'),
        stamp: '2026-01-01-120000'
    });
    assert.strictEqual(resolved.outputPath,
        path.join(path.resolve(tmpRoot), 'app.example.com'));
});

test('inside a repo the output path defaults to the repo root, not the cwd (#300)', () => {
    // The defect: run from a subdirectory of a checkout, output was created
    // relative to wherever the operator happened to be standing. This test file
    // lives inside a real repository, so __dirname is a genuine "deep in a
    // checkout" cwd -- no fixture required to prove the anchoring.
    const toplevel = require('child_process')
        .execFileSync('git', ['rev-parse', '--show-toplevel'],
            { cwd: __dirname, encoding: 'utf8' }).trim();
    const resolved = capture.resolveSessionPaths({
        uri: 'https://app.example.com/',
        cwd: __dirname,
        capturesRoot: path.join(tmpRoot, '.har-captures'),
        stamp: '2026-01-01-120000'
    });
    // realpath the existing parent, not the not-yet-created host folder.
    assert.strictEqual(fs.realpathSync(path.dirname(resolved.outputPath)),
        fs.realpathSync(toplevel));
    assert.strictEqual(path.basename(resolved.outputPath), 'app.example.com');
});

test('an explicit relative output path still resolves against the cwd (#300)', () => {
    // Anchoring is scoped to the DEFAULT. A relative path the operator typed
    // has to mean what they typed, or the option becomes a riddle.
    const nested = path.join(tmpRoot, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const resolved = capture.resolveSessionPaths({
        uri: 'https://app.example.com/',
        outputPath: 'refs',
        cwd: nested,
        capturesRoot: path.join(tmpRoot, '.har-captures'),
        stamp: '2026-01-01-120000'
    });
    assert.strictEqual(resolved.outputPath,
        path.join(nested, 'refs', 'app.example.com'));
});

test('uriFolder keeps the host and discards path and query', () => {
    // The operator types this URL. A magic-link, password-reset or signed
    // start URL carries its token in the path or the query, and this name
    // becomes a directory next to committable artifacts -- so only the host
    // may survive. Same rationale as the digest's originOf().
    const folder = capture.uriFolder('https://app.example.com/reset/TOKENPATH?t=TOKENQUERY');
    assert.strictEqual(folder, 'app.example.com');
    assert.ok(!folder.includes('TOKENPATH') && !folder.includes('TOKENQUERY'),
        'no URL path or query component may reach the folder name');
});

test('uriFolder preserves periods and renders a port with an underscore', () => {
    // Dashes are legal in hostnames, so a dash is a bad separator: it would be
    // ambiguous with the host's own characters.
    assert.strictEqual(capture.uriFolder('https://my-app.example.com/'), 'my-app.example.com');
    assert.strictEqual(capture.uriFolder('https://localhost:5001/'), 'localhost_5001');
});

test('uriFolder lowercases the host and yields a path-legal name', () => {
    assert.strictEqual(capture.uriFolder('HTTPS://APP.Example.COM/'), 'app.example.com');
    // An IPv6 literal arrives bracketed; brackets and colons are illegal in a
    // Windows path, so nothing outside [a-z0-9._-] may survive.
    assert.match(capture.uriFolder('http://[::1]:8080/'), /^[a-z0-9._-]+$/);
});

test('uriFolder refuses a URI it cannot parse', () => {
    // Falling back to a shared folder would silently re-introduce the
    // collision this change exists to remove.
    assert.throws(() => capture.uriFolder('not-a-url'), /uri/i);
});

test('uriFolder refuses a host that would escape the directory it names', () => {
    // `new URL('http://../evil')` PARSES, and its hostname is '..'. Left
    // alone that walks the session out of .har-captures/ and the output out
    // of its parent entirely -- the raw capture, which carries live session
    // cookies, lands in the working tree. Parsing successfully is not the
    // same as naming a directory safely.
    assert.throws(() => capture.uriFolder('http://../evil'), /host/i);
    assert.throws(() => capture.uriFolder('http://./x'), /host/i);
});

test('uriFolder refuses a URI with no host at all', () => {
    // These parse, and their hostname is ''. An empty folder name collapses
    // every hostless capture into one directory -- the exact collision this
    // keying exists to remove -- and `file:///...` is a plausible paste, not
    // an exotic input.
    for (const uri of ['file:///etc/passwd', 'data:text/plain,x', 'about:blank']) {
        assert.throws(() => capture.uriFolder(uri), /host/i, `${uri} must be refused`);
    }
});

test('uriFolder sidesteps reserved Windows device names', () => {
    // `con`, `nul`, `lpt1` and friends cannot be directories on Windows, and
    // a capture of http://con/ would fail at mkdir with an error naming
    // nothing the operator could act on.
    assert.notStrictEqual(capture.uriFolder('http://con/'), 'con');
    assert.match(capture.uriFolder('http://con/'), /^con/);
    assert.notStrictEqual(capture.uriFolder('http://lpt1:8080/'), 'lpt1_8080');
});

test('uriFolder keeps distinct IPv6 hosts distinct', () => {
    // Folding every one of `[`, `:` and `]` to `_` made addresses that differ
    // only in their zero-groups converge. A colon maps to `-`, which is in
    // the safe set, so the address stays readable and stays unique.
    const a = capture.uriFolder('http://[::1]:8080/');
    const b = capture.uriFolder('http://[fe80::1]:8080/');
    assert.notStrictEqual(a, b);
    assert.match(a, /^[a-z0-9._-]+$/);
    assert.match(b, /^[a-z0-9._-]+$/);
});

// Build a captures root holding `<host>/<stamp>/session.json` for each entry.
function seedSessions(root, entries) {
    for (const [host, sessionStamp] of entries) {
        const dir = path.join(root, host, sessionStamp);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'session.json'),
            JSON.stringify({ sessionDir: dir, endedUtc: '2026-01-01T00:00:00Z' }), 'utf8');
    }
}

test('the newest session is the newest in time, not the last host alphabetically', () => {
    // Sessions used to be direct children of the captures root, so sorting the
    // joined paths sorted by stamp. Now the host comes first in the path, and a
    // path sort would answer "zeta.example.com" for a capture made days before
    // the one under "alpha.example.com" -- silently stopping or cataloguing the
    // wrong session.
    const root = path.join(tmpRoot, 'newest-across-hosts', '.har-captures');
    seedSessions(root, [
        ['zeta.example.com', '2026-01-01-090000'],
        ['alpha.example.com', '2026-06-01-090000']
    ]);
    assert.strictEqual(capture.resolveSession({ dir: root }),
        path.join(root, 'alpha.example.com', '2026-06-01-090000'));
});

test('a session nested under its host is still found', () => {
    const root = path.join(tmpRoot, 'nested-single', '.har-captures');
    seedSessions(root, [['app.example.com', '2026-01-01-120000']]);
    assert.strictEqual(capture.resolveSession({ dir: root }),
        path.join(root, 'app.example.com', '2026-01-01-120000'));
});

test('resolveSession reports nothing when the captures root holds no session', () => {
    const root = path.join(tmpRoot, 'empty-root', '.har-captures');
    fs.mkdirSync(path.join(root, 'app.example.com'), { recursive: true });
    assert.strictEqual(capture.resolveSession({ dir: root }), null);
});

test('a live capture under its host directory is still detected as a conflict', async () => {
    // The single-instance profile guard scans the captures root. Left flat, it
    // would find nothing at the new depth and stop guarding -- silently, which
    // is the worst way for a guard to fail.
    const root = path.join(tmpRoot, 'conflict', '.har-captures');
    const dir = path.join(root, 'app.example.com', '2026-01-01-120000');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
        sessionDir: dir,
        profileDir: '/profiles/capture',
        pid: process.pid          // this process is certainly alive
    }), 'utf8');

    const conflict = await capture.findProfileConflict('/profiles/capture', root);
    assert.ok(conflict, 'a live session nested under its host must be detected');
    assert.strictEqual(conflict.sessionDir, dir);

    assert.strictEqual(await capture.findProfileConflict('/profiles/other', root), null,
        'a different profile is not a conflict');
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

test('the digest reduces the start URL to an origin, dropping any credential in it', () => {
    // The operator types the URL, and a magic-link / password-reset / signed
    // start URL carries its token in the query or the path. digest.json is
    // written to the COMMITTABLE output path, so echoing that URL back
    // verbatim would put a live credential exactly where the whole design
    // promises only scrubbed artifacts land.
    const digest = capture.buildDigest(
        har([{ startedDateTime: '2026-01-01T12:00:00Z', time: 5, request: { method: 'GET', url: 'https://api.example.com/a' }, response: { status: 200, content: {} } }]),
        { uri: 'https://app.example.com/reset?token=eyJhbGciOiJIUzI1NiJ9.secret' });
    assert.strictEqual(digest.uri, 'https://app.example.com');
    assert.doesNotMatch(JSON.stringify(digest), /eyJhbGciOiJIUzI1NiJ9|secret/);
});

// ---------------------------------------------------------------------------
// postProcess -- the containment property, end to end
// ---------------------------------------------------------------------------

// postProcess shells to the real sanitize-har.js and verify-scrub.js, which
// discover the operator profile by walking up from the working directory. So
// these run inside a sandbox with a real profile: a stubbed scrub would prove
// only that the stub works, and the property under test is precisely that the
// real one ran.
function withSandbox(name, entries, fn) {
    // A real repository with the tables gitignored: postProcess shells out to
    // the actual scrub, which since #318 refuses a destination git will not
    // confirm is ignored.
    const dir = initProtectedRepo(tmpDir(name));
    const sessionDir = path.join(dir, '.har-captures', '2026-01-01-120000');
    const outputPath = path.join(dir, 'docs', 'har-reference');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'test-salt',
        literals: { 'operator@example.com': '<UserEmail>' }
    }), 'utf8');
    const harPath = path.join(sessionDir, 'raw.har');
    fs.writeFileSync(harPath, JSON.stringify(har(entries)), 'utf8');
    const session = {
        uri: 'https://app.example.com/start',
        describe: null,
        sessionDir,
        harPath,
        outputPath,
        startedUtc: '2026-01-01T12:00:00Z'
    };
    const cwd = process.cwd();
    process.chdir(dir);
    try { return fn(session, { dir, outputPath, harPath }); } finally { process.chdir(cwd); }
}

const okEntry = {
    startedDateTime: '2026-01-01T12:00:00Z', time: 5,
    request: { method: 'GET', url: 'https://api.example.com/v1/thing', headers: [], queryString: [], cookies: [], headersSize: 10, bodySize: 0 },
    response: { status: 200, statusText: 'OK', headers: [], cookies: [], redirectURL: '', headersSize: 10, bodySize: 2, content: { size: 2, mimeType: 'application/json', text: '{}' } },
    cache: {}, timings: { send: 1, wait: 3, receive: 1 }
};

test('postProcess builds the digest from the SCRUBBED capture, not the raw one', () => {
    // The raw carries the operator's own identifier. If the digest is computed
    // from it, that identifier reaches the host-named output folder -- the
    // directory the design promises receives only scrubbed, verified artifacts.
    const leaky = JSON.parse(JSON.stringify(okEntry));
    leaky.request.url = 'https://api.example.com/v1/users/operator@example.com/posts';

    withSandbox('pp-scrubbed', [leaky], (session, paths) => {
        const state = capture.postProcess(session);
        assert.deepStrictEqual(state.errors, [], 'the scrub itself must succeed');
        const digestText = fs.readFileSync(state.digest.path, 'utf8');
        assert.doesNotMatch(digestText, /operator@example\.com/,
            'the operator literal must not survive into the digest');
        const catalogueText = fs.readFileSync(state.catalogue.path, 'utf8');
        assert.doesNotMatch(catalogueText, /operator@example\.com/,
            'nor into the catalogue, whose Endpoints come from the same groups');
    });
});

test('postProcess writes nothing to the output path when the scrub fails', () => {
    // Reporting a digest built from an unscrubbed capture would be worse than
    // reporting no digest: it looks like a safe artifact.
    withSandbox('pp-noscrub', [okEntry], (session, paths) => {
        fs.unlinkSync(path.join(paths.dir, '.har-profile.json'));   // scrub cannot run
        const state = capture.postProcess(session);
        assert.ok(state.errors.length, 'a failed scrub must be reported');
        assert.ok(!fs.existsSync(path.join(paths.outputPath, 'digest.json')),
            'no digest may be derived from an unscrubbed capture');
        assert.ok(!fs.existsSync(path.join(paths.outputPath, 'catalogue.json')));
        assert.ok(fs.existsSync(paths.harPath), 'the raw capture is always kept');
    });
});

test('postProcess writes nothing to the output path when the scrub does not VERIFY', () => {
    // The dangerous middle case: sanitize-har.js runs and writes a file, but
    // verify-scrub.js then finds a leak in it. Gating on "a scrubbed file
    // exists" instead of "the scrub verified clean" lets that file, plus a
    // digest and catalogue derived from it, land in the committable output
    // path -- and exit 6 arrives only AFTER they are already on disk, so
    // `git add -A` beats the warning.
    //
    // The verdict is injected rather than provoked. The two stages apply
    // deliberately different detectors, so a value they disagree about exists
    // -- but pinning THIS behavior to whichever value currently splits them
    // would test sanitize-har.js's pattern list, not the decision under test,
    // and would silently stop covering it the day that list grows.
    //
    // sanitize still runs for real, so scrubbed.har is genuinely written and
    // the assertion "nothing was left behind" has something to be wrong about.
    withSandbox('pp-unverified', [okEntry], (session, paths) => {
        const state = capture.postProcess(session, {
            run: (script, argv) => script.endsWith('verify-scrub.js')
                ? { ok: false, status: 3, stdout: '', stderr: 'leak detected' }
                : capture.runNode(script, argv)
        });

        assert.strictEqual(state.scrubbed.verified, false);
        assert.ok(!fs.existsSync(path.join(paths.outputPath, 'digest.json')),
            'no digest may be derived from a capture that failed the leak gate');
        assert.ok(!fs.existsSync(path.join(paths.outputPath, 'catalogue.json')));
        // sanitize writes scrubbed.har before verify judges it, so a rejected
        // scrub would otherwise leave a known-leaking file in the committable
        // directory, named as though it were the safe artifact.
        assert.ok(!fs.existsSync(path.join(paths.outputPath, 'scrubbed.har')),
            'a scrub the gate rejected must not be left in the output path');
        assert.ok(fs.existsSync(paths.harPath),
            'the raw capture is still kept -- it is the only copy of the recording');
        assert.ok(state.errors.length, 'and the failure must be reported');
    });
});

test('postProcess still produces artifacts when the scrub verifies', () => {
    // The mirror of the gate above. Without it, "withhold on failure" could
    // regress into "withhold always" and every test above would still pass.
    withSandbox('pp-verified', [okEntry], (session, paths) => {
        const state = capture.postProcess(session);
        assert.strictEqual(state.scrubbed.verified, true);
        assert.ok(fs.existsSync(path.join(paths.outputPath, 'digest.json')));
        assert.ok(fs.existsSync(path.join(paths.outputPath, 'catalogue.json')));
    });
});

test('postProcess does not clobber a catalogue an earlier AI pass already filled in', () => {
    withSandbox('pp-keep', [okEntry], (session, paths) => {
        fs.mkdirSync(paths.outputPath, { recursive: true });
        const cataloguePath = path.join(paths.outputPath, 'catalogue.json');
        fs.writeFileSync(cataloguePath, JSON.stringify([{
            Action: 'composer-story-create', Description: 'named by a human',
            Methods: ['POST'], Endpoints: ['api.example.com/v1/posts'],
            EntryCount: 3, Status: 'Exercised', HarFile: 'x.har',
            CapturedUtc: '2026-01-01T12:00:00Z'
        }]), 'utf8');

        const state = capture.postProcess(session);
        const rows = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
        assert.strictEqual(rows[0].Action, 'composer-story-create',
            're-capturing must not erase actions already named and exercised');
        assert.deepStrictEqual(state.catalogue.actions, ['composer-story-create']);
    });
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
// Stage 6 -- console output is levelled (#288)
//
// The console is the product here. An operator who just wants to browse and
// get a catalogue was reading a dozen lines of resolved paths, with the one
// line that matters -- how to end the recording cleanly -- buried among them.
//
// The lines are built as (level, text) pairs by pure functions and rendered
// through a threshold, so what an operator sees at each level is assertable
// without launching a browser or spawning a process.
// ---------------------------------------------------------------------------

function fakeSession(overrides) {
    return Object.assign({
        uri: 'https://example.com/',
        profileDir: '/tmp/profile-livetest-f76b1e97',
        storageState: null,
        externalProfile: false,
        harPath: '/tmp/.har-captures/example.com/2026-08-27-210525/raw.har',
        outputPath: '/tmp/example.com',
        cdpEndpoint: 'http://localhost:9333',
        port: 9333,
        requestedPort: 9333
    }, overrides);
}

test('setLogLevel rejects a value that is not a level', () => {
    // Silently falling back to `normal` would make a typo look like a working
    // --log-level, and the operator would blame the tool for ignoring them.
    assert.throws(() => capture.setLogLevel('loud'), /log-level/);
    capture.setLogLevel('normal');
});

test('log-level is an accepted start option', () => {
    assert.ok(capture.START_OPTIONS.includes('log-level'),
        'start must accept the level its PowerShell front door forwards');
});

test('the default banner names the site and how to end, not the paths', () => {
    const text = capture.renderLines(capture.startBannerLines(fakeSession()), 'normal');
    assert.match(text, /recording https:\/\/example\.com/);
    assert.match(text, /press ENTER/);
    assert.doesNotMatch(text, /profile:/, 'the profile path is a diagnostic');
    assert.doesNotMatch(text, /raw:/, 'the raw path is a diagnostic');
    assert.doesNotMatch(text, /cdp:/, 'the debugging endpoint is a diagnostic');
});

test('the verbose banner adds the resolved paths and the endpoint', () => {
    const text = capture.renderLines(capture.startBannerLines(fakeSession()), 'verbose');
    assert.match(text, /profile:\s+\/tmp\/profile-livetest/);
    assert.match(text, /raw:\s+\/tmp\/\.har-captures\/example\.com\//);
    assert.match(text, /output:\s+\/tmp\/example\.com/);
    assert.match(text, /cdp:\s+http:\/\/localhost:9333/);
});

test('the ENTER recommendation is one sentence, with no snapshot folklore', () => {
    // The old block spent three lines on Ctrl+C and a "recovery snapshot" that
    // no longer exists. Closing the window now yields a genuine raw.har, so
    // the recommendation is a preference, not a warning.
    const text = capture.renderLines(capture.startBannerLines(fakeSession()), 'verbose');
    assert.doesNotMatch(text, /Ctrl\+C/);
    assert.doesNotMatch(text, /(?:recovery|snapshot)/i);
    const enterLines = text.split('\n').filter((l) => /ENTER/.test(l));
    assert.strictEqual(enterLines.length, 1, 'exactly one line mentions ENTER');
});

test('the caveat about borrowing another tool\'s profile survives the default level', () => {
    // This one is not a diagnostic: it tells the operator that some other tool
    // is locked out for the duration, which they need before they browse.
    const text = capture.renderLines(
        capture.startBannerLines(fakeSession({ externalProfile: true })), 'normal');
    assert.match(text, /another tool/i);
});

test('a default run still says which artifacts it produced', () => {
    // Hiding these behind -Verbose would end a default run without naming the
    // two files the operator acts on next.
    const text = capture.renderLines(capture.postProcessLines(fakeSession({
        postProcess: {
            scrubbed: { path: '/tmp/out/scrubbed.har', verified: true },
            digest: { path: '/tmp/out/digest.json' },
            catalogue: { path: '/tmp/out/catalogue.json', delegatedTo: 'agent' },
            errors: []
        }
    })), 'normal');
    assert.match(text, /scrubbed:\s+\/tmp\/out\/scrubbed\.har/);
    assert.match(text, /catalogue:\s+\/tmp\/out\/catalogue\.json/);
    assert.doesNotMatch(text, /digest:/, 'the digest is an intermediate');
    assert.doesNotMatch(text, /raw:/, 'the raw path is a diagnostic');
});

test('a leak-gate rejection is never levelled away', () => {
    // The one report that must reach an operator who never types -Verbose:
    // a scrub the gate refused, and the reason.
    const text = capture.renderLines(capture.postProcessLines(fakeSession({
        postProcess: {
            scrubbed: { path: null, removed: true, verified: false },
            errors: ['verify-scrub: bearer token survived the scrub']
        }
    })), 'normal');
    assert.match(text, /REJECTED/);
    assert.match(text, /bearer token survived/);
});

// ---------------------------------------------------------------------------
// The placement guard fires BEFORE anything is recorded (#300)
// ---------------------------------------------------------------------------

// A primary checkout on the protected branch that declares the no-work-on-main
// rule the way this repository does -- a tracked hooks directory. Built with
// real git, because the guard's whole job is to read what git actually says.
function makeGuardedCheckout(name) {
    const cp = require('child_process');
    const g = (cwd, ...args) => cp.execFileSync('git', args,
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

    const seed = path.join(tmpRoot, name + '-seed');
    fs.mkdirSync(path.join(seed, '.githooks'), { recursive: true });
    g(seed, 'init', '--initial-branch', 'main');
    g(seed, 'config', 'user.email', 't@example.com');
    g(seed, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(seed, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    g(seed, 'add', '-A');
    g(seed, 'commit', '-m', 'seed');

    const bare = path.join(tmpRoot, name + '.git');
    g(tmpRoot, 'clone', '--bare', seed, bare);
    const work = path.join(tmpRoot, name);
    g(tmpRoot, 'clone', bare, work);
    g(work, 'config', 'core.hooksPath', '.githooks');
    return work;
}

test('the placement guard warns before any capture begins', () => {
    // --validate-only never opens a browser and never writes a HAR, so a
    // warning on this run proves the guard sits ahead of the recording rather
    // than after it. That ordering is the load-bearing part of the design: a
    // guard downstream would be choosing whether to discard a recording the
    // operator already spent minutes producing.
    const work = makeGuardedCheckout('guard-order');
    const res = require('child_process').spawnSync(
        process.execPath,
        [path.join(__dirname, 'capture-har.js'), 'start',
            '--uri', 'https://app.example.com', '--port', '0', '--validate-only'],
        { cwd: work, encoding: 'utf8' });

    assert.strictEqual(res.status, 0, 'the guard must not turn an advisory into a failure');
    assert.match(res.stderr, /primary checkout/i, 'says what it detected');
    assert.match(res.stderr, /git worktree add/, 'gives the exact command to run instead');
    // stdout stays parseable JSON -- the warning must not corrupt the contract.
    JSON.parse(res.stdout);
});

test('the closing notice names what was written and how to relocate it (#300)', () => {
    // Since the guard proceeds, an operator who ignored it must not be left to
    // work out what to tidy. Raw captures are already confined to a gitignored
    // directory, so the polluting set is exactly one host-named folder -- which
    // is what makes reducing cleanup to a single move possible at all.
    const lines = capture.postProcessLines({
        harPath: '/repo/.har-captures/app.example.com/x/raw.har',
        outputPath: '/repo/app.example.com',
        placement: {
            shouldWarn: true,
            protectedBranch: 'main',
            topLevel: '/repo'
        },
        postProcess: { catalogue: { path: '/repo/app.example.com/catalogue.json', delegatedTo: 'agent' } }
    });
    const text = lines.map((l) => l[1]).join('\n');
    assert.match(text, /app\.example\.com/, 'names the folder actually written');
    assert.match(text, /git worktree add/, 'gives the worktree command');
    assert.match(text, /(^|\s)mv\s/m, 'reduces cleanup to a single move');
});

test('the recorder keeps the closing notice even when a front door warned (#300)', () => {
    // Ownership is split on purpose. The front door owns the OPENING warning,
    // because it is printed before this process exists and so cannot be lost.
    // The recorder owns the CLOSING notice, because it is the process that
    // actually wrote the files and prints it in-process.
    //
    // Suppressing this copy to avoid a duplicate would make the notice depend
    // on the front door surviving from spawn to epilogue. A killed terminal, a
    // hard Ctrl+C or an agent dying mid-session would then take the notice with
    // it -- and it would be persisted as null in session.json, so `stop` and
    // `status` recovery would stay silent too. A notice that only arrives when
    // nothing went wrong is not a safety net.
    const work = makeGuardedCheckout('guard-dupe');
    const res = require('child_process').spawnSync(
        process.execPath,
        [path.join(__dirname, 'capture-har.js'), 'start',
            '--uri', 'https://app.example.com', '--port', '0', '--validate-only'],
        {
            cwd: work,
            encoding: 'utf8',
            env: Object.assign({}, process.env, { HARCAPTURE_PLACEMENT_GUARD_RAN: '1' })
        });

    assert.strictEqual(res.status, 0);
    assert.doesNotMatch(res.stderr, /primary checkout/i,
        'the opening warning belongs to the front door that already printed it');

    const session = JSON.parse(res.stdout);
    assert.ok(session.placement, 'the recorder must keep ownership of the closing notice');
    assert.strictEqual(session.placement.shouldWarn, true);

    // Persisted, so a later `stop` or `status` in another process can still
    // report it without re-probing.
    const lines = capture.postProcessLines(session).map((l) => l[1]).join('\n');
    assert.match(lines, /git worktree add/, 'the persisted session still yields the notice');
});

test('there is no closing notice when the guard never fired (#300)', () => {
    const lines = capture.postProcessLines({
        harPath: '/repo/.har-captures/app.example.com/x/raw.har',
        outputPath: '/repo/app.example.com',
        placement: null,
        postProcess: { catalogue: { path: '/repo/app.example.com/catalogue.json', delegatedTo: 'agent' } }
    });
    const text = lines.map((l) => l[1]).join('\n');
    assert.doesNotMatch(text, /git worktree add/);
});

test('the placement guard stays silent in a worktree', () => {
    const work = makeGuardedCheckout('guard-quiet');
    const wt = path.join(tmpRoot, 'guard-quiet-wt');
    require('child_process').execFileSync('git',
        ['worktree', 'add', wt, '-b', 'feat/q'],
        { cwd: work, stdio: ['ignore', 'ignore', 'ignore'] });

    const res = require('child_process').spawnSync(
        process.execPath,
        [path.join(__dirname, 'capture-har.js'), 'start',
            '--uri', 'https://app.example.com', '--port', '0', '--validate-only'],
        { cwd: wt, encoding: 'utf8' });

    assert.strictEqual(res.status, 0);
    assert.doesNotMatch(res.stderr, /primary checkout/i,
        'a worktree is the sanctioned place to work and must never be warned about');
});

// ---------------------------------------------------------------------------

run().then((passed) => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.stdout.write(`All capture-har tests passed (${passed})\n`);
}).catch((e) => {
    process.stderr.write(`capture-har.test.js: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
});
