#!/usr/bin/env node
// Behavior tests for verify-har-catalogue.js (issue #379).
//
// THE FALSIFIER THIS SUITE EXISTS FOR:
//
//   A catalogue entry claiming request-side behaviour, on a reference whose
//   entries have no request body, must FAIL.
//
// It fails today only because the catalogue is now structured. As prose in a
// markdown table, "one Only-Me post with two people tagged" was a sentence: a
// guard could confirm the row EXISTED and never that it was TRUE. Four
// references shipped with a 29-character placeholder where the request payload
// belonged, under rows describing exactly that, and passed a dedicated guard,
// an independent review and a merge. A design document then cited one of them
// as the evidence for four request-side facts it cannot provide.
//
// Every assertion below is ablated in the evidence: break what it checks, watch
// it fail, restore.
//
// Zero-dep, runs with `node har-catalogue-verify.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cat = require(path.join(__dirname, 'har-catalogue.js'));
const verify = path.join(__dirname, 'verify-har-catalogue.js');
const render = path.join(__dirname, 'render-har-catalogue.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-cat-verify-'));

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
}

// spawnSync, not execFileSync: a gate that reported a violation on stderr
// alongside a SUCCESS exit would be invisible to execFileSync, and the test
// that noticed would be the one that could not see it.
function runVerify(dir) {
    const r = spawnSync(process.execPath, [verify, '--dir', dir], { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const FORM_BODY = 'message=hello+world&tags%5B0%5D=100000123456789&audience=SELF';
const HOLLOW_BODY = 'REDACTED_FORM_URLENCODED_BODY';
const REF = 'example/example-create-post-2026-08-26.har';

function entryFor(body) {
    const request = {
        method: 'POST', url: 'https://api.example.invalid/v1/posts',
        httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [],
        headersSize: -1, bodySize: -1,
    };
    if (body !== null) {
        request.postData = { mimeType: 'application/x-www-form-urlencoded', text: body };
    }
    return {
        startedDateTime: '2026-08-26T00:00:00.000Z', time: 1,
        request,
        response: {
            status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
            redirectURL: '', headersSize: -1, bodySize: -1,
            content: { size: 2, mimeType: 'application/json', text: '{}' },
        },
        cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    };
}

/**
 * A reference directory that PASSES, so every failing test differs from a
 * passing one by exactly the thing it is testing.
 */
function makeProject(name, mutate) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, 'example'), { recursive: true });

    const state = {
        body: FORM_BODY,
        row: {
            Action: 'create-post',
            Description: 'Published one post with two people tagged, audience Only Me',
            Provider: 'example',
            Status: 'Exercised',
            HarFile: REF,
            CapturedUtc: '2026-08-26T00:00:00.000Z',
            Related: [379],
            Methods: ['POST'],
            Endpoints: ['api.example.invalid/v1/posts'],
            EntryCount: 1,
            RequestBodies: 1,
            RequestBytes: Buffer.byteLength(FORM_BODY),
            ResponseBytes: 2,
        },
        extraRows: [],
        extraFiles: {},
        extraEntries: [],
    };
    if (mutate) mutate(state);

    fs.writeFileSync(path.join(dir, REF), JSON.stringify({
        log: {
            version: '1.2', creator: { name: 'test', version: '1' },
            entries: [...state.extraEntries, entryFor(state.body)],
        },
    }, null, 2));
    for (const [rel, content] of Object.entries(state.extraFiles)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }

    const rows = state.row === null ? state.extraRows : [state.row, ...state.extraRows];
    fs.writeFileSync(path.join(dir, 'catalogue.json'), JSON.stringify(rows, null, 2) + '\n');

    // Render the README so the staleness check starts satisfied. A fixture that
    // failed staleness by construction would make every other test ambiguous.
    spawnSync(process.execPath, [render, '--dir', dir], { encoding: 'utf8' });
    return dir;
}

