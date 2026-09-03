#!/usr/bin/env node
'use strict';

/**
 * THE ONE WALK OVER A CAPTURE STORE.
 *
 * `capture-har.js` already had a walk -- `listSessionDirs`, the enumeration
 * `resolveSession` uses to answer "which capture" for `stop`, `status` and
 * `catalogue`. Issue #386 wanted to process a whole store, and issue #387's
 * narrowing comment made the binding call on how: REUSE that enumeration, do
 * not write a second one. Two notions of what a capture is, is the defect this
 * subsystem exists to avoid.
 *
 * So the walk MOVED here rather than being copied. `capture-har.js`'s
 * `listSessionDirs` now delegates to `listSessionDirs` below and keeps its
 * exact old contract (`{ dir, stamp }`, recorder sessions only), while the
 * batch drivers ask `listCaptureDirs` for the same walk with its
 * CLASSIFICATION intact. One traversal, two readings of it -- not two
 * traversals.
 *
 * WHY CLASSIFICATION IS PART OF THE WALK. Measured in a real 88-capture store,
 * a walk that understands only `<host>/<stamp>/session.json` silently misses
 * two whole populations:
 *
 *   LEGACY   date-stamped session directories sitting at the captures ROOT,
 *            written before the host layer existed. Six of them. A host-scoped
 *            walk never descends to them, and they carry a `session.json` and a
 *            raw like any other capture.
 *   FOREIGN  directories holding a capture that this recorder did not make --
 *            mitmproxy `raw.mitm` dumps, five of them, 1,739 entries. They have
 *            no `session.json`, so nothing here knows their provenance, their
 *            URI or their intent.
 *
 * Silently skipping either is the failure mode: the operator asked for the
 * store and got a subset, with nothing said. So a foreign directory is NAMED
 * and DECLINED -- reported by path and marker file, never fed to a HAR scrub
 * that has no session to attribute it to.
 *
 * IT NEVER READS A CAPTURE. Only directory entries and file existence, plus
 * `session.json`, which the recorder wrote and which holds no captured traffic.
 * Nothing here can echo a captured value because nothing here opens a HAR.
 */

const fs = require('fs');
const path = require('path');

const CAPTURES_DIR = '.har-captures';
const SESSION_FILE = 'session.json';
const RAW_HAR = 'raw.har';
const RAW_MITM = 'raw.mitm';
const SCRUBBED_HAR = 'scrubbed.har';
const DIGEST_FILE = 'digest.json';
const CATALOGUE_FILE = 'catalogue.json';
// Same stem `capture-har.js` quarantines onto. Matched as a PREFIX because a
// second rejection is given a distinguishing suffix rather than overwriting the
// first -- nothing under .har-captures/ is replaced.
const REJECTED_PREFIX = 'scrubbed.rejected';

/** A recorder capture under `<root>/<host>/<stamp>`. */
const CLASS_SESSION = 'session';
/** A recorder capture at `<root>/<stamp>`, predating the host layer. */
const CLASS_LEGACY = 'legacy';
/** A capture this recorder did not make. Named, and declined. */
const CLASS_FOREIGN = 'foreign';

/**
 * Legacy or current, decided on the PARENT DIRECTORY and not on the walk's
 * starting point.
 *
 * The distinction has to survive being asked from anywhere: an operator may
 * point the batch at the store root, at one host folder, or at a single
 * capture, and the same directory must classify the same way in all three. A
 * depth counter measured from wherever the walk began would call every stamp
 * under a host folder "legacy" the moment the operator narrowed to that host --
 * which is the supported way to filter by host, so it would be wrong most of
 * the time it mattered.
 *
 * Sitting directly under `.har-captures` IS the legacy layout, and is the only
 * thing that means it.
 */
function classifySessionDir(dir) {
    return isAtCapturesRoot(dir) ? CLASS_LEGACY : CLASS_SESSION;
}

/** Does this directory sit DIRECTLY under `.har-captures`, with no host layer? */
function isAtCapturesRoot(dir) {
    return path.basename(path.dirname(dir)).toLowerCase() === CAPTURES_DIR;
}

