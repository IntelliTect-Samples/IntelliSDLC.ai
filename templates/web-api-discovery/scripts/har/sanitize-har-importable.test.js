#!/usr/bin/env node
// sanitize-har.js is a CLI *and* a library (issue #446).
//
// The defect: `main()` ran unconditionally at the bottom of the file, so
// `require('./sanitize-har.js')` -- even to read one string -- performed a live
// scrub, wrote substitution tables into the requiring process's tree, and then
// called `process.exit()`. An unimportable module cannot be the single
// definition of anything, so every caller that needed something the scrubber
// knew spelled its own copy instead: the two substitution-table filenames alone
// reached seven spellings across this tree.
//
// This suite is in two halves, and BOTH must hold. A guard tested in one
// direction is half a test:
//
//   FALSIFIER -- sections 1 and 2. Importing the module does no work. These
//   fail if the guard's condition is removed so `main()` always runs.
//
//   GUARD -- section 3. Invoking it as a command still scrubs. This fails if
//   `main()` is never called, which is the way a "fix" for the falsifier
//   silently disables the most safety-critical script in the repo.
//
// Section 4 pins the consolidation the guard made possible: the two filenames
// have exactly one definition in executable text.
//
// Zero-dep, runs with `node sanitize-har-importable.test.js`.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { initProtectedRepo } = require(path.join(__dirname, 'har-test-repo.test-support.js'));

