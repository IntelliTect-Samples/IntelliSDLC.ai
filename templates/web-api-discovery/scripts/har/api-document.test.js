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
    url: 'https://www.example.invalid/api/graphql/?_callFlowletID=0',
    // A query parameter on the SAME endpoint that carries form parameters.
    // Sorted by name alone, `_callFlowletID` leads; sorted by (where it lives,
    // name) it trails the form parameters. Without both on one endpoint the
    // `in` half of the order could not fail.
    queryString: [{ name: '_callFlowletID', value: '0' }],
    headers: [{ name: 'cookie', value: 'c_user=<Redacted>' }],
    cookies: [{ name: 'c_user', value: '<Redacted>' }],
    // Deliberately NOT alphabetical, and not the order the document emits.
    postData: formPost([
        { name: 'variables', value: '{}' },
        { name: 'doc_id', value: '9876543210' },
        { name: 'fb_api_req_friendly_name', value: 'ComposerCreate' },
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
            url: 'https://www.example.invalid/api/posts/1234?fields=body&depth=1',
            queryString: [{ name: 'fields', value: 'body' }, { name: 'depth', value: '1' }],
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

// --- the shared definition ------------------------------------------------

console.log('generate-api-document -- one definition of "the same endpoint"');

test('reaches the shared path templater without loading the recorder', () => {
    // api.json, digest.json and the catalogue guard must agree about what one
    // endpoint IS; a second notion would make the artifacts disagree about the
    // API they all describe. The templater is owned by har-catalogue.js, so
    // that is where this reads it from.
    //
    // Asserted as a property of the MODULE GRAPH rather than by reading the
    // source: requiring the recorder to obtain a pure function pulls in `net`,
    // `readline`, `child_process` and the incremental recorder, and that cost
    // is the actual reason for importing directly. A test over the import
    // statement would pin the wiring; this pins the consequence.
    const probe = 'const p=require(process.argv[1]);'
        + 'const loaded=Object.keys(require.cache).some((k)=>k.endsWith("capture-har.js"));'
        + 'console.log(loaded?"RECORDER-LOADED":"clean");'
        + 'console.log(typeof require(process.argv[2]).pathTemplate);';
    const out = execFileSync(process.execPath, [
        '-e', probe,
        path.join(__dirname, 'generate-api-document.js'),
        path.join(__dirname, 'har-catalogue.js'),
    ], { encoding: 'utf8' });

    assert.match(out, /^clean/, 'the recorder must not be loaded to get a path templater');
    assert.match(out, /function/, 'and har-catalogue.js is where the templater lives');
});

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
    assert.deepStrictEqual(graphql.requestFields.map((f) => `${f.in}:${f.name}`),
        ['param:doc_id', 'param:fb_api_req_friendly_name', 'param:variables',
            'query:_callFlowletID'],
        'names from both references, minus the credential, ordered by where they '
        + 'live and then by name -- the fixture sends `variables` first and puts '
        + 'the query parameter where a name-only sort would lead with it');
    assert.deepStrictEqual(names(graphql.responseFields), ['data', 'errors', 'extensions'],
        'top-level response keys from both references');
});

