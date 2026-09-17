#!/usr/bin/env node
// Five CLI entry points are commands *and* modules (issue #456).
//
// #446 / PR #455 fixed `har/sanitize-har.js`: it called `main()` at the bottom
// with no `require.main === module` guard, so `require()`ing it -- even to read
// one constant -- performed a live scrub against the requiring process's tree
// and called `process.exit()` before `require` returned. PR #455 surveyed the
// rest of the tree and deliberately did not widen its own scope; this suite is
// the other half of that survey.
//
// The five, and why each one is not merely tidiness:
//
//   har/verify-scrub.js           the scrub's own leak gate. Requiring it runs
//                                 the gate against the requiring process's
//                                 tree and exits. It is the other half of the
//                                 pair #408 wants a parity mechanism across,
//                                 and the reason #395's test compares SOURCE
//                                 TEXT -- it could not import the module.
//   har/extract-har-reference.js  runs a full reference extraction on import.
//   har/pii-enrich.js
//   codegen/run-agent.js          the pipeline driver. PR #455 gave it an
//                                 import of subs-destination.js, but its own
//                                 consolidation had to be verified by READING
//                                 it rather than by requiring it.
//   capture/capture-cdp.js
//
// BOTH HALVES MUST HOLD, per script. A guard tested in one direction is half a
// test, and here the untested direction is the dangerous one:
//
//   FALSIFIER -- requiring the module does no work, writes no file, leaves the
//   inputs untouched, and RETURNS. Fails if the guard's condition is removed.
//
//   GUARD -- invoked as a command it still does exactly what it did. Fails if
//   `main()` is never called. That is the shape a careless fix takes, and for
//   `verify-scrub.js` it is far worse than the defect being fixed: a leak gate
//   that inspects nothing and exits 0 reads as "no leaks found".
//
// Zero-dep, runs with `node cli-entry-points-importable.test.js`.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const scriptsDir = path.join(__dirname, '..');
const harDir = path.join(scriptsDir, 'har');
const { initProtectedRepo } = require(path.join(harDir, 'har-test-repo.test-support.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-entry-points-')));

// A 32-char hex value. verify-scrub recognises the SHAPE, so its presence or
// absence in a verdict is a decisive signal about whether the gate ran.
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ACCOUNT_ID = '100000123456789';

// The marker the importer prints AFTER the require returns. Its absence is the
// sharpest single signal in this suite: every one of these five scripts ends
// every path in `process.exit()`, so if `main()` ran during the require the
// process is gone before this line is reached, whatever the exit code says.
const RETURNED = 'IMPORT-RETURNED:';

function runNode(args, cwd, env) {
    try {
        const out = execFileSync(process.execPath, args, {
            encoding: 'utf8',
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: Object.assign({}, process.env, env || {}),
        });
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return {
            code: e.status === null || e.status === undefined ? 1 : e.status,
            stdout: e.stdout ? e.stdout.toString() : '',
            stderr: e.stderr ? e.stderr.toString() : '',
        };
    }
}

// Every file under `dir`, mapped to its sha256. Comparing this before and
// after is what makes the falsifier a statement about the whole tree rather
// than about a list of artifacts someone remembered to enumerate -- a script
// that writes somewhere unexpected is exactly the case an enumeration misses.
// `.git` is skipped: `git init` leaves a tree whose own bookkeeping files are
// not evidence about these scripts.
function treeHashes(dir, base, acc) {
    base = base || dir;
    acc = acc || {};
    for (const name of fs.readdirSync(dir)) {
        if (name === '.git') continue;
        const full = path.join(dir, name);
        const st = fs.lstatSync(full);
        if (st.isDirectory()) { treeHashes(full, base, acc); continue; }
        acc[path.relative(base, full).split(path.sep).join('/')] =
            crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
    return acc;
}

function harWith(entries) {
    return JSON.stringify({
        log: { version: '1.2', creator: { name: 'test', version: '1' }, entries },
    }, null, 2);
}

function entry(headers, bodyText) {
    return {
        startedDateTime: '2026-01-01T00:00:00.000Z',
        time: 1,
        request: {
            method: 'GET',
            url: 'https://api.example.invalid/v1/users/' + ACCOUNT_ID,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: headers || [],
            queryString: [],
            headersSize: -1,
            bodySize: -1,
        },
        response: {
            status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
            cookies: [], headers: [],
            content: {
                size: (bodyText || '{"ok":true}').length,
                mimeType: 'application/json',
                text: bodyText || '{"ok":true}',
            },
            redirectURL: '', headersSize: -1, bodySize: -1,
        },
        cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    };
}

// A project shaped like a real consumer's: a git repo whose .gitignore covers
// the substitution tables, holding a profile and a capture every one of these
// scripts would act on. The point of the fixture is that nothing is missing,
// so "nothing happened" can only be the guard and never an absent
// precondition.
function makeProject(name, opts) {
    const dir = path.join(tmp, name);
    initProtectedRepo(dir);
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'cli-entry-points-salt',
        literals: { [ACCOUNT_ID]: '<AccountId>' },
    }), 'utf8');
    const headers = opts && opts.headers
        ? opts.headers
        : [{ name: 'X-Api-Key', value: SECRET }];
    fs.writeFileSync(path.join(dir, 'raw.har'), harWith([entry(headers)]), 'utf8');
    return dir;
}