// ---------------------------------------------------------------------------
// The baseline. Everything else is this, minus one thing.
// ---------------------------------------------------------------------------

test('an honest catalogue passes', () => {
    const r = runVerify(makeProject('honest'));
    assert.strictEqual(r.code, 0, `${r.stdout}\n${r.stderr}`);
});

// ---------------------------------------------------------------------------
// THE FALSIFIER
// ---------------------------------------------------------------------------

test('a row declaring POST on a reference with no request body FAILS', () => {
    // This is the assertion that would have caught all four hollow references.
    // The row is honest about everything it can be checked on -- the methods
    // and the entry count are right -- and the file still cannot support what
    // the description says.
    const dir = makeProject('hollow', (s) => {
        s.body = HOLLOW_BODY;
        s.row.RequestBodies = 0;
        s.row.RequestBytes = 0;
    });

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0, 'a hollow reference passed the guard');
    assert.match(r.stderr, /request body/i);
    assert.match(r.stderr, /POST/);
});

test('a body on a GET does not let a hollow POST reference through', () => {
    // The hole an independent review found in the first cut of this guard.
    // The falsifier read the FILE-WIDE `RequestBodies` count, so one unrelated
    // GET carrying a body vouched for every bodyless POST beside it -- and a
    // row reading "published five posts, each with a payload" over this file
    // passed untouched, which is the whole defect class restated.
    const dir = makeProject('get-covers-post', (s) => {
        s.extraEntries = [{
            startedDateTime: '2026-08-26T00:00:00.000Z', time: 1,
            request: {
                method: 'GET', url: 'https://api.example.invalid/v1/probe',
                httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [],
                headersSize: -1, bodySize: -1,
                postData: { mimeType: 'application/json', text: '{"probe":true}' },
            },
            response: {
                status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
                redirectURL: '', headersSize: -1, bodySize: -1,
                content: { size: 2, mimeType: 'application/json', text: '{}' },
            },
            cache: {}, timings: { send: 0, wait: 1, receive: 0 },
        }];
        s.body = HOLLOW_BODY;
        // The row is honest about every file-wide fact: one body really is in
        // there, on the GET.
        s.row.Methods = ['GET', 'POST'];
        s.row.Endpoints = ['api.example.invalid/v1/posts', 'api.example.invalid/v1/probe'];
        s.row.EntryCount = 2;
        s.row.RequestBodies = 1;
        s.row.RequestBytes = Buffer.byteLength('{"probe":true}');
        s.row.ResponseBytes = 4;
    });

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0, 'a GET body vouched for the bodyless POSTs');
    assert.match(r.stderr, /POST/);
});

test('the same row passes once a written reason records why there is no body', () => {
    // `POST /logout` with no body is legal traffic. Without an escape the gate
    // would fire on real captures, and a gate that fires on real captures gets
    // disabled -- costing every other check it carries. The escape is not free:
    // it costs a human a sentence, in the file, under review.
    const dir = makeProject('hollow-explained', (s) => {
        s.body = null;
        s.row.RequestBodies = 0;
        s.row.RequestBytes = 0;
        s.row.RequestBodiesAbsent =
            'The provider signs out with a bodyless POST; there is no payload to preserve.';
    });

    const r = runVerify(dir);
    assert.strictEqual(r.code, 0, `${r.stdout}\n${r.stderr}`);
});

test('an EMPTY reason does not silence the gate', () => {
    // Otherwise the escape hatch is a boolean with extra steps, and the first
    // person in a hurry sets it to "".
    const dir = makeProject('hollow-blank-reason', (s) => {
        s.body = HOLLOW_BODY;
        s.row.RequestBodies = 0;
        s.row.RequestBytes = 0;
        s.row.RequestBodiesAbsent = '   ';
    });

    assert.notStrictEqual(runVerify(dir).code, 0, 'a blank reason silenced the gate');
});

// ---------------------------------------------------------------------------
// Every declared fact is recomputed from the file
// ---------------------------------------------------------------------------

