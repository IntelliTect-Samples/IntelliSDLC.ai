#!/usr/bin/env node
// Behavior tests for render-har-catalogue.js (issue #379).
//
// The README table becomes a RENDERING of catalogue.json rather than a second
// source of truth. Two things have to hold for that to be safe, and both are
// pinned here:
//
//   * regeneration is idempotent -- otherwise every run dirties the tree and
//     a diff stops meaning "something changed";
//   * hand-written prose survives -- the provenance notes, the naming
//     convention and the re-capture recipe are the part of the file nobody can
//     regenerate, and a generator that ate one would be worse than the prose
//     table it replaced.
//
// Zero-dep, runs with `node har-catalogue-render.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cat = require(path.join(__dirname, 'har-catalogue.js'));
const render = path.join(__dirname, 'render-har-catalogue.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-render-'));

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
}

function runRender(dir, args = []) {
    const r = spawnSync(process.execPath, [render, '--dir', dir, ...args], { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const FORM_BODY = 'message=hello+world&audience=SELF';

function har(entries) {
    return JSON.stringify({
        log: { version: '1.2', creator: { name: 'test', version: '1' }, entries },
    }, null, 2);
}

function postEntry(body, url) {
    return {
        startedDateTime: '2026-08-26T00:00:00.000Z', time: 1,
        request: {
            method: 'POST', url: url || 'https://api.example.invalid/v1/posts',
            httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [],
            headersSize: -1, bodySize: -1,
            postData: { mimeType: 'application/x-www-form-urlencoded', text: body },
        },
        response: {
            status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [],
            redirectURL: '', headersSize: -1, bodySize: -1,
            content: { size: 2, mimeType: 'application/json', text: '{}' },
        },
        cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    };
}

/** A reference directory with one honest reference and a matching catalogue. */
function makeProject(name, extra = {}) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, 'example'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'example', 'example-create-post-2026-08-26.har'),
        har([postEntry(FORM_BODY)]));

    const entries = extra.entries || [{
        Action: 'create-post',
        Description: 'Published one post with the audience set to Only Me',
        Provider: 'example',
        Status: 'Exercised',
        HarFile: 'example/example-create-post-2026-08-26.har',
        CapturedUtc: '2026-08-26T00:00:00.000Z',
        Related: [379],
        Methods: ['POST'],
        Endpoints: ['api.example.invalid/v1/posts'],
        EntryCount: 1,
        RequestBodies: 1,
        RequestBytes: Buffer.byteLength(FORM_BODY),
        ResponseBytes: 2,
    }];
    fs.writeFileSync(path.join(dir, 'catalogue.json'), JSON.stringify(entries, null, 2) + '\n');
    if (extra.readme !== undefined) fs.writeFileSync(path.join(dir, 'README.md'), extra.readme);
    return dir;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

test('writes a README carrying the markers and the table when none exists', () => {
    const dir = makeProject('fresh');
    const r = runRender(dir);
    assert.strictEqual(r.code, 0, r.stderr);

    const text = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    assert.ok(text.includes(cat.BEGIN_MARKER));
    assert.ok(text.includes(cat.END_MARKER));
    assert.ok(text.includes('example-create-post-2026-08-26.har'));
    assert.ok(text.includes('Published one post with the audience set to Only Me'));
});

test('renders the request-body count, so a hollow reference is visible without opening it', () => {
    // The column exists because four hollow references were readable as
    // ordinary rows. A human scanning the table now sees `0` next to a row
    // describing what a request sent.
    const dir = makeProject('bodycount');
    runRender(dir);
    const table = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    assert.ok(/\| Request bodies \|/.test(table), 'the table declares the column');
    assert.ok(/\| 1 \| 1 \|/.test(table), `entries and request bodies rendered:\n${table}`);
});

test('regenerating an unchanged catalogue is byte-identical', () => {
    // Idempotence is what makes the staleness gate meaningful. If a re-render
    // churned, every CI run would report a diff and the gate would be turned
    // off within a week.
    const dir = makeProject('idempotent');
    runRender(dir);
    const first = fs.readFileSync(path.join(dir, 'README.md'));
    runRender(dir);
    const second = fs.readFileSync(path.join(dir, 'README.md'));
    assert.ok(first.equals(second), 'a second render changed the file');
});

test('row order does not follow the order rows sit in the JSON', () => {
    // Otherwise appending a row reshuffles the table and turns a one-row
    // catalogue edit into an unreviewable diff.
    const rows = (order) => order.map((action) => ({
        Action: action, Description: `did ${action}`, Provider: 'example',
        Status: 'Exercised', HarFile: 'example/example-create-post-2026-08-26.har',
        CapturedUtc: '2026-08-26T00:00:00.000Z', Related: [],
        Methods: ['POST'], Endpoints: ['api.example.invalid/v1/posts'],
        EntryCount: 1, RequestBodies: 1, RequestBytes: 33, ResponseBytes: 2,
    }));

    const a = cat.renderTable(rows(['alpha', 'beta', 'gamma']));
    const b = cat.renderTable(rows(['gamma', 'alpha', 'beta']));
    assert.strictEqual(a, b);
});

// ---------------------------------------------------------------------------
// Prose survival -- the assertion most likely to be the one that matters
// ---------------------------------------------------------------------------

test('hand-written prose outside the markers survives regeneration verbatim', () => {
    const preamble = [
        '# Facebook references',
        '',
        '## Provenance',
        '',
        'The 2026-08-26 captures were taken against the desktop composer, not m.facebook.com.',
        'A capture taken against mobile will not diff cleanly against these.',
        '',
    ].join('\n');
    const epilogue = [
        '',
        '## Re-capture recipe',
        '',
        '1. `Invoke-HarCapture https://www.facebook.com -Describe "compose a post"`',
        '2. Diff the new reference against the committed one.',
        '',
        'Do not edit a reference by hand. Re-capture it.',
        '',
    ].join('\n');

    const dir = makeProject('prose', {
        readme: `${preamble}${cat.BEGIN_MARKER}\nstale table that must be replaced\n${cat.END_MARKER}${epilogue}`,
    });

    const r = runRender(dir);
    assert.strictEqual(r.code, 0, r.stderr);

    const text = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    assert.ok(text.startsWith(preamble), 'prose before the region was altered');
    assert.ok(text.endsWith(epilogue), 'prose after the region was altered');
    assert.ok(!text.includes('stale table that must be replaced'), 'the region was not replaced');
    assert.ok(text.includes('example-create-post-2026-08-26.har'), 'the new table is absent');
});

test('a CRLF README stays CRLF, so the staleness gate cannot fail forever', () => {
    // THE FAILURE THIS PREVENTS: a consuming project whose checkout produces
    // CRLF (no `eol=lf` attribute, autocrlf on) renders a README whose prose is
    // CRLF and whose generated region is LF. Re-rendering never reproduces the
    // committed bytes, so verify-har-catalogue.js reports the table as stale on
    // every run -- and the gate's own advice, "run render-har-catalogue.js and
    // review the diff", does not fix it. A permanently red gate gets disabled.
    //
    // This repo's own .gitattributes forces LF and hides the bug here. The
    // scripts ship as a TEMPLATE into repos that carry no such guarantee.
    const preamble = '# Notes\r\n\r\nHand-written, with CRLF endings.\r\n\r\n';
    const dir = makeProject('crlf', {
        readme: `${preamble}${cat.BEGIN_MARKER}\r\nold\r\n${cat.END_MARKER}\r\n`,
    });

    assert.strictEqual(runRender(dir).code, 0);
    const text = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    assert.ok(!/(?<!\r)\n/.test(text), `a lone LF was written into a CRLF file:\n${JSON.stringify(text)}`);

    // And it is still idempotent in that shape -- which is the property the
    // staleness gate actually rests on.
    const first = fs.readFileSync(path.join(dir, 'README.md'));
    runRender(dir);
    assert.ok(first.equals(fs.readFileSync(path.join(dir, 'README.md'))));
});

test('an LF README stays LF', () => {
    const dir = makeProject('lf', {
        readme: `# Notes\n\nHand-written.\n\n${cat.BEGIN_MARKER}\nold\n${cat.END_MARKER}\n`,
    });
    runRender(dir);
    assert.ok(!fs.readFileSync(path.join(dir, 'README.md'), 'utf8').includes('\r'));
});

test('a second, orphaned BEGIN marker FAILS rather than leaving garbage', () => {
    // Only the first BEGIN/END pair is ever replaced. A stray second marker
    // after a valid region is a broken file, and silently rendering around it
    // leaves a reader with two tables and no way to know which is generated.
    const dir = makeProject('orphan-marker', {
        readme: `${cat.BEGIN_MARKER}\nold\n${cat.END_MARKER}\n\n${cat.BEGIN_MARKER}\nstray\n`,
    });

    const r = runRender(dir);
    assert.notStrictEqual(r.code, 0, 'an orphaned second marker was accepted');
    assert.match(r.stderr, /more than one|second/i);
});

test('a README with no markers FAILS rather than being rewritten', () => {
    // Guessing where the table goes is how a generator eats a paragraph. The
    // file is left exactly as it was and the operator is told what to paste.
    const original = '# Hand-written notes\n\nNothing here is generated.\n';
    const dir = makeProject('nomarkers', { readme: original });

    const r = runRender(dir);
    assert.notStrictEqual(r.code, 0, 'a markerless README was accepted');
    assert.match(r.stderr, /BEGIN GENERATED CATALOGUE/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), original,
        'the markerless README was modified anyway');
});

