#!/usr/bin/env node
// Behavior tests for generate-api-document.js (issue #382).
//
// A HAR is a record of one session; it is not a specification. Two captures of
// the same flow differ in every incidental way -- one account's data, one
// moment's persisted-query id, one incidental ordering -- and should still
// produce the SAME description of the server. `api.json` is that description,
// and these tests pin the two properties that make it worth trusting:
//
//   * IDEMPOTENCE -- regenerating from unchanged references is byte-identical,
//     so a diff always means something changed. Without it the staleness gate
//     below fires on every run and gets disabled, which costs the repository
//     every check the gate carries.
//   * TRACEABILITY -- every endpoint, field, credential and persisted id names
//     the reference and entry that witnesses it, and `--check` re-opens that
//     entry to confirm. A claim nobody can check is how four hollow references
//     came to carry catalogue rows describing request-side behaviour the files
//     have none of.
//
// Each falsifier below is an ABLATION: break what the assertion checks, watch
// it fail, restore. A gate whose failure nobody has observed is a gate nobody
// has tested.
//
// Zero-dep, runs with `node api-document.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const generate = path.join(__dirname, 'generate-api-document.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-document-')));

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (e) {
        failures++;
        console.error(`FAIL  ${name}`);
        console.error(`      ${e && e.message}`);
    }
}

