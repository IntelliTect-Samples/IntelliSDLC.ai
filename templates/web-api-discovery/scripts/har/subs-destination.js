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
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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

// Variables naming where git looks for a home directory, and therefore for
// global config. Overridden, not merely removed -- see probeEnv().
const HOME_VARS = ['HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];

// A directory that does not exist and cannot be predicted by whoever set the
// environment, so nothing can be planted there ahead of the run. git reads no
// config from a home that is not there.
const NO_HOME = path.join(os.tmpdir(), 'sanitize-har-no-home-' + crypto.randomBytes(9).toString('hex'));

/**
 * The environment the probes run in: everything except what can tell git where
 * to find configuration.
 *
 * The whole `GIT_*` namespace goes, rather than the variables known to be
 * dangerous today. A blocklist is the wrong shape: `GIT_DIR` and
 * `GIT_WORK_TREE` redirect the answer to another repository, and
 * `GIT_CONFIG_COUNT` with a `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pair
 * injects `core.excludesFile` so that `check-ignore` calls a path ignored that
 * the repository does not protect -- and the next release may add a third way.
 *
 * The home variables go for the same reason, though it took a second look to
 * see it. The tempting argument for keeping them is that global config is
 * *persistent*, so unlike a per-invocation `GIT_CONFIG_*` it binds the
 * operator's own later `git add` too, which would make its "ignored" a true
 * answer rather than a forged one. That argument does not survive: what is
 * persistent is the config *file*, while the path to it is named by an
 * environment variable, and `HOME=<somewhere> node sanitize-har.js` scopes that
 * to exactly one invocation as cheaply as the `GIT_CONFIG_*` form it was
 * supposed to be different from.
 *
 * The home variables are OVERRIDDEN rather than removed, which is not
 * decoration. On Windows, node re-injects `HOMEDRIVE`, `HOMEPATH` and
 * `USERPROFILE` into a child process even when the `env` handed to spawnSync
 * omits them, so deleting those keys is silently ineffective -- a poisoned
 * `HOMEDRIVE`/`HOMEPATH` pair still reached git and still produced a false
 * "ignored". Assigning them a home that does not exist is what actually holds.
 * `GIT_CONFIG_GLOBAL` says the same thing a second way, for git versions that
 * honor it, without depending on how home discovery happens to be implemented.
 *
 * System config is deliberately still honored: once the `GIT_*` namespace is
 * stripped its location is fixed rather than environment-named, so it cannot be
 * pointed somewhere else for one invocation, and an admin-installed rule is a
 * real fact about the machine.
 *
 * The cost is real and deliberate: an operator whose only ignore rule for these
 * files lives in a global `core.excludesFile` is refused, and told to add the
 * entry to the repository. That is a false refusal rather than a false pass,
 * which is the direction this module errs in everywhere else.
 */
function probeEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        // Windows environment names are case-insensitive; compare accordingly.
        if (/^GIT_/i.test(k) || HOME_VARS.includes(k.toUpperCase())) continue;
        env[k] = v;
    }
    env.HOME = NO_HOME;
    env.USERPROFILE = NO_HOME;
    env.XDG_CONFIG_HOME = NO_HOME;
    env.HOMEDRIVE = NO_HOME.slice(0, 2);
    env.HOMEPATH = NO_HOME.slice(2);
    env.GIT_CONFIG_GLOBAL = path.join(NO_HOME, 'gitconfig');
    return env;
}

// A plain git question with a plain git answer. `status` is null when git could
// not be run at all, which is an answer of its own (see UNVERIFIABLE).
function git(cwd, args) {
    const r = spawnSync('git', args, {
        cwd, env: probeEnv(), encoding: 'utf8', windowsHide: true,
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

    // A repository whose ownership git disputes fails this probe and is
    // refused. That reads as over-strict and there is an obvious-looking
    // remedy -- pass `-c safe.directory=<path>` so the probe proceeds. Do not:
    // a repository's own .git/config may set core.excludesFile, and pointing it
    // at a file matching `*` makes check-ignore call anything ignored
    // (confirmed: exit 1 before planting the setting, exit 0 after). Disputed
    // ownership means the repository is somebody else's, so safe.directory is
    // the control that stops us trusting their config -- bypassing it here
    // would open a forging vector rather than close a false refusal.
    //
    // Nor does neutralising that one setting rescue the idea. Once ownership
    // is trusted, a plain tracked `.gitignore` containing `*` forges the same
    // answer with no config involved: git has no notion of trusting a tree
    // enough to walk it but not enough to believe its ignore rules, because
    // they are the same trust boundary. Honouring the boundary is the only
    // option short of reimplementing gitignore semantics outside git.
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