test('observed-but-not-exercised rows are generated too, not left hand-written', () => {
    // A half-generated section is the drift this issue closes: the generated
    // half stays current while the hand-written half describes a previous
    // capture.
    const dir = makeProject('observed', {
        entries: [{
            Action: 'delete-post', Description: 'Deletes a post. Nothing in the session drove it.',
            Provider: 'example', Status: 'Observed', HarFile: null,
            CapturedUtc: '2026-08-26T00:00:00.000Z', Related: [],
            Methods: ['DELETE'], Endpoints: ['api.example.invalid/v1/posts/{id}'],
            EntryCount: 1, RequestBodies: 0, RequestBytes: 0, ResponseBytes: 0,
        }],
    });
    // The lone reference on disk is uncatalogued here; that is the verifier's
    // complaint, not the renderer's. The renderer renders what it is given.
    runRender(dir);

    const text = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    assert.ok(text.includes('### Observed, not exercised'));
    assert.ok(text.includes('api.example.invalid/v1/posts/{id}'));
});

// `| a | b | c | d | e | f |` splits into 8 parts: six cells plus the empty
// strings either side of the leading and trailing pipes.
const EXPECTED_CELLS = 8;

test('a description carrying a pipe or a newline cannot break the table', () => {
    const table = cat.renderTable([{
        Action: 'weird', Provider: 'example', Status: 'Exercised',
        Description: 'sent a | pipe\nand a newline', HarFile: 'x.har',
        CapturedUtc: '2026-08-26T00:00:00.000Z', Related: [],
        Methods: ['POST'], Endpoints: ['h/p'], EntryCount: 1,
        RequestBodies: 1, RequestBytes: 1, ResponseBytes: 1,
    }]);

    const row = table.split('\n').find((l) => l.includes('x.har'));
    assert.ok(!/\n/.test(row));
    // Split on UNESCAPED pipes only. A `\|` in a cell is the correct markdown
    // escape and renders as a literal pipe; counting it as a delimiter would be
    // the test misreading a correct escape as a broken table.
    assert.strictEqual(row.split(/(?<!\\)\|/).length, EXPECTED_CELLS,
        `a pipe in the description added a column:\n${row}`);
    assert.ok(row.includes('\\|'), 'the pipe was dropped instead of escaped');
});

console.log(`All har-catalogue-render tests passed (${passed} assertions)`);