// ---------------------------------------------------------------------------
// The five scripts, each with the argv that drives a REAL run of it.
// ---------------------------------------------------------------------------
//
// The argv matters as much as the fixture. An importer handed no arguments
// would prove very little: with the guard removed, the require reads
// `process.argv` -- which belongs to the IMPORTER -- so handing it the real
// arguments is what makes an unguarded module do its real work before
// `require` returns. That is the sharp form of this falsifier, and it is how
// each row below is ablated.
const SCRIPTS = [
    {
        name: 'har/verify-scrub.js',
        file: path.join(harDir, 'verify-scrub.js'),
        // An unguarded require gates the requiring process's own capture and
        // exits 3, after writing scrub-findings.json beside it.
        argv: (dir) => ['--in', path.join(dir, 'raw.har'),
            '--profile', path.join(dir, '.har-profile.json')],
        exports: ['main', 'parseArgs'],
    },
    {
        name: 'har/extract-har-reference.js',
        file: path.join(harDir, 'extract-har-reference.js'),
        argv: (dir) => ['--in', path.join(dir, 'raw.har'),
            '--out', path.join(dir, 'reference.har'),
            '--profile', path.join(dir, '.har-profile.json')],
        exports: ['main', 'parseArgs'],
    },
    {
        name: 'har/pii-enrich.js',
        file: path.join(harDir, 'pii-enrich.js'),
        argv: (dir) => ['--in', path.join(dir, 'raw.har'),
            '--out', path.join(dir, 'enriched.har')],
        env: { LLM_PROVIDER: 'stub' },
        exports: ['main', 'parseArgs'],
    },
    {
        name: 'codegen/run-agent.js',
        file: path.join(scriptsDir, 'codegen', 'run-agent.js'),
        // Enough to get past argument validation and into real filesystem
        // work: an unguarded require creates <out>/.run-agent/ and writes
        // transcript.log before the missing-profile exit.
        argv: (dir) => ['--har', path.join(dir, 'raw.har'),
            '--out', path.join(dir, 'wrapper-out'),
            '--project', 'Probe', '--namespace', 'Probe.Api'],
        exports: ['main', 'parseArgs'],
    },
    {
        name: 'capture/capture-cdp.js',
        file: path.join(scriptsDir, 'capture', 'capture-cdp.js'),
        // --validate-only reaches real work without launching a browser, and
        // the missing --storage-state makes that work OBSERVABLE as exit 2.
        // Deliberately not the browser path: whether playwright happens to be
        // installed must not decide what this falsifier proves.
        argv: (dir) => ['--url', 'https://example.invalid',
            '--out', path.join(dir, 'capture.har'),
            '--validate-only',
            '--storage-state', path.join(dir, 'absent-storage-state.json')],
        exports: ['main', 'parseArgs'],
    },
];