for (const [field, wrong] of [
    ['EntryCount', 7],
    ['RequestBodies', 5],
    ['RequestBytes', 999999],
    ['ResponseBytes', 4242],
    ['Methods', ['GET']],
    ['Endpoints', ['api.example.invalid/v1/somewhere-else']],
]) {
    test(`a declared ${field} that disagrees with the file FAILS`, () => {
        const dir = makeProject(`wrong-${field}`, (s) => { s.row[field] = wrong; });
        const r = runVerify(dir);
        assert.notStrictEqual(r.code, 0, `a wrong ${field} passed`);
        assert.match(r.stderr, new RegExp(field));
    });
}

// ---------------------------------------------------------------------------
// Coverage, both directions
// ---------------------------------------------------------------------------

test('a reference on disk that no entry names FAILS', () => {
    // A capture nobody catalogued is a capture nobody will find -- and it is
    // also the shape a reference takes when someone adds a file and forgets
    // the row.
    const dir = makeProject('uncatalogued', (s) => {
        s.extraFiles['example/example-orphan-2026-08-27.har'] =
            JSON.stringify({ log: { version: '1.2', entries: [] } });
    });

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0, 'an uncatalogued reference passed');
    assert.match(r.stderr, /example-orphan-2026-08-27\.har/);
});

test('an entry naming a reference that does not exist FAILS', () => {
    const dir = makeProject('missing-file', (s) => {
        s.row.HarFile = 'example/example-was-deleted-2026-08-26.har';
    });

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0, 'a row naming a missing file passed');
    assert.match(r.stderr, /example-was-deleted-2026-08-26\.har/);
});

test('a HarFile differing only in casing is reported AS a casing problem', () => {
    // On Windows the file opens regardless of case, so `Example/foo.har` looks
    // fine locally and does not exist at all on the Linux runner. Two bad
    // outcomes to avoid, and the fix is neither of them:
    //
    //   * accepting it, which builds a passes-here / fails-in-CI trap;
    //   * reporting it as two unrelated findings -- "names a file not in this
    //     directory" AND "a file nobody names" -- which sends the reader
    //     hunting for a missing reference that is sitting right there.
    //
    // It fails, once, saying what is actually wrong.
    const dir = makeProject('casing', (s) => {
        s.row.HarFile = 'Example/Example-Create-Post-2026-08-26.har';
    });

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0, 'a mis-cased HarFile passed');
    assert.match(r.stderr, /case/i);
    // Named together, so the repair is a copy-paste rather than a hunt.
    assert.match(r.stderr, /Example\/Example-Create-Post-2026-08-26\.har/);
    assert.match(r.stderr, new RegExp(REF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // And NOT also reported as an uncatalogued file: the row does name it.
    assert.ok(!/no catalogue entry names it/.test(r.stderr),
        `the same file was reported as uncatalogued too:\n${r.stderr}`);
});

test('a duplicate is reported whichever row is mis-cased, and whichever comes first', () => {
    // A guard's REPORT must not depend on the order rows happen to sit in the
    // file. The case-mismatch branch claims the real path on the row's behalf,
    // and claiming it unconditionally let a second row's claim overwrite the
    // first -- so "two rows describe one file" went unsaid when the correctly
    // cased row happened to come first. Never a false pass, but it cost the
    // operator a second CI cycle to see the whole picture, and which findings
    // you get should not depend on arrangement.
    const mis = 'Example/Example-Create-Post-2026-08-26.har';

    for (const [name, rows] of [
        ['exact-then-miscased', [REF, mis]],
        ['miscased-then-exact', [mis, REF]],
        ['both-miscased', [mis, mis.toUpperCase()]],
    ]) {
        const dir = makeProject(`dup-${name}`, (s) => {
            s.row.HarFile = rows[0];
            s.extraRows.push(Object.assign({}, s.row, {
                Action: 'create-post-again', HarFile: rows[1],
            }));
        });

        const r = runVerify(dir);
        assert.notStrictEqual(r.code, 0, `${name}: passed`);
        assert.match(r.stderr, /already claims/,
            `${name}: two rows over one reference went unreported:\n${r.stderr}`);
    }
});

test('two entries naming the same reference FAIL', () => {
    // Two rows over one file means at least one of them describes traffic the
    // file does not hold, and the reader has no way to tell which.
    const dir = makeProject('duplicate', (s) => {
        s.extraRows.push(Object.assign({}, s.row, { Action: 'create-post-again' }));
    });

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0, 'two rows over one reference passed');
    assert.match(r.stderr, /already claims/i);
    // Both rows are named, so the operator knows which two to reconcile.
    assert.match(r.stderr, /create-post-again/);
    assert.match(r.stderr, /'create-post'/);
});

