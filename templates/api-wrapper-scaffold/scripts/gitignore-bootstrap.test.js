// Behavior test for ensureRepoRootGitignoreHasScaffoldEntries (issue #119).
// Zero-dep, runs under plain Node. Asserts:
//   1. On a fresh outDir with no .gitignore, the function creates one and
//      adds every scaffold entry -- the raw-capture and binary directories,
//      and the operator's .har-profile.json (issue #255), which carries the
//      salt and identifier -> sentinel map and must never be committed.
//   2. Idempotent: a second call adds nothing.
//   3. Pre-existing .gitignore with unrelated content is preserved; only
//      missing scaffold entries are appended.
//   4. Pre-existing .gitignore that already lists one entry only appends
//      the other.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { ensureRepoRootGitignoreHasScaffoldEntries, SCAFFOLD_GITIGNORE_ENTRIES } =
    require('./generate-wrapper.js');

function mkTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-gitignore-'));
}

function readGi(dir) {
    return fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
}

let failed = 0;
function assert(cond, msg) {
    if (!cond) { failed++; console.error('FAIL: ' + msg); }
}

// 1. Fresh outDir, no .gitignore.
{
    const dir = mkTmp();
    const added = ensureRepoRootGitignoreHasScaffoldEntries(dir);
    assert(added.length === SCAFFOLD_GITIGNORE_ENTRIES.length,
        '[fresh] every entry should be added, got ' + added.length);
    assert(SCAFFOLD_GITIGNORE_ENTRIES.includes('.har-profile.json'),
        '[fresh] the operator profile must be gitignored -- it holds real identifiers');
    const body = readGi(dir);
    for (const e of SCAFFOLD_GITIGNORE_ENTRIES) {
        assert(body.includes(e), '[fresh] .gitignore missing ' + e);
    }
}

// 2. Idempotent.
{
    const dir = mkTmp();
    ensureRepoRootGitignoreHasScaffoldEntries(dir);
    const before = readGi(dir);
    const added2 = ensureRepoRootGitignoreHasScaffoldEntries(dir);
    assert(added2.length === 0, '[idempotent] second call should add zero, got ' + added2.length);
    const after = readGi(dir);
    assert(before === after, '[idempotent] .gitignore byte-identical across calls');
}

// 3. Pre-existing unrelated content preserved.
{
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'bin/\nobj/\n', 'utf8');
    const added = ensureRepoRootGitignoreHasScaffoldEntries(dir);
    assert(added.length === SCAFFOLD_GITIGNORE_ENTRIES.length,
        '[preserve] should add every entry, got ' + added.length);
    const body = readGi(dir);
    assert(body.startsWith('bin/\nobj/\n'), '[preserve] original content must be preserved at start');
    for (const e of SCAFFOLD_GITIGNORE_ENTRIES) {
        assert(body.includes(e), '[preserve] missing ' + e);
    }
}

// 4. Already lists one entry; only the other is appended.
{
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'bin/\nSamples/HAR-Original/\n', 'utf8');
    const added = ensureRepoRootGitignoreHasScaffoldEntries(dir);
    assert(added.length === SCAFFOLD_GITIGNORE_ENTRIES.length - 1,
        '[partial] should add all but the one already listed, got ' + added.length);
    assert(!added.includes('Samples/HAR-Original/'),
        '[partial] should not re-add the entry already present');
    const body = readGi(dir);
    // exactly one occurrence of HAR-Original
    const harCount = (body.match(/Samples\/HAR-Original\//g) || []).length;
    assert(harCount === 1, '[partial] HAR-Original/ duplicated (count=' + harCount + ')');
}

if (failed === 0) {
    console.log('All gitignore-bootstrap tests passed.');
    process.exit(0);
} else {
    console.error(failed + ' test(s) failed.');
    process.exit(1);
}