// ---------------------------------------------------------------------------
// 1. FALSIFIER -- requiring each module does no work, and returns.
// ---------------------------------------------------------------------------
for (const script of SCRIPTS) {
    const slug = script.name.replace(/[\\/.]/g, '-');
    const dir = makeProject('falsifier-' + slug);
    const importer = path.join(dir, 'importer.js');
    fs.writeFileSync(importer,
        "'use strict';\n" +
        'const m = require(' + JSON.stringify(script.file) + ');\n' +
        'process.stdout.write(' + JSON.stringify(RETURNED) + ' + JSON.stringify({\n' +
        '  keys: Object.keys(m).sort(),\n' +
        "  mainIsFunction: typeof m.main === 'function',\n" +
        '}));\n', 'utf8');

    const before = treeHashes(dir);
    const r = runNode([importer].concat(script.argv(dir)), dir, script.env);
    const after = treeHashes(dir);

    assert.strictEqual(r.code, 0,
        `1.a [${script.name}]: requiring the module did not return control to the importer ` +
        `cleanly (exit ${r.code}). Every path in these scripts ends in process.exit(), so a ` +
        `non-zero exit here is the module's own verdict, delivered during a require.\n` +
        `stderr: ${r.stderr}`);

    assert.ok(r.stdout.startsWith(RETURNED),
        `1.b [${script.name}]: the require never returned -- the marker printed after it is ` +
        `absent. main() ran while the module was being loaded and exited the process out ` +
        `from under the importer. stdout: ${JSON.stringify(r.stdout)}`);

    assert.deepStrictEqual(after, before,
        `1.c [${script.name}]: requiring the module changed the tree. The import did real ` +
        'work as a side effect of being loaded, which is the whole defect: a module that ' +
        'acts when you read a constant from it cannot be the single definition of anything.');

    const parsed = JSON.parse(r.stdout.slice(RETURNED.length));
    assert.ok(parsed.mainIsFunction,
        `1.d [${script.name}]: exports no callable main(). The CLI path must be a function ` +
        'something can call, not a side effect of loading the file.');
    for (const key of script.exports) {
        assert.ok(parsed.keys.includes(key),
            `1.e [${script.name}]: does not export ${key}. Exported keys: ` +
            `${parsed.keys.join(', ') || '(none)'}. Without a reusable surface the guard ` +
            'alone leaves every caller still re-deriving what this module already knows.');
    }
}

// ---------------------------------------------------------------------------
// 2. FALSIFIER -- and requiring all five into ONE process is free too.
// ---------------------------------------------------------------------------
//
// Section 1 spawns one process per module. This requires all five into one,
// which is the situation a test helper or a consolidating caller is actually
// in, and it is the shape that fails if any single one of them still exits:
// the first offender takes the whole process with it, so the marker is the
// verdict for the set.
{
    const dir = makeProject('falsifier-all-five-at-once');
    const importer = path.join(dir, 'importer.js');
    fs.writeFileSync(importer,
        "'use strict';\n" +
        'const files = ' + JSON.stringify(SCRIPTS.map((s) => s.file)) + ';\n' +
        'const got = files.map((f) => Object.keys(require(f)).length);\n' +
        'process.stdout.write(' + JSON.stringify(RETURNED) + ' + JSON.stringify(got));\n',
        'utf8');

    const before = treeHashes(dir);
    const r = runNode([importer, '--in', path.join(dir, 'raw.har')], dir,
        { LLM_PROVIDER: 'stub' });
    const after = treeHashes(dir);

    assert.strictEqual(r.code, 0, `2.a: the importer exited ${r.code}: ${r.stderr}`);
    assert.ok(r.stdout.startsWith(RETURNED),
        '2.b: requiring all five in one process did not return. At least one of them still ' +
        `runs its entry point on load. stdout: ${JSON.stringify(r.stdout)} stderr: ${r.stderr}`);
    assert.deepStrictEqual(after, before,
        '2.c: requiring all five changed the tree.');
    assert.deepStrictEqual(JSON.parse(r.stdout.slice(RETURNED.length)).filter((n) => n === 0), [],
        '2.d: one of the five exports nothing, so it is importable and still useless.');
}