test('an Observed row does not need a file, and does not claim one', () => {
    // "Observed, not exercised" rows are endpoints nobody drove. Requiring a
    // reference for them would delete exactly the knowledge they carry.
    const dir = makeProject('observed', (s) => {
        s.extraRows.push({
            Action: 'delete-post', Description: 'Deletes a post. Nothing drove it.',
            Provider: 'example', Status: 'Observed', HarFile: null,
            CapturedUtc: '2026-08-26T00:00:00.000Z', Related: [],
            Methods: ['DELETE'], Endpoints: ['api.example.invalid/v1/posts/{id}'],
            EntryCount: 1, RequestBodies: 0, RequestBytes: 0, ResponseBytes: 0,
        });
    });

    const r = runVerify(dir);
    assert.strictEqual(r.code, 0, `${r.stdout}\n${r.stderr}`);
});

test('an Exercised row with no HarFile FAILS', () => {
    // `Exercised` is the claim that a worked example exists. A row claiming one
    // and naming no file is worse than no row.
    const dir = makeProject('exercised-no-file', (s) => { s.row.HarFile = null; });
    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0, 'an Exercised row with no reference passed');
    assert.match(r.stderr, /Exercised/);
});

// ---------------------------------------------------------------------------
// Staleness -- the generated table cannot describe a previous reference
// ---------------------------------------------------------------------------

test('a README that does not match a re-render FAILS', () => {
    const dir = makeProject('stale');
    const readme = path.join(dir, 'README.md');
    fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8')
        .replace('Published one post', 'Published SOMETHING ELSE'));

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0, 'a stale README passed');
    assert.match(r.stderr, /README/);
});

test('the guard never writes the README it is checking', () => {
    // A gate that repaired what it found would report success on a tree it had
    // just changed, and CI would go green on a diff nobody reviewed.
    const dir = makeProject('readonly');
    const readme = path.join(dir, 'README.md');
    fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8')
        .replace('Published one post', 'Published SOMETHING ELSE'));
    const before = fs.readFileSync(readme);

    runVerify(dir);
    assert.ok(before.equals(fs.readFileSync(readme)), 'the guard rewrote the README');
});

test('a missing README FAILS rather than being treated as up to date', () => {
    const dir = makeProject('no-readme');
    fs.unlinkSync(path.join(dir, 'README.md'));

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0, 'a missing README passed');
    assert.match(r.stderr, /README/);
});

// ---------------------------------------------------------------------------
// Operational shape
// ---------------------------------------------------------------------------

test('a missing catalogue.json FAILS with the path, not a stack trace', () => {
    const dir = makeProject('no-catalogue');
    fs.unlinkSync(path.join(dir, 'catalogue.json'));

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /catalogue\.json/);
    assert.ok(!/ at .*\.js:\d+/.test(r.stderr), `a stack trace reached the operator:\n${r.stderr}`);
});