const scriptsDir = path.join(__dirname, '..');
const sanitize = path.join(__dirname, 'sanitize-har.js');
const subsDestination = require(path.join(__dirname, 'subs-destination.js'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-importable-')));

function runNode(args, cwd, extra) {
    try {
        const out = execFileSync(process.execPath, args, Object.assign({
            encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'],
        }, extra || {}));
        return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
        return {
            code: e.status === null || e.status === undefined ? 1 : e.status,
            stdout: e.stdout ? e.stdout.toString() : '',
            stderr: e.stderr ? e.stderr.toString() : '',
        };
    }
}

// A 32-char hex value: a shape the scrub redacts by pattern, so its survival or
// removal is a decisive signal about whether a scrub ran.
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

// A project shaped like a real consumer's: a git repo whose .gitignore protects
// the substitution tables, holding a profile and a capture the scrub WOULD act
// on. The point of the fixture is that everything a scrub needs is present and
// in reach, so "nothing happened" can only be the guard and not a missing
// precondition.
function makeProject(name) {
    const dir = path.join(tmp, name);
    initProtectedRepo(dir);
    fs.writeFileSync(path.join(dir, '.har-profile.json'), JSON.stringify({
        salt: 'importable-salt',
        literals: { '100000123456789': '<AccountId>' },
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'raw.har'), JSON.stringify({
        log: {
            version: '1.2',
            creator: { name: 'test', version: '1' },
            entries: [{
                startedDateTime: '2026-01-01T00:00:00.000Z',
                time: 1,
                request: {
                    method: 'GET',
                    url: 'https://api.example.com/v1/users/100000123456789',
                    httpVersion: 'HTTP/1.1',
                    cookies: [],
                    headers: [{ name: 'X-Api-Key', value: SECRET }],
                    queryString: [],
                    headersSize: -1,
                    bodySize: -1,
                },
                response: {
                    status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
                    cookies: [], headers: [],
                    content: { size: 1, mimeType: 'application/json', text: '{"ok":true}' },
                    redirectURL: '', headersSize: -1, bodySize: -1,
                },
                cache: {}, timings: { send: 0, wait: 1, receive: 0 },
            }],
        },
    }, null, 2), 'utf8');
    return dir;
}

// Every path a scrub would write to, relative to the project root. Section 1
// asserts none of them appears; section 3 asserts all of them do.
function scrubArtifacts(dir) {
    const captures = path.join(dir, '.har-captures');
    return [
        path.join(dir, 'raw.scrubbed.har'),
        path.join(captures, subsDestination.LEGACY_SUBS_FILENAME),
        path.join(captures, subsDestination.PII_SUBS_FILENAME),
    ];
}

// ---------------------------------------------------------------------------
// 1. FALSIFIER -- requiring the module performs no scrub and writes no file.
// ---------------------------------------------------------------------------
{
    const dir = makeProject('falsifier-no-work-on-import');
    const importer = path.join(dir, 'importer.js');
    // The importer runs from inside the project, with the profile and the
    // capture beside it, which is exactly the situation in which the unguarded
    // file scrubbed. It prints only the shape of what it got back -- never a
    // value the scrub handles.
    fs.writeFileSync(importer,
        "'use strict';\n" +
        'const m = require(' + JSON.stringify(sanitize) + ');\n' +
        "process.stdout.write(JSON.stringify({\n" +
        '  keys: Object.keys(m).sort(),\n' +
        "  mainIsFunction: typeof m.main === 'function',\n" +
        '}));\n', 'utf8');

    // The importer is handed the very arguments that drive a real scrub. That is
    // the sharp form of this falsifier: with the guard removed, `require` reads
    // `process.argv` -- which belongs to the IMPORTER -- finds a valid --in, and
    // performs a complete scrub of the requiring process's capture before
    // `require` ever returns. Confirmed by ablation: 1.b and 1.c both fire, with
    // the scrubbed HAR and both substitution tables left on disk by an import.
    const r = runNode([importer, '--in', path.join(dir, 'raw.har'),
        '--fixed-time', '2026-01-01T00:00:00.000Z'], dir);

    assert.strictEqual(r.code, 0,
        '1.a: requiring sanitize-har.js did not return control to the importer ' +
        `cleanly (exit ${r.code}). stderr: ${r.stderr}\n` +
        '     Before #446 this was exit 0 too -- but only because the scrub itself ' +
        'succeeded and called process.exit(0) out from under the importer.');

    for (const artifact of scrubArtifacts(dir)) {
        assert.ok(!fs.existsSync(artifact),
            `1.b: requiring sanitize-har.js wrote ${path.basename(artifact)}. The import ` +
            'ran a live scrub as a side effect, which is the whole defect: a module ' +
            'that scrubs when you read a constant from it cannot be the single ' +
            'definition of anything.');
    }

    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
        '1.c: the importer produced no parseable result, so the require never ' +
        `returned the module. stdout: ${r.stdout}`);
    assert.ok(parsed.mainIsFunction,
        '1.d: sanitize-har.js exports no callable main(). The CLI path must be a ' +
        'function something can call, not a side effect of loading the file.');
    assert.ok(parsed.keys.length > 1,
        '1.e: sanitize-har.js exports nothing reusable, so consolidating anything ' +
        'onto it remains impossible and callers will keep copying.');
}

// ---------------------------------------------------------------------------
// 2. FALSIFIER -- the raw capture is untouched by the import, too.
// ---------------------------------------------------------------------------
//
// Section 1 asserts no NEW file appeared. This asserts the input the scrub
// would have consumed is bit-for-bit as it was: a scrub that ran and failed
// partway is not the same as a scrub that never started, and only this
// distinguishes them.
{
    const dir = makeProject('falsifier-input-untouched');
    const rawPath = path.join(dir, 'raw.har');
    const before = fs.readFileSync(rawPath);

    const importer = path.join(dir, 'importer.js');
    fs.writeFileSync(importer,
        "'use strict';\nrequire(" + JSON.stringify(sanitize) + ');\n', 'utf8');
    const r = runNode([importer, '--in', rawPath,
        '--fixed-time', '2026-01-01T00:00:00.000Z'], dir);

    assert.strictEqual(r.code, 0, `2.a: the importer exited ${r.code}: ${r.stderr}`);
    assert.strictEqual(r.stdout, '',
        '2.b: requiring sanitize-har.js printed to stdout. The scrubber reports what ' +
        `it wrote when it runs, so any output here means it ran: ${r.stdout}`);
    assert.ok(before.equals(fs.readFileSync(rawPath)),
        '2.c: the raw capture changed as a side effect of an import.');
}

// ---------------------------------------------------------------------------
// 3. GUARD -- invoked as a command, it still scrubs.
// ---------------------------------------------------------------------------
//
// This is the half that fails if `main()` is never called. Section 1 alone is
// satisfied by deleting the call entirely, which would leave the repo with a
// scrubber that silently scrubs nothing -- a far worse defect than the one
// being fixed, and one that reports exit 0.
{
    const dir = makeProject('guard-cli-still-scrubs');
    const r = runNode([sanitize, '--in', path.join(dir, 'raw.har'),
        '--fixed-time', '2026-01-01T00:00:00.000Z'], dir);

    assert.strictEqual(r.code, 0,
        `3.a: node sanitize-har.js --in ... exited ${r.code}: ${r.stderr}`);

    for (const artifact of scrubArtifacts(dir)) {
        assert.ok(fs.existsSync(artifact),
            `3.b: the CLI run did not write ${path.basename(artifact)}. main() is not ` +
            'reached when the file is the entry script, so the scrubber scrubs nothing ' +
            'and still exits 0.');
    }

    const scrubbed = fs.readFileSync(path.join(dir, 'raw.scrubbed.har'), 'utf8');
    assert.ok(!scrubbed.includes(SECRET),
        '3.c: the api-key value survived the CLI scrub. The output file exists but the ' +
        'redaction did not happen.');
    assert.ok(!scrubbed.includes('100000123456789'),
        '3.d: the operator literal survived the CLI scrub.');
    assert.ok(/sanitize-har: wrote /.test(r.stdout),
        `3.e: the CLI did not report writing a scrubbed HAR. stdout: ${r.stdout}`);
}

// ---------------------------------------------------------------------------
// 4. The two substitution-table filenames have exactly ONE definition.
// ---------------------------------------------------------------------------
//
// This is what the guard was for. A comment naming `.substitutions.json` while
// explaining why it is not spelled there is documentation, not a second
// definition, and a check that cannot tell those apart pushes authors toward
// deleting the explanation. But telling them apart is a JS-tokenizing problem,
// and the first version of this check tried to do it by hand -- with a comment
// stripper that read the two adjacent slashes inside a regex like
// `/http:\/\//` as the start of a line comment and silently discarded the rest
// of the line. A guard whose own parser can drop a real second copy without
// saying so is worse than no guard, which is exactly the class of defect this
// suite exists to catch. (Found by independent review; pinned as 4.d below.)
//
// So the rule is now line-oriented and DELIBERATELY CONSERVATIVE. An
// occurrence is exempt only when its line is plainly a comment line -- trimmed,
// it begins with `//`, `*` or `/*`. Everything else is reported, including a
// trailing comment on a line that also carries code.
//
// That over-reports: `const x = PII_SUBS_FILENAME; // was '.substitutions.json'`
// is flagged even though it defines nothing. That is the direction to be wrong
// in. Over-reporting fails loudly on the pull request and is fixed by moving
// the note to its own line; under-reporting ships a second copy of a filename
// that decides whether live credentials stay out of version control. The check
// can only be satisfied by not spelling the name in code, which is the claim
// being made.
//
// Test files are excluded in the opposite spirit: a test that imports the
// constant it is checking asserts that a string equals itself, so restating a
// literal there is an independent pin and is wanted.

// Is this occurrence of a literal on a line that is nothing but comment?
function isPlainCommentLine(line) {
    const t = line.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// Every line of `src` that spells `literal` in something other than a plain
// comment line. Operates on RAW text, so no occurrence can be lost to a parser.
function offendingLines(src, literal) {
    return src.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter((e) => e.line.includes(literal) && !isPlainCommentLine(e.line))
        .map((e) => e.n);
}

{
    // Self-tests first, both directions. A scan whose own rule is wrong reports
    // confident nonsense, and which way it is wrong decides whether the failure
    // is loud or silent.
    const LIT = '.substitutions.json';
    const BS = String.fromCharCode(92);

    assert.deepStrictEqual(offendingLines("// mentions " + LIT + " in prose", LIT), [],
        '4.a: a whole-line // comment is reported, so the check cannot coexist with ' +
        'the explanation of why the name is not spelled there.');
    assert.deepStrictEqual(offendingLines(" * mentions " + LIT + " in a JSDoc block", LIT), [],
        '4.b: a JSDoc continuation line is reported.');
    assert.deepStrictEqual(offendingLines("const x = '" + LIT + "';", LIT), [1],
        '4.c: a plain second definition is NOT reported. The check is inert.');

    // The exact reproduction that defeated the previous hand-rolled stripper:
    // the two escaped slashes in the regex put a literal `//` in the raw text,
    // which a naive scanner treats as a line comment and throws the rest away.
    const regexLine = 'const re = /http:' + BS + '/' + BS + '//; const y = ' +
        "'" + LIT + "';";
    assert.deepStrictEqual(offendingLines(regexLine, LIT), [1],
        '4.d: a second definition sharing a line with a slash-escaping regex is not ' +
        'reported. This is the false negative the line-oriented rule replaced a ' +
        'comment stripper to close -- do not reintroduce a stripper here.');

    // Documented over-reporting, pinned so it is a decision rather than a surprise.
    assert.deepStrictEqual(offendingLines("const x = A; // was '" + LIT + "'", LIT), [1],
        '4.e: a trailing comment naming the literal is NOT reported. The rule is ' +
        'meant to over-report here; if that changed, check it did not also start ' +
        'under-reporting.');
}

{
    const literals = [subsDestination.LEGACY_SUBS_FILENAME, subsDestination.PII_SUBS_FILENAME];
    const owner = path.join(__dirname, 'subs-destination.js');

    function walkJs(dir, found) {
        for (const name of fs.readdirSync(dir)) {
            if (name === 'node_modules') continue;
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) { walkJs(full, found); continue; }
            if (!name.endsWith('.js')) continue;
            if (name.endsWith('.test.js') || name.endsWith('.test-support.js')) continue;
            found.push(full);
        }
        return found;
    }

    const scanned = walkJs(scriptsDir, []);
    assert.ok(scanned.length > 10,
        `4.f: only ${scanned.length} production scripts were scanned, so this section is ` +
        'green because it looked almost nowhere.');

    const offenders = [];
    for (const file of scanned) {
        if (path.resolve(file) === path.resolve(owner)) continue;
        const src = fs.readFileSync(file, 'utf8');
        for (const lit of literals) {
            for (const n of offendingLines(src, lit)) {
                offenders.push(path.relative(scriptsDir, file) + ':' + n + ' -> ' + lit);
            }
        }
    }

    assert.deepStrictEqual(offenders, [],
        '4.g: a substitution-table filename is spelled outside subs-destination.js. ' +
        'These two names are what the scrub writes, what the scaffolded .gitignore ' +
        'protects, and what two gates recognise; a copy that drifts is a table nothing ' +
        'keeps out of version control. Import LEGACY_SUBS_FILENAME / PII_SUBS_FILENAME ' +
        'from har/subs-destination.js instead. If the line is only a comment, put it on ' +
        'a line of its own. Offenders: ' + offenders.join(', '));

    // The scan is only meaningful if it can see the owner's own definition;
    // otherwise a rename would make it vacuously green.
    const ownerSrc = fs.readFileSync(owner, 'utf8');
    for (const lit of literals) {
        assert.ok(offendingLines(ownerSrc, lit).length > 0,
            `4.h: ${lit} is not defined in executable text in subs-destination.js, so ` +
            'section 4 is passing because the definition moved, not because there is one.');
    }
}

// ---------------------------------------------------------------------------
// 5. Each consolidated consumer actually reads the shared constant.
// ---------------------------------------------------------------------------
//
// Section 4 proves nobody re-spells the names. This proves the consumers use
// them -- a file that imports the constant and then ignores it passes 4 and is
// still broken. Where a consumer exports the value it derived, that export is
// compared to the constant by IDENTITY of content, and the ablation for this
// section is done by changing subs-destination.js and confirming each consumer
// follows.
{
    const generateWrapper = require(path.join(scriptsDir, 'codegen', 'generate-wrapper.js'));
    for (const lit of [subsDestination.LEGACY_SUBS_FILENAME, subsDestination.PII_SUBS_FILENAME]) {
        assert.ok(generateWrapper.SCAFFOLD_GITIGNORE_ENTRIES.includes(lit),
            `5.a: the scaffolded .gitignore no longer lists ${lit}. An operator who ran ` +
            'an earlier scrub has a table sitting in a committed directory and only ' +
            'this entry stops `git add -A` publishing what the scrub removed.');
    }

    const captureStore = require(path.join(scriptsDir, 'capture', 'capture-store.js'));
    assert.strictEqual(captureStore.LEGACY_SUBS_FILENAME, subsDestination.LEGACY_SUBS_FILENAME,
        '5.b: capture-store.js re-exports a different legacy table name than the scrub writes.');
    assert.strictEqual(captureStore.PII_SUBS_FILENAME, subsDestination.PII_SUBS_FILENAME,
        '5.c: capture-store.js re-exports a different PII table name than the scrub writes.');

    // audit-scrub-drift.js and verify-har-reference.js keep their name sets
    // private, so they are pinned by section 4 plus the fact that requiring
    // them is now free of side effects -- which is itself worth asserting,
    // since both grew `require.main` guards for the same reason this file exists.
    assert.doesNotThrow(() => require(path.join(__dirname, 'audit-scrub-drift.js')),
        '5.d: requiring audit-scrub-drift.js ran work.');
    assert.doesNotThrow(() => require(path.join(__dirname, 'verify-har-reference.js')),
        '5.e: requiring verify-har-reference.js ran work.');
}

console.log('All sanitize-har-importable tests passed');