/**
 * The site this capture belongs to, or null when there is no host layer to
 * read one from.
 *
 * Null rather than `.har-captures`, which is what the parent directory
 * literally is for a root-level capture -- printing that in a summary would
 * name the store as though it were a site. Applies to a DECLINED capture at the
 * root as much as to a legacy one: the question is the layout, not the class.
 */
function hostOf(dir) {
    return isAtCapturesRoot(dir) ? null : path.basename(path.dirname(dir));
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function exists(p) {
    try { fs.statSync(p); return true; } catch (e) { return false; }
}

function byteSize(p) {
    try { return fs.statSync(p).size; } catch (e) { return null; }
}

/**
 * Has a scrub already been quarantined here?
 *
 * A rejected scrub is NOT a processed capture -- there is no verified artifact
 * and nothing was promoted -- but it is worth reporting, because "this ran and
 * the gate refused it" and "nobody has touched this" are different states and
 * the operator triages them differently.
 */
function hasRejectedScrub(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return false; }
    return names.some((n) => n.startsWith(REJECTED_PREFIX) && n.endsWith('.har'));
}

/**
 * What one directory IS, or null if it is not a capture at all.
 *
 * The `session.json` test comes first and decides everything: with it, the
 * recorder made this and its provenance is readable; without it, a raw beside
 * no session is a capture somebody else made. A directory with neither is not a
 * capture -- an analysis folder, a manifest, a rescued output directory -- and
 * returning null for those is why the summary counts stay meaningful.
 */
function describeCaptureDir(dir) {
    const sessionPath = path.join(dir, SESSION_FILE);
    const stamp = path.basename(dir);

    if (exists(sessionPath)) {
        const session = readJson(sessionPath);
        const raw = path.join(dir, RAW_HAR);
        return {
            dir,
            stamp,
            host: hostOf(dir),
            captureClass: classifySessionDir(dir),
            reason: null,
            raw: exists(raw) ? raw : null,
            rawBytes: byteSize(raw),
            // A session the recorder never finished closing. Reported, not
            // refused: `assembleFromLog` exists precisely so an interrupted
            // recording still yields a raw.
            ended: Boolean(session && session.endedUtc),
            describe: (session && session.describe) || null,
            scrubbed: exists(path.join(dir, SCRUBBED_HAR)),
            rejected: hasRejectedScrub(dir),
            digest: exists(path.join(dir, DIGEST_FILE)),
            catalogue: exists(path.join(dir, CATALOGUE_FILE))
        };
    }

    // No session.json. A raw of either kind still means somebody captured
    // traffic here, and the operator pointed the batch at it, so it is named.
    const marker = [RAW_MITM, RAW_HAR].find((n) => exists(path.join(dir, n)));
    if (!marker) return null;
    return {
        dir,
        stamp,
        host: hostOf(dir),
        captureClass: CLASS_FOREIGN,
        reason: `${marker} with no ${SESSION_FILE}`,
        raw: null,
        rawBytes: null,
        ended: false,
        describe: null,
        scrubbed: false,
        rejected: false,
        digest: false,
        catalogue: false
    };
}

/**
 * Every capture at or under `root`, classified.
 *
 * Two levels and no deeper, which is the whole shape of a store: a capture is
 * `<root>/<host>/<stamp>` or, in the legacy layout, `<root>/<stamp>`. Pointing
 * at one host folder finds that host's captures at the first level; pointing at
 * a single capture directory finds exactly it. Recursing further would start
 * calling scrub-output subdirectories captures.
 *
 * Accepts several roots for the reason `capture-har.js` already needed to
 * (#367): a capture written under an older working-directory root has to remain
 * findable, and a union is how it is found without anything being moved.
 */