test('no failure message echoes a request body', () => {
    // Every finding names a file and a field. A gate that quoted the payload it
    // objected to would relocate the leak into the CI log that reports it --
    // the rule verify-har-reference.js already holds.
    const dir = makeProject('no-echo', (s) => {
        s.body = FORM_BODY;
        s.row.RequestBytes = 1;
    });

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0);
    assert.ok(!r.stderr.includes('100000123456789'), 'the finding echoed the body');
    assert.ok(!r.stderr.includes('hello+world'), 'the finding echoed the body');
});

test('reports every violation in one run, not just the first', () => {
    // An operator who has to re-run the gate once per defect fixes one and
    // ships the rest.
    const dir = makeProject('many', (s) => {
        s.row.EntryCount = 9;
        s.row.ResponseBytes = 12345;
        s.extraFiles['example/example-orphan-2026-08-27.har'] =
            JSON.stringify({ log: { version: '1.2', entries: [] } });
    });

    const r = runVerify(dir);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /EntryCount/);
    assert.match(r.stderr, /ResponseBytes/);
    assert.match(r.stderr, /example-orphan-2026-08-27\.har/);
});

// ---------------------------------------------------------------------------
// Scaffold -> promote -> verify, across the module boundary
// ---------------------------------------------------------------------------

test('a row promoted from a mixed-case scaffold passes its own guard', () => {
    // THIS ASSERTION EXISTS TO FAIL IF SOMEONE NORMALISES ONE SIDE ONLY.
    //
    // buildDigest writes a row's Methods; measureReference recomputes them. The
    // digest once kept the verb exactly as captured while the guard uppercased,
    // so a capture containing `post` produced a row reading ["post"] that failed
    // the guard on casing alone -- correct data reported as wrong, and the
    // repair people reach for is to weaken the comparison.
    //
    // The naive form of this test -- scaffold, then verify -- is WORTHLESS here
    // and it is worth saying why: a scaffold row is `Observed` with no HarFile,
    // so the guard skips fact comparison entirely and the test passes without
    // ever engaging the thing it claims to check. It has to PROMOTE a row
    // against a real reference first, which is the first point both paths run.
    const capture = require(path.join(__dirname, '..', 'capture', 'capture-har.js'));

    const dir = path.join(tmp, 'scaffold-promote');
    fs.mkdirSync(path.join(dir, 'example'), { recursive: true });

    // Mixed case, and the same operation spelled both ways -- one endpoint.
    const entries = [
        entryFor(FORM_BODY),
        Object.assign(JSON.parse(JSON.stringify(entryFor(FORM_BODY))), {}),
    ];
    entries[1].request.method = 'post';

    const doc = { log: { version: '1.2', creator: { name: 'test', version: '1' }, entries } };
    fs.writeFileSync(path.join(dir, REF), JSON.stringify(doc, null, 2));

    const scaffold = capture.buildCatalogueScaffold(capture.buildDigest(doc));
    assert.strictEqual(scaffold.length, 1,
        'one operation spelled two ways must not scaffold as two rows');

    // Promote exactly as catalogue-prompt.md instructs -- and deliberately keep
    // the scaffold's Methods/Endpoints, which is the tempting shortcut the
    // normalisation mismatch used to punish.
    const facts = cat.measureReference(path.join(dir, REF));
    const row = Object.assign({}, scaffold[0], {
        Status: 'Exercised',
        HarFile: REF,
        Provider: 'example',
        Description: 'Published two posts',
        EntryCount: facts.EntryCount,
        RequestBodies: facts.RequestBodies,
        RequestBytes: facts.RequestBytes,
        ResponseBytes: facts.ResponseBytes,
    });
    fs.writeFileSync(path.join(dir, 'catalogue.json'), JSON.stringify([row], null, 2) + '\n');
    spawnSync(process.execPath, [render, '--dir', dir], { encoding: 'utf8' });

    const r = runVerify(dir);
    assert.strictEqual(r.code, 0,
        `a correctly promoted row failed its own guard:\n${r.stderr}`);
});

console.log(`All har-catalogue-verify tests passed (${passed} assertions)`);