// ---------------------------------------------------------------------------
// 3. GUARD -- verify-scrub.js, invoked as a command, still gates.
// ---------------------------------------------------------------------------
//
// This is the half that fails if `main()` is never called, and this is the
// script where that matters most. Section 1 alone is satisfied by DELETING the
// call, which would leave the repo with a leak gate that inspects nothing and
// exits 0 -- and exit 0 is what every caller reads as "clean". The exit codes
// are load-bearing for capture-har.js, which quarantines on 3 and keeps the
// artifact with a warning on 4, so they are pinned by value here.
{
    const verifyScrub = path.join(harDir, 'verify-scrub.js');

    // Clean: no secret, no literal, and no profile passed so the literal check
    // stands aside.
    const cleanDir = makeProject('guard-verify-scrub-clean', { headers: [] });
    fs.writeFileSync(path.join(cleanDir, 'raw.har'),
        harWith([{
            startedDateTime: '2026-01-01T00:00:00.000Z', time: 1,
            request: {
                method: 'GET', url: 'https://api.example.invalid/v1/ping',
                httpVersion: 'HTTP/1.1', cookies: [], headers: [], queryString: [],
                headersSize: -1, bodySize: -1,
            },
            response: {
                status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', cookies: [],
                headers: [],
                content: { size: 11, mimeType: 'application/json', text: '{"ok":true}' },
                redirectURL: '', headersSize: -1, bodySize: -1,
            },
            cache: {}, timings: { send: 0, wait: 1, receive: 0 },
        }]), 'utf8');
    const clean = runNode([verifyScrub, '--in', path.join(cleanDir, 'raw.har')], cleanDir);
    assert.strictEqual(clean.code, 0,
        `3.a: a clean capture did not verify clean (exit ${clean.code}).\n` +
        `stdout: ${clean.stdout}\nstderr: ${clean.stderr}`);
    assert.match(clean.stdout, /0 blocking leaks/,
        '3.b: the CLI run reported no verdict. main() is not reached when the file is the ' +
        'entry script, so the gate inspects nothing and still exits 0 -- which every caller ' +
        `reads as clean. stdout: ${JSON.stringify(clean.stdout)}`);

    // Gating: a bearer token in a header. Exit 3, and capture-har quarantines.
    const leakDir = makeProject('guard-verify-scrub-gating', {
        headers: [{ name: 'Authorization', value: 'Bearer ' + SECRET }],
    });
    const leak = runNode([verifyScrub, '--in', path.join(leakDir, 'raw.har')], leakDir);
    assert.strictEqual(leak.code, 3,
        `3.c: a capture carrying a bearer token exited ${leak.code}, not 3. capture-har.js ` +
        'quarantines on 3 alone; any other code lets the leak through.\n' +
        `stdout: ${leak.stdout}\nstderr: ${leak.stderr}`);
    assert.match(leak.stderr, /blocking leak/,
        `3.d: the gate blocked without naming what it found. stderr: ${leak.stderr}`);
    assert.ok(fs.existsSync(path.join(leakDir, 'scrub-findings.json')),
        '3.e: the CLI run wrote no findings report beside the capture, so the gate exited ' +
        'without doing the work its exit code claims.');

    // The forbidden-literal path, which runs only when a profile is found: the
    // operator's own value, gating, and reported by name. It is the half that
    // is silently skipped when no profile is present, so it gets its own case.
    const litDir = makeProject('guard-verify-scrub-literal', { headers: [] });
    const lit = runNode([verifyScrub, '--in', path.join(litDir, 'raw.har'),
        '--profile', path.join(litDir, '.har-profile.json')], litDir);
    assert.strictEqual(lit.code, 3,
        `3.f: an operator literal from the profile did not gate (exit ${lit.code}).\n` +
        `stdout: ${lit.stdout}\nstderr: ${lit.stderr}`);
    assert.match(lit.stderr, /forbidden-literal/,
        `3.g: the literal leak was not reported as one. stderr: ${lit.stderr}`);
}

