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
    guardMessage,
    relocationNotice,
    FALLBACK_TRUNKS
};
