#!/usr/bin/env node
// Where a capture's artifacts are allowed to land, and when to say so (#300).
//
// Capture tooling resolves its output against the WORKING DIRECTORY. That is
// correct outside a repository and wrong inside one: run from a project's root
// checkout while sitting on the protected branch, the output folder is created
// at the repo root on `main`, where the repo's own rules forbid committing it.
// Nothing noticed, so the violation stayed invisible until somebody happened to
// run `git status` hours later.
//
// THE INVARIANT THIS MODULE EXISTS TO SERVE:
//
//     The guard runs BEFORE any capture begins, never after. Nothing that cost
//     the operator effort may exist when it fires.
//
// That is what makes warn-and-proceed safe. Launching a recorder is cheap, so a
// warning seconds in costs nothing to act on. A guard placed anywhere
// downstream would be deciding whether to discard a recording the operator
// spent minutes producing -- a worse outcome than the pollution it prevents.
// Hence: this module warns and never throws, and callers must call it before
// they start work rather than before they write files.
//
// A SECOND, HARDER PLACEMENT QUESTION now lives here too (#367): where the RAW
// capture root goes. That one is not advisory, because its failure mode is not
// a dirty tree -- it is deletion. `resolveCaptureRoot` anchors the root to the
// repository's MAIN working tree, so a routine worktree cleanup cannot take an
// unrepeatable capture with it. Warn-and-proceed is right for output that
// merely landed awkwardly; it is not right for bytes that stop existing.
//
// WHY THAT ONE CANNOT BE A WARNING AT ALL. The session that destroyed the
// reported capture checked twice before deleting, and both checks were
// structurally incapable of seeing it: a directory listing that hides
// dot-directories, and `git status --porcelain` reporting clean. IGNORED
// CONTENT NEVER APPEARS IN `git status`. The capture store is gitignored -- by
// design, because it holds live session cookies -- so the standard "what would
// I lose if I deleted this?" check is blind to the only thing worth
// protecting. No warning printed at record time survives to the cleanup that
// happens days later in another session, and the cleanup's own instruments say
// there is nothing there. Placement is the only control that works.
//
// It lives in scripts/lib/ and is shared rather than reimplemented per script.
// Bespoke per-script placement logic is how the defect arrived in the first
// place. RepoWorkflowGuard.ps1 is its PowerShell twin; the two are held to one
// decision table by repo-workflow-guard.test.js and har-recording.Tests.ps1.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Every probe is a plain git question with a plain git answer. No heuristics:
// the point of the three probes below is that each has a definite answer, so
// there is nothing to guess and nothing to tune.
function git(cwd, args) {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
        }).trim();
    } catch (err) {
        // Not a repo, no such ref, no such config -- all of which are answers,
        // not faults. The caller distinguishes them by which probe went quiet.
        void err;
        return null;
    }
}

function realpath(p) {
    try { return fs.realpathSync(p); } catch (err) { void err; return path.resolve(p); }
}

/**
 * Probe 1 of 3: are we inside a repository at all?
 *
 * If not, the working-directory default is CORRECT and this module has nothing
 * to say. Returning null here is what keeps standalone use byte-for-byte
 * unchanged.
 */
function topLevelOf(cwd) {
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    return top ? realpath(top) : null;
}

/**
 * Probe 2 of 3: primary checkout, or worktree?
 *
 * In a linked worktree `--git-dir` points at `.git/worktrees/<name>` while
 * `--git-common-dir` points at the shared `.git`; in the primary checkout they
 * are the same directory. This is the same test the repository's own pre-commit
 * hook uses, deliberately -- a guard that disagreed with the hook about what
 * counts as a worktree would be worse than no guard.
 */
function isPrimaryCheckout(cwd) {
    const dir = git(cwd, ['rev-parse', '--absolute-git-dir']);
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!dir || !common) { return false; }
    return realpath(dir) === realpath(common);
}