// ---------------------------------------------------------------------------
// 4. GUARD -- extract-har-reference.js, invoked as a command, still extracts.
// ---------------------------------------------------------------------------
{
    const dir = makeProject('guard-extract-reference');
    const out = path.join(dir, 'reference.har');
    const r = runNode([path.join(harDir, 'extract-har-reference.js'),
        '--in', path.join(dir, 'raw.har'), '--out', out,
        '--profile', path.join(dir, '.har-profile.json')], dir);

    assert.strictEqual(r.code, 0,
        `4.a: extract-har-reference.js --in ... exited ${r.code}.\n` +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(fs.existsSync(out),
        '4.b: the CLI run wrote no reference file. main() is not reached when the file is ' +
        'the entry script, so the extractor extracts nothing and still exits 0.');
    assert.match(r.stdout, /extract-har-reference: wrote /,
        `4.c: the CLI did not report writing a reference. stdout: ${r.stdout}`);
    const referenceText = fs.readFileSync(out, 'utf8');
    assert.ok(JSON.parse(referenceText).log.entries.length > 0,
        '4.d: the reference was written with no entries, so the file exists and proves nothing.');
    assert.ok(!referenceText.includes(SECRET),
        '4.e: the api-key value survived into the reference.');
}

// ---------------------------------------------------------------------------
// 5. GUARD -- pii-enrich.js, invoked as a command, still runs its provider.
// ---------------------------------------------------------------------------
{
    const dir = makeProject('guard-pii-enrich');
    const enrich = path.join(harDir, 'pii-enrich.js');
    const out = path.join(dir, 'enriched.har');

    const r = runNode([enrich, '--in', path.join(dir, 'raw.har'), '--out', out], dir,
        { LLM_PROVIDER: 'stub' });
    assert.strictEqual(r.code, 0,
        `5.a: pii-enrich.js exited ${r.code}.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(fs.existsSync(out),
        '5.b: the CLI run copied nothing. main() is not reached, so the stub provider ' +
        'applied nothing and still exited 0.');
    assert.match(r.stdout, /stub provider applied/,
        `5.c: the CLI reported no provider outcome. stdout: ${r.stdout}`);

    // No --in at all: the usage path, exit 2. An entry point that never runs
    // exits 0 here, which is exactly what this pins against.
    const usage = runNode([enrich], dir, { LLM_PROVIDER: 'stub' });
    assert.strictEqual(usage.code, 2,
        `5.d: pii-enrich.js with no arguments exited ${usage.code}, not 2.`);
    assert.match(usage.stderr, /usage: node pii-enrich\.js/,
        `5.e: no usage text was printed. stderr: ${usage.stderr}`);
}

// ---------------------------------------------------------------------------
// 6. GUARD -- run-agent.js, invoked as a command, still drives the pipeline.
// ---------------------------------------------------------------------------
//
// Not a full pipeline run: agent-e2e.Tests.ps1 already drives every stage end
// to end and would fail loudly if this entry point stopped running. What is
// pinned here is cheaper and still decisive -- run-agent reaches real
// filesystem work (it creates <out>/.run-agent/ and truncates transcript.log)
// BEFORE the missing-profile refusal, so the transcript's existence is proof
// that main() got past argument parsing rather than never starting.
{
    const runAgent = path.join(scriptsDir, 'codegen', 'run-agent.js');
    const dir = makeProject('guard-run-agent');
    // The profile makes the run proceed, so it is moved aside: what is wanted
    // here is the cheapest refusal that still happens AFTER real work.
    fs.renameSync(path.join(dir, '.har-profile.json'), path.join(dir, 'profile.hidden'));
    const outDir = path.join(dir, 'wrapper-out');
    const r = runNode([runAgent, '--har', path.join(dir, 'raw.har'), '--out', outDir,
        '--project', 'Probe', '--namespace', 'Probe.Api'], dir);

    assert.strictEqual(r.code, 2,
        `6.a: run-agent.js with no discoverable profile exited ${r.code}, not 2. There is no ` +
        'default salt by design, so this refusal is a behaviour rather than an accident.\n' +
        `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(outDir, '.run-agent', 'transcript.log')),
        '6.b: run-agent.js never created its working directory, so main() did not reach real ' +
        'work. An entry point that is never called exits 0 and leaves nothing behind; this ' +
        'asserts the opposite of both.');

    // The usage path: exit 2 with the argument named, not a silent success.
    const usage = runNode([runAgent], dir);
    assert.strictEqual(usage.code, 2,
        `6.c: run-agent.js with no arguments exited ${usage.code}, not 2.`);
    assert.match(usage.stderr, /usage: node run-agent\.js/,
        `6.d: no usage text was printed. stderr: ${usage.stderr}`);
}

// ---------------------------------------------------------------------------
// 7. GUARD -- capture-cdp.js, invoked as a command, still validates.
// ---------------------------------------------------------------------------
//
// --validate-only is the one path through this script that does real work
// without launching a browser, so it is what CI can pin. Both directions of it
// are asserted: a missing storage-state refuses (2), a present one passes (0).
// Pinning only the pass would be satisfied by an entry point that never runs.
{
    const dir = makeProject('guard-capture-cdp');
    const cdp = path.join(scriptsDir, 'capture', 'capture-cdp.js');
    const statePath = path.join(dir, 'storage-state.json');

    const missing = runNode([cdp, '--url', 'https://example.invalid',
        '--out', path.join(dir, 'capture.har'), '--validate-only',
        '--storage-state', statePath], dir);
    assert.strictEqual(missing.code, 2,
        `7.a: a missing --storage-state exited ${missing.code}, not 2. stderr: ${missing.stderr}`);
    assert.match(missing.stderr, /storage-state file not found/,
        `7.b: the refusal did not say what was missing. stderr: ${missing.stderr}`);

    fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    const ok = runNode([cdp, '--url', 'https://example.invalid',
        '--out', path.join(dir, 'capture.har'), '--validate-only',
        '--storage-state', statePath], dir);
    assert.strictEqual(ok.code, 0,
        `7.c: --validate-only with a present storage state exited ${ok.code}: ${ok.stderr}`);
    assert.match(ok.stdout, /--validate-only OK/,
        '7.d: the CLI printed no validation verdict. main() is not reached when the file is ' +
        `the entry script. stdout: ${ok.stdout}`);

    // Missing required arguments: exit 1, per this script's documented codes.
    const bare = runNode([cdp], dir);
    assert.strictEqual(bare.code, 1,
        `7.e: capture-cdp.js with no arguments exited ${bare.code}, not 1.`);
    assert.match(bare.stderr, /usage: node capture-cdp\.js/,
        `7.f: no usage text was printed. stderr: ${bare.stderr}`);
}

