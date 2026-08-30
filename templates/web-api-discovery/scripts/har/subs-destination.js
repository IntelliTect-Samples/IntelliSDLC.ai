#!/usr/bin/env node
/**
 * subs-destination.js -- is this substitution-table destination protected?
 *
 * The substitution tables are keyed by the plaintext values the scrub
 * replaced, which makes each one a reverse lookup of live credentials. #294
 * moved them out of the committable output path and into a `.har-captures/`
 * directory, and the tooling has described that directory as "gitignored by
 * construction" ever since.
 *
 * It was not. It was gitignored by *convention plus location*: the name
 * `.har-captures` matched what a scaffolded consumer's `.gitignore` happens to
 * carry. Outside such a repo -- a capture corpus under `C:\temp`, a tree
 * spelled `har-captures` without the dot, a directory a human made by hand --
 * the name still matched the check while nothing protected the files (#318).
 *
 * A name is a proxy. This module asks git the actual question instead, and
 * every answer other than "yes, ignored" is a refusal: an unverified
 * destination is not assumed to be a safe one.
 *
 * Note the check is on the FILE path, not on its directory. That is what makes
 * it a property check rather than a better-spelled name check: a consumer's
 * scaffolded `.gitignore` covers `.substitutions.json` and
 * `.har-substitutions.json` by name at any depth as well as `.har-captures/`,
 * so a hand-made capture tree inside such a repo is accepted on its merits.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const IGNORED = 'ignored';
const NOT_IGNORED = 'not-ignored';
const OUTSIDE_WORK_TREE = 'outside-work-tree';
const UNVERIFIABLE = 'unverifiable';

/**
 * The nearest ancestor of `p` that exists on disk.
 *
 * The scrub creates the tables' directory itself, so classification routinely
 * runs against a path several levels below anything that exists yet. git needs
 * a real working directory to answer from; the nearest existing ancestor is
 * the closest one that still sits inside the same repository, if there is one.
 */
function nearestExistingDir(p) {
    let dir = path.resolve(p);
    for (;;) {
        if (fs.existsSync(dir)) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return dir;
        dir = parent;
    }
}

// A plain git question with a plain git answer -- the same shape as the probes
// in scripts/lib/repo-workflow-guard.js. `status` is null when git could not
// be run at all, which is an answer of its own (see UNVERIFIABLE).
//
// The whole `GIT_*` namespace is stripped from the child's environment, not a
// list of the variables that happen to be dangerous today. A blocklist is the
// wrong shape here: `GIT_DIR` and `GIT_WORK_TREE` redirect the answer to
// another repository, and `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
// `GIT_CONFIG_VALUE_n` inject `core.excludesFile` to make `check-ignore` call
// a path ignored that the repository does not protect -- and the next release
// may add a third way. A question about the wrong repository is worse than no
// answer, because it is a confident one.
//
// What is deliberately NOT stripped is `HOME` / `XDG_CONFIG_HOME`, so global
// and system config still apply. The distinction is not squeamishness about
// how far to go: environment-scoped config binds only this subprocess, so an
// "ignored" it produces is a claim about nothing -- the operator's own later
// `git add` would not honor it. Persistent config binds that `git add` too, so
// when it says a path is ignored, the path really will not be committed and
// the answer is correct.
function git(cwd, args) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!/^GIT_/i.test(k)) env[k] = v;
    }
    const r = spawnSync('git', args, {
        cwd, env, encoding: 'utf8', windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error) return { status: null, stdout: '' };
    return { status: r.status, stdout: (r.stdout || '').trim() };
}

/**
 * Classify where a substitution table is about to be written.
 *
 * @param {string} filePath absolute or relative path to the table itself
 * @returns {string} one of IGNORED, NOT_IGNORED, OUTSIDE_WORK_TREE, UNVERIFIABLE
 */
function classifyDestination(filePath) {
    const target = path.resolve(filePath);
    const cwd = nearestExistingDir(path.dirname(target));

    const inTree = git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inTree.status === null) return UNVERIFIABLE;
    if (inTree.status !== 0 || inTree.stdout !== 'true') return OUTSIDE_WORK_TREE;

    // check-ignore is path-name based, so the file need not exist. Exit 0 is
    // "ignored", exit 1 is "not ignored"; anything else is git declining to
    // answer, which is not the same as answering no.
    const ignored = git(cwd, ['check-ignore', '-q', '--', target]);
    if (ignored.status === 0) return IGNORED;
    if (ignored.status === 1) return NOT_IGNORED;
    return UNVERIFIABLE;
}

const WHY =
    'Its keys are the plaintext values the scrub replaced, so the table is a ' +
    'reverse lookup of live credentials and must never be committable.';

const REASONS = {
    [NOT_IGNORED]: (p) =>
        `${p} is inside a git work tree but is not gitignored. ${WHY}\n` +
        "  Add '.har-captures/' (or the table filenames '.substitutions.json' and " +
        "'.har-substitutions.json') to the repository's .gitignore, then re-run.",
    [OUTSIDE_WORK_TREE]: (p) =>
        `${p} is not inside a git work tree, so nothing keeps it out of version ` +
        `control if a repository is ever created around it. ${WHY}\n` +
        '  Re-run from inside the repository that owns the capture.',
    [UNVERIFIABLE]: (p) =>
        `${p} could not be checked -- git did not answer whether the path is ` +
        `ignored. ${WHY}\n` +
        '  An unverified destination is not assumed to be a safe one. Make git ' +
        'available on PATH and re-run.',
};

/**
 * The operator-facing refusal for a classification, or null when the
 * destination is fine.
 *
 * @param {string} filePath the destination that was classified
 * @param {string} status a classifyDestination() result
 * @param {string} flagName the flag that names this table explicitly
 */
function refusalMessage(filePath, status, flagName) {
    if (status === IGNORED) return null;
    const reason = REASONS[status] || REASONS[UNVERIFIABLE];
    return `refusing to write a substitution table: ${reason(filePath)}\n` +
        `  Or pass ${flagName} <path> to name the destination deliberately.`;
}

module.exports = {
    classifyDestination,
    refusalMessage,
    nearestExistingDir,
    IGNORED,
    NOT_IGNORED,
    OUTSIDE_WORK_TREE,
    UNVERIFIABLE,
};