function runNode(args, cwd) {
    try {
        const out = execFileSync(process.execPath, [generate, ...args], {
            encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
    }
}

// --- fixtures -------------------------------------------------------------
//
// Two references over one provider, deliberately overlapping: the same
// endpoint appears in both, so aggregation ACROSS references is what is under
// test rather than a walk over one file.

function entry(o) {
    return {
        startedDateTime: o.startedDateTime || '2026-01-01T00:00:00.000Z',
        time: 10,
        request: {
            method: o.method || 'POST',
            url: o.url,
            httpVersion: 'HTTP/1.1',
            headers: o.headers || [],
            queryString: o.queryString || [],
            cookies: o.cookies || [],
            headersSize: -1,
            bodySize: -1,
            postData: o.postData,
        },
        response: {
            status: o.status === undefined ? 200 : o.status,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            headers: [],
            cookies: [],
            content: {
                size: -1,
                mimeType: o.responseMime || 'application/json',
                text: o.responseText,
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
        },
        cache: {},
        timings: { send: 1, wait: 8, receive: 1 },
    };
}

function har(entries) {
    return { log: { version: '1.2', creator: { name: 'fixture', version: '1' }, entries } };
}

function formPost(params) {
    return {
        mimeType: 'application/x-www-form-urlencoded',
        text: params.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`).join('&'),
        params,
    };
}

const GRAPHQL_ENTRY = () => entry({
    url: 'https://www.example.invalid/api/graphql/',
    headers: [{ name: 'cookie', value: 'c_user=<Redacted>' }],
    cookies: [{ name: 'c_user', value: '<Redacted>' }],
    postData: formPost([
        { name: 'doc_id', value: '9876543210' },
        { name: 'fb_api_req_friendly_name', value: 'ComposerCreate' },
        { name: 'variables', value: '{}' },
        { name: 'fb_dtsg', value: '<Redacted>' },
    ]),
    responseText: '{"data":{"story":{"id":"1"}},"extensions":{}}',
});

/** A provider directory holding the two references, at a fresh path. */
function makeProvider(name) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'example-composer-2026-01-01.har'), JSON.stringify(har([
        GRAPHQL_ENTRY(),
        // A failed attempt, kept deliberately: it is observed traffic, and its
        // status arrives BEFORE the 400 in the other reference, so a document
        // that listed statuses in the order it met them would differ from one
        // that sorted them.
        Object.assign(GRAPHQL_ENTRY(), { response: Object.assign(GRAPHQL_ENTRY().response, { status: 500 }) }),
        entry({
            method: 'GET',
            url: 'https://www.example.invalid/api/posts/1234',
            responseText: '{"id":"1234","body":"hi"}',
        }),
    ]), null, 2) + '\n', 'utf8');

    // The second reference re-witnesses the SAME graphql endpoint (a different
    // persisted id -- exactly the drift this document exists to make visible)
    // and adds one endpoint of its own.
    fs.writeFileSync(path.join(dir, 'example-delete-2026-02-02.har'), JSON.stringify(har([
        entry({
            url: 'https://www.example.invalid/api/graphql/',
            headers: [{ name: 'cookie', value: 'c_user=<Redacted>' }],
            postData: formPost([
                { name: 'doc_id', value: '1111111111' },
                { name: 'variables', value: '{}' },
            ]),
            status: 400,
            responseText: '{"errors":[]}',
        }),
        entry({
            method: 'DELETE',
            url: 'https://www.example.invalid/api/posts/5678',
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');

    fs.writeFileSync(path.join(dir, 'README.md'),
        '# Example references\n\nHand-written prose that regeneration must not touch.\n', 'utf8');
    return dir;
}

function readDoc(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8'));
}

function endpointOf(doc, method, template) {
    const found = doc.endpoints.filter((e) => e.method === method && e.pathTemplate === template);
    assert.strictEqual(found.length, 1, `expected exactly one ${method} ${template}, got ${found.length}`);
    return found[0];
}

const names = (list) => list.map((x) => x.name);

// --- aggregation ----------------------------------------------------------

console.log('generate-api-document -- aggregation');

test('writes api.json describing every endpoint across every reference', () => {
    const dir = makeProvider('aggregate');
    const run = runNode(['--dir', dir]);
    assert.strictEqual(run.code, 0, `exit ${run.code}: ${run.stderr}`);

    const doc = readDoc(dir);
    assert.deepStrictEqual(
        doc.endpoints.map((e) => `${e.method} ${e.pathTemplate}`).sort(),
        ['DELETE /api/posts/{id}', 'GET /api/posts/{id}', 'POST /api/graphql/'],
        'every endpoint in either reference is described exactly once');
});

test('names the provider and both references it read', () => {
    const dir = makeProvider('references');
    runNode(['--dir', dir]);
    const doc = readDoc(dir);

    assert.strictEqual(doc.provider, 'references');
    assert.deepStrictEqual(doc.references.map((r) => r.harFile),
        ['example-composer-2026-01-01.har', 'example-delete-2026-02-02.har']);
    assert.deepStrictEqual(doc.references.map((r) => r.entryCount), [3, 2]);
});

test('one endpoint aggregates the statuses and fields of BOTH references', () => {
    const dir = makeProvider('across');
    runNode(['--dir', dir]);
    const graphql = endpointOf(readDoc(dir), 'POST', '/api/graphql/');

    assert.deepStrictEqual(graphql.statuses, [200, 400, 500],
        'a status observed in any reference is described, in a declared order rather '
        + 'than the order the traffic happened to arrive in');
    assert.deepStrictEqual(names(graphql.requestFields),
        ['doc_id', 'fb_api_req_friendly_name', 'variables'],
        'form parameter names from both references, minus the credential');
    assert.deepStrictEqual(names(graphql.responseFields), ['data', 'errors', 'extensions'],
        'top-level response keys from both references');
});

test('a path with an id collapses to the same template as its sibling', () => {
    const dir = makeProvider('template');
    runNode(['--dir', dir]);
    const doc = readDoc(dir);
    assert.ok(doc.endpoints.some((e) => e.pathTemplate === '/api/posts/{id}'),
        '/api/posts/1234 and /api/posts/5678 are one endpoint, not two');
});

test('persisted operation ids from both references are described, with the name', () => {
    const dir = makeProvider('operations');
    runNode(['--dir', dir]);
    const graphql = endpointOf(readDoc(dir), 'POST', '/api/graphql/');

    assert.deepStrictEqual(graphql.operations.map((o) => o.persistedId), ['1111111111', '9876543210'],
        'both ids -- a rotated id is a DIFF against this document, not a discovery');
    const named = graphql.operations.find((o) => o.persistedId === '9876543210');
    assert.strictEqual(named.name, 'ComposerCreate');
});

test('credentials are described by NAME, and their values never appear', () => {
    const dir = makeProvider('credentials');
    runNode(['--dir', dir]);
    const doc = readDoc(dir);
    const graphql = endpointOf(doc, 'POST', '/api/graphql/');

    assert.deepStrictEqual(graphql.credentialFields.map((c) => `${c.in}:${c.name}`),
        ['cookie:c_user', 'header:cookie', 'param:fb_dtsg'],
        'what a request must CARRY, named from the same list the leak gate uses');
    assert.ok(!names(graphql.requestFields).includes('fb_dtsg'),
        'a credential is not also an ordinary request field');

    const raw = fs.readFileSync(path.join(dir, 'api.json'), 'utf8');
    assert.ok(!raw.includes('<Redacted>'),
        'no credential VALUE reaches the document, redacted or otherwise');
});

// --- determinism ----------------------------------------------------------

console.log('generate-api-document -- idempotence');

test('regenerating over unchanged references is byte-identical', () => {
    const dir = makeProvider('idempotent');
    runNode(['--dir', dir]);
    const first = fs.readFileSync(path.join(dir, 'api.json'));
    runNode(['--dir', dir]);
    assert.ok(first.equals(fs.readFileSync(path.join(dir, 'api.json'))),
        'a diff must mean something changed, never that the generator ran twice');
});

test('the document does not depend on the order the references are read', () => {
    // The ablation the issue names: non-deterministic ordering is the usual way
    // a generated artifact churns a diff on every run. Reading the same two
    // references under names that sort the other way must still produce the
    // same endpoints in the same order.
    const forward = makeProvider('order-forward');
    runNode(['--dir', forward]);
    const forwardDoc = readDoc(forward);

    const reversed = path.join(tmp, 'order-reversed');
    fs.mkdirSync(reversed, { recursive: true });
    for (const [from, to] of [['example-composer-2026-01-01.har', 'z-second.har'],
        ['example-delete-2026-02-02.har', 'a-first.har']]) {
        fs.copyFileSync(path.join(forward, from), path.join(reversed, to));
    }
    runNode(['--dir', reversed]);
    const reversedDoc = readDoc(reversed);

    assert.deepStrictEqual(
        reversedDoc.endpoints.map((e) => `${e.method} ${e.pathTemplate}`),
        forwardDoc.endpoints.map((e) => `${e.method} ${e.pathTemplate}`),
        'endpoint order is a declared total order, not the filesystem\'s');
    assert.deepStrictEqual(
        endpointOf(reversedDoc, 'POST', '/api/graphql/').operations.map((o) => o.persistedId),
        endpointOf(forwardDoc, 'POST', '/api/graphql/').operations.map((o) => o.persistedId));
});

test('regeneration leaves hand-written prose in the directory untouched', () => {
    const dir = makeProvider('prose');
    const before = fs.readFileSync(path.join(dir, 'README.md'));
    const refBefore = fs.readFileSync(path.join(dir, 'example-composer-2026-01-01.har'));
    runNode(['--dir', dir]);

    assert.ok(before.equals(fs.readFileSync(path.join(dir, 'README.md'))),
        'the generator owns api.json and nothing else');
    assert.ok(refBefore.equals(fs.readFileSync(path.join(dir, 'example-composer-2026-01-01.har'))),
        'and it never rewrites the ground truth it read');
});

// --- traceability ---------------------------------------------------------

console.log('generate-api-document -- traceability');

test('every claim names a reference and an entry that contains it', () => {
    const dir = makeProvider('witnesses');
    runNode(['--dir', dir]);
    const doc = readDoc(dir);

    const claims = [];
    for (const endpoint of doc.endpoints) {
        claims.push(endpoint);
        claims.push(...endpoint.requestFields, ...endpoint.responseFields,
            ...endpoint.credentialFields, ...endpoint.operations);
    }
    assert.ok(claims.length > 0);
    for (const claim of claims) {
        assert.ok(Array.isArray(claim.witnesses) && claim.witnesses.length > 0,
            `a claim with no witness cannot be checked: ${JSON.stringify(claim).slice(0, 80)}`);
        for (const w of claim.witnesses) {
            const file = path.join(dir, w.harFile);
            assert.ok(fs.existsSync(file), `witness names a missing reference: ${w.harFile}`);
            const entries = JSON.parse(fs.readFileSync(file, 'utf8')).log.entries;
            assert.ok(w.entry >= 0 && w.entry < entries.length,
                `witness entry ${w.entry} is out of range in ${w.harFile}`);
        }
    }
});

test('the graphql endpoint is witnessed by BOTH references', () => {
    const dir = makeProvider('both-witnesses');
    runNode(['--dir', dir]);
    const graphql = endpointOf(readDoc(dir), 'POST', '/api/graphql/');
    assert.deepStrictEqual(graphql.witnesses.map((w) => w.harFile),
        ['example-composer-2026-01-01.har', 'example-delete-2026-02-02.har']);
    assert.deepStrictEqual(graphql.witnesses.map((w) => w.entry), [0, 0]);
});

// --- the check ------------------------------------------------------------

console.log('generate-api-document --check');

test('--check passes on a freshly generated document and writes nothing', () => {
    const dir = makeProvider('check-clean');
    runNode(['--dir', dir]);
    const before = fs.readFileSync(path.join(dir, 'api.json'));

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 0, `exit ${run.code}: ${run.stderr}`);
    assert.ok(before.equals(fs.readFileSync(path.join(dir, 'api.json'))));
});

test('--check fails and names api.json stale when a reference changed', () => {
    // The falsifier from the comment on #382: commit a reference change without
    // regenerating. Note WHICH reference is edited -- the second one -- while
    // the endpoint it changes is shared. Aggregation makes the blast radius the
    // whole provider, so the check must regenerate everything.
    const dir = makeProvider('check-stale');
    runNode(['--dir', dir]);

    const file = path.join(dir, 'example-delete-2026-02-02.har');
    const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
    edited.log.entries[0].request.postData.params.push({ name: 'newly_added_field', value: '1' });
    fs.writeFileSync(file, JSON.stringify(edited, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /api\.json/, 'the message names the stale artifact');
    assert.match(run.stderr, /stale|regenerat/i);
});

test('--check fails when api.json has never been generated', () => {
    const dir = makeProvider('check-missing');
    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /api\.json/);
});

test('--check fails on a planted claim no entry witnesses', () => {
    // The assertion the catalogue cannot make. A hand-written claim is exactly
    // what a generated document exists to prevent, so the check must reject one
    // INDEPENDENTLY of the generator -- by re-opening the named entry -- not
    // merely because a regeneration happened to differ.
    const dir = makeProvider('check-planted');
    runNode(['--dir', dir]);

    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const graphql = doc.endpoints.find((e) => e.pathTemplate === '/api/graphql/');
    graphql.requestFields.push({
        name: 'invented_field',
        witnesses: [{ harFile: 'example-composer-2026-01-01.har', entry: 0 }],
    });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /invented_field/, 'the message names the unwitnessed claim');
});

test('--check fails when a witness names a reference that does not exist', () => {
    const dir = makeProvider('check-ghost-file');
    runNode(['--dir', dir]);

    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.endpoints[0].witnesses = [{ harFile: 'never-captured.har', entry: 0 }];
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /never-captured\.har/);
});

test('--check fails when a witness names an entry beyond the end of its reference', () => {
    const dir = makeProvider('check-ghost-entry');
    runNode(['--dir', dir]);

    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.endpoints[0].witnesses = [{ harFile: 'example-composer-2026-01-01.har', entry: 99 }];
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /99/);
});

test('--check fails when a reference in the directory has no representation', () => {
    const dir = makeProvider('check-unrepresented');
    runNode(['--dir', dir]);

    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.references = doc.references.filter((r) => r.harFile !== 'example-delete-2026-02-02.har');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /example-delete-2026-02-02\.har/);
});

test('--check reports the planted claim even though regeneration also differs', () => {
    // Both failures fire at once here. The point is that the traceability
    // message survives: a check that only ever said "run the generator" would
    // tell a reader nothing about WHICH claim has no support.
    const dir = makeProvider('check-both');
    runNode(['--dir', dir]);
    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.endpoints[0].responseFields.push({
        name: 'phantom',
        witnesses: [{ harFile: 'example-composer-2026-01-01.har', entry: 0 }],
    });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3);
    assert.match(run.stderr, /phantom/);
});

// --- usage ----------------------------------------------------------------

console.log('generate-api-document -- usage');

test('refuses to run without --dir', () => {
    const run = runNode([]);
    assert.strictEqual(run.code, 2, `expected a usage error, got ${run.code}`);
});

test('a directory that does not exist is an error, not an empty document', () => {
    const run = runNode(['--dir', path.join(tmp, 'no-such-provider')]);
    assert.strictEqual(run.code, 1, `expected an I/O error, got ${run.code}`);
});

test('a directory with no references is an error, not an empty document', () => {
    // Being pointed at nothing is a wiring mistake, not a pass -- the same
    // reading verify-har-reference.js takes of an empty reference directory.
    const empty = path.join(tmp, 'no-references');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, 'README.md'), 'nothing here\n', 'utf8');

    const run = runNode(['--dir', empty]);
    assert.strictEqual(run.code, 1, `expected an I/O error, got ${run.code}`);
    assert.ok(!fs.existsSync(path.join(empty, 'api.json')),
        'an empty document would be a specification asserting the API has nothing in it');
});

test('a reference that is not parseable JSON is an error, not a skip', () => {
    const dir = makeProvider('unparseable');
    fs.writeFileSync(path.join(dir, 'broken.har'), '{ this is not json', 'utf8');
    const run = runNode(['--dir', dir]);
    assert.strictEqual(run.code, 1, `expected an I/O error, got ${run.code}`);
    assert.match(run.stderr, /broken\.har/);
});

// --------------------------------------------------------------------------

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
    console.error(`\n${failures} failing`);
    process.exit(1);
}
console.log('\nall green');