/**
 * Probe 3 of 3: which branch is the protected one?
 *
 * Discovered from `origin/HEAD` rather than hardcoded, so a repo whose trunk is
 * `trunk`, `develop` or anything else is served correctly.
 *
 * When origin/HEAD is absent -- a repo with no remote, or a clone whose
 * origin/HEAD was never set -- we fall back to the conventional trunk names
 * instead of disabling the guard. The asymmetry is deliberate: a spurious
 * warning costs one ignored line and the run proceeds regardless, while a
 * missed warning is exactly the defect being fixed.
 */
const FALLBACK_TRUNKS = ['main', 'master'];

function protectedBranchOf(cwd, currentBranch) {
    const head = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head) { return head.replace(/^origin\//, ''); }
    if (currentBranch && FALLBACK_TRUNKS.includes(currentBranch)) { return currentBranch; }
    return FALLBACK_TRUNKS[0];
}

/**
 * Does this repository declare a no-work-on-the-protected-branch rule?
 *
 * Asking matters because warning in a repo that has no such rule would be
 * noise, and noise is how a warning gets trained out of an operator's
 * attention.
 *
 * 1. `core.hooksPath` resolving to a TRACKED directory with a `pre-commit` in
 *    it. Self-declaring, needs no new configuration, and it is the convention's
 *    own artifact. Tracked is the load-bearing half: an untracked hooks
 *    directory is one developer's local preference and cannot speak for the
 *    repository.
 * 2. An explicit `sdlc.protectedBranchWorkflow` boolean, for repos that rely on
 *    server-side branch protection and ship no hooks. Set false, it is also the
 *    opt-out -- checked first so it can override the hooks signal.
 *
 * Deliberately NOT `git hook run pre-commit`: `pre-commit` semantics are not
 * `pre-write`, and hooks may have side effects. Nor is the hook's CONTENT
 * grepped -- matching on what a shell script says would be the heuristic this
 * design set out to avoid, and it would break the moment a repo phrased its
 * own rule differently.
 */
function declaredRule(cwd, topLevel) {
    const declared = git(cwd, ['config', '--get', 'sdlc.protectedBranchWorkflow']);
    if (declared !== null && declared !== '') {
        return /^(true|yes|on|1)$/i.test(declared) ? 'config' : null;
    }

    const hooksPath = git(cwd, ['config', '--get', 'core.hooksPath']);
    if (!hooksPath) { return null; }

    const resolved = path.isAbsolute(hooksPath)
        ? hooksPath
        : path.resolve(topLevel, hooksPath);
    const preCommit = path.join(resolved, 'pre-commit');
    if (!fs.existsSync(preCommit)) { return null; }

    const tracked = git(topLevel, ['ls-files', '--error-unmatch', '--', preCommit]);
    return tracked ? 'hooksPath' : null;
}

/**
 * Everything the three probes know about the current checkout.
 *
 * Returns a plain description, never a decision to abort: `shouldWarn` is the
 * only judgement, and it is advisory by construction.
 */
function inspectCheckout(cwd) {
    const dir = cwd || process.cwd();
    const topLevel = topLevelOf(dir);

    if (!topLevel) {
        return {
            insideRepo: false,
            topLevel: null,
            primaryCheckout: false,
            currentBranch: null,
            protectedBranch: null,
            declaresRule: false,
            ruleSource: null,
            shouldWarn: false
        };
    }

    const primaryCheckout = isPrimaryCheckout(dir);
    // A detached HEAD reports "HEAD", which is not a branch name and so can
    // never equal the protected branch. That is the right answer: nothing is
    // being committed to the protected branch from a detached head either.
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const currentBranch = branch === 'HEAD' ? null : branch;
    const protectedBranch = protectedBranchOf(dir, currentBranch);
    const ruleSource = declaredRule(dir, topLevel);

    return {
        insideRepo: true,
        topLevel,
        primaryCheckout,
        currentBranch,
        protectedBranch,
        declaresRule: ruleSource !== null,
        ruleSource,
        shouldWarn: Boolean(
            primaryCheckout && ruleSource && currentBranch &&
            currentBranch === protectedBranch)
    };
}

/**
 * Where the DEFAULT output goes -- the repo root inside a repo, the working
 * directory outside one.
 *
 * The default only. An explicitly supplied relative path keeps resolving
 * against the working directory, because a path the operator typed should mean
 * what they typed.
 *
 * Anchoring on its own does NOT fix the problem this module is named for: a
 * worktree has its own toplevel, so output still lands wherever the operator
 * happens to be. It makes placement PREDICTABLE, not correct. The warning is
 * what addresses correctness, and it is still required.
 */
function resolveDefaultOutputRoot(cwd) {
    const dir = cwd || process.cwd();
    return topLevelOf(dir) || path.resolve(dir);
}

/**
 * The MAIN working tree of the repository containing `cwd` -- never a linked
 * worktree -- or null when there is no main working tree to name.
 *
 * WHY THIS EXISTS (#367). A linked worktree is DISPOSABLE by design:
 * `git worktree remove` deletes it outright, no prompt, nothing to the Recycle
 * Bin. Anything gitignored inside it is invisible to git, so the operator is
 * asked nothing and told nothing. A 71 MB raw capture was destroyed that way by
 * an ordinary cleanup, and the cleanup was CORRECT -- the capture simply had no
 * business being somewhere with a short lifetime.
 *
 * The main working tree has the lifetime of the clone, which is the lifetime an
 * unrepeatable artifact needs.
 *
 * `git worktree list --porcelain` names the main working tree as its FIRST
 * entry, by definition, which is why it is asked rather than derived. Deriving
 * it from `--git-common-dir` by taking the parent is right for an ordinary
 * clone and wrong for a submodule, whose common dir is
 * `<super>/.git/modules/<name>` and whose parent is not a working tree at all.
 * The worktree test itself stays `--git-dir` vs `--git-common-dir` -- the same
 * comparison the repository's pre-commit hook uses -- so this module and the
 * hook cannot disagree about what a worktree is.
 *
 * Returns null for: outside a repository, and a BARE main repository (whose
 * first entry has no working tree to write into). Both fall back to the
 * caller's working directory, which is exactly today's behaviour.
 */
function mainWorkingTreeOf(cwd) {
    const dir = cwd || process.cwd();
    const here = topLevelOf(dir);
    if (!here) { return null; }
    // The overwhelmingly common case, and it costs no extra process: a primary
    // checkout IS the main working tree.
    if (isPrimaryCheckout(dir)) { return here; }

    const listed = git(dir, ['worktree', 'list', '--porcelain']);
    if (!listed) { return null; }
    // Blocks are separated by a blank line; the first block is the main working
    // tree. Only the trailing CR is stripped -- a path is taken verbatim
    // otherwise, so one containing spaces survives intact.
    const firstBlock = listed.split(/\r?\n\s*\r?\n/)[0] || '';
    const lines = firstBlock.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
    if (lines.some((l) => l === 'bare')) { return null; }
    const entry = lines.find((l) => l.startsWith('worktree '));
    if (!entry) { return null; }
    const p = entry.slice('worktree '.length);
    return p ? realpath(p) : null;
}

/**
 * Where a capture root of the given NAME belongs, and whether that differs from
 * where the working directory alone would have put it.
 *
 * The name is the caller's -- this module decides the ANCHOR, never the folder,
 * so nothing here can be used to redirect a raw capture somewhere else.
 *
 * `legacyRoot` is the working-directory answer this replaces. It is reported so
 * a caller can still FIND a capture written before this change, or by an older
 * copy of the tool, without any of them being moved: reading both places is
 * safe, and relocating what is already on disk is precisely the operation that
 * must never happen to a raw.
 */
function resolveCaptureRoot(cwd, dirName) {
    const dir = cwd || process.cwd();
    const here = topLevelOf(dir);
    const main = mainWorkingTreeOf(dir);
    const anchor = main || path.resolve(dir);
    const root = path.join(anchor, dirName);
    const legacyRoot = path.join(path.resolve(dir), dirName);
    return {
        root,
        legacyRoot,
        insideRepo: here !== null,
        mainWorkingTree: main,
        currentWorkingTree: here,
        // Only a LINKED worktree is a durability problem. Anchoring a run made
        // from a subdirectory of the main checkout also moves the root, and
        // that is worth saying, but it is not the deletion hazard.
        worktree: Boolean(main && here && main !== here),
        relocated: root !== legacyRoot
    };
}

/**
 * One line the operator can act on, printed while the capture is STARTING.
 *
 * At record time and not only into `session.json`: the incident's session file
 * recorded the doomed path perfectly, and nobody read it until after the bytes
 * were gone. A path named on the way in is a path the operator can question.
 *
 * ALWAYS the path, even when nothing moved -- including outside a repository,
 * where the working-directory answer is the only one there is. A notice that
 * appeared only in the interesting case would leave "no line" meaning both
 * "unchanged" and "this version does not tell you", and the second is what the
 * operator would be relying on.
 */
function captureRootNotice(placement) {
    if (!placement) { return null; }
    const lines = ['Capture root: ' + placement.root];
    if (placement.worktree) {
        lines.push(
            '  Recording from a linked worktree (' + placement.currentWorkingTree + '),',
            '  so the raw capture is written to the MAIN working tree instead.',
            '  `git worktree remove` deletes a gitignored capture outright, with nothing',
            '  to prompt about, and a raw is the one artifact that cannot be regenerated.');
    } else if (placement.relocated) {
        lines.push('  (anchored to the repository root, not the working directory)');
    }
    return lines.join('\n');
}

function worktreeCommand(info) {
    const branchName = info.protectedBranch || 'main';
    return 'git worktree add .worktrees/<name> -b <type>/<issue#>-<name> ' + branchName;
}

/**
 * The warning itself.
 *
 * It has to carry four things or it is not actionable: what was detected, why
 * it matters, the exact command to run instead, and the fact that ignoring it
 * is safe. Leaving out the last one would turn an advisory into something that
 * reads like a failure.
 */
function guardMessage(info) {
    if (!info || !info.shouldWarn) { return ''; }
    return [
        'This is the primary checkout on the protected branch (' + info.protectedBranch + ').',
        'Output will land in ' + info.topLevel + ', where commits are blocked,',
        'so the artifacts will strand there until somebody notices a dirty tree.',
        'To place them somewhere committable, cancel and run:',
        '    ' + worktreeCommand(info),
        'Continuing anyway is safe -- the recording proceeds and nothing is discarded.'
    ].join('\n');
}

/**
 * The closing notice: what was written, and the one command that relocates it.
 *
 * This is the other half of what makes "proceed" genuinely safe rather than
 * merely deferred. The polluting set is small and precisely known -- raw
 * captures are already confined to a gitignored directory -- so cleanup can be
 * reduced to a single move, and an operator who ignored the warning is not left
 * to work out what to tidy.
 *
 * Returns null when the guard never fired, so callers can print it
 * unconditionally.
 */
function relocationNotice(info, writtenPaths) {
    if (!info || !info.shouldWarn) { return null; }
    const paths = (writtenPaths || []).filter(Boolean);
    if (!paths.length) { return null; }

    const lines = [
        'Written to the primary checkout on ' + info.protectedBranch + ':'
    ];
    for (const p of paths) { lines.push('    ' + p); }
    lines.push('To move them somewhere committable:');
    lines.push('    ' + worktreeCommand(info));
    lines.push('    mv ' + paths.map((p) => '"' + p + '"').join(' ') + ' .worktrees/<name>/');
    return lines.join('\n');
}

module.exports = {
    inspectCheckout,
    resolveDefaultOutputRoot,
    mainWorkingTreeOf,
    resolveCaptureRoot,
    captureRootNotice,
    guardMessage,
    relocationNotice,
    FALLBACK_TRUNKS
};