test('a query parameter is a request field, tagged with where it lives', () => {
    // `in` is half the claim: the same name in a query string and in a form
    // body are different facts about the endpoint, and --check has to know
    // which one to look for. Ordering is by (in, name), so `query` fields sort
    // after `param` fields and neither inherits the order they arrived in.
    const dir = makeProvider('query-fields');
    runNode(['--dir', dir]);
    const get = endpointOf(readDoc(dir), 'GET', '/api/posts/{id}');

    assert.deepStrictEqual(get.requestFields.map((f) => `${f.in}:${f.name}`),
        ['query:depth', 'query:fields'],
        'declared order, not the order the request happened to list them');
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

test('a credential sent as a JSON body key is a credential, not an ordinary field', () => {
    // Found by independent review. Classification needs the NAME only, and the
    // name is already known for a top-level JSON key -- so excluding bodies
    // described a provider's CSRF token as ordinary API surface. GraphQL APIs
    // that post JSON rather than form-encoding are exactly where this lands.
    const dir = makeProvider('json-body-credential');
    fs.writeFileSync(path.join(dir, 'example-jsonpost-2026-03-03.har'), JSON.stringify(har([
        entry({
            method: 'POST',
            url: 'https://www.example.invalid/api/jsonpost',
            postData: { mimeType: 'application/json', text: '{"fb_dtsg":"REDACTED_TOKEN","message":"hi"}' },
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const post = endpointOf(readDoc(dir), 'POST', '/api/jsonpost');

    assert.deepStrictEqual(post.credentialFields.map((c) => `${c.in}:${c.name}`), ['body:fb_dtsg'],
        'a known credential name is a credential wherever the request carries it');
    assert.deepStrictEqual(names(post.requestFields), ['message'],
        'and it is not ALSO listed as an ordinary request field');
});

test('--check rejects a credential re-listed as an ordinary request field', () => {
    // The traceability pass must catch this on its own. Independent review
    // showed the byte comparison caught it while `entrySupports` did not, which
    // makes the traceability message -- the one that names the offending claim
    // -- silent on a real defect.
    const dir = makeProvider('credential-relisted');
    runNode(['--dir', dir]);
    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const graphql = doc.endpoints.find((e) => e.pathTemplate === '/api/graphql/');
    graphql.requestFields.push({
        name: 'fb_dtsg',
        in: 'param',
        observedIn: 1,
        // Cite the reference that DOES send it. Citing one that does not would
        // be caught by the ordinary missing-witness rule and would prove
        // nothing about whether a credential can masquerade as a plain field.
        witnesses: [{ harFile: 'example-composer-2026-01-01.har', entry: 0 }],
    });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /requestField 'fb_dtsg'/,
        'traceability names it, rather than leaving the byte comparison to say only "it differs"');
});

test('a reference whose log.entries is not an array fails with our own message', () => {
    // Found by independent review: it parsed as JSON, so the parse guard let it
    // through, and the fold then threw a raw Node stack trace. The exit code
    // was right and the message was somebody else's.
    const dir = makeProvider('entries-not-an-array');
    fs.writeFileSync(path.join(dir, 'malformed.har'),
        JSON.stringify({ log: { version: '1.2', entries: 'not an array' } }, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir]);
    assert.strictEqual(run.code, 1, `expected an I/O error, got ${run.code}`);
    assert.match(run.stderr, /malformed\.har/, 'the message names the file');
    assert.ok(!/at Object\.|TypeError/.test(run.stderr),
        'and it is our error, not a raw stack trace');
});

test('verb case does not split one endpoint into two', () => {
    // Found by the #379 session hitting the same defect in buildDigest. An
    // endpoint identity must not depend on the casing a capture tool happened
    // to emit: `post` and `POST` are the same operation, and describing them
    // as two endpoints each witnessed once is a false statement about the API.
    const dir = path.join(tmp, 'verb-case');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'verbs.har'), JSON.stringify(har([
        entry({
            method: 'POST',
            url: 'https://www.example.invalid/api/thing',
            postData: formPost([{ name: 'a', value: '1' }]),
            responseText: '{"ok":true}',
        }),
        entry({
            method: 'post',
            url: 'https://www.example.invalid/api/thing',
            postData: formPost([{ name: 'a', value: '2' }]),
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const doc = readDoc(dir);

    assert.strictEqual(doc.endpoints.length, 1,
        `one operation, one endpoint: ${JSON.stringify(doc.endpoints.map((e) => e.method))}`);
    assert.strictEqual(doc.endpoints[0].method, 'POST', 'described in the registered spelling');
    assert.strictEqual(doc.endpoints[0].observedEntries, 2, 'and witnessed by both calls');
});

test('a lowercase body-bearing verb still raises the request-side hole', () => {
    // The quiet half of the defect. BODY_BEARING_METHODS is matched against
    // the endpoint's method, so a lowercase verb silently skipped the hole --
    // a gap that fails to fire is worse than one that fires wrongly, because
    // nothing reports it.
    const dir = path.join(tmp, 'verb-case-hole');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lower.har'), JSON.stringify(har([
        entry({
            method: 'post',
            url: 'https://www.example.invalid/api/hollow',
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const hollow = endpointOf(readDoc(dir), 'POST', '/api/hollow');

    assert.ok(hollow.unproven.some((u) => u.kind === 'no-request-body-observed'),
        `the hole must fire whatever case the capture recorded: ${JSON.stringify(hollow.unproven)}`);
});

test('mixed-case verbs merge, and the document still passes its own check', () => {
    // Two jobs, and it is worth being explicit that the SECOND one could not
    // fail for this defect: before the fix both the fold and the check read the
    // raw verb, so they agreed with each other while both being wrong, and
    // exit 0 said nothing. Independent review caught that the name promised
    // more than the assertions delivered. It now asserts the merge as well, so
    // it discriminates -- and it keeps the --check call, which is what fails if
    // someone later normalizes the fold and forgets the re-derivation.
    const dir = path.join(tmp, 'verb-case-check');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'verbs.har'), JSON.stringify(har([
        entry({
            method: 'get',
            url: 'https://www.example.invalid/api/thing',
            responseText: '{"ok":true}',
        }),
        entry({
            method: 'GET',
            url: 'https://www.example.invalid/api/thing',
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');
    assert.strictEqual(runNode(['--dir', dir]).code, 0);

    const doc = readDoc(dir);
    assert.strictEqual(doc.endpoints.length, 1, 'the two calls are one endpoint');
    assert.strictEqual(doc.endpoints[0].method, 'GET');
    assert.strictEqual(doc.endpoints[0].observedEntries, 2);

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 0,
        `the check normalizes the same way the fold does, got ${run.code}: ${run.stderr}`);
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

// --- holes -------------------------------------------------------------
//
// The document is authoritative about what the captures PROVED -- nothing more
// and nothing less. "Nothing more" is the easy half: do not describe what was
// not observed. "Nothing less" is this half: where the references do not
// establish something, the document must SAY SO, so the hole is a work item
// rather than a silence a reader mistakes for completeness.
//
// Every hole is derived from the captures, never guessed, and each names the
// capture that would close it.

console.log('generate-api-document -- holes the captures leave');

test('an endpoint with no successful response says so, and says what would close it', () => {
    const dir = makeProvider('gap-no-success');
    fs.writeFileSync(path.join(dir, 'example-errors-2026-03-03.har'), JSON.stringify(har([
        entry({
            method: 'PUT',
            url: 'https://www.example.invalid/api/posts/4242',
            postData: formPost([{ name: 'message', value: 'edited' }]),
            status: 403,
            responseText: '{"error":"forbidden"}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const put = endpointOf(readDoc(dir), 'PUT', '/api/posts/{id}');

    const gap = put.unproven.find((u) => u.kind === 'no-success-observed');
    assert.ok(gap, `expected a no-success hole, got ${JSON.stringify(put.unproven)}`);
    assert.match(gap.closedBy, /captur/i, 'a hole names the capture that would close it');
    assert.ok(gap.witnesses.length > 0, 'and cites the entries it examined to conclude it');
});

test('an endpoint whose request side was never captured says so', () => {
    // The hollow-reference class: the endpoint is known to exist, and NOTHING
    // is known about what a caller must send. Silence here is what let rows
    // describing request-side behaviour survive against files that had none.
    const dir = makeProvider('gap-no-request-body');
    fs.writeFileSync(path.join(dir, 'example-hollow-2026-03-03.har'), JSON.stringify(har([
        entry({
            method: 'POST',
            url: 'https://www.example.invalid/api/uploads',
            // A failing POST with no body: TWO holes at once, and the order
            // they are DERIVED in is the reverse of the order they are
            // reported in. Without an endpoint like this, the hole ordering
            // could not be falsified by any ablation.
            status: 500,
            responseText: '{"id":"u1"}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const post = endpointOf(readDoc(dir), 'POST', '/api/uploads');

    assert.deepStrictEqual(post.unproven.map((u) => u.kind),
        ['no-request-body-observed', 'no-success-observed'],
        'both holes, in a declared order rather than the order they were derived');
});

test('a GET is not accused of a missing request body', () => {
    // A hole must be a real hole. A gate that fires on traffic behaving normally
    // trains its readers to ignore it.
    const dir = makeProvider('gap-get-is-fine');
    runNode(['--dir', dir]);
    const get = endpointOf(readDoc(dir), 'GET', '/api/posts/{id}');
    assert.ok(!get.unproven.some((u) => u.kind === 'no-request-body-observed'),
        'a GET carrying no body is not a gap; it is a GET');
});

test('a truncated response is recorded as a partial description, not a complete one', () => {
    const dir = makeProvider('gap-truncated');
    fs.writeFileSync(path.join(dir, 'example-capped-2026-03-03.har'), JSON.stringify(har([
        (() => {
            const e = entry({
                method: 'GET',
                url: 'https://www.example.invalid/api/feed',
                responseText: '{"items":[',
            });
            e.response.content.truncated = { originalBytes: 900000, keptBytes: 10 };
            return e;
        })(),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const feed = endpointOf(readDoc(dir), 'GET', '/api/feed');

    assert.ok(feed.unproven.some((u) => u.kind === 'response-truncated'),
        'the response field list is partial BY CONSTRUCTION and must say so');
});

test('a persisted id nobody named is a hole, not a nameless fact', () => {
    const dir = makeProvider('gap-unnamed-operation');
    runNode(['--dir', dir]);
    const graphql = endpointOf(readDoc(dir), 'POST', '/api/graphql/');
    const unnamed = graphql.operations.find((o) => o.persistedId === '1111111111');

    assert.strictEqual(unnamed.name, null);
    assert.ok(graphql.unproven.some((u) => u.kind === 'operation-name-unknown'
        && u.detail.includes('1111111111')),
        `expected the unnamed id listed as a hole, got ${JSON.stringify(graphql.unproven)}`);
});

test('a field seen in some calls and not others is a hole, not an inference', () => {
    // The document must NOT say "optional". One capture cannot tell an optional
    // field from a provider change, and saying which would be the guesswork this
    // artifact exists to replace. It says the presence VARIES, and what would
    // settle it.
    const dir = makeProvider('gap-varying-field');
    runNode(['--dir', dir]);
    const graphql = endpointOf(readDoc(dir), 'POST', '/api/graphql/');

    const gap = graphql.unproven.find((u) => u.kind === 'request-field-presence-varies');
    assert.ok(gap, `expected a varying-presence hole, got ${JSON.stringify(graphql.unproven)}`);
    assert.ok(gap.detail.includes('fb_api_req_friendly_name'),
        'the fixture sends it in one reference and not the other');
    assert.ok(!/optional/i.test(JSON.stringify(graphql.unproven)),
        'the document never labels a field optional; that is an inference, not an observation');
});

test('counts are recorded so a reader can see how thin the evidence is', () => {
    const dir = makeProvider('gap-counts');
    runNode(['--dir', dir]);
    const graphql = endpointOf(readDoc(dir), 'POST', '/api/graphql/');

    assert.strictEqual(graphql.observedEntries, 3, 'two calls in one reference, one in the other');
    const friendly = graphql.requestFields.find((f) => f.name === 'fb_api_req_friendly_name');
    assert.strictEqual(friendly.observedIn, 2, 'seen in 2 of the 3 observed calls');
});

test('an endpoint the captures fully establish carries no holes', () => {
    // Holes must be absent when there are none, or the field becomes noise and
    // a reader stops reading it.
    const dir = makeProvider('gap-none');
    runNode(['--dir', dir]);
    const del = endpointOf(readDoc(dir), 'DELETE', '/api/posts/{id}');
    assert.deepStrictEqual(del.unproven, [],
        'a DELETE with a 200 and a response body leaves nothing unproven at this depth');
});

test('regenerating with holes present is still byte-identical', () => {
    const dir = makeProvider('gap-order');
    runNode(['--dir', dir]);
    const first = fs.readFileSync(path.join(dir, 'api.json'));
    runNode(['--dir', dir]);
    assert.ok(first.equals(fs.readFileSync(path.join(dir, 'api.json'))));
});

test('--check rejects a hole the captures do not support', () => {
    // A hole is a claim too -- "this was not proven" is an assertion ABOUT the
    // references, and a hand-written one must fail exactly as a hand-written
    // endpoint does.
    const dir = makeProvider('gap-planted');
    runNode(['--dir', dir]);
    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const del = doc.endpoints.find((e) => e.method === 'DELETE');
    del.unproven.push({
        kind: 'no-success-observed',
        detail: 'invented: this endpoint never succeeded',
        closedBy: 'capture a successful call',
        witnesses: del.witnesses.slice(),
    });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /no-success-observed/,
        'the message names the hole the captures contradict');
});

test('a freshly generated document passes its own check, even when a name lives in two places', () => {
    // C1, found by independent review. The fold decides a field varies per
    // (WHERE IT LIVES, name); the re-derivation counted by name alone. A name
    // in the query string on one call and in the body on every call made the
    // re-derivation disagree with the fold -- so an honest, unedited document
    // failed its own check. That is the "gate cries wolf" failure the staleness
    // requirement exists to avoid, and a gate that fires on correct output gets
    // disabled, taking every other check it carries with it.
    const dir = path.join(tmp, 'same-name-two-places');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'twoplaces.har'), JSON.stringify(har([
        entry({
            method: 'POST',
            url: 'https://www.example.invalid/api/items?id=7',
            queryString: [{ name: 'id', value: '7' }],
            postData: { mimeType: 'application/json', text: '{"id":"7","note":"a"}' },
            responseText: '{"ok":true}',
        }),
        entry({
            method: 'POST',
            url: 'https://www.example.invalid/api/items',
            postData: { mimeType: 'application/json', text: '{"id":"8","note":"b"}' },
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');

    assert.strictEqual(runNode(['--dir', dir]).code, 0);
    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 0,
        `a document nobody edited must pass its own check, got exit ${run.code}: ${run.stderr}`);
});

test('a field repeated within one call counts as ONE observation of it', () => {
    // I1, found by independent review. `?ids=1&ids=2&ids=3` is one call, not
    // three. Counting per occurrence produced observedIn > observedEntries --
    // a count that contradicts the thing counts exist to show.
    const dir = path.join(tmp, 'repeated-param');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'repeated.har'), JSON.stringify(har([
        entry({
            method: 'GET',
            url: 'https://www.example.invalid/api/items?ids=1&ids=2&ids=3',
            queryString: [
                { name: 'ids', value: '1' }, { name: 'ids', value: '2' }, { name: 'ids', value: '3' },
            ],
            responseText: '{"items":[]}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const items = endpointOf(readDoc(dir), 'GET', '/api/items');

    assert.strictEqual(items.observedEntries, 1);
    const ids = items.requestFields.find((f) => f.name === 'ids');
    assert.strictEqual(ids.observedIn, 1,
        'observedIn counts CALLS that carried the field, never occurrences within one');
});

test('a repeated parameter does not hide a field whose presence varies', () => {
    // The same miscount suppressed a real hole: entry 0 sending `ids` twice
    // made observedIn equal observedEntries, so a field present in one call of
    // two looked present in all of them.
    const dir = path.join(tmp, 'repeated-hides-gap');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'repeated.har'), JSON.stringify(har([
        entry({
            method: 'GET',
            url: 'https://www.example.invalid/api/items?ids=1&ids=2',
            queryString: [{ name: 'ids', value: '1' }, { name: 'ids', value: '2' }],
            responseText: '{"items":[]}',
        }),
        entry({
            method: 'GET',
            url: 'https://www.example.invalid/api/items',
            responseText: '{"items":[]}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const items = endpointOf(readDoc(dir), 'GET', '/api/items');

    const gap = items.unproven.find((u) => u.kind === 'request-field-presence-varies');
    assert.ok(gap, `expected the varying field to be reported, got ${JSON.stringify(items.unproven)}`);
    assert.ok(gap.detail.includes('ids'));
});

test('an endpoint repeatedly captured without a body is not accused of a missing one', () => {
    // I2, found by independent review. A bodyless POST captured twice is
    // evidence that it TAKES no body, and telling a reader to "capture it with
    // the request body preserved" is advice that can never be satisfied. A hole
    // nobody can close is noise, and noise is how a gate gets ignored.
    const dir = path.join(tmp, 'legitimately-bodyless');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['logout-a.har', 'logout-b.har']) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(har([
            entry({
                method: 'POST',
                url: 'https://www.example.invalid/api/logout',
                responseText: '{"ok":true}',
            }),
        ]), null, 2) + '\n', 'utf8');
    }
    runNode(['--dir', dir]);
    const logout = endpointOf(readDoc(dir), 'POST', '/api/logout');

    assert.ok(!logout.unproven.some((u) => u.kind === 'no-request-body-observed'),
        `two references agreeing is evidence, not a hole: ${JSON.stringify(logout.unproven)}`);
});

test('a single bodyless capture IS a hole, because one call cannot tell the two apart', () => {
    const dir = path.join(tmp, 'bodyless-once');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'once.har'), JSON.stringify(har([
        entry({
            method: 'POST',
            url: 'https://www.example.invalid/api/logout',
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const logout = endpointOf(readDoc(dir), 'POST', '/api/logout');

    const gap = logout.unproven.find((u) => u.kind === 'no-request-body-observed');
    assert.ok(gap, 'one reference cannot distinguish "takes no body" from "body not captured"');
    assert.match(gap.closedBy, /again/i, 'and the way to close it is another capture');
});

test('a hole cannot be revived by trimming the witnesses that disprove it', () => {
    // M2, found by independent review. The single-reference precondition was
    // read off the COMMITTED document rather than re-derived from the
    // references, so trimming a witness could flip it. Every other part of the
    // re-derivation walks the entries on disk; this one trusted the file it is
    // supposed to be checking.
    const dir = path.join(tmp, 'trimmed-witness');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['a.har', 'b.har']) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(har([
            entry({
                method: 'POST',
                url: 'https://www.example.invalid/api/logout',
                responseText: '{"ok":true}',
            }),
        ]), null, 2) + '\n', 'utf8');
    }
    runNode(['--dir', dir]);

    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const logout = doc.endpoints[0];
    logout.witnesses = [logout.witnesses[0]];
    logout.unproven.push({
        kind: 'no-request-body-observed',
        subjects: [],
        detail: 'invented, propped up by a trimmed witness list',
        closedBy: 'capture this operation again',
        witnesses: logout.witnesses.slice(),
    });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /no-request-body-observed.*contradicted/,
        'the references still show two of them; what the document says about that is not evidence');
});

test('one bad witness does not hide another bad witness on the same claim', () => {
    // M3, found by independent review -- a completeness regression I introduced
    // when factoring witness validation out. Returning early on the first
    // malformed citation meant a second, well-formed citation that does not
    // support the claim went unreported. The gate still failed, but it named
    // one defect out of two, and the point of naming claims is to name all of
    // them.
    const dir = path.join(tmp, 'two-bad-witnesses');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'real.har'), JSON.stringify(har([
        entry({
            method: 'POST',
            url: 'https://www.example.invalid/api/items',
            postData: formPost([{ name: 'present', value: '1' }]),
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);

    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.endpoints[0].requestFields.push({
        name: 'absent_field',
        in: 'param',
        observedIn: 1,
        witnesses: [
            { harFile: 'ghost.har', entry: 0 },
            { harFile: 'real.har', entry: 0 },
        ],
    });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /ghost\.har/, 'the malformed citation is named');
    assert.match(run.stderr, /not supported by entry 0 of 'real\.har'/,
        'and so is the well-formed citation that does not support the claim');
});

test('--check rejects a body hole on an endpoint two references witness', () => {
    // The re-derivation must apply the same rule the fold applies, not just a
    // weaker version of it. Without this, a hand-written "we never saw a
    // request body" survived on an endpoint that two references had already
    // settled -- and only the byte comparison would have noticed.
    const dir = path.join(tmp, 'planted-body-hole');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['a.har', 'b.har']) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(har([
            entry({
                method: 'POST',
                url: 'https://www.example.invalid/api/logout',
                responseText: '{"ok":true}',
            }),
        ]), null, 2) + '\n', 'utf8');
    }
    runNode(['--dir', dir]);

    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.endpoints[0].unproven.push({
        kind: 'no-request-body-observed',
        subjects: [],
        detail: 'invented: nothing is known about what a caller must send',
        closedBy: 'capture this operation again',
        witnesses: doc.endpoints[0].witnesses.slice(),
    });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /no-request-body-observed.*contradicted/,
        'two references having settled it is exactly what contradicts the hole');
});

test('--check validates a hole\'s witnesses, not only the hole itself', () => {
    // I3, found by independent review. Gaps recorded witnesses that nothing
    // checked, so a hole citing a reference that does not exist was left to the
    // byte comparison -- which says the file differs, never which claim is bad.
    const dir = makeProvider('gap-ghost-witness');
    runNode(['--dir', dir]);
    const file = path.join(dir, 'api.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const graphql = doc.endpoints.find((e) => e.pathTemplate === '/api/graphql/');
    graphql.unproven[0].witnesses = [{ harFile: 'never-captured.har', entry: 0 }];
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /never-captured\.har/,
        'the traceability pass names the bad witness rather than leaving it to the byte comparison');
});

test('a placeholder standing in for a request body is not a request body', () => {
    // #426. Two definitions of "carried a request body" disagreed: the
    // catalogue's requires the body to belong to a recognised wire grammar,
    // this one accepted any non-empty text. So a SENTINEL standing in for a
    // body counted as a body, the hole did not fire, and the document reported
    // the request side as observed when what was observed was a placeholder.
    //
    // That is the #358 hollow-reference defect reappearing one artifact later:
    // a file catalogued as documenting request-side behaviour it contains none
    // of. Both definitions now come from har-catalogue.js.
    const dir = path.join(tmp, 'placeholder-body');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'placeholder.har'), JSON.stringify(har([
        entry({
            method: 'POST',
            url: 'https://www.example.invalid/api/upload',
            postData: { mimeType: 'application/x-www-form-urlencoded', text: '[body removed]' },
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const upload = endpointOf(readDoc(dir), 'POST', '/api/upload');

    assert.ok(upload.unproven.some((u) => u.kind === 'no-request-body-observed'),
        `a sentinel is not a body, so the request side is unproven: ${JSON.stringify(upload.unproven)}`);
});

test('a real body in any recognised grammar still counts as a body', () => {
    // The strict definition must not fire on traffic behaving normally. A gate
    // that flags real bodies trains its readers to ignore it, which costs every
    // other hole the document carries.
    const dir = path.join(tmp, 'real-bodies');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'real.har'), JSON.stringify(har([
        entry({
            method: 'POST',
            url: 'https://www.example.invalid/api/json',
            postData: { mimeType: 'application/json', text: '{"a":1}' },
            responseText: '{"ok":true}',
        }),
        entry({
            method: 'PUT',
            url: 'https://www.example.invalid/api/form',
            postData: formPost([{ name: 'a', value: '1' }]),
            responseText: '{"ok":true}',
        }),
        entry({
            method: 'PATCH',
            url: 'https://www.example.invalid/api/empty-json',
            // `{}` is a legal minimal body, not an absent one.
            postData: { mimeType: 'application/json', text: '{}' },
            responseText: '{"ok":true}',
        }),
    ]), null, 2) + '\n', 'utf8');
    runNode(['--dir', dir]);
    const doc = readDoc(dir);

    for (const template of ['/api/json', '/api/form', '/api/empty-json']) {
        const endpoint = doc.endpoints.find((e) => e.pathTemplate === template);
        assert.ok(!endpoint.unproven.some((u) => u.kind === 'no-request-body-observed'),
            `${template} carries a real body: ${JSON.stringify(endpoint.unproven)}`);
    }
});

test('the body definition and the method set come from the catalogue, not a copy', () => {
    // The reason #426 existed: two paths that must agree were agreeing by
    // coincidence, and the coincidence was maintained by a THIRD component's
    // gate rather than by either of them. Identity is what makes the agreement
    // structural.
    const generator = require(path.join(__dirname, 'generate-api-document.js'));
    const catalogue = require(path.join(__dirname, 'har-catalogue.js'));

    assert.strictEqual(generator.hasRequestBody, catalogue.hasRequestBody);
    assert.strictEqual(generator.BODY_BEARING_METHODS, catalogue.BODY_BEARING_METHODS);
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

    const stale = fs.readFileSync(path.join(dir, 'api.json'));
    const run = runNode(['--dir', dir, '--check']);
    assert.strictEqual(run.code, 3, `expected a check violation, got ${run.code}`);
    assert.match(run.stderr, /api\.json/, 'the message names the stale artifact');
    assert.match(run.stderr, /stale|regenerat/i);
    assert.ok(stale.equals(fs.readFileSync(path.join(dir, 'api.json'))),
        'a check REPORTS; it must not silently repair what it reports, or the '
        + 'next run would pass and the staleness would never reach review');
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