function listCaptureDirs(root) {
    const roots = Array.isArray(root) ? root : [root];
    const seen = new Set();
    const found = [];

    // Records what `dir` is, and answers ONE question for the caller: is this a
    // leaf?
    //
    // A recorder session IS a leaf -- its own scrub output lives inside it, and
    // a `<stamp>/` directory has no captures under it by construction. So the
    // walk stops there and never calls `scrubbed.har`'s directory a capture.
    //
    // A DECLINED directory is NOT a leaf, and the difference is load-bearing. A
    // stray `raw.har` at host level is enough to make that directory look like
    // somebody else's capture; if declining also stopped the descent, one stray
    // file would hide every capture under that host, silently -- the exact
    // failure mode this classification exists to remove. Declining is a
    // statement about the directory, never about the tree below it.
    const consider = (dir) => {
        if (seen.has(dir)) return false;
        const entry = describeCaptureDir(dir);
        if (!entry) return false;
        seen.add(dir);
        found.push(entry);
        return entry.captureClass !== CLASS_FOREIGN;
    };

    for (const r of roots) {
        if (!r || !isDir(r)) continue;
        const resolved = path.resolve(r);
        // The root ITSELF may be a capture. An operator who points the batch at
        // one session directory is asking for a batch of one, and refusing that
        // would make "point it at a folder" mean "point it at the right level
        // of folder".
        if (consider(resolved)) continue;
        let children;
        try { children = fs.readdirSync(resolved); } catch (e) { continue; }
        for (const child of children) {
            const childDir = path.join(resolved, child);
            if (!isDir(childDir)) continue;   // a stray file, or anything non-traversable
            if (consider(childDir)) continue;
            let grandchildren;
            try { grandchildren = fs.readdirSync(childDir); } catch (e) { continue; }
            for (const grandchild of grandchildren) {
                const grandchildDir = path.join(childDir, grandchild);
                if (!isDir(grandchildDir)) continue;
                consider(grandchildDir);
            }
        }
    }

    return found;
}

/**
 * The old `capture-har.js` contract, unchanged: recorder sessions only, as
 * `{ dir, stamp }`.
 *
 * `resolveSession` sorts these by stamp and takes the newest, so returning the
 * stamp separately still matters -- the host sorts first in a joined path and
 * would otherwise decide which capture counts as most recent.
 *
 * Legacy captures are now IN this list where before they were invisible. That
 * is the fix, not a side effect: a date-stamped session directory at the
 * captures root is a capture by every test `stop` and `status` apply, and the
 * only reason they could not see it was that the walk started one level too
 * deep.
 *
 * THE CLASS COMES WITH THEM, and it is not decoration. Being findable and being
 * a candidate for "a recorder is running right now" are different questions,
 * and only the first one was being fixed -- see `isDriverAlive`'s callers.
 */
function listSessionDirs(root) {
    return listCaptureDirs(root)
        .filter((e) => e.captureClass === CLASS_SESSION || e.captureClass === CLASS_LEGACY)
        .map(({ dir, stamp, captureClass }) => ({ dir, stamp, captureClass }));
}

module.exports = {
    listCaptureDirs,
    isAtCapturesRoot,
    listSessionDirs,
    describeCaptureDir,
    classifySessionDir,
    CLASS_SESSION,
    CLASS_LEGACY,
    CLASS_FOREIGN,
    CAPTURES_DIR,
    SCRUBBED_HAR,
    CATALOGUE_FILE,
    REJECTED_PREFIX
};

// A JSON printer, and deliberately nothing more.
//
// This is the transport that lets the PowerShell batch drivers use THIS walk
// instead of growing one of their own in a language that cannot import it. It
// takes a path and prints the classified inventory; it has no options, no
// filters and no verbs, because every one of those would be a decision made
// twice. It is plumbing between two halves of one feature, not an operator
// surface -- the read-only store REPORT an operator runs is #387.
if (require.main === module) {
    const target = process.argv[2];
    if (!target) {
        process.stderr.write('capture-store: a path is required\n');
        process.exit(2);
    }
    if (!exists(target)) {
        process.stderr.write(`capture-store: ${target} does not exist\n`);
        process.exit(3);
    }
    process.stdout.write(JSON.stringify(listCaptureDirs(target), null, 2) + '\n');
}