// ---------------------------------------------------------------------------
// 8. The survey itself: no production script calls its entry point
//    unconditionally at the top level.
// ---------------------------------------------------------------------------
//
// Sections 1-7 name five files. This is the part that keeps the SIXTH from
// being written, and it is why this suite does not simply list the five: the
// defect #446 found was not special to sanitize-har.js, and the survey that
// found these five was done by hand, twice.
//
// WHAT THIS CHECKS, precisely: a production script that calls a top-level
// entry point must mention `require.main` somewhere. Nothing here decides
// whether an occurrence is inside a comment -- PR #455 spent three rounds
// learning that deciding that is lexing JavaScript, that a regex over lines is
// not a lexer, and that every failure landed in the SILENT direction.
//
// So this is deliberately shallow, and wrong only in the loud direction.
//
// THE FIRST VERSION OF THIS SECTION WAS WRONG IN THE OTHER ONE, and independent
// review found it. It matched a call named `main` or `run`, then exempted any
// file whose raw text contained `require.main` ANYWHERE:
//
//     if (!BARE_ENTRY_CALL.test(src)) continue;
//     if (src.includes('require.main')) continue;   // <- whole file
//
// so a sixth script with a real unguarded `main();` and an unrelated mention of
// `require.main` elsewhere -- a comment, a see-also, a TODO -- passed silently.
// That is the same defect as PR #455's commented-out `require()`: a substring
// test that is not tied to the thing it is meant to be about.
//
// The exemption is gone rather than narrowed, because it was never needed. A
// GUARDED call cannot match this pattern in the first place: `if (require.main
// === module) main();` begins with `if`, and the multi-line spelling indents
// the call. There is nothing for an exemption to rescue, so there is nothing
// for one to leak through. The rule is now a single question of raw text -- is
// there a call at column zero -- and the name half was widened at the same
// time, since restricting it to `main` and `run` silently missed `execute()`
// or `cli()` and no production script in this tree has any column-zero call at
// all.
//
// THE IIFE HALF WAS WRONG TOO, and the same review found that on the next
// round. Its prefix class was `( ! + ~ -`, which misses two textbook spellings
// of exactly the thing it is for:
//
//     ;(function () { main(); })();     the semicolon-guard form, written to
//                                       survive concatenation
//     void function () { main(); }();   the void-prefixed form
//
// Neither is contrived, both run main() unconditionally at load, and both were
// passing silently.
//
// AND THE FIX FOR THAT WAS INCOMPLETE, which the next round found. Handling
// `void` as a prefix to a function EXPRESSION missed `void` as a prefix to an
// ordinary call:
//
//     void main();
//
// which is not an IIFE at all -- it is the standard way to silence a linter's
// floating-promise warning on a fire-and-forget async call, and `main` is
// async in two of the five scripts this suite is about. So `void` is now an
// optional prefix on the CALL half as well.
//
// Three rounds, three silent misses, each one a guess about spellings. The
// lesson is the one PR #455 already paid for, and the reason every spelling
// below is pinned individually rather than by one example: the next guess that
// is wrong should be wrong visibly.
//
// WHAT IT STILL MISSES, each one found by trying, none of them closed:
//
//   * A top-level `await`.
//   * Work scheduled rather than called -- `Promise.resolve().then(() =>
//     main());` at column zero. The identifier `Promise` is not followed by
//     `(`, and the call to main is indented inside the callback.
//   * `new function () { main(); }();`, the comma-operator indirection
//     `(0, main)();`, a tagged template, and `[main][0]();`. All real
//     JavaScript, all contrived: nobody reaches for one of these by accident,
//     which is the line between a tripwire and a lock.
//   * An entry point reached some way other than a call at column zero. It
//     says nothing about a script with no top-level call.
//
// AND WHERE IT IS WRONG LOUDLY, which is the acceptable direction: the
// brace-less guard spelling
//
//     if (require.main === module)
//     main();
//
// is valid JavaScript and IS reported, because the call reaches column zero on
// its own line. Nothing in this tree writes it that way -- every guard here is
// single-line or braced -- but a file that did would fail this section while
// being perfectly correct. One line to fix by adding the braces.
//
// It is a tripwire for the ordinary case -- someone adding a sixth CLI with
// `main();` at the bottom -- and should not be read as a proof that none
// exists.
{
    // A call at column zero: `main();`, `main().catch(...)`, `execute(argv)`,
    // `void main();`, or an immediately-invoked function expression in any of
    // its prefixed spellings. An indented call is inside something else and is
    // not the pattern this is about.
    const TOP_LEVEL_CALL = /^(?:void\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;

    // Three branches, because `void` and the punctuation prefixes are not
    // interchangeable, and a bare `function` at column zero is a DECLARATION --
    // every file here has those, so the `function` alternative is only ever
    // reachable behind a prefix.
    //
    // The discipline every branch shares: after an opening paren, what follows
    // must be a function expression or a second paren. Dropping it is how two
    // loud false positives got in, one per round. `;` as a MEMBER of the
    // punctuation class needed only a `(` after it, so every `;(expr).method()`
    // -- the same ASI guard applied to something that is not an IIFE at all --
    // was reported; and `void\s+\(` alone read `void (x + 1);` as an IIFE. Both
    // are now spelled so the discipline applies.
    const TOP_LEVEL_IIFE = new RegExp([
        '^(?:',
        'void\\s+(?:async\\s+)?function\\b',            // void function () {}()
        '|void\\s+\\(\\s*(?:async\\s+)?(?:function\\b|\\()',  // void (function () {})()
        '|;?[(!+~-]\\s*(?:async\\s+)?(?:function\\b|\\()',    // (...)(), ;(...)(), !..., +..., ~..., -...
        ')',
    ].join(''), 'm');

    // Statements that begin a line with a name followed by `(` and are not
    // calls. Keeping this list is the price of not writing a parser, and it
    // errs loud: a keyword left off it reports a compliant file.
    const NOT_A_CALL = new Set(['if', 'for', 'while', 'switch', 'catch', 'do',
        'else', 'return', 'typeof', 'void', 'delete', 'new', 'function',
        'class', 'await', 'yield', 'throw', 'import', 'export', 'with']);

    function unguardedEntryCalls(src) {
        const names = [];
        if (TOP_LEVEL_IIFE.test(src)) names.push('(IIFE)');
        TOP_LEVEL_CALL.lastIndex = 0;
        let m;
        while ((m = TOP_LEVEL_CALL.exec(src)) !== null) {
            if (!NOT_A_CALL.has(m[1])) names.push(m[1]);
        }
        return names;
    }

    function walkJs(dir, found) {
        for (const name of fs.readdirSync(dir)) {
            if (name === 'node_modules') continue;
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) { walkJs(full, found); continue; }
            if (!/\.(?:js|mjs|cjs)$/.test(name)) continue;
            if (/\.test\.(?:js|mjs|cjs)$/.test(name)) continue;
            if (name.endsWith('.test-support.js')) continue;
            found.push(full);
        }
        return found;
    }

    const scanned = walkJs(scriptsDir, []);
    assert.ok(scanned.length > 10,
        `8.a: only ${scanned.length} production scripts were scanned, so this section is ` +
        'green because it looked almost nowhere.');

    // Both directions on the predicate itself, driven by synthetic sources, so
    // the rule is pinned rather than whatever the tree happens to contain today.
    assert.deepStrictEqual(unguardedEntryCalls('function main() {}\nmain();\n'), ['main'],
        '8.b: an unguarded top-level main() is not recognised, so this section is inert.');
    assert.deepStrictEqual(
        unguardedEntryCalls('main().catch((e) => { process.exit(1); });\n'), ['main'],
        '8.c: an unguarded top-level main().catch(...) is not recognised -- the async ' +
        'spelling, which is what capture-cdp.js and capture-har.js use.');
    assert.deepStrictEqual(unguardedEntryCalls('if (require.main === module) main();\n'), [],
        '8.d: a guarded call is reported, so every compliant script fails this section.');
    assert.deepStrictEqual(
        unguardedEntryCalls('if (require.main === module) {\n    main().catch(() => {});\n}\n'),
        [],
        '8.e: the multi-line guarded spelling is reported. capture-cdp.js and capture-har.js ' +
        'both use it, so this section would fail the very files it is meant to bless.');
    assert.deepStrictEqual(unguardedEntryCalls('    main();\n'), [],
        '8.f: an indented call is treated as a top-level entry point.');

    // The reviewer's reproduction of the FIRST version of this rule, which
    // exempted any file whose text contained `require.main` anywhere. It is
    // pinned because the failure was silent, and a silent failure that is
    // fixed but not pinned is a silent failure waiting to be reintroduced.
    assert.deepStrictEqual(
        unguardedEntryCalls(
            '// TODO: revisit per the require.main pattern used elsewhere\n' +
            'function main() {}\nmain();\n'),
        ['main'],
        '8.g: an unrelated mention of require.main elsewhere in the file silences the check ' +
        'for a real unguarded call. That is the whole-file substring test this rule was ' +
        'rewritten to stop needing.');

    // The name half, widened: an entry point called something else is still an
    // entry point, and so is one that takes arguments.
    assert.deepStrictEqual(unguardedEntryCalls('execute();\n'), ['execute'],
        '8.h: an entry point not named main or run is missed.');
    assert.deepStrictEqual(
        unguardedEntryCalls('cli(process.argv.slice(2));\n'), ['cli'],
        '8.i: an entry point taking arguments is missed.');
    // Every top-level IIFE spelling, because the prefix class was a guess and
    // the first guess missed two of them silently. Each entry is a real idiom,
    // not a contrivance: the bare-paren forms, the semicolon guard written to
    // survive concatenation, the void form, and the operator-prefixed ones.
    const IIFE_SPELLINGS = [
        '(function () { main(); })();\n',
        '(() => { main(); })();\n',
        '(async () => { await main(); })();\n',
        '(async function () { await main(); })();\n',
        ';(function () { main(); })();\n',
        ';(async () => { await main(); })();\n',
        'void function () { main(); }();\n',
        'void (function () { main(); })();\n',
        '!function () { main(); }();\n',
        '+function () { main(); }();\n',
        '~function () { main(); }();\n',
        '-function () { main(); }();\n',
    ];
    for (const src of IIFE_SPELLINGS) {
        assert.deepStrictEqual(unguardedEntryCalls(src), ['(IIFE)'],
            `8.j: the top-level IIFE spelling \`${src.trim()}\` is missed. Independent ` +
            'review falsified the first prefix class with the `;` and `void` forms, both ' +
            'of which run main() at load and both of which passed silently.');
    }

    // `void` in front of an ordinary call: not an IIFE, and the standard way
    // to silence a floating-promise warning on a fire-and-forget async call.
    // `main` is async in two of the five scripts this suite is about, so this
    // is the spelling a linter would talk the author of a sixth one into.
    assert.deepStrictEqual(unguardedEntryCalls('void main();\n'), ['main'],
        '8.k: `void main();` is missed. It is not an IIFE, so the IIFE half does not see ' +
        'it, and `void` is blocklisted as a statement keyword, so the call half stops at ' +
        'the prefix instead of looking past it.');
    assert.deepStrictEqual(unguardedEntryCalls('void startPipeline(argv);\n'), ['startPipeline'],
        '8.k: the same with a name and arguments.');

    // The loud direction on both halves: `void` that is not a call, a prefix
    // character that opens nothing, and -- the one that made `;` an optional
    // prefix rather than a class member -- an ASI guard in front of an
    // ordinary parenthesised expression.
    for (const benign of ['void 0;\n', 'const x = (1 + 2);\n', '// (function) in prose\n',
        '(x).foo();\n', ';(x).foo();\n', ';(this.emitter || fallback).emit("done");\n',
        'void (x + 1);\n', 'void new Foo();\n', 'void typeof x;\n',
        'function main() {}\n', 'async function main() {}\n']) {
        assert.deepStrictEqual(unguardedEntryCalls(benign), [],
            `8.l: \`${benign.trim()}\` is reported. The ASI-guard convention is not ` +
            'IIFE-specific -- style guides apply it to any line opening with a paren -- so ' +
            'reading every guarded parenthesis as an entry point would fail ordinary ' +
            'compliant code.');
    }

    // The loud direction, pinned so the keyword list is not quietly emptied.
    for (const kw of ['if (x) {', 'for (const a of b) {', 'while (n) {',
        'switch (v) {', 'catch (e) {', 'return (1);', 'throw (e);']) {
        assert.deepStrictEqual(unguardedEntryCalls(kw + '\n'), [],
            `8.k: the statement \`${kw}\` is read as a call, so this section reports every ` +
            'file that opens a block at column zero.');
    }

    const offenders = [];
    for (const file of scanned) {
        const calls = unguardedEntryCalls(fs.readFileSync(file, 'utf8'));
        if (calls.length === 0) continue;
        offenders.push(path.relative(scriptsDir, file).split(path.sep).join('/') +
            ' -> ' + calls.join(', '));
    }

    assert.deepStrictEqual(offenders, [],
        '8.n: a production script calls its entry point unconditionally at the top level, so ' +
        'requiring it runs the work and exits the requiring process. That is #446 and #456 ' +
        'again: an unimportable module cannot be the single definition of anything, and ' +
        'every caller that needs something it knows will copy instead. Wrap the call in ' +
        '`if (require.main === module)` and export the reusable surface. Offenders: ' +
        offenders.join(', '));
}

console.log('All cli-entry-points-importable tests passed');
