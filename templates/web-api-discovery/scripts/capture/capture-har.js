#!/usr/bin/env node
/**
 * capture-har.js -- record a browser session, scrub it, and catalogue it.
 *
 * One command takes a URL to a scrubbed, catalogued, committable reference
 * set. The operator's entire surface is still a URL:
 *
 *   Invoke-HarCapture https://example.com
 *
 * Two properties drive the design, and neither is negotiable:
 *
 *  - A HUMAN drives it by browsing, and ends it by pressing ENTER.
 *  - An AI drives it over CDP, and ends it with `stop`.
 *
 * Both need the SAME recording, so this script owns the browser context and
 * nothing else does. `playwright open --save-har` cannot serve the second
 * case: it flushes only when a human closes the window, and it offers no
 * persistent profile. A context launched here records every request made in
 * it, including requests driven by a CDP client that attached later --
 * `connectOverCDP(...).contexts()[0]` IS this context, not a new one.
 *
 * ## Two recorders, one artifact
 *
 * Playwright's recordHar buffers the entire session in the driver and
 * serializes it once, during a client-initiated context.close(). That has a
 * sharp edge, measured rather than assumed: when the operator closes the
 * BROWSER WINDOW, Chrome exits, the connection drops before any close call
 * can run, and nothing is written at all.
 *
 * So a second recorder runs alongside it, appending every finished and every
 * FAILED request to a line-delimited log. Both recorders always run and
 * exactly one survives:
 *
 *   clean driver close  -> recordHar wins; the log is deleted
 *   window closed       -> the log is assembled into raw.har
 *
 * Either way `raw.har` exists and is a genuine HAR 1.2 document. recordHar is
 * preferred where both are available because it is more authoritative on
 * serverIPAddress, connection, real header/body sizes, cache and page timings
 * -- not because the assembled one is degraded. It is not: it carries real
 * timings, uncapped bodies, base64 for anything not valid UTF-8, and the
 * failed requests that a `response`-driven recorder drops entirely.
 *
 * ## Raw captures are confined by construction
 *
 * The raw capture carries live session cookies. It always lands in the fixed,
 * gitignored `.har-captures/` and no option can redirect it.
 *
 * WHICH `.har-captures/`, though, is the question that wording never asked, and
 * it turned out to be the load-bearing one (#367). The root used to resolve
 * against the working directory, so recording from a linked worktree put an
 * unrepeatable capture somewhere `git worktree remove` deletes outright --
 * gitignored, so git reports nothing to lose and no prompt appears. It now
 * anchors to the repository's MAIN working tree, whose lifetime is the clone's,
 * and the resolved path is announced while the recording starts. `--output-path`
 * receives only what has already been scrubbed and verified, so the guard is
 * structural rather than a check somebody has to remember to run. The scrub
 * therefore writes its candidate into the session directory and it is COPIED
 * out only once the gate has passed on it: a file the gate has not judged
 * never exists in a committable directory, and a scrub the gate refuses is
 * renamed to `scrubbed.rejected.har` where it stands, never deleted. One false
 * positive used to destroy the whole capture (#297).
 *
 * NOTHING IN THIS FILE EVER DELETES A RAW, and the rejected-scrub path above is
 * unconditional: a capture the gate refused keeps both its raw and its refused
 * candidate, because that is the case where losing either is unrecoverable.
 *
 * What that rule no longer says is "a raw is never deleted by anything". An
 * operator may now ask for one to be removed, through
 * `har/Invoke-SanitizeHar.ps1 -RemoveSource`, and only when the scrub of it
 * VERIFIED CLEAN -- never on a rejection and never on an advisory verdict,
 * since advisory means "waive or correct, then scrub again" and scrubbing
 * again needs the raw. The lever exists because raws carry live session
 * cookies and accumulate; it is opt-in per run, it takes the substitution
 * tables with it because they are keyed by the plaintext originals, and there
 * is deliberately no age sweep and no bulk delete command (#352).
 *
 * ## Phases
 *
 *   record -> scrub -> verify -> digest     this process, on every ending
 *   catalogue (segment, extract, rows)      an AI, once the digest exists
 *
 * ## The pipeline is RE-ENTERABLE at the catalogue stage
 *
 * `catalogue` runs the digest and delegation phases against a capture that was
 * recorded and scrubbed some other time, so regenerating a catalogue no longer
 * means re-recording a browser session a human drove by hand (#352). Scrubbing
 * alone was already re-enterable through Invoke-SanitizeHar.ps1; this is the
 * other half.
 *
 * It is an ENTRY POINT, not a second pipeline. It asks the same leak gate, runs
 * the same digest, and asks the same decideCatalogueRunner. It does not publish
 * and does not quarantine -- those belong to the scrub stage, and a second copy
 * of them behind a second door is how the invariants in #343 get lost.
 *
 * Usage:
 *   node capture-har.js start --uri <url> --describe <text>
 *                             [--profile <name|path>] [--isolated]
 *                             [--port <n>] [--output-path <dir>]
 *                             [--snapshot-seconds <n>] [--no-wait]
 *                             [--validate-only]
 *   node capture-har.js stop  [--session <dir>] [--min-bytes <n>] [--dir <d>]
 *   node capture-har.js status [--session <dir>] [--dir <d>]
 *   node capture-har.js catalogue [<scrubbed.har | session dir | output dir>]
 *                                 [--session <dir>] [--output-path <dir>]
 *
 *   --profile        a NAME keeps a separate signed-in identity under the
 *                    capture root; a PATH records as an identity another tool
 *                    owns (that tool cannot use it meanwhile -- a persistent
 *                    profile is single-instance).
 *   --isolated       bundled Chromium + an ephemeral profile, for CI and
 *                    throwaway captures. The default is system Chrome on a
 *                    dedicated capture profile, which stays signed in between
 *                    sessions -- bundled Chromium can silently close against
 *                    a profile Chrome created, hence channel:'chrome'.
 *   --port           default 9333, and it never has to be specified: a busy
 *                    port falls forward to the next free one.
 *   --describe       REQUIRED (#366). What this recording is for, in the
 *                    operator's own words. Segmenting the session is the
 *                    smaller half of its job: a shared, append-only capture
 *                    store whose directory names are START times is one where
 *                    the description is the ONLY reliable way to tell one
 *                    capture from another -- a time window wide enough to hold
 *                    one session's runs holds other sessions' runs too. It is
 *                    never the source of action names; those come from the
 *                    traffic.
 *   --no-wait        do not read ENTER from stdin (for non-interactive use;
 *                    the session then ends via `stop`, SIGINT, or the window).
 *   --validate-only  resolve and print paths without launching a browser.
 *   --log-level      `normal` (default) says what is being recorded, how to
 *                    end it, and which artifacts it produced. `verbose` adds
 *                    the resolved paths, the profile and the CDP endpoint.
 *                    Accepted on every command; Invoke-HarCapture sets it from
 *                    PowerShell's own -Verbose rather than exposing a second
 *                    switch for the same idea. All chatter goes to STDERR --
 *                    stdout carries only the --validate-only and status JSON.
 *
 * Exit codes:
 *   0 -- recorded, scrubbed and catalogued
 *   1 -- I/O or runtime error
 *   2 -- usage error
 *   3 -- no capture session found to stop
 *   4 -- the capture produced no usable recording
 *   5 -- raw.har was assembled from the incremental log rather than recordHar
 *   6 -- recorded successfully, but scrub or catalogue failed
 *   7 -- recorded, scrubbed and catalogued, but the leak gate reported
 *        ADVISORY findings (identity evidence by shape). Every artifact is
 *        where it should be; the findings need a human verdict.
 */

'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const harProfile = require(path.join(__dirname, '..', 'har', 'har-profile.js'));
const harCatalogue = require(path.join(__dirname, '..', 'har', 'har-catalogue.js'));
const repoGuard = require(path.join(__dirname, '..', 'lib', 'repo-workflow-guard.js'));
// The ONE gitignore check in this subsystem (#318). It wraps `git check-ignore`
// and already defends against a forged `.gitignore` containing `*` and against
// `core.excludesFile` injection, so nothing here asks the question a second
// way -- a bespoke re-implementation is how the original defect arrived.
const subsDestination = require(path.join(__dirname, '..', 'har', 'subs-destination.js'));
// Reused, not reimplemented: the consumer .gitignore entry list and the
// idempotent append both already exist for the scaffolder (#119).
const { ensureRepoRootGitignoreHasScaffoldEntries } =
    require(path.join(__dirname, '..', 'codegen', 'generate-wrapper.js'));

const DEFAULT_PORT = 9333;
const DEFAULT_MIN_BYTES = 1024;
const CAPTURES_DIR = '.har-captures';
const DEFAULT_SNAPSHOT_SECONDS = 5;
const STORAGE_STATE_FILENAME = '.har-storage-state.json';
const CATALOGUE_PROMPT = 'catalogue-prompt.md';
const STOP_SENTINEL = 'STOP';
const SESSION_FILE = 'session.json';
// There is deliberately NO `current.json` (#377). A single pointer file at the
// captures ROOT is shared mutable state in a store several agent sessions write
// to at once, so a second capture overwrote it and the first recording became
// unaddressable. The STAMP is the identity, and `resolveSession` already scanned
// the session directories whenever the pointer went stale -- removing it makes
// that existing path the only path.
const RAW_HAR = 'raw.har';
const RECORD_LOG = 'raw.ndjson';
const SCRUBBED_HAR = 'scrubbed.har';
// Where a scrub the leak gate refused goes. Under the session directory, which
// is gitignored, so triage is possible without the committable output path
// ever holding a file that is known to be leaking.
const REJECTED_HAR = 'scrubbed.rejected.har';
const FINDINGS_FILE = 'scrub-findings.json';
// Publication writes here first and then RENAMES onto the real name. The
// prefix is shared by every file the output path receives, so one sweep finds
// them all; the dot keeps them out of a casual listing.
const PUBLISH_TEMP_PREFIX = '.publishing-';
// A temporary older than this was abandoned by a run that died. A live one
// exists for milliseconds, so nothing in flight is ever this old -- which is
// what lets the sweep run without racing a concurrent capture.
const PUBLISH_TEMP_STALE_MS = 24 * 60 * 60 * 1000;
// Windows refuses to rename ONTO a destination another process holds open,
// where POSIX replaces it regardless. The everyday cause is real-time
// antivirus reading the file that was just written, and it clears in
// milliseconds. Six attempts with a doubling backoff wait 465ms in total: long
// enough for a scanner to let go, short enough that a standing fault -- a file
// somebody left open in an editor -- is reported rather than waited on.
const PUBLISH_RENAME_ATTEMPTS = 6;
const PUBLISH_RENAME_BACKOFF_MS = 15;
// EPERM and EBUSY are what Windows raises for a held handle, and only those.
// EACCES is a permission fact about the path: retrying it changes nothing
// except how long the operator waits to be told.
const PUBLISH_RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY']);
// verify-scrub.js exit 4: identity findings by SHAPE and nothing worse. The
// artifact is verified enough to proceed. Any other non-zero blocks.
const VERIFY_ADVISORY_EXIT = 4;
const DIGEST_FILE = 'digest.json';
const CATALOGUE_FILE = 'catalogue.json';
// Where committed references live in a consuming project. Named here only to
// PRINT the promote command -- nothing in this file writes into it.
const REFERENCE_DIR = path.join('docs', 'har-reference');
const POLL_MS = 200;
const STOP_TIMEOUT_MS = 60000;
const LAUNCH_TIMEOUT_MS = 45000;
const CDP_PROBE_MS = 1500;
const PORT_SCAN_LIMIT = 64;
// A pause longer than this between two requests is the only signal in the
// traffic that says "the human moved on to a different action".
const ACTION_GAP_SECONDS = 5;

// ---------------------------------------------------------------------------
// Console levels
// ---------------------------------------------------------------------------

/**
 * Two thresholds, matching the only two states PowerShell can be in: with
 * `-Verbose` and without it. There is deliberately no `--quiet`: the caller
 * already has `-InformationAction SilentlyContinue` and a third level would be
 * a second way to say the same thing.
 */
const LOG_LEVELS = { normal: 1, verbose: 2 };

/**
 * The threshold at which each kind of message becomes visible. Warnings and
 * errors sit at 0 so no level can suppress them -- a leak-gate rejection that
 * an operator has to opt in to read is worse than no report at all.
 */
const LINE_LEVELS = { error: 0, warn: 0, info: 1, verbose: 2 };

let currentLevel = LOG_LEVELS.normal;

/**
 * Reject an unrecognized level rather than falling back to `normal`. Silently
 * substituting turns a typo into a working flag that ignores the operator.
 */
function setLogLevel(value) {
    if (!Object.prototype.hasOwnProperty.call(LOG_LEVELS, value)) {
        throw new Error(
            `--log-level must be one of ${Object.keys(LOG_LEVELS).join(', ')} (got '${value}')`);
    }
    currentLevel = LOG_LEVELS[value];
}

/**
 * Filter (level, text) pairs down to what one threshold shows, then join them.
 *
 * Building the console output as data and rendering it separately is what
 * makes "what does an operator see without -Verbose" a question a test can ask
 * without launching a browser or spawning a process.
 */
function renderLines(lines, levelName) {
    const threshold = levelName === undefined ? currentLevel : LOG_LEVELS[levelName];
    return lines
        .filter(([level]) => LINE_LEVELS[level] <= threshold)
        .map(([, text]) => text)
        .join('\n');
}

/**
 * Every human-facing message goes to stderr. stdout carries machine output --
 * the `--validate-only` and `status` JSON -- and prose mixed into it is what
 * makes `Invoke-HarCapture ... | ConvertFrom-Json` fail on a verbose run.
 *
 * `lines` is the only primitive; the per-level helpers are one-line pairs
 * through it, so the threshold is applied in exactly one place.
 */
const log = {
    lines: (pairs) => {
        const text = renderLines(pairs);
        if (text) process.stderr.write(text + '\n');
    },
    info: (text) => log.lines([['info', text]]),
    verbose: (text) => log.lines([['verbose', text]]),
    warn: (text) => log.lines([['warn', text]]),
    error: (text) => log.lines([['error', text]])
};

// The options `start` accepts. Exported so a test can assert that the two
// dropped ones are genuinely gone: silently accepting and ignoring `--dir`
// would leave an operator believing the raw capture had moved.
const START_OPTIONS = [
    'uri', 'profile', 'isolated', 'port', 'output-path', 'describe',
    'snapshot-seconds', 'no-wait', 'validate-only', 'log-level'
];

/**
 * Is the driver that owns this session still running?
 *
 * Signal 0 sends nothing: it is the POSIX and Node idiom for "does this pid
 * exist and may I signal it". Nothing here ever terminates a process -- that
 * would discard the recording and, for a browser, could destroy unrelated
 * signed-in windows.
 *
 * Asking about the DRIVER pid rather than the debugging port matters: the
 * browser is a separate child process, and nothing in this design kills it, so
 * a crashed driver can leave a browser still answering on the port. Trusting
 * the port there reports a dead session as live. A port can also be answered
 * by an unrelated browser that happens to hold the same number.
 */
function isDriverAlive(session) {
    if (!session || !session.pid) return false;
    try {
        process.kill(session.pid, 0);
        return true;
    } catch (e) {
        // EPERM means it exists but belongs to someone else; only ESRCH means gone.
        return e.code === 'EPERM';
    }
}

/**
 * Ask a debugging port whether a browser is already there. Used to name a
 * running capture in a conflict message rather than to gate the launch --
 * a busy port is no longer fatal, because it falls forward.
 */
async function probeCdp(port) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CDP_PROBE_MS);
        const res = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
        clearTimeout(timer);
        return res.ok ? await res.json() : null;
    } catch (e) {
        return null;   // nothing listening, which is the normal case
    }
}

/**
 * The first free port at or after `start`.
 *
 * A busy port used to be a hard error because it doubled as the "a capture is
 * already running" detector. Those are two different concerns: several
 * captures can coexist happily on different ports, while a persistent profile
 * genuinely is single-instance. Only the second is a conflict, so only the
 * second still fails.
 */
function findFreePort(start, limit = PORT_SCAN_LIMIT) {
    const tryPort = (port) => new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        server.listen(port, '127.0.0.1');
    });
    return (async () => {
        for (let port = start; port < start + limit; port++) {
            if (await tryPort(port)) return port;
        }
        throw new Error(`no free port in ${start}..${start + limit - 1}`);
    })();
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--isolated' || a === '--validate-only' || a === '--no-wait') {
            out[a.slice(2)] = true;
            continue;
        }
        if (a.startsWith('--')) { out[a.slice(2)] = argv[++i]; continue; }
        out._.push(a);
    }
    return out;
}

function usage(msg) {
    if (msg) process.stderr.write(`capture-har: ${msg}\n`);
    process.stderr.write(
        'usage: node capture-har.js start --uri <url> --describe <text>\n' +
        '                                 [--isolated] [--port <n>] [--output-path <dir>]\n' +
        '       node capture-har.js stop [--session <dir>] [--min-bytes <n>]\n' +
        '       node capture-har.js status\n' +
        '       node capture-har.js catalogue [<scrubbed.har|session dir|output dir>]\n' +
        '                                     [--session <dir>] [--output-path <dir>]\n' +
        '\n' +
        '  --log-level normal|verbose  how much the console says (default normal).\n' +
        '                              Invoke-HarCapture sets it from -Verbose.\n');
    return 2;
}

/**
 * Where raw captures live. FIXED, and deliberately not derived from any
 * option: the raw carries live session cookies, and the only reason the old
 * `--dir` existed was to move it -- which is exactly the leak this closes.
 *
 * Still no option redirects the NAME. What changed in #367 is WHICH
 * `.har-captures` -- the question the old wording never asked.
 *
 * It used to resolve against the working directory. Inside a linked worktree
 * that put an unrepeatable capture somewhere DISPOSABLE: `git worktree remove`
 * deletes the tree outright, the capture is gitignored so git reports nothing
 * to lose, and no prompt appears at any point. A 71 MB, 666-entry raw was
 * destroyed exactly that way by a correct, routine cleanup.
 *
 * So the root anchors to the repository's MAIN working tree, whose lifetime is
 * the clone's. Outside a repository the working-directory answer is the only
 * one there is and nothing changes -- which is also how a test harness contains
 * a capture, by choosing where node runs rather than by an override that would
 * reopen the redirect for everyone else.
 */
function capturePlacement(cwd) {
    return repoGuard.resolveCaptureRoot(cwd || process.cwd(), CAPTURES_DIR);
}

/**
 * Every root a capture might be FOUND under, newest convention first.
 *
 * Discovery is not resolution. `stop`, `status` and `catalogue` have to reach
 * captures written before this change -- including a recording still in flight
 * when the tool was updated, whose `current.json` sits in the old place. So
 * they read both roots and never write to, move, or tidy the old one: reading
 * is free, and relocating a raw is the one operation this pipeline will not
 * perform.
 */
function capturesSearchRoots(cwd) {
    const placement = capturePlacement(cwd);
    return placement.relocated ? [placement.root, placement.legacyRoot] : [placement.root];
}

/**
 * The directory name that stands for the captured site.
 *
 * HOST ONLY, for the same reason the digest reduces the URI to its origin: the
 * operator types this URL, and a magic-link, password-reset or signed start URL
 * carries its token in the path or the query. This name becomes a directory
 * sitting next to committable artifacts, so echoing any more of the URL would
 * put a live credential exactly where the design promises only scrubbed
 * artifacts land.
 *
 * The port is joined with `_` rather than `-`: a dash is legal inside a
 * hostname, so it could not be told apart from the host's own characters.
 * Periods are kept for the same reason -- they read as the host does.
 *
 * Throws rather than falling back to a shared name. An unparseable URI that
 * quietly collapsed to one folder would re-introduce the cross-site collision
 * this keying exists to remove.
 */
function uriFolder(uri) {
    let url;
    try {
        url = new URL(uri);
    } catch (e) {
        throw new Error(`cannot derive a capture folder: --uri ${JSON.stringify(uri)} is not a URL`);
    }

    // PARSING IS NOT ENOUGH. `new URL('http://../evil')` succeeds and its
    // hostname is '..'; `file:///x`, `data:...` and `about:blank` succeed with
    // an empty one. Used as a directory name, the first walks the raw capture
    // OUT of .har-captures/ and into the working tree, and the second collapses
    // every hostless capture into a single directory -- the very collision this
    // keying removes. Both are rejected on the host itself, before it is folded
    // into a name, so no later replacement can disguise them.
    const host = url.hostname;
    if (!host || host === '.' || host === '..') {
        throw new Error(
            `cannot derive a capture folder: --uri ${JSON.stringify(uri)} has no usable host ` +
            '(a capture needs a real site, e.g. https://example.com)');
    }

    // An IPv6 literal arrives bracketed (`[::1]`). Dropping the brackets and
    // mapping the separator to `-` -- which is already in the safe set -- keeps
    // distinct addresses distinct; folding every one of `[`, `:` and `]` to `_`
    // made addresses that differ only in their zero-groups converge.
    const bare = host.replace(/^\[|\]$/g, '').replace(/:/g, '-');
    const withPort = url.port ? `${bare}_${url.port}` : bare;
    const folded = withPort.toLowerCase().replace(/[^a-z0-9._-]/g, '_');

    // `con`, `nul`, `lpt1` and friends cannot be directories on Windows. A
    // trailing `_` keeps the name recognisable while making it creatable.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|_|$)/i.test(folded)) return `${folded}_`;
    return folded;
}

/**
 * The two directories a capture writes to, and why they are different.
 *
 * `harPath` is under the fixed captures root, always. `outputPath` receives
 * only artifacts that have already been scrubbed and verified. Nothing an
 * operator passes can move the first, which is what makes the containment
 * structural rather than a rule somebody has to remember.
 *
 * Both are keyed on the captured host, so two captures against different sites
 * never land on top of each other -- `scrubbed.har`, `digest.json` and
 * `catalogue.json` are fixed filenames, and before this the second capture
 * silently overwrote the first.
 *
 * WHERE THE DEFAULT OUTPUT LANDS (#377, revising #300). It was the working
 * directory, then the repository root. Both were wrong for the same reason: the
 * root of whichever work tree the operator happened to be standing in is not a
 * place scrubbed artifacts belong, so a run from a checkout root dropped an
 * untracked `<host>/` directory there and #300's warning was simply stepped
 * past. Anchoring made placement PREDICTABLE, not correct -- its own comment
 * said so.
 *
 * The default is now THE RUN'S OWN SESSION DIRECTORY. That fixes three defects
 * at once and invents no new location:
 *
 *   - it is inside `.har-captures/`, which is gitignored by construction, so
 *     nothing lands untracked in a work tree;
 *   - it carries the STAMP, so a second capture against the same host no longer
 *     silently overwrites the first's `scrubbed.har`/`digest.json`;
 *   - the scrubbed artifact ends up beside the raw it came from, which is the
 *     structural link a committed reference needs back to its source.
 *
 * Nothing is lost by this: promotion into a committable directory is a separate,
 * deliberate step (see promoteReferenceLines), and the session directory is the
 * durable copy either way.
 *
 * An explicit `outputPath` still resolves against the WORKING DIRECTORY, because
 * a relative path the operator typed has to mean what they typed. It is warned
 * about, never refused -- see classifyOutputDestination.
 */
function resolveSessionPaths(opts = {}) {
    const cwd = opts.cwd || process.cwd();
    const placement = opts.capturesRoot ? null : capturePlacement(cwd);
    const root = opts.capturesRoot ? path.resolve(opts.capturesRoot) : placement.root;
    const folder = uriFolder(opts.uri);
    const sessionDir = path.join(root, folder, opts.stamp || stamp(new Date()));
    // The host folder is appended to an EXPLICIT root only. The session
    // directory is already keyed on the host one level up, and appending it
    // again would produce `<host>/<stamp>/<host>/`.
    const outputPath = opts.outputPath
        ? path.join(path.resolve(cwd, opts.outputPath), folder)
        : sessionDir;
    return {
        capturesRoot: root,
        // Null when a caller pinned the root itself (tests do), because there
        // is then nothing about the anchoring for the recorder to announce.
        capturePlacement: placement,
        // Where a session may be FOUND, as opposed to where this one is
        // written. Identical unless #367's anchoring moved the root.
        searchRoots: placement && placement.relocated ? [root, placement.legacyRoot] : [root],
        uriFolder: folder,
        sessionDir,
        harPath: path.join(sessionDir, RAW_HAR),
        recordLog: path.join(sessionDir, RECORD_LOG),
        outputPath,
        // Whether the operator NAMED this destination. The warning below fires
        // only for a deliberate choice; the default can no longer be the hazard.
        outputExplicit: Boolean(opts.outputPath)
    };
}

/**
 * Is an EXPLICIT `--output-path` somewhere scrubbed artifacts will show up as
 * untracked files, and what to say about it?
 *
 * WARN, DO NOT REFUSE (#377). Hard-failing was right while the DEFAULT was the
 * hazard -- an operator who never typed a path got the bad location anyway.
 * Now that the default is the gitignored session directory, the only route to a
 * committable-but-unignored destination is a deliberate one, and refusing a
 * deliberate choice is user-hostile: pointing `--output-path` at
 * `docs/har-reference` is a legitimate thing to do, and the test suites do it.
 *
 * The question is asked through `classifyDestination()` and nowhere else. It
 * already wraps `git check-ignore`, and already refuses to trust a forged
 * `.gitignore` containing `*` or an injected `core.excludesFile`. A second
 * gitignore check written here would be a second answer free to disagree.
 *
 * Returns null when there is nothing to say -- outside a work tree (where
 * behaviour is unchanged), when the destination is ignored, and for the
 * default, which is never classified because it cannot be the problem.
 */
function outputDestinationWarning(paths) {
    if (!paths || !paths.outputExplicit) { return null; }
    // Classified on a FILE inside the destination, not on the directory: a
    // consumer's .gitignore covers these artifacts by name at any depth as well
    // as by directory, and asking about the directory would miss that.
    const status = subsDestination.classifyDestination(path.join(paths.outputPath, SCRUBBED_HAR));
    if (status !== subsDestination.NOT_IGNORED) { return null; }
    return [
        `--output-path resolved to ${paths.outputPath}`,
        '  It is inside a git work tree and is not gitignored -- the scrubbed capture, the',
        '  digest and the catalogue will show as untracked files there.',
        '  Proceeding: this is a destination you named. The session directory keeps its own',
        '  copy of everything either way.'
    ].join('\n');
}

// The gitignore entries a capture store needs. A SUBSET of the scaffolder's
// list, and passed to the scaffolder's own idempotent append rather than
// retyped into a second writer.
//
// Deliberately NOT a blanket `*.har`. `docs/har-reference/**/*.har` are the
// committed artifacts of this whole pipeline, and a blanket rule would make a
// NEW reference silently un-committable until somebody remembered `git add -f`.
// By name and by suffix is what the shipped .gitignore already does.
const CAPTURE_GITIGNORE_ENTRIES = [
    '.har-captures/',
    '.har-profile.json',
    '.har-substitutions.json',
    '.substitutions.json'
];

/**
 * A path under the captures root that only a rule ABOUT THE STORE can ignore.
 *
 * Not `raw.har`: the shipped .gitignore also lists that by name, so probing
 * with it would report a store as protected on the strength of a rule that
 * covers one filename. The probe has to be a name nothing else claims.
 */
function capturesRootProbe(capturesRoot) {
    return path.join(capturesRoot, '.har-captures-ignore-probe');
}

/**
 * Refuse to record into a capture store that version control can see.
 *
 * The raw capture carries live session cookies and runs to hundreds of
 * megabytes. Unignored, it is one `git add -A` from a commit -- and unlike the
 * output side, there is no warn-and-proceed answer that is honest here: what
 * would be committed is unscrubbed.
 *
 * INTERACTIVE: prompt once, naming the resolved absolute path, saying it is in
 * the MAIN checkout (which is not where the operator is standing when they run
 * from a worktree), and saying why. Answering yes appends the rules and re-asks
 * git; the answer that matters is git's, not ours.
 *
 * NON-INTERACTIVE: hard failure. An agent or a CI run has nowhere to prompt,
 * and this is exactly the case worth stopping.
 *
 * OUTSIDE A WORK TREE: nothing to do. There is no repository for `git add` to
 * take the capture into, and behaviour there is unchanged by design.
 */
async function ensureCapturesRootIgnored(placement, opts = {}) {
    const isTty = !!opts.isTty;
    const ask = opts.ask || askLine;
    const capturesRoot = placement && placement.root;
    if (!capturesRoot) { return { ok: true, status: null }; }
    const probe = capturesRootProbe(capturesRoot);
    const status = subsDestination.classifyDestination(probe);
    if (status === subsDestination.IGNORED
        || status === subsDestination.OUTSIDE_WORK_TREE) {
        return { ok: true, status };
    }

    const anchor = placement.mainWorkingTree || placement.currentWorkingTree;
    // "not ignored" and "git declined to answer" are different facts, and
    // telling an operator the first when the second happened sends them to edit
    // a .gitignore that was never the problem. Both still refuse: an unverified
    // destination is not assumed to be a safe one.
    const unverified = status === subsDestination.UNVERIFIABLE;
    const why = [
        unverified
            ? `capture-har: git did not answer whether the capture store is ignored: ${capturesRoot}`
            : `capture-har: the capture store is not gitignored: ${capturesRoot}`,
        '  A raw capture carries live session cookies and is never scrubbed -- unignored,',
        '  it is one `git add -A` away from being committed.',
        anchor ? `  The store belongs to the MAIN working tree (${anchor}), not to the` : null,
        anchor ? '  worktree you may be standing in.' : null
    ].filter(Boolean).join('\n');

    if (unverified) {
        // There is nothing to prompt about: appending a rule cannot help when
        // the answer could not be read in the first place.
        return {
            ok: false,
            status,
            message: `${why}\n` +
                '  Make git available on PATH and re-run. An unverified destination is not\n' +
                '  assumed to be a safe one.'
        };
    }

    if (!isTty) {
        return {
            ok: false,
            status,
            message: `${why}\n` +
                `  Add ${CAPTURE_GITIGNORE_ENTRIES.map((e) => `'${e}'`).join(', ')} to that\n` +
                "  repository's .gitignore and re-run. This run is refused rather than\n" +
                '  prompted: there is no terminal here to answer, and an unscrubbed capture\n' +
                '  inside a work tree is the one case worth stopping for.'
        };
    }

    const answer = await ask(`${why}\n  Append ${CAPTURE_GITIGNORE_ENTRIES.join(', ')} to ` +
        `${path.join(anchor || capturesRoot, '.gitignore')} now? [y/N] `);
    if (!/^y/i.test((answer || '').trim())) {
        return { ok: false, status, message: 'capture-har: declined -- nothing was recorded.' };
    }
    ensureRepoRootGitignoreHasScaffoldEntries(anchor || capturesRoot, CAPTURE_GITIGNORE_ENTRIES);
    // Ask git again rather than assuming the append worked. A rule that does
    // not take effect -- a negation later in the file, a nested .gitignore --
    // must not be reported as protection.
    const after = subsDestination.classifyDestination(probe);
    if (after === subsDestination.IGNORED) { return { ok: true, status: after, appended: true }; }
    return {
        ok: false,
        status: after,
        message: 'capture-har: the entries were appended but git still does not report the ' +
            `store as ignored (${after}). Nothing was recorded.`
    };
}

/**
 * The SHORT provider name for a host: `www.facebook.com` -> `facebook`.
 *
 * The reference-naming convention repeats the provider in the filename as well
 * as in the directory, because the directory is invisible the moment the file
 * is opened in an editor tab, attached to an issue, or pasted into a diff.
 */
// Second-level labels that are part of the suffix rather than the name:
// `example.co.uk` must give `example`, not `co`. Deliberately a short list and
// not the public suffix list -- this names a file a human then reads and can
// rename, so the cost of a miss is cosmetic, and a megabyte of suffix data
// vendored into a recorder to improve a default filename is not a trade worth
// making.
const SUFFIX_LABELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

function providerSlug(host) {
    const labels = String(host || '').split('.').filter(Boolean)
        .filter((l, i) => !(i === 0 && l === 'www'));
    if (!labels.length) { return null; }
    // The registrable label, not the TLD: `app.example.com` -> `example`.
    let index = labels.length >= 2 ? labels.length - 2 : 0;
    if (index > 0 && SUFFIX_LABELS.has(labels[index])) { index -= 1; }
    return slugify(labels[index]) || null;
}

function slugify(value) {
    // Character-for-character the extractor's own slug(), because the name this
    // prints has to be the name the extractor produces.
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Words that carry no information in an action slug. Trimming them is what
// turns a sentence into a name a human would have written.
const ACTION_STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'then', 'with', 'of', 'to', 'for', 'in', 'on', 'my',
    'that', 'this', 'it', 'its', 'at', 'by', 'from', 'into'
]);
const ACTION_SLUG_WORDS = 3;

/**
 * A short action slug derived from `--describe`, for the operator to accept or
 * replace.
 *
 * Deriving SILENTLY from a whole sentence yields
 * `facebook-create-a-post-with-an-audience-selection-then-delete-it-2026-09-01.har`
 * -- legal, and not a name anybody would write for a file that gets read in
 * issues and diffs. So the derivation is a DEFAULT, not an answer.
 */
function deriveActionSlug(describe, provider) {
    let text = String(describe || '');
    // `facebook: create a post ...` -- the operator already named the provider,
    // and repeating it would give `facebook-facebook-...`.
    const colon = text.indexOf(':');
    if (colon > 0 && provider && slugify(text.slice(0, colon)).includes(provider)) {
        text = text.slice(colon + 1);
    }
    const words = slugify(text).split('-')
        .filter(Boolean)
        .filter((w) => !ACTION_STOPWORDS.has(w));
    const picked = words.slice(0, ACTION_SLUG_WORDS);
    return picked.length ? picked.join('-') : 'capture';
}

function todayStamp(now) {
    return (now || new Date()).toISOString().slice(0, 10);
}

function uriHostOf(uri) {
    try { return new URL(uri).hostname; } catch (e) { void e; return null; }
}

/**
 * The reference filename this capture's extract would take.
 *
 * `<provider>-<action>-<yyyy-MM-dd>.har`, which is exactly what
 * `har/extract-har-reference.js` writes. This names it; it does not invent a
 * second convention, and it does not write anything.
 *
 * The provider is in the FILENAME as well as the directory it lands in. The
 * directory is invisible the moment the file is opened in an editor tab,
 * attached to an issue, or pasted into a diff, and a reference that cannot
 * say what provider it describes once separated from its folder is a
 * reference nobody can place.
 */
function referenceFileName(session, opts = {}) {
    const provider = providerSlug(uriHostOf(session && session.uri));
    if (!provider) { return null; }
    const action = opts.action || deriveActionSlug(session && session.describe, provider);
    return `${provider}-${action}-${todayStamp(opts.now)}.har`;
}

/**
 * The same reference, as `<provider>/<filename>`.
 *
 * This -- not the bare filename -- is what `HarFile` records, because the
 * field's job is to survive promotion. #379 defines `HarFile` as a path
 * RELATIVE TO the committed `catalogue.json`, which sits at
 * `docs/har-reference/<host>/` while the extract sits one level deeper in
 * `<provider>/`. A bare filename would be ambiguous the moment a host carries
 * two providers, and `verify-har-catalogue.js` resolves the value against the
 * catalogue's own directory, so a bare filename would simply not resolve.
 *
 * Forward slash, always: this is a value written into JSON and read back on
 * every platform, not a path built for the local filesystem.
 */
function referenceRelativePath(session, opts = {}) {
    const provider = providerSlug(uriHostOf(session && session.uri));
    const fileName = referenceFileName(session, opts);
    if (!provider || !fileName) { return null; }
    return `${provider}/${fileName}`;
}

/**
 * The capture profile deliberately lives OUTSIDE the repo and is shared by
 * every capture: signing in once is the whole point, and a per-session
 * profile would ask the operator to re-authenticate on every recording. It is
 * never the operator's daily browser profile -- that one holds live sessions
 * this tool must not disturb.
 */
function captureProfileRoot() {
    const base = process.env.LOCALAPPDATA
        || process.env.XDG_DATA_HOME
        || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'har-capture');
}

function defaultProfileDir() {
    if (process.env.HAR_CAPTURE_PROFILE) return process.env.HAR_CAPTURE_PROFILE;
    return path.join(captureProfileRoot(), 'profile');
}

/**
 * --profile takes a NAME or a PATH, because the two real needs are different.
 *
 * A name keeps several signed-in identities side by side without the operator
 * having to know or type where profiles live.
 *
 * A path records as an identity some other tool already owns. Projects that
 * key browser profiles off their own concept -- a workspace, an account, a
 * tenant -- compute that directory themselves; this script cannot know the
 * rule, and should not pretend to. Handing it a path is the whole integration.
 */
function resolveProfileDir(value) {
    if (!value) return defaultProfileDir();
    if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
        return path.resolve(value);
    }
    const safe = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '-');
    return path.join(captureProfileRoot(), `profile-${safe}`);
}

/**
 * Find the nearest serialized session, the same upward walk that discovers the
 * operator profile. The capability that `--storage-state` provided survives;
 * the option does not, because a path the operator had to retype on every
 * capture was never carrying information the filesystem could not.
 *
 * An absent storage state is NOT an error -- the default path is a persistent
 * profile that is already signed in.
 */
function discoverStorageState(startDir, stopAt) {
    return harProfile.findUpward(STORAGE_STATE_FILENAME, startDir, stopAt);
}

function requirePlaywright() {
    try {
        return require('playwright');
    } catch (e) {
        process.stderr.write(
            'capture-har: the playwright module was not found.\n' +
            '  npm install playwright && npx playwright install chromium\n' +
            '  (or set NODE_PATH to an install that has it)\n');
        process.exit(1);
    }
}

function stamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Numeric option with a default, without `||`'s falsy-zero trap: a caller who
 * passes 0 means 0, and silently substituting the default turns an explicit
 * instruction into a surprise.
 */
function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

function toHeaderArray(headers) {
    return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * Header block size on the wire, near enough to be useful. -1 is the HAR
 * spec's "not available", and reporting it when the headers are right there
 * throws away information a reader of the reference actually uses.
 */
function headerBytes(headers, firstLine) {
    const lines = Object.entries(headers || {})
        .map(([name, value]) => `${name}: ${value}\r\n`).join('');
    return Buffer.byteLength(`${firstLine}\r\n${lines}\r\n`, 'utf8');
}

/**
 * Does this buffer survive a UTF-8 round trip?
 *
 * `body.toString('utf8')` on a PNG or a protobuf silently substitutes U+FFFD
 * for every invalid sequence, which is lossy and irreversible -- the capture
 * looks fine and the payload is destroyed. HAR's answer is content.encoding,
 * so anything that does not round-trip becomes base64 and anything that does
 * stays readable text (a reference nobody can grep is most of a reference
 * wasted).
 */
function isUtf8(buf) {
    return Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) === 0;
}

function bodyContent(buf, mimeType) {
    const content = { size: buf ? buf.length : 0, mimeType: mimeType || '' };
    if (!buf) return content;
    if (isUtf8(buf)) {
        content.text = buf.toString('utf8');
    } else {
        content.text = buf.toString('base64');
        content.encoding = 'base64';
    }
    return content;
}

function queryStringOf(url) {
    try {
        // URLSearchParams decodes percent-encoding for us. A raw query string
        // is not greppable for a field name; the decoded copy is what makes
        // the reference searchable.
        return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
    } catch (e) {
        return [];
    }
}

function cookiesOf(headers) {
    const raw = headers && (headers.cookie || headers.Cookie);
    if (!raw) return [];
    return String(raw).split(';').map((pair) => {
        const i = pair.indexOf('=');
        return i < 0
            ? { name: pair.trim(), value: '' }
            : { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
    }).filter((c) => c.name);
}

/**
 * Build one HAR entry from what the recorder observed.
 *
 * Pure by design: the Playwright event handlers are a thin adapter that reads
 * the request/response and hands the values here, so the entry shape can be
 * tested exhaustively without launching a browser -- which is the only way it
 * ever gets tested at all.
 *
 * `response` is null for a FAILED request. Those used to be dropped entirely,
 * because the recorder listened on `response` and a failure never produces
 * one. SKILL.md calls failure paths "frequently the highest-value entries":
 * they establish the platform's real error taxonomy.
 */
function buildEntry(observed) {
    const { request, response, failure, timing, body } = observed;
    // Whether a body was READABLE is different from whether it was EMPTY, and
    // only the caller knows which. Absent the flag, a present body implies it
    // was readable.
    const bodyAvailable = observed.bodyAvailable === undefined
        ? body !== null && body !== undefined
        : observed.bodyAvailable;
    const reqHeaders = request.headers || {};
    const resHeaders = (response && response.headers) || {};
    const postBuf = request.postDataBuffer || null;

    const phases = timing
        ? { send: timing.send, wait: timing.wait, receive: timing.receive }
        : { send: -1, wait: -1, receive: -1 };
    const known = [phases.send, phases.wait, phases.receive].filter((n) => typeof n === 'number' && n >= 0);

    const entry = {
        startedDateTime: observed.startedDateTime || new Date().toISOString(),
        time: known.length ? known.reduce((a, b) => a + b, 0) : -1,
        request: {
            method: request.method,
            url: request.url,
            httpVersion: request.httpVersion || 'HTTP/1.1',
            headers: toHeaderArray(reqHeaders),
            queryString: queryStringOf(request.url),
            cookies: cookiesOf(reqHeaders),
            headersSize: headerBytes(reqHeaders, `${request.method} ${request.url}`),
            bodySize: postBuf ? postBuf.length : 0
        },
        response: {
            // A failed request has no status. 0 is the established HAR
            // convention for it, and it keeps the document schema-valid
            // instead of inventing a "no response" shape no tool reads.
            status: response ? response.status : 0,
            statusText: response
                ? (response.statusText || '')
                : ((failure && failure.errorText) || 'request failed'),
            httpVersion: (response && response.httpVersion) || 'HTTP/1.1',
            headers: toHeaderArray(resHeaders),
            cookies: [],
            content: bodyContent(body, resHeaders['content-type'] || ''),
            redirectURL: resHeaders.location || '',
            headersSize: response
                ? headerBytes(resHeaders, `HTTP/1.1 ${response.status}`)
                : -1,
            // -1 is HAR's "not available". Reporting 0 for a body we could
            // not read -- a redirect, a stream, one already discarded -- is a
            // claim the recorder cannot support.
            bodySize: body ? body.length : (response && bodyAvailable ? 0 : -1)
        },
        cache: {},
        timings: phases
    };

    if (postBuf) {
        entry.request.postData = Object.assign(
            { mimeType: request.postMimeType || '', params: [] },
            (({ text, encoding }) => (encoding ? { text, encoding } : { text }))(
                bodyContent(postBuf, request.postMimeType))
        );
    }
    if (failure && failure.errorText) entry._failure = failure.errorText;
    return entry;
}

// ---------------------------------------------------------------------------
// Incremental recorder
// ---------------------------------------------------------------------------

/**
 * Append-only recorder. Entries are buffered and flushed on an interval;
 * a flush writes ONLY what arrived since the last one, so the cost of a short
 * interval does not grow with the size of the capture.
 */
class IncrementalRecorder {
    constructor(logPath, intervalMs) {
        this.logPath = logPath;
        this.intervalMs = intervalMs;
        this.pending = [];
        this.written = 0;
        this.timer = null;
    }

    start() {
        this.timer = setInterval(() => this.flush(), this.intervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    add(entry) {
        this.pending.push(entry);
    }

    flush() {
        if (!this.pending.length) return;
        const batch = this.pending;
        this.pending = [];
        try {
            fs.appendFileSync(this.logPath, batch.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
            this.written += batch.length;
        } catch (e) {
            // A failed flush must never take the recording down with it.
            log.verbose(`capture-har: incremental flush failed: ${e.message}`);
        }
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.flush();
    }
}

/**
 * Adapt Playwright events onto buildEntry.
 *
 * `requestfinished` and `requestfailed` rather than `response`, for two
 * reasons: a failed request never emits a response and was therefore lost
 * entirely, and `requestfinished` is the point at which timing information is
 * actually complete.
 */
function attachRecorder(context, recorder) {
    const record = async (request, failure) => {
        // The whole handler is guarded, not just the calls known to be
        // fragile: an unhandled rejection here would crash the driver
        // mid-capture, which is the exact loss this recorder exists to prevent.
        try {
            const response = await request.response().catch(() => null);
            let body = null;
            // Tracked separately from `body` because "could not read it" and
            // "it was empty" are different facts, and only this layer knows
            // which one happened.
            let bodyAvailable = false;
            if (response) {
                // Best-effort: a redirect, a streamed response, or one already
                // discarded must not cost the entry itself.
                body = await response.body().then(
                    (b) => { bodyAvailable = true; return b; },
                    () => null);
            }
            const reqHeaders = await request.allHeaders().catch(() => ({}));
            recorder.add(buildEntry({
                request: {
                    method: request.method(),
                    url: request.url(),
                    headers: reqHeaders,
                    httpVersion: 'HTTP/1.1',
                    postDataBuffer: request.postDataBuffer ? request.postDataBuffer() : null,
                    postMimeType: reqHeaders['content-type'] || ''
                },
                response: response ? {
                    status: response.status(),
                    statusText: response.statusText(),
                    headers: await response.allHeaders().catch(() => ({})),
                    httpVersion: 'HTTP/1.1'
                } : null,
                failure,
                timing: request.timing ? request.timing() : null,
                body,
                bodyAvailable
            }));
        } catch (e) {
            log.verbose(`capture-har: entry skipped: ${e.message}`);
        }
    };

    context.on('requestfinished', (request) => { void record(request, null); });
    context.on('requestfailed', (request) => { void record(request, request.failure()); });
    // Our process outlives the browser, so a window close still reaches us --
    // flushing here is what makes the fallback non-lossy.
    context.on('close', () => recorder.stop());
}

/**
 * Assemble the append-only log into raw.har.
 *
 * A truncated final line is expected after an abrupt ending and is dropped
 * rather than failing the assembly -- salvaging the rest is the entire point.
 *
 * There is deliberately no "this artifact is degraded" banner. It is not
 * degraded: it carries real timings, uncapped bodies, and the failed requests
 * recordHar's own output would have. recordHar is preferred where both exist
 * only because it knows things a client-side recorder cannot observe.
 */
function assembleFromLog(logPath, outPath) {
    if (!fs.existsSync(logPath)) return null;
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
    const entries = [];
    let dropped = 0;
    for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch (e) { dropped++; }
    }
    if (!entries.length) return null;
    const har = {
        log: {
            version: '1.2',
            creator: { name: 'capture-har.js', version: '2.0' },
            comment: 'Assembled from the incremental record log.' +
                (dropped ? ` ${dropped} truncated entr${dropped === 1 ? 'y was' : 'ies were'} dropped.` : ''),
            pages: [],
            entries
        }
    };
    writeJson(outPath, har);
    return { entries: entries.length, dropped };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * Collapse the ids out of a path so two calls to one operation group together.
 *
 * Without this, `/posts/1234` and `/posts/9876` read as two different
 * endpoints and the digest degenerates into a list of every request -- which
 * is the thing the digest exists to avoid.
 */
// Collapse identifier-shaped path segments to a template.
//
// The implementation lives in har-catalogue.js and is imported rather than
// kept here, because verify-har-catalogue.js recomputes a committed row's
// `Endpoints` from the reference while `buildCatalogueScaffold` below writes
// them from this digest. Two implementations that agree today would drift, and
// the drift would surface as every scaffolded row failing the guard the moment
// it was committed -- a failure that looks like the gate is broken, so the fix
// people reach for is to weaken the gate.
//
// Re-exported below, so a caller that reasonably expects the digest's own
// templating to come from the digest's own module still gets it.
const pathTemplate = harCatalogue.pathTemplate;

/**
 * Top-level key names of a JSON payload -- the SHAPE, never the values.
 *
 * A digest that embedded bodies would be as large as the capture and would
 * carry the very credentials the containment rule exists to keep out of the
 * output path.
 */
function payloadShape(text) {
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        const target = Array.isArray(parsed) ? parsed[0] : parsed;
        return target && typeof target === 'object' ? Object.keys(target) : [];
    } catch (e) {
        return [];
    }
}

/**
 * Scheme and host, discarding path, query and fragment -- the parts that carry
 * tokens. Returns null rather than guessing when the value is not a URL.
 */
function originOf(uri) {
    if (!uri) return null;
    try { return new URL(uri).origin; } catch (e) { return null; }
}

/**
 * A compact description of a capture that an AI can segment from without
 * re-parsing a multi-hundred-megabyte HAR.
 */
function buildDigest(har, meta = {}) {
    const entries = (har && har.log && har.log.entries) || [];
    const groups = new Map();
    const gaps = [];

    entries.forEach((entry, index) => {
        let url;
        try { url = new URL(entry.request.url); } catch (e) { return; }
        const template = pathTemplate(url.pathname);
        const status = (entry.response && entry.response.status) || 0;
        // UPPERCASED, and it matters twice.
        //
        // RFC 9110 defines the methods in uppercase and makes them
        // case-sensitive, so `get` and `GET` are one endpoint in every practical
        // sense -- keying on the raw verb split them into two groups and
        // double-counted the endpoint.
        //
        // It also has to agree with har-catalogue.js's `measureReference`, which
        // uppercases: the scaffold writes a row's `Methods` from here, and the
        // guard recomputes them from the reference. A scaffold reading ["get"]
        // against a recomputed ["GET"] fails the row on casing alone -- correct
        // data reported as wrong, and the repair everyone reaches for is to
        // weaken the comparison rather than fix the derivation.
        const method = String(entry.request.method || '').toUpperCase();
        const key = `${url.host}|${method}|${template}|${status}`;

        let group = groups.get(key);
        if (!group) {
            group = {
                host: url.host,
                method,
                pathTemplate: template,
                status,
                count: 0,
                firstIndex: index,
                contentTypes: [],
                requestShape: [],
                responseShape: []
            };
            groups.set(key, group);
        }
        group.count++;

        const mime = (entry.response && entry.response.content && entry.response.content.mimeType) || '';
        if (mime && !group.contentTypes.includes(mime)) group.contentTypes.push(mime);
        for (const k of payloadShape(entry.request.postData && entry.request.postData.text)) {
            if (!group.requestShape.includes(k)) group.requestShape.push(k);
        }
        for (const k of payloadShape(entry.response && entry.response.content && entry.response.content.text)) {
            if (!group.responseShape.includes(k)) group.responseShape.push(k);
        }

        // A pause between two requests is the only evidence in the traffic
        // that the human moved on to a different action.
        if (index > 0) {
            const prev = entries[index - 1];
            const prevEnd = Date.parse(prev.startedDateTime) + (prev.time > 0 ? prev.time : 0);
            const seconds = (Date.parse(entry.startedDateTime) - prevEnd) / 1000;
            if (seconds >= ACTION_GAP_SECONDS) {
                gaps.push({ beforeIndex: index - 1, afterIndex: index, seconds: Math.round(seconds * 100) / 100 });
            }
        }
    });

    return {
        capturedUtc: meta.capturedUtc || new Date().toISOString(),
        // ORIGIN only. The operator types this URL, and a magic-link,
        // password-reset or signed start URL carries its token in the query or
        // the path. The digest is written to the committable output path, so
        // echoing the URL back verbatim would put a live credential exactly
        // where the design promises only scrubbed artifacts land.
        uri: originOf(meta.uri),
        describe: meta.describe || null,
        entryCount: entries.length,
        hosts: [...new Set(entries.map((e) => {
            try { return new URL(e.request.url).host; } catch (x) { return '?'; }
        }))].sort(),
        groups: [...groups.values()],
        gaps
    };
}

/**
 * Provisional catalogue rows, one per observed operation.
 *
 * Every row starts `Observed`: nothing is `Exercised` until an AI has actually
 * segmented the session and extracted a reference HAR for it. Naming and
 * describing the actions is the AI's job -- a name derived mechanically from a
 * URL is exactly the "endpoint is recoverable from the file, what you did to
 * provoke it is not" gap the catalogue exists to close.
 */
function buildCatalogueScaffold(digest, meta = {}) {
    return digest.groups.map((group) => ({
        Action: `${group.method.toLowerCase()}-${group.pathTemplate.split('/').filter(Boolean).join('-') || 'root'}`,
        Description: null,
        Provider: null,
        Methods: [group.method],
        Endpoints: [`${group.host}${group.pathTemplate}`],
        EntryCount: group.count,
        Status: 'Observed',
        // The reference this capture WOULD be extracted into (#377 s6), as
        // `<provider>/<filename>` -- the shape #379 defines for this field,
        // relative to the committed catalogue at docs/har-reference/<host>/.
        // Not invented here: `referenceRelativePath` names what
        // har/extract-har-reference.js writes, from the provider, the operator's
        // own --describe and the capture date. Null when there is no session to
        // derive it from, which is every caller that passes no meta.
        //
        // This is the structural link a committed reference needs back to its
        // raw. Its absence is why an audit found 0 of 29 committed references
        // adjudicable: a reference nobody can pair with a capture cannot be
        // re-derived, re-scrubbed, or diffed.
        HarFile: meta.referenceFile || null,
        // NULL, NOT ZERO. These are facts about a reference file, and a scaffold
        // row describes a digest GROUP -- no reference has been extracted yet,
        // so there is nothing to have measured. Writing `0` would state a fact
        // nobody checked, in the exact shape of the defect the structured
        // catalogue exists to prevent: a row asserting something about a file
        // that does not support it. verify-har-catalogue.js recomputes these
        // once the row names a reference, so a null that was never filled in is
        // reported rather than mistaken for a measurement.
        RequestBodies: null,
        RequestBytes: null,
        ResponseBytes: null,
        RequestBodiesAbsent: null,
        Related: [],
        CapturedUtc: meta.capturedUtc || digest.capturedUtc
    }));
}

// ---------------------------------------------------------------------------
// Catalogue delegation
// ---------------------------------------------------------------------------

/**
 * Who runs the catalogue phase.
 *
 * Cataloguing is AI work, and the two ways this command gets launched need
 * different handling:
 *
 *  - An agent already drives the session. It reads the digest itself; shelling
 *    out to a second AI from inside one would be absurd.
 *  - A human ran it interactively. Shell out to the `claude` CLI so the
 *    catalogue completes without the human needing to know it was an AI step.
 *  - Neither. Report the prompt and the command, so the step is visibly
 *    outstanding rather than silently dropped.
 */
function decideCatalogueRunner(ctx = {}) {
    const env = ctx.env || process.env;
    const promptPath = path.join(__dirname, CATALOGUE_PROMPT);
    if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) {
        return { delegatedTo: 'agent', pending: true, promptPath };
    }
    if (ctx.isTty && ctx.claudeOnPath) {
        return { delegatedTo: 'claude-cli', pending: false, promptPath };
    }
    return { delegatedTo: 'none', pending: true, promptPath };
}

function claudeOnPath() {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
        encoding: 'utf8', windowsHide: true
    });
    return probe.status === 0;
}

// ---------------------------------------------------------------------------
// Post-processing: scrub -> verify -> digest -> catalogue
// ---------------------------------------------------------------------------

function runNode(script, argv, cwd) {
    const result = spawnSync(process.execPath, [script, ...argv], {
        encoding: 'utf8', cwd, windowsHide: true
    });
    return {
        ok: result.status === 0,
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
    };
}

/**
 * Put `candidate` in front of the leak gate and record its verdict on `state`.
 *
 * ONE implementation, because there are now two doors into the pipeline. A
 * full capture arrives here from postProcess with a scrub it just wrote; the
 * `catalogue` command arrives here with a HAR somebody hands it. Both need the
 * same three-way verdict, and a second copy of it in the second door is
 * exactly how "advisory" quietly becomes "rejected" on one path only.
 *
 * Exit 4 is not a rejection. It says the only findings are identity evidence
 * by SHAPE, which carries no provenance -- a Luhn-valid 16-digit run is a
 * card, a trip id, or ~10% of digit runs by chance. Withholding the capture
 * over that is what cost 1413 trip ids their reference; the artifact is kept
 * and the findings are surfaced, so a false positive costs a review step
 * instead of the capture.
 *
 * @returns {{path: string, verified: boolean, advisory: boolean}} state.scrubbed
 */
function askTheGate(candidate, state, run) {
    const verify = (run || runNode)(
        path.join(__dirname, '..', 'har', 'verify-scrub.js'), ['--in', candidate]);
    const advisory = !verify.ok && verify.status === VERIFY_ADVISORY_EXIT;
    state.scrubbed = { path: candidate, verified: verify.ok, advisory };
    // verify-scrub.js already names itself in what it prints, so a second
    // prefix would read as two tools reporting the same thing.
    const spoke = verify.stderr.trim();
    const said = spoke.startsWith('verify-scrub')
        ? spoke : `verify-scrub: ${spoke || `exit ${verify.status}`}`;
    if (advisory) state.warnings.push(said);
    else if (!verify.ok) state.errors.push(said);
    return state.scrubbed;
}

/**
 * Digest the scrubbed capture at `state.scrubbed.path`, then hand the result to
 * whoever catalogues.
 *
 * Split out of postProcess so the `catalogue` command can run THIS code rather
 * than a copy of it. Nothing about the phase changed in the move: it still
 * derives from the scrubbed capture, still refuses to clobber an existing
 * catalogue, and still asks decideCatalogueRunner -- once, in runCatalogue --
 * who does the segmenting.
 *
 * It does not publish and it does not quarantine. Those belong to the scrub
 * stage, and a second implementation of them behind a second door is the
 * two-engines defect this subsystem has spent a dozen PRs removing.
 */
function catalogueScrubbed(session, state) {
    try {
        const har = JSON.parse(fs.readFileSync(state.scrubbed.path, 'utf8'));
        // capturedUtc is when the RECORDING happened, not when it was
        // processed. A catalogue row dated to the scrub would answer "how old
        // is this evidence of their API" with the wrong number -- and that
        // question is most of why the date is in the filename convention.
        const digest = buildDigest(har, {
            uri: session.uri,
            describe: session.describe,
            capturedUtc: session.startedUtc
        });
        const digestPath = path.join(session.outputPath, DIGEST_FILE);
        writeJson(digestPath, digest);
        state.digest = { path: digestPath };

        const cataloguePath = path.join(session.outputPath, CATALOGUE_FILE);
        // Never clobber an existing catalogue: a re-capture must not erase the
        // actions a previous run's AI phase already named and exercised.
        if (!fs.existsSync(cataloguePath)) {
            writeJson(cataloguePath, buildCatalogueScaffold(digest, {
                referenceFile: referenceRelativePath(session)
            }));
        }
        state.catalogue = Object.assign(
            { path: cataloguePath, actions: [], files: [] },
            runCatalogue(session, digestPath, cataloguePath, state));
        // Described, never performed -- see describeReference. Placed after the
        // catalogue so a rejected scrub, which returns before any of this,
        // cannot reach it: a capture the leak gate refused promotes nothing.
        state.reference = describeReference(session, state);
    } catch (e) {
        state.errors.push(`digest: ${e.message}`);
    }
    return state;
}

/**
 * What promoting this capture into a committable reference would produce.
 *
 * A DESCRIPTION, not an action. Nothing here copies, writes or creates
 * anything, and that is the whole point of the shape:
 *
 *  - A reference is a TRIMMED EXTRACT, not a whole scrubbed capture. Measured
 *    in a consuming project, committed references run 3 KB - 60 KB while the
 *    captures they came from run 277 MB - 1.6 GB. Copying `scrubbed.har` into
 *    `docs/har-reference/` would commit a several-hundred-megabyte file where a
 *    20 KB extract belongs.
 *  - The tool that makes the extract already exists --
 *    `har/extract-har-reference.js` -- and already implements this naming
 *    convention, the no-truncation rule for request bodies, and the decoded
 *    `postData.params[]`. Re-implementing any of that here would be a second
 *    engine.
 *  - That tool REFUSES to run without `--match`, and the refusal is correct: it
 *    is what stops an empty or accidental reference being committed. Choosing
 *    which entries matter is the judgement a reference exists to record, and a
 *    selector guessed from a digest that "looks right" is plausible,
 *    unverifiable, and wrong in a way nobody notices until somebody relies on
 *    it. So the run ends by telling the operator exactly what to type, with the
 *    provider, the action and the destination already filled in.
 *
 * Returns null when there is nothing to suggest -- no host to derive a provider
 * from, or no verified artifact to extract from.
 */
function describeReference(session, state, cwd) {
    if (!state || !state.scrubbed || !state.scrubbed.path) { return null; }
    const host = uriHostOf(session && session.uri);
    const fileName = referenceFileName(session);
    const relativePath = referenceRelativePath(session);
    if (!host || !fileName || !relativePath) { return null; }
    // The CURRENT working tree, which is where the operator is standing and
    // where a committed reference belongs. Never the main working tree: that is
    // the raw capture's anchor, chosen for its lifetime, and it is frequently
    // the protected branch.
    const placement = capturePlacement(cwd || process.cwd());
    const root = placement.currentWorkingTree || path.resolve(cwd || process.cwd());
    // NESTED under the provider: `docs/har-reference/<host>/<provider>/`. The
    // host directory holds the committed `catalogue.json` and its generated
    // `README.md` (#379); each provider under it holds that provider's
    // extracts and its generated `api.json` (#382). A host routinely spans
    // several third-party APIs, so the provider level is what keeps one
    // provider's references, policy and API document together.
    const dir = path.join(root, REFERENCE_DIR, host, providerSlug(host));
    return {
        fileName,
        relativePath,
        dir,
        path: path.join(dir, fileName),
        source: state.scrubbed.path,
        extractor: path.join(__dirname, '..', 'har', 'extract-har-reference.js')
    };
}

// The catalogue table, column for column what HarCapture.Format.ps1xml already
// renders. The two entry points agree because they show the same five columns
// in the same order, and neither shows anything else.
//
// NONE OF THESE FIELDS CAN CARRY A CAPTURED VALUE. `Endpoints` is
// `<host><pathTemplate>` from the digest, which groups on the TEMPLATE -- ids
// are collapsed before they reach here, and the digest is derived from the
// SCRUBBED capture in the first place. `Action` is built from the same
// template. `Methods`, `EntryCount` and `Status` are a verb, a count and an
// enum. `Description` is the operator's own words and is deliberately NOT a
// column: the PowerShell table does not show it either, and parity is what
// stops the two renderings drifting.
const CATALOGUE_COLUMNS = [
    { label: 'Status', width: 10, value: (r) => r.Status },
    { label: 'Action', width: 32, value: (r) => r.Action },
    { label: 'Methods', width: 12, value: (r) => (r.Methods || []).join(',') },
    { label: 'Entries', width: 7, right: true, value: (r) => r.EntryCount },
    { label: 'Endpoints', width: 0, value: (r) => (r.Endpoints || []).join(', ') }
];

function catalogueCell(column, row) {
    const raw = column.value(row);
    const text = raw === null || raw === undefined ? '' : String(raw);
    if (!column.width) { return text; }
    // Padded, never truncated. PowerShell's formatter truncates to the column
    // width; here a long path template would lose its tail, and the tail is the
    // part that distinguishes two endpoints under one prefix.
    return column.right ? text.padStart(column.width) : text.padEnd(column.width);
}

function catalogueTableLines(rows) {
    const list = (rows || []).filter((r) => r && typeof r === 'object');
    if (!list.length) { return []; }
    const header = CATALOGUE_COLUMNS
        .map((c) => (c.width ? (c.right ? c.label.padStart(c.width) : c.label.padEnd(c.width)) : c.label))
        .join(' ').replace(/\s+$/, '');
    const rule = CATALOGUE_COLUMNS
        .map((c) => '-'.repeat(c.width || Math.max(9, ...list.map((r) => catalogueCell(c, r).length))))
        .join(' ');
    const body = list.map((row) =>
        CATALOGUE_COLUMNS.map((c) => catalogueCell(c, row)).join(' ').replace(/\s+$/, ''));
    return [header, rule].concat(body);
}

/**
 * The mechanical phases, run in this process on every ending that is not a
 * cancel. Recording success dominates: a scrub failure is reported and exits
 * 6, but it never reports a good capture as lost, and the raw is always kept.
 *
 * Three verdicts, not two. Clean promotes; ADVISORY (identity evidence by
 * shape) also promotes, with the findings surfaced as a warning and exit 7;
 * anything else quarantines the candidate and stops before the digest. The
 * middle verdict is the whole point of #297 -- a false positive should cost a
 * review step, not the capture.
 */
function postProcess(session, opts = {}) {
    // The runner is injectable so a test can exercise the "sanitized, but the
    // leak gate rejected it" branch without having to find a value that the
    // two real detectors happen to disagree about. What is under test there is
    // this function's decision, not sanitize-har.js's pattern list.
    const run = opts.run || runNode;
    const harDir = path.join(__dirname, '..', 'har');
    const state = { startedUtc: new Date().toISOString(), errors: [], warnings: [] };

    // Phase A -- scrub, then verify. Both reused, never reimplemented.
    //
    // The candidate is written INSIDE the session directory and only promoted
    // to the output path once the gate has passed on it. That ordering is what
    // makes "the output path receives only verified artifacts" true by
    // construction rather than by cleanup: there is no window in which a file
    // the gate has not yet judged sits in a committable directory, and a
    // re-capture whose scrub is rejected cannot have already overwritten the
    // verified artifact a previous run left there.
    const candidate = path.join(session.sessionDir, SCRUBBED_HAR);
    fs.mkdirSync(session.sessionDir, { recursive: true });
    const sanitize = run(path.join(harDir, 'sanitize-har.js'),
        ['--in', session.harPath, '--out', candidate]);
    if (!sanitize.ok) {
        state.errors.push(`sanitize-har: ${sanitize.stderr.trim() || `exit ${sanitize.status}`}`);
        state.scrubbed = { path: null, verified: false, advisory: false };
    } else {
        askTheGate(candidate, state, run);
    }

    // Phase B input -- the digest an AI segments from.
    //
    // Derived from the SCRUBBED capture, never the raw one. The digest and the
    // catalogue are written to the output path, which the design promises
    // receives only scrubbed, verified artifacts -- and a URL path segment
    // carrying an operator identifier survives grouping untouched, because
    // path templating collapses ids, not secrets. Scrubbing the input is the
    // control; the template heuristic is not and cannot be.
    //
    // So a scrub that did not VERIFY stops the pipeline here -- gating on
    // "a scrubbed file exists" would not be enough. sanitize-har.js and
    // verify-scrub.js apply deliberately different detectors, and a value the
    // first misses and the second catches is precisely the case the two-stage
    // design exists for. Falling through on it would derive a digest and a
    // catalogue from a capture already known to be leaking, and write all
    // three into the committable output path -- where `git add -A` beats the
    // exit-6 warning that arrives afterwards.
    //
    // Reporting a digest built from an unverified capture is worse than
    // reporting none: it looks safe.
    if (!state.scrubbed || !(state.scrubbed.verified || state.scrubbed.advisory)) {
        // Quarantine, not deletion. The old code UNLINKED the scrubbed file
        // here, so one false positive destroyed the whole capture -- no
        // artifact, no digest, no catalogue, and a missing file to explain it.
        // The reasoning was right and is kept: a file the gate refused must not
        // sit where `git add -A` will take it. What changes is that the
        // invariant is now preserved by WHERE the file goes.
        quarantineRejectedScrub(session, state);
        state.completedUtc = new Date().toISOString();
        return state;
    }
    // Verified (or advisory-only): promote the candidate to the output path.
    // A COPY, because nothing under .har-captures/ is ever taken away -- the
    // session keeps the complete record of what it produced.
    try {
        fs.mkdirSync(session.outputPath, { recursive: true });
        sweepAbandonedTemps(session.outputPath);
        state.scrubbed.path =
            publishFile(state.scrubbed.path, path.join(session.outputPath, SCRUBBED_HAR));
        // A findings report describes ONE run. Left behind by a re-capture
        // that came back clean it would still read as current, which is the
        // same disease as a digest built from an unverified capture: it looks
        // like information. The output path is the committable tree, not the
        // archive -- the session directory keeps every report ever written.
        const publishedReport = path.join(session.outputPath, FINDINGS_FILE);
        const freshReport = path.join(session.sessionDir, FINDINGS_FILE);
        if (!fs.existsSync(freshReport) && isFindingsReport(publishedReport)) {
            try { fs.unlinkSync(publishedReport); } catch { /* leave it */ }
        }
        // A sidecar that will not copy must not fail the capture -- the report
        // is a triage aid, not the gate. But the degradation has to carry a
        // signal. Silently leaving `findings` null ends the run byte-for-byte
        // the way a CLEAN one ends, so neither the operator nor an agent
        // reading the artifacts afterwards can tell "no report was needed"
        // from "advisory findings exist and their report did not make it" --
        // while the front door goes on naming a file that is not there.
        //
        // The report is not lost in that state: it is complete in the session
        // directory. So point at it and say so.
        if (fs.existsSync(freshReport)) {
            try {
                state.scrubbed.findings = publishFile(freshReport, publishedReport);
            } catch (e) {
                state.scrubbed.findings = freshReport;
                state.warnings.push(
                    `capture-har: the findings report could not be published to the output ` +
                    `path (${e.message}). It is complete at ${freshReport}`);
            }
        }
    } catch (e) {
        state.errors.push(`publish: ${e.message}`);
        state.scrubbed.path = null;
        state.completedUtc = new Date().toISOString();
        return state;
    }
    catalogueScrubbed(session, state);

    state.completedUtc = new Date().toISOString();
    return state;
}

/**
 * Is the file at `p` a findings report THIS tool wrote?
 *
 * Clearing a stale report must key on the document, not on the filename. The
 * output path being tool-owned is documented and bannered, which makes it a
 * convention; deleting whatever occupies a name on the strength of a
 * convention is how somebody's hand-written notes disappear.
 */
function isFindingsReport(p) {
    const doc = readJson(p);
    return !!doc && typeof doc === 'object'
        && doc.schemaVersion !== undefined && Array.isArray(doc.findings);
}

/**
 * A name in `dir` that is not taken yet: `base.ext`, then `base.2.ext`, ...
 *
 * Nothing under `.har-captures/` is ever deleted or overwritten BY THIS TOOL,
 * and a second rejection in a session that already holds one is exactly where a
 * careless implementation would overwrite the first -- which is the evidence
 * the operator is still triaging.
 *
 * The qualifier is not a loophole. An operator can now ask for a verified
 * scrub's source to be removed (`Invoke-SanitizeHar.ps1 -RemoveSource`, #352),
 * which is a request, per run, about one raw. It cannot reach a rejected
 * scrub's evidence: that path never verifies, so the removal never runs.
 */
function freeName(dir, base, ext) {
    let candidate = path.join(dir, `${base}${ext}`);
    for (let n = 2; fs.existsSync(candidate); n++) {
        candidate = path.join(dir, `${base}.${n}${ext}`);
    }
    return candidate;
}

/**
 * Put `from` at `to` so that `to` is never seen holding a partial write.
 *
 * The bytes land under a temporary name in the SAME directory and then take
 * the real name with a rename, which either happens or does not -- there is no
 * intermediate state in which the destination exists and is incomplete. A
 * plain copy has one: a run killed part-way through leaves a truncated file
 * under the name that means "verified", and two captures publishing at once
 * interleave into a corrupted one rather than one of them simply winning.
 *
 * The whole invariant here is "a file that exists at the output path has
 * already been judged", so a half-written file under that name is worse than
 * no file at all -- neither a reader nor `git add -A` can tell it apart.
 *
 * The temporary is removed if the rename does not happen, so a failure leaves
 * the previous artifact in place and nothing else behind.
 *
 * The rename is retried on a transient Windows lock -- see renameWithRetry.
 * Atomicity is not free on that platform, and the retry is what stops the
 * guarantee costing availability.
 */
/**
 * Block for `ms` without an event loop turn.
 *
 * postProcess is synchronous by design -- it runs the mechanical phases in the
 * recorder's own process -- so the backoff cannot be a promise without turning
 * the whole call chain async for a wait measured in milliseconds.
 */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `fs.renameSync`, retried while the destination is momentarily held.
 *
 * Bounded on purpose. Retrying until a lock clears would hang a capture on a
 * file left open in an editor, which is a worse failure than the one being
 * avoided: an error can at least be read. And the retry is narrow -- every
 * attempt is still a rename, so nothing here weakens the property that the
 * destination is never seen holding a partial write.
 */
function renameWithRetry(from, to) {
    for (let attempt = 1; ; attempt++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (e) {
            if (attempt >= PUBLISH_RENAME_ATTEMPTS
                || !PUBLISH_RENAME_RETRY_CODES.has(e.code)) throw e;
            sleepSync(PUBLISH_RENAME_BACKOFF_MS * 2 ** (attempt - 1));
        }
    }
}

function publishFile(from, to) {
    // The default output path IS the session directory now (#377), so the
    // candidate is frequently already at its destination. Copying a file onto
    // itself through a temporary is not a no-op -- it is a window in which the
    // only copy exists under a name nothing recognises -- so the identity case
    // is answered before any bytes move.
    if (path.resolve(from) === path.resolve(to)) { return to; }
    const temp = path.join(path.dirname(to),
        `${PUBLISH_TEMP_PREFIX}${process.pid}-${Date.now().toString(36)}-` +
        `${Math.random().toString(36).slice(2, 8)}`);
    fs.copyFileSync(from, temp);
    try {
        renameWithRetry(temp, to);
    } catch (e) {
        try { fs.unlinkSync(temp); } catch { /* nothing more to do */ }
        throw e;
    }
    return to;
}

/**
 * Remove publication temporaries abandoned by a run that died.
 *
 * Age is the discriminator, not the prefix alone. A blind sweep would delete
 * the in-flight temporary of a CONCURRENT capture and reintroduce exactly the
 * corruption `publishFile` exists to prevent -- from the other side.
 */
function sweepAbandonedTemps(dir, now = Date.now()) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
        if (!name.startsWith(PUBLISH_TEMP_PREFIX)) continue;
        const full = path.join(dir, name);
        try {
            if (now - fs.statSync(full).mtimeMs < PUBLISH_TEMP_STALE_MS) continue;
            fs.unlinkSync(full);
        } catch { /* another run may have just taken it; that is fine */ }
    }
}

/**
 * Move a scrub the leak gate refused out of the way, keeping every byte.
 *
 * The candidate already lives in the session directory, so this is a rename
 * within one volume: it cannot half-succeed, and it cannot leave the artifact
 * in a committable directory. The findings report verify-scrub.js wrote beside
 * it moves with it under a matching name, because a report separated from the
 * artifact it describes is a report nobody can act on.
 */
function quarantineRejectedScrub(session, state) {
    if (!state.scrubbed || !state.scrubbed.path) return;
    const source = state.scrubbed.path;
    state.scrubbed.path = null;
    if (!fs.existsSync(source)) return;

    const stem = REJECTED_HAR.slice(0, -path.extname(REJECTED_HAR).length);
    const dest = freeName(session.sessionDir, stem, path.extname(REJECTED_HAR));
    // The suffix that made the artifact's name unique, so the report keeps the
    // same one and the pair stays legible in a directory listing.
    const suffix = path.basename(dest, path.extname(REJECTED_HAR)).slice(stem.length);
    try {
        fs.renameSync(source, dest);
    } catch (e) {
        state.errors.push(`quarantine: ${e.message}`);
        return;
    }
    state.scrubbed.quarantined = dest;
    state.scrubbed.rejected = true;

    const report = path.join(session.sessionDir, FINDINGS_FILE);
    if (fs.existsSync(report) && suffix) {
        const reportStem = FINDINGS_FILE.slice(0, -path.extname(FINDINGS_FILE).length);
        const moved = path.join(session.sessionDir,
            `${reportStem}${suffix}${path.extname(FINDINGS_FILE)}`);
        try { fs.renameSync(report, moved); state.scrubbed.findings = moved; } catch { /* keep */ }
    } else if (fs.existsSync(report)) {
        state.scrubbed.findings = report;
    }
}

function runCatalogue(session, digestPath, cataloguePath, state) {
    const decision = decideCatalogueRunner({
        env: process.env,
        isTty: !!process.stdin.isTTY,
        claudeOnPath: claudeOnPath()
    });
    const result = { delegatedTo: decision.delegatedTo, pending: decision.pending };

    if (decision.delegatedTo === 'claude-cli') {
        const prompt =
            `${fs.readFileSync(decision.promptPath, 'utf8')}\n\n` +
            `Digest: ${digestPath}\nCatalogue: ${cataloguePath}\n` +
            `Raw capture: ${session.harPath}\nOutput path: ${session.outputPath}\n` +
            (session.describe ? `Operator intent: ${session.describe}\n` : '');
        const run = spawnSync('claude', ['-p', prompt], {
            encoding: 'utf8', cwd: session.outputPath, stdio: 'inherit', windowsHide: true
        });
        if (run.status !== 0) {
            state.errors.push(`catalogue: claude exited ${run.status}`);
            result.pending = true;
        }
    } else if (decision.delegatedTo === 'none') {
        result.skippedReason =
            `no AI runner available -- catalogue with the prompt at ${decision.promptPath}`;
    }

    const rows = readJson(cataloguePath) || [];
    result.actions = rows.filter((r) => r.Status === 'Exercised').map((r) => r.Action);
    result.files = rows.map((r) => r.HarFile).filter(Boolean);
    return result;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function summarize(harPath) {
    if (!harPath || !fs.existsSync(harPath)) return { exists: false, bytes: 0 };
    const bytes = fs.statSync(harPath).size;
    const summary = { exists: true, bytes, path: harPath };
    try {
        const entries = JSON.parse(fs.readFileSync(harPath, 'utf8')).log.entries || [];
        summary.entries = entries.length;
        summary.hosts = [...new Set(entries.map((e) => {
            try { return new URL(e.request.url).host; } catch (x) { return '?'; }
        }))].sort();
    } catch (e) {
        summary.parseError = e.message;
    }
    return summary;
}

/**
 * What the console says once a recording is under way.
 *
 * The split is by what the operator needs in order to browse versus what they
 * need in order to debug. The site being recorded and how to end the recording
 * are the first; every resolved path, the profile and the debugging endpoint
 * are the second.
 *
 * The external-profile caveat is deliberately NOT a diagnostic: it says some
 * other tool is locked out for the duration, which the operator has to know
 * before they start rather than after they wonder why.
 */
function startBannerLines(session) {
    const lines = [['info', `\ncapture-har: recording ${session.uri}`]];
    if (session.externalProfile) {
        lines.push(['info',
            '  This profile belongs to another tool, which cannot use it\n' +
            '  until the recording ends.']);
    }
    lines.push(['verbose', `  profile:  ${session.profileDir}`]);
    if (session.storageState) lines.push(['verbose', `  session:  ${session.storageState}`]);
    // Still verbose: the capture ROOT is announced unconditionally before this
    // banner (#367), and that is the durability-relevant half. The per-session
    // path under it stays a diagnostic, as the rest of these do.
    lines.push(['verbose', `  raw:      ${session.harPath}  (never committed)`]);
    lines.push(['verbose', `  output:   ${session.outputPath}  (scrubbed artifacts only)`]);
    lines.push(['verbose', `  cdp:      ${session.cdpEndpoint}` +
        (session.port !== session.requestedPort ? `  (${session.requestedPort} was busy)` : '')]);
    lines.push(['info', '\n  Browse, then press ENTER here -- that writes the most complete HAR.\n']);
    return lines;
}

/**
 * What the console says about the artifacts, once the phases have run.
 *
 * `scrubbed` and `catalogue` stay visible without -Verbose because they are
 * what the operator acts on next; a default run that ended without naming them
 * would send them hunting. `raw` and `digest` are a diagnostic and an
 * intermediate.
 *
 * A rejected scrub says so at warn level, which no threshold suppresses. Going
 * quiet about it would read as "no scrub was attempted" -- a different and far
 * less alarming story than "one was attempted and the leak gate refused it".
 */
/**
 * Render the findings report for the console: one triageable line each.
 *
 * "credit-card, 1413 occurrences" with no location is the report that taught
 * operators to ignore this gate. A kind, a class, an entry index, a key path,
 * a count and a fingerprint is one pass of triage instead -- and the escape is
 * named, because a warning nobody can act on is a warning nobody reads.
 *
 * The report holds no values (verify-scrub.js writes it that way), so nothing
 * here can print one. Everything below is a name, a location or a hash.
 */
function findingSummaryLines(reportPath) {
    const doc = readJson(reportPath);
    if (!doc || !Array.isArray(doc.findings)) return [];
    const shown = doc.findings.filter((f) => f.disposition !== 'reported');
    const lines = shown.slice(0, 10).map((f) => {
        // A finding inside a percent-encoded parameter has no JSON key path of
        // its own -- the enclosing field name is the location, and printing
        // nothing there would leave the operator with a fingerprint and no
        // idea where to look.
        const at = f.keyPath || (f.enclosing ? `(inside encoded ${f.enclosing})` : '');
        const where = f.entryIndex === undefined
            ? '' : ` at entry ${f.entryIndex}${at ? ` ${at}` : ''}`;
        const count = f.count > 1 ? `, x${f.count}` : '';
        return `${f.disposition === 'gating' ? '-' : '!'} ${f.kind}` +
            `${f.class ? ` [${f.class}]` : ''}${where}` +
            ` (fingerprint ${f.fingerprint}${count})`;
    });
    if (shown.length > lines.length) {
        lines.push(`... ${shown.length - lines.length} more in ${path.basename(reportPath)}`);
    }
    if (doc.suggestedPolicyFragment) {
        lines.push(`To accept an identity finding, waive its fingerprint in ` +
            `.har-policy.project.json -- the report carries a paste-ready fragment.`);
    }
    return lines;
}

/**
 * Is the catalogue at `p` still an untouched scaffold?
 *
 * Not a second rule: `describedRowCount` is the one implementation of "has the
 * AI pass happened", already used by the re-catalogue refusal.
 */
function isScaffoldOnly(p) {
    const rows = readJson(p);
    return Array.isArray(rows) && rows.length > 0 && describedRowCount(p) === 0;
}

/**
 * The promote step: the exact command that turns this capture into a committed
 * reference, and the catalogue row that reference will want.
 *
 * It PRINTS and stops. See describeReference for why nothing is copied, and
 * `#379` for the catalogue row this only suggests -- writing a structured
 * committed catalogue is that issue, not this one.
 */
function referenceNoticeLines(reference, pp, describe) {
    if (!reference) { return []; }
    const rows = readJson((pp && pp.catalogue && pp.catalogue.path) || null) || [];
    const described = rows.find((r) => r && r.Description) || rows[0] || null;
    const lines = [
        ['info', `  reference: ${reference.path}`],
        ['info', '             not written yet -- a reference is a TRIMMED extract of the entries'],
        ['info', '             that matter, not the whole scrubbed capture. To write it:'],
        ['info', `               node ${reference.extractor} \\`],
        ['info', `                 --in ${reference.source} \\`],
        ['info', "                 --match '<regex over the request URL or body>' \\"],
        ['info', `                 --out ${reference.path}`],
        ['info', '             --match is required and has no default: which entries matter is the'],
        ['info', '             judgement the reference exists to record. The path templates in'],
        ['info', '             digest.json are where to look for one.']
    ];
    if (described) {
        lines.push(['info', '             Suggested catalogue row (printed only -- see #379):']);
        // The operator's own --describe stands in until the AI pass writes a
        // per-row description. An empty cell in a suggested row is a row
        // nobody can paste.
        lines.push(['info', `               | ${described.Action} ` +
            `| ${described.Description || describe || ''} | ${reference.relativePath} |`]);
    }
    return lines;
}

function postProcessLines(session) {
    const pp = session.postProcess || {};
    const lines = [['verbose', `  raw:       ${session.harPath}  (unscrubbed -- never commit it)`]];
    if (pp.scrubbed && pp.scrubbed.path) {
        lines.push(['info', `  scrubbed:  ${pp.scrubbed.path}` +
            `  (${pp.scrubbed.advisory ? 'kept -- advisory findings, see below' : 'verified'})`]);
    } else if (pp.scrubbed && pp.scrubbed.quarantined) {
        // Where it went, not that it is gone. The predecessor of this line
        // said "deleted", which left the operator with an exit code, a missing
        // file and nothing to triage.
        lines.push(['warn',
            `  scrubbed:  REJECTED by the leak gate -- quarantined, not destroyed:\n` +
            `             ${pp.scrubbed.quarantined}`]);
    } else if (pp.scrubbed && pp.scrubbed.rejected) {
        lines.push(['warn',
            '  scrubbed:  REJECTED by the leak gate; the raw capture is kept']);
    }
    if (pp.scrubbed && pp.scrubbed.findings) {
        lines.push(['warn', `  findings:  ${pp.scrubbed.findings}`]);
        for (const line of findingSummaryLines(pp.scrubbed.findings)) {
            lines.push(['warn', `             ${line}`]);
        }
    }
    if (pp.digest) lines.push(['verbose', `  digest:    ${pp.digest.path}`]);
    if (pp.catalogue) {
        lines.push(['info', `  catalogue: ${pp.catalogue.path}  (${pp.catalogue.delegatedTo})`]);
        if (pp.catalogue.skippedReason) lines.push(['warn', `             ${pp.catalogue.skippedReason}`]);
        // THE CATALOGUE ITSELF, not just its path (#377 s5b).
        //
        // A path is not a result. `CLAUDE.md` asks a run to show the actual
        // result "so the user sees the change worked without re-running it",
        // and this run's result is what was captured. The rendering existed
        // already, but only on the PowerShell front door -- and the node path
        // is the one agents use.
        //
        // Printed from the RECORDER on #300's precedent: this is the process
        // that wrote the files, so the print is in-process and unconditional. A
        // front door killed between spawning us and reaching its own epilogue
        // cannot take it away, and a notice that goes missing exactly when
        // something went wrong is not a safety net.
        for (const line of catalogueTableLines(readJson(pp.catalogue.path))) {
            lines.push(['info', `  ${line}`]);
        }
        // Keyed on Description and NOT on Status, for the reason
        // Invoke-HarCapture.ps1 already gives: a real AI pass may legitimately
        // conclude that every group was Observed and none Exercised, so Status
        // cannot tell a finished catalogue from an untouched scaffold.
        // Describing a row is the one thing the AI does that the scaffold never
        // can.
        if (isScaffoldOnly(pp.catalogue.path)) {
            lines.push(['info',
                '  Every row is still Observed -- the catalogue needs its AI pass. See ' +
                path.join(__dirname, CATALOGUE_PROMPT)]);
        }
    }
    for (const line of referenceNoticeLines(pp.reference, pp, session.describe)) { lines.push(line); }
    for (const err of pp.errors || []) lines.push(['error', `  ERROR:     ${err}`]);
    for (const warn of pp.warnings || []) {
        for (const line of `${warn}`.split('\n')) lines.push(['warn', `  WARNING:   ${line}`]);
    }

    // The other half of what makes warn-and-proceed safe rather than merely
    // deferred (#300). Having declined to discard anything, the run owes the
    // operator the exact paths it wrote and one command to move them. `warn`,
    // not `info`, so it survives -InformationAction SilentlyContinue -- the
    // whole failure mode being fixed is a mess nobody was told about.
    const relocate = repoGuard.relocationNotice(session.placement, [session.outputPath]);
    if (relocate) {
        for (const line of relocate.split('\n')) lines.push(['warn', `  ${line}`]);
    }
    return lines;
}

function describeSummary(summary) {
    if (!summary.exists) return 'no HAR was written';
    const kb = (summary.bytes / 1024).toFixed(1);
    if (summary.parseError) return `${kb} KB, unparseable (${summary.parseError})`;
    const hosts = summary.hosts.length <= 4
        ? summary.hosts.join(', ')
        : `${summary.hosts.slice(0, 4).join(', ')} +${summary.hosts.length - 4} more`;
    return `${summary.entries} entries, ${kb} KB, hosts: ${hosts}`;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/**
 * Fail before the browser launches when the operator profile is missing.
 *
 * #255 forbids defaulting the literal map -- the values are the operator's own
 * account identifiers. Discovering that after a browsing session is spent
 * costs the whole session, so the check moved to preflight where it costs
 * seconds.
 */
function preflightProfile(isTty) {
    try {
        harProfile.loadProfile({});
        return { ok: true };
    } catch (e) {
        if (!(e instanceof harProfile.ProfileError)) throw e;
        if (isTty) {
            return { ok: false, scaffold: true, message: e.message };
        }
        return { ok: false, scaffold: false, message: e.message };
    }
}

function scaffoldProfile(targetDir) {
    const file = path.join(targetDir, harProfile.PROFILE_FILENAME);
    writeJson(file, { salt: require('crypto').randomBytes(24).toString('hex'), literals: {} });
    return file;
}

/**
 * Ask the operator one line.
 *
 * The question goes to STDERR, with everything else human-facing. stdout is
 * machine output -- and since #377 a completed `start` ends by writing one JSON
 * line there for its front door to read, so a prompt on stdout would be a
 * question mixed into a data stream that a caller is capturing rather than
 * showing.
 */
async function askLine(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
        return await new Promise((resolve) => rl.question(question, resolve));
    } finally {
        rl.close();
    }
}

async function start(args) {
    if (!args.uri) return usage('start requires --uri');
    for (const key of Object.keys(args)) {
        if (key === '_') continue;
        if (!START_OPTIONS.includes(key)) {
            return usage(`start does not accept --${key}` +
                (key === 'dir'
                    ? '. Raw captures are confined to .har-captures/ by design;\n' +
                      '  --output-path receives the scrubbed artifacts instead.'
                    : key === 'storage-state'
                        ? `. A ${STORAGE_STATE_FILENAME} at or above the working directory is\n` +
                          '  discovered automatically.'
                        : ''));
        }
    }

    // #366 -- A CAPTURE NOBODY CAN IDENTIFY IS A CAPTURE NOBODY CAN USE.
    //
    // Checked here, before anything is recorded, for the same reason the
    // placement guard is: refusing a recording costs seconds now and a whole
    // browsing session later. It is deliberately AFTER the option check above,
    // so `--dir` still gets told why it was dropped rather than being answered
    // with a complaint about a different flag.
    //
    // Not a warning. `describe` was already visibly null in session.json and
    // nobody noticed across 82 captures -- a warning is what this effectively
    // was. Whitespace is empty: `--describe "   "` identifies nothing.
    if (typeof args.describe !== 'string' || !args.describe.trim()) {
        process.stderr.write(
            'capture-har: refusing to record without --describe.\n' +
            '  A capture nobody can identify is a capture nobody can use: the store is\n' +
            '  shared and append-only, the directory name is a START time, and several\n' +
            '  sessions record into it at once. The description is the only part of a\n' +
            '  capture that cannot be reconstructed afterwards -- the bytes can be\n' +
            '  re-captured, what you were doing cannot.\n' +
            '  Try: --describe "example.com: create a post with two photos, then delete it"\n');
        return 2;
    }

    const isTty = !!process.stdin.isTTY;

    // WHERE THE OUTPUT WILL LAND, checked here and nowhere later (#300).
    //
    // This sits at the very top of `start`, ahead of the profile preflight, the
    // port scan and the browser, because the guard is only safe while nothing
    // has been recorded yet. Warn a second in and cancelling costs the operator
    // nothing; warn after a capture and the choice becomes "discard the
    // recording you just spent minutes producing", which is a worse outcome
    // than the misplacement it would prevent. So: advisory, never fatal, and
    // never moved downstream.
    //
    // The PowerShell front door runs the same check and marks the environment,
    // so an operator driving through Invoke-HarCapture is told once, not twice.
    const placement = repoGuard.inspectCheckout(process.cwd());
    if (placement.shouldWarn && !process.env.HARCAPTURE_PLACEMENT_GUARD_RAN) {
        process.stderr.write('capture-har: ' +
            repoGuard.guardMessage(placement).split('\n').join('\n  ') + '\n');
    }

    // Preflight FIRST -- before the port scan and long before a browser.
    const preflight = preflightProfile(isTty);
    if (!preflight.ok && !args['validate-only']) {
        if (preflight.scaffold) {
            const answer = await askLine(
                `capture-har: no ${harProfile.PROFILE_FILENAME} found.\n` +
                `  ${preflight.message}\n` +
                '  Scaffold one here now? [y/N] ');
            if (!/^y/i.test((answer || '').trim())) {
                process.stderr.write('capture-har: cannot record without an operator profile.\n');
                return 1;
            }
            const created = scaffoldProfile(process.cwd());
            log.info(
                `capture-har: wrote ${created}. Add your own identifiers to "literals"\n` +
                '  before the scrub can redact them.');
        } else {
            process.stderr.write(`capture-har: ${preflight.message}\n`);
            return 1;
        }
    }

    const paths = resolveSessionPaths({ uri: args.uri, outputPath: args['output-path'] });

    // WHERE THE BYTES ARE GOING, said on the way IN (#367).
    //
    // session.json recorded the destroyed capture's path perfectly; nobody read
    // it until the directory was gone. A path announced while the recording is
    // starting is a path the operator can still question, so this is printed at
    // info level, before the browser, and not gated on -Verbose.
    const rootNotice = repoGuard.captureRootNotice(paths.capturePlacement);
    if (rootNotice) log.info('capture-har: ' + rootNotice);
    const requestedPort = numberOr(args.port, DEFAULT_PORT);
    const port = args['validate-only'] && requestedPort === 0
        ? requestedPort
        : await findFreePort(requestedPort);
    const snapshotSeconds = numberOr(args['snapshot-seconds'], DEFAULT_SNAPSHOT_SECONDS);
    const snapshotMs = snapshotSeconds * 1000;
    const isolated = !!args.isolated;
    const profileDir = isolated
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'har-capture-'))
        : resolveProfileDir(args.profile);
    const externalProfile = !isolated && !profileDir.startsWith(captureProfileRoot());
    const storageState = isolated ? discoverStorageState(process.cwd()) : null;

    const session = {
        uri: args.uri,
        describe: args.describe.trim(),
        sessionDir: paths.sessionDir,
        harPath: paths.harPath,
        recordLog: paths.recordLog,
        outputPath: paths.outputPath,
        // Carried on the session so the CLOSING notice can name what was
        // written even though the detection happened before the browser opened.
        // Null unless the guard fired, so nothing downstream has to re-probe.
        //
        // THE RECORDER OWNS THE CLOSING NOTICE, and deliberately not the front
        // door -- unlike the opening warning, which the front door owns via
        // HARCAPTURE_PLACEMENT_GUARD_RAN. The asymmetry is the point. The
        // opening warning is printed BEFORE this process is spawned, so it
        // cannot be lost. The closing notice is printed after work has
        // happened, and this is the process that actually wrote the files:
        // printing it here is in-process and unconditional, so a front door
        // that is killed between spawning us and reaching its own epilogue --
        // a closed terminal, a hard Ctrl+C, an agent that dies mid-session --
        // cannot take the notice with it. Deduplicating by suppressing THIS
        // copy would make the notice depend on another process surviving, and
        // a notice that only arrives when nothing went wrong is not a safety
        // net.
        placement: placement.shouldWarn ? placement : null,
        profileDir,
        externalProfile,
        storageState,
        mode: isolated ? 'isolated-chromium' : 'chrome-profile',
        cdpEndpoint: `http://localhost:${port}`,
        port,
        requestedPort,
        snapshotSeconds: snapshotMs / 1000
    };

    if (args['validate-only']) {
        // stdout stays pure JSON so a caller can parse it; the human note goes
        // to stderr rather than corrupting that.
        process.stdout.write(JSON.stringify(session, null, 2) + '\n');
        log.info('capture-har: --validate-only OK (no browser launched)');
        return 0;
    }

    // THE CAPTURE STORE MUST BE GITIGNORED BEFORE ANYTHING IS RECORDED (#377).
    //
    // Placed here for the reason repo-workflow-guard.js states as its own
    // invariant: a guard that fires before any work costs a cancelled operator
    // seconds, while the same guard downstream would be deciding whether to
    // discard a browsing session somebody spent minutes on. It sits after the
    // --validate-only return so that flag stays what it says it is -- path
    // resolution, no side effects, no prompt.
    const ignoreGuard = await ensureCapturesRootIgnored(paths.capturePlacement, { isTty });
    if (!ignoreGuard.ok) {
        process.stderr.write(ignoreGuard.message + '\n');
        return 1;
    }

    // And the other half: an EXPLICIT --output-path into a committable
    // directory is warned about, never refused. See outputDestinationWarning.
    const outputWarning = outputDestinationWarning(paths);
    if (outputWarning) { log.warn('capture-har: ' + outputWarning); }

    // A busy port is no longer a conflict -- we moved. A persistent profile
    // genuinely is single-instance, though, and that stays a hard error naming
    // what holds it.
    const conflict = await findProfileConflict(profileDir, paths.searchRoots);
    if (conflict) {
        process.stderr.write(
            `capture-har: the capture profile is already recording.\n` +
            `  profile: ${profileDir}\n` +
            `  session: ${conflict.sessionDir}\n` +
            `  cdp:     ${conflict.cdpEndpoint}\n` +
            '  End it first (node capture-har.js stop), or record a throwaway\n' +
            '  identity alongside it with --isolated.\n');
        return 1;
    }

    fs.mkdirSync(paths.sessionDir, { recursive: true });
    const playwright = requirePlaywright();

    const options = {
        headless: false,
        timeout: LAUNCH_TIMEOUT_MS,
        recordHar: { path: paths.harPath, mode: 'full', content: 'embed' },
        args: [`--remote-debugging-port=${port}`]
    };
    // Bundled Chromium can silently close against a Chrome-created profile,
    // so the default path pins the system Chrome channel.
    if (!isolated) options.channel = 'chrome';
    if (storageState) options.storageState = storageState;

    let context;
    try {
        context = await playwright.chromium.launchPersistentContext(profileDir, options);
    } catch (e) {
        // The profile can also be held by a browser that no session file knows
        // about. Launch then stalls rather than erroring, so a timeout here
        // means "in use" far more often than it means "broken".
        if (/Timeout/i.test(e.message)) {
            process.stderr.write(
                `capture-har: the browser did not start within ${LAUNCH_TIMEOUT_MS / 1000}s.\n` +
                `  The capture profile is almost certainly open in another window:\n` +
                `    ${profileDir}\n` +
                '  Close that window (do not kill the process -- other windows may share it),\n' +
                '  or record in a throwaway profile with --isolated.\n');
            return 1;
        }
        throw e;
    }

    const recorder = new IncrementalRecorder(paths.recordLog, snapshotMs);
    attachRecorder(context, recorder);
    recorder.start();

    // Armed BEFORE the first navigation. A window closed while `goto` is still
    // in flight emits `close` on an emitter with no listeners, and Node drops
    // it -- after which no ending can ever fire and the driver waits forever,
    // holding the port and reporting `recording: true`.
    let reason = null;
    const settle = (r) => { if (!reason) reason = r; };
    context.on('close', () => settle('window-closed'));

    session.pid = process.pid;
    session.startedUtc = new Date().toISOString();
    writeJson(path.join(paths.sessionDir, SESSION_FILE), session);

    const page = context.pages()[0] || await context.newPage();
    await page.goto(args.uri, { waitUntil: 'domcontentloaded' }).catch((e) => {
        log.warn(`capture-har: initial navigation failed (${e.message}); recording anyway`);
    });

    log.lines(startBannerLines(session));

    // Whichever ending arrives first wins. (The window-closed ending is
    // already armed, above.)
    const sentinel = path.join(paths.sessionDir, STOP_SENTINEL);
    const endings = [];
    endings.push((async () => {
        while (!reason && !fs.existsSync(sentinel)) await sleep(POLL_MS);
        settle('stop-command');
    })());

    let rl = null;
    if (!args['no-wait'] && isTty) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        endings.push(new Promise((resolve) => rl.once('line', () => { settle('enter'); resolve(); })));
    }
    endings.push(new Promise((resolve) => {
        process.once('SIGINT', () => { settle('ctrl-c'); resolve(); });
    }));

    await Promise.race(endings);
    if (rl) rl.close();

    // Ctrl+C is ambiguous in a way ENTER is not: it can mean "I'm done" or "I
    // hit the wrong key". Cancel keeps the raw and skips post-processing, so a
    // mis-keyed Ctrl+C is recoverable. Without a TTY there is nobody to ask,
    // and SIGINT means what it conventionally means: cancel.
    let cancelled = false;
    if (reason === 'ctrl-c') {
        if (isTty) {
            const answer = await askLine(
                '\ncapture-har: Ctrl+C -- [f]inish and post-process, or [c]ancel? [f/c] ');
            cancelled = /^c/i.test((answer || '').trim());
        } else {
            cancelled = true;
        }
    }

    recorder.stop();
    if (reason !== 'window-closed') {
        await context.close().catch((e) => {
            process.stderr.write(`capture-har: closing the context failed: ${e.message}\n`);
        });
    }

    // Playwright writes the HAR during close; give a slow flush a moment
    // before judging the capture missing.
    for (let i = 0; i < 25 && !fs.existsSync(paths.harPath); i++) await sleep(POLL_MS);

    let assembled = null;
    if (!fs.existsSync(paths.harPath)) {
        assembled = assembleFromLog(paths.recordLog, paths.harPath);
    } else {
        // recordHar won; keeping both invites someone to analyze the other one.
        try { fs.unlinkSync(paths.recordLog); } catch (e) { /* nothing to remove */ }
    }
    const summary = summarize(paths.harPath);

    // endedUtc is written FIRST, preserving the stop contract, and
    // postProcess is written after -- so `stop` can tell "still
    // post-processing" from "done" rather than guessing.
    session.endedUtc = new Date().toISOString();
    session.endedBy = reason;
    session.cancelled = cancelled;
    session.assembledFromLog = !!assembled;
    session.summary = summary;
    writeJson(path.join(paths.sessionDir, SESSION_FILE), session);

    if (!summary.exists) {
        process.stderr.write(
            `capture-har: nothing was recorded for ${paths.sessionDir}.\n` +
            '  Neither recorder produced a HAR: the recording was lost entirely.\n');
        return 4;
    }

    if (cancelled) {
        log.info(
            `\ncapture-har: cancelled -- ${describeSummary(summary)}\n` +
            `  raw kept, not post-processed: ${paths.harPath}\n` +
            '  Re-run post-processing by stopping this session again.');
        return 0;
    }

    log.info(`\ncapture-har: stopped (${reason}) -- ${describeSummary(summary)}`);
    session.postProcess = postProcess(session);
    writeJson(path.join(paths.sessionDir, SESSION_FILE), session);
    reportPostProcess(session);

    // ONE line of machine output, on stdout, naming what this run produced.
    //
    // It exists because the DEFAULT output path now carries a stamp (#377), so
    // a front door can no longer compute it: `Invoke-HarCapture.ps1` used to
    // rebuild the path from the same anchoring rule, and the alternative --
    // globbing .har-captures/ for the newest session -- is the very thing that
    // file's own comment refuses, since a concurrent capture against another
    // site finishing first would hand this run somebody else's catalogue.
    //
    // stdout, because that is where this script's machine output already goes
    // (--validate-only and `status`); every human-facing line is on stderr, so
    // a caller capturing this stream still sees the recording live.
    process.stdout.write(JSON.stringify({
        capture: 'complete',
        sessionDir: paths.sessionDir,
        outputPath: session.outputPath,
        cataloguePath: (session.postProcess.catalogue && session.postProcess.catalogue.path) || null
    }) + '\n');

    return postProcessExitCode(session.postProcess, assembled);
}

/**
 * The process exit code the post-process phases earned.
 *
 * 7 exists so an advisory finding is neither a lie nor a failure. Returning 0
 * would tell every wrapper and CI step that a capture possibly carrying a real
 * card is clean; returning 6 would say "scrub or catalogue failed" about a run
 * that produced both. An error outranks a warning, and both outrank the
 * assembled-from-log signal, which is informational.
 */
function postProcessExitCode(pp, assembled) {
    if (pp.errors && pp.errors.length) return 6;
    if (pp.warnings && pp.warnings.length) return 7;
    return assembled ? 5 : 0;
}

function reportPostProcess(session) {
    log.lines(postProcessLines(session));
}

/**
 * Every session under the captures root, as `{ dir, stamp }`.
 *
 * Sessions live at `<root>/<host>/<stamp>`, two levels down. Both callers used
 * to read the root's direct children, and both would silently find nothing at
 * this depth: the conflict scan would stop guarding the single-instance
 * profile, and `stop`/`status` would report no session at all.
 *
 * The stamp is returned alongside the directory because it, not the path, is
 * the ordering key -- the host sorts first in a joined path and would decide
 * which capture counts as newest.
 *
 * Accepts SEVERAL roots since #367 moved where new captures are written: an
 * older capture still under a working-directory root has to remain findable,
 * and a union is how it is found without anything being moved.
 */
function listSessionDirs(root) {
    const roots = Array.isArray(root) ? root : [root];
    if (roots.length > 1) {
        const seen = new Set();
        const all = [];
        for (const r of roots) {
            for (const entry of listSessionDirs(r)) {
                if (seen.has(entry.dir)) continue;
                seen.add(entry.dir);
                all.push(entry);
            }
        }
        return all;
    }
    root = roots[0];
    if (!root || !fs.existsSync(root)) return [];
    const found = [];
    for (const host of fs.readdirSync(root)) {
        const hostDir = path.join(root, host);
        let stamps;
        try {
            if (!fs.statSync(hostDir).isDirectory()) continue;
            stamps = fs.readdirSync(hostDir);
        } catch (e) {
            continue;   // a stray file, or anything else non-traversable
        }
        for (const sessionStamp of stamps) {
            const dir = path.join(hostDir, sessionStamp);
            if (fs.existsSync(path.join(dir, SESSION_FILE))) found.push({ dir, stamp: sessionStamp });
        }
    }
    return found;
}

/**
 * Is a live capture already recording against this profile?
 *
 * The profile, not the port, is the real single-instance resource. Scanning
 * the sessions for a live driver on the same profile names the offender,
 * which "port 9333 is busy" never could -- that port may belong to anything.
 */
async function findProfileConflict(profileDir, root) {
    for (const { dir } of listSessionDirs(root)) {
        const session = readJson(path.join(dir, SESSION_FILE));
        if (!session || session.endedUtc) continue;
        if (session.profileDir !== profileDir) continue;
        if (isDriverAlive(session)) return session;
    }
    return null;
}

// ---------------------------------------------------------------------------
// stop / status
// ---------------------------------------------------------------------------

/**
 * Resolve which capture to act on: an explicit --session, the newest LIVE one,
 * or failing that the newest on disk. The last case is what makes "catalogue
 * that capture" work after a session already ended.
 *
 * THERE IS NO POINTER FILE ANY MORE (#377). `current.json` sat at the captures
 * ROOT and held one `sessionDir`, in a store several agent sessions record into
 * at once -- so a second capture overwrote it and the first recording became
 * unaddressable. It was also unnecessary: this function ALREADY scanned the
 * session directories whenever the pointer went stale, which it did every time
 * a driver was killed before its own cleanup. Removing the pointer makes that
 * existing fallback the only path, and deletes a piece of shared mutable state
 * rather than adding a lock around it.
 *
 * Identity needs no pointer: the STAMP is the identity. Liveness is
 * `session.json` without `endedUtc` plus `isDriverAlive()` -- exactly the test
 * the pointer had to pass before it was trusted at all.
 *
 * With several captures live, `stop` without `--session` takes the newest live
 * one. That is deterministic, and strictly better than the old answer, which
 * was "whichever run wrote the shared file last".
 */
function resolveSession(args) {
    if (args.session) return path.resolve(args.session);
    const roots = args.dir ? [path.resolve(args.dir)] : capturesSearchRoots();
    const candidates = listSessionDirs(roots);
    if (!candidates.length) return null;
    // Sort by STAMP, not by the joined path. The host comes first in the path,
    // so a path sort would answer with the alphabetically-last host rather than
    // the most recent capture.
    candidates.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
    // A LIVE capture outranks a newer dead one. Without this, a session that
    // ended seconds ago would shadow the recording the operator is actually
    // sitting in front of -- which is the one `stop` means.
    const live = candidates.filter(({ dir }) => {
        const session = readJson(path.join(dir, SESSION_FILE));
        return session && !session.endedUtc && isDriverAlive(session);
    });
    const pool = live.length ? live : candidates;
    return pool[pool.length - 1].dir;
}

async function stop(args) {
    const sessionDir = resolveSession(args);
    if (!sessionDir) {
        process.stderr.write('capture-har: no capture session found to stop\n');
        return 3;
    }
    const sessionFile = path.join(sessionDir, SESSION_FILE);
    let session = readJson(sessionFile);
    if (!session) {
        process.stderr.write(`capture-har: ${sessionDir} has no ${SESSION_FILE}\n`);
        return 3;
    }
    const minBytes = numberOr(args['min-bytes'], DEFAULT_MIN_BYTES);

    if (args['validate-only']) {
        process.stdout.write(JSON.stringify({ sessionDir, harPath: session.harPath, minBytes }, null, 2) + '\n');
        return 0;
    }

    // Idempotent: a session that already ended has flushed whatever it had and
    // retired its driver, so there is nothing to signal -- just report.
    let driverLost = false;
    if (!session.endedUtc) {
        // A driver that already died will never answer the sentinel, and
        // waiting the full timeout for it looks identical to a healthy stop
        // that is merely slow. Ask about the driver process, not the debugging
        // port: a crashed driver can leave an orphaned browser answering that
        // port, and believing it would reinstate the silent 60-second hang.
        if (!isDriverAlive(session)) {
            driverLost = true;
            process.stderr.write(
                `capture-har: the recorder for ${sessionDir} is no longer running.\n` +
                '  Assembling the incremental log instead.\n');
        } else {
            fs.writeFileSync(path.join(sessionDir, STOP_SENTINEL), '', 'utf8');
            // Wait for endedUtc, then keep waiting for post-processing --
            // reporting "done" while the scrub is still running would hand the
            // caller a catalogue that does not exist yet.
            const deadline = Date.now() + STOP_TIMEOUT_MS;
            while (Date.now() < deadline) {
                const updated = readJson(sessionFile);
                if (updated && updated.endedUtc) { session = updated; break; }
                await sleep(POLL_MS);
            }
        }
    }

    let summary = summarize(session.harPath);
    let assembled = false;
    if (!summary.exists) {
        // The driver never got to write one -- assemble the log itself, which
        // is the case where the driver died rather than closed.
        assembled = !!assembleFromLog(session.recordLog, session.harPath);
        summary = summarize(session.harPath);
    }

    if (!summary.exists) {
        process.stderr.write(
            `capture-har: nothing was recorded for ${sessionDir}.\n` +
            '  Neither recorder produced a HAR: the recording was lost entirely.\n');
        return 4;
    }
    if (summary.bytes < minBytes) {
        process.stderr.write(
            `capture-har: ${summary.path} is only ${summary.bytes} bytes ` +
            `(minimum ${minBytes}) -- treat this as a failed capture, not data.\n`);
        return 4;
    }

    // The driver owns post-processing whenever it is alive, so `stop` waits
    // rather than racing it. When the driver is gone, nothing else will ever
    // run those phases, so `stop` runs them itself.
    session = readJson(sessionFile) || session;
    if (!session.postProcess && !session.cancelled) {
        // Wait only while something is actually going to do the work. A driver
        // that is gone will never write postProcess, so waiting the full
        // timeout for it is a minute of silence followed by the same answer --
        // run the phases here instead. `driverLost` alone is not the test: a
        // driver that died AFTER writing endedUtc never sets it.
        if (driverLost || !isDriverAlive(session)) {
            session.postProcess = postProcess(session);
            writeJson(sessionFile, session);
        } else {
            const deadline = Date.now() + STOP_TIMEOUT_MS;
            while (Date.now() < deadline) {
                const updated = readJson(sessionFile);
                if (updated && updated.postProcess) { session = updated; break; }
                await sleep(POLL_MS);
            }
        }
    }

    log.info(`capture-har: ${describeSummary(summary)}`);
    if (session.postProcess) {
        reportPostProcess(session);
    } else if (session.cancelled) {
        log.info(`  raw kept, not post-processed: ${session.harPath}`);
    } else {
        log.warn(
            `  raw:       ${session.harPath}\n` +
            '  post-processing is still running in the recording process --\n' +
            '  the scrubbed artifacts and the catalogue are not ready yet.');
        return 6;
    }

    return postProcessExitCode(session.postProcess, assembled || session.assembledFromLog);
}

// ---------------------------------------------------------------------------
// catalogue -- the pipeline's second door
// ---------------------------------------------------------------------------

/**
 * What the `catalogue` command was pointed at, and where its output goes.
 *
 * Three shapes, because an operator re-entering the pipeline has three things
 * to hand and none of them is reliably the same one:
 *
 *   a FILE            the scrubbed HAR itself. Output lands beside it.
 *   a SESSION dir     one holding session.json. Its own outputPath is used,
 *                     and its uri/describe/startedUtc are carried through --
 *                     the provenance a re-catalogue would otherwise lose.
 *   any other dir     an output path that already holds a scrubbed.har.
 *
 * With none of them, `resolveSession` answers -- the same resolution `stop`
 * and `status` use, whose whole point is that it still works after a session
 * has ended.
 */
function resolveCatalogueTarget(args) {
    const given = args._ && args._.length ? path.resolve(args._[0]) : null;
    if (given && !fs.existsSync(given)) {
        return { error: `${given} does not exist`, code: 3 };
    }
    if (given && fs.statSync(given).isFile()) {
        return catalogueTarget(given, args, null);
    }
    const dir = given || resolveSession(args);
    if (!dir) return { error: 'no capture session found to catalogue', code: 3 };
    const session = readJson(path.join(dir, SESSION_FILE));
    const outputPath = args['output-path']
        ? path.resolve(args['output-path'])
        : (session && session.outputPath) || dir;
    return catalogueTarget(path.join(outputPath, SCRUBBED_HAR), args, session);
}

function catalogueTarget(scrubbedPath, args, session) {
    const outputPath = args['output-path']
        ? path.resolve(args['output-path'])
        : path.dirname(scrubbedPath);
    if (!fs.existsSync(scrubbedPath)) {
        // Said, not guessed at. The likeliest reason a session has no scrubbed
        // HAR in its output path is that the gate refused the scrub and #343
        // quarantined it -- in which case the file to look at is the rejected
        // one, and re-cataloguing is not what the operator needs next.
        const rejected = session && session.sessionDir
            && path.join(session.sessionDir, REJECTED_HAR);
        return {
            code: 3,
            error: rejected && fs.existsSync(rejected)
                ? `${scrubbedPath} does not exist -- this capture's scrub was REJECTED by the ` +
                  `leak gate and quarantined at ${rejected}. There is nothing verified to ` +
                  'catalogue: triage the findings, re-scrub, and catalogue then.'
                : `${scrubbedPath} does not exist -- nothing to catalogue.`
        };
    }
    // Provenance the digest would otherwise lose on a second pass. The
    // previous digest is the fallback because capturedUtc means WHEN THE
    // RECORDING HAPPENED: re-cataloguing must not re-date a capture to the day
    // somebody regenerated its catalogue.
    const previous = readJson(path.join(outputPath, DIGEST_FILE)) || {};
    return {
        scrubbedPath,
        outputPath,
        session: {
            uri: (session && session.uri) || previous.uri || null,
            describe: (session && session.describe) || previous.describe || null,
            startedUtc: (session && session.startedUtc) || previous.capturedUtc || null,
            harPath: (session && session.harPath) || null,
            sessionDir: (session && session.sessionDir) || null,
            outputPath
        }
    };
}

/**
 * How many rows in the catalogue at `p` carry a description.
 *
 * The discriminator between "a scaffold nobody has worked on" and "a catalogue
 * with something in it to lose". Keyed on Description and not on Status, and
 * for the reason Invoke-HarCapture.ps1 already gives: a real AI pass may
 * legitimately conclude that every group was Observed and none Exercised, so
 * Status cannot tell the two apart. Describing an action is the one thing the
 * AI does that the scaffold never can.
 *
 * A file that is not a catalogue at all counts as no work -- the refusal below
 * exists to protect somebody's segmentation, not to bounce off anything that
 * occupies the name.
 */
function describedRowCount(p) {
    const rows = readJson(p);
    if (!Array.isArray(rows)) return 0;
    return rows.filter((r) => r && typeof r === 'object' && r.Description).length;
}

/**
 * Catalogue a capture that was recorded and scrubbed some other time.
 *
 * This is an ENTRY POINT to the phases postProcess already runs, and nothing
 * more. It re-decides nothing: the gate verdict comes from `askTheGate`, the
 * digest and the delegation from `catalogueScrubbed`, and the exit code from
 * `postProcessExitCode` -- the same three functions a full capture goes
 * through, so an advisory verdict still exits 7 here and a refusal still
 * exits 6.
 *
 * It asks the gate again rather than trusting the file's location, because
 * "the digest and catalogue derive from a capture that PASSED the gate" is a
 * property of the pipeline and not of the capture path. The new door makes it
 * possible for the first time to point the catalogue phase at a HAR nobody
 * scrubbed, so the door has to hold the property itself.
 *
 * It never publishes and never quarantines. A scrub is judged and promoted by
 * the scrub stage; re-implementing that here would put a second copy of #343's
 * invariants behind a second door.
 */
function catalogueCommand(args) {
    const target = resolveCatalogueTarget(args);
    if (target.error) {
        process.stderr.write(`capture-har: ${target.error}\n`);
        return target.code || 2;
    }

    // WHAT HAPPENS WHEN THE CATALOGUE STAGE RUNS TWICE: it refuses, when there
    // is work in the catalogue to lose.
    //
    // The segmentation is an AI reading catalogue-prompt.md, so two runs over
    // the same digest can legitimately disagree -- this is not a deterministic
    // recomputation, and `catalogue.json` is a fixed name. Silently replacing a
    // catalogue a human reviewed (or corrected by hand) with a fresh,
    // differently-grouped one is the more expensive of the two mistakes, and it
    // is invisible after the fact.
    //
    // But refusing on EXISTENCE alone would block the case this command exists
    // for. The advisory loop is: capture, waive a false positive, catalogue
    // again -- and by then a scaffold is already sitting there. So the test is
    // whether the catalogue carries WORK, using the same discriminator
    // Invoke-HarCapture.ps1 already uses to tell a finished catalogue from a
    // provisional one: a Description is the one thing the AI writes that the
    // scaffold never can. A scaffold is regenerated without comment; anything
    // described is left exactly as it is.
    //
    // Deliberately NOT behind an override option. An option would let a caller
    // ASK for the destructive branch, which is precisely the request that
    // should cost a moment's thought; moving the file you want replaced is an
    // unambiguous statement of the same intent, and is already possible.
    const cataloguePath = path.join(target.outputPath, CATALOGUE_FILE);
    const described = describedRowCount(cataloguePath);
    if (described) {
        process.stderr.write(
            `capture-har: ${cataloguePath} already carries ${described} described ` +
            'action(s), so nothing was written.\n' +
            '  Cataloguing is an AI pass, not a recomputation: a second run over the same\n' +
            '  digest may group the session differently, and replacing a catalogue somebody\n' +
            '  reviewed or corrected would discard that silently.\n' +
            '  To catalogue afresh, move the existing file aside (or catalogue into another\n' +
            '  --output-path) and run this again.\n');
        return 2;
    }

    const state = { startedUtc: new Date().toISOString(), errors: [], warnings: [] };
    const verdict = askTheGate(target.scrubbedPath, state);
    if (verdict.verified || verdict.advisory) {
        const findings = path.join(target.outputPath, FINDINGS_FILE);
        if (isFindingsReport(findings)) state.scrubbed.findings = findings;
        fs.mkdirSync(target.outputPath, { recursive: true });
        catalogueScrubbed(target.session, state);
    } else {
        // No path is claimed, because claiming one would make the summary read
        // as though a verified artifact is sitting there.
        state.scrubbed = { path: null, verified: false, advisory: false };
        state.errors.push(
            `capture-har: ${target.scrubbedPath} did not pass the leak gate, so no digest and ` +
            'no catalogue were derived from it. Nothing was written. Re-scrub it, or waive ' +
            'the findings, and catalogue again.');
    }
    state.completedUtc = new Date().toISOString();

    // The shared placement guard, not a second opinion about where output may
    // land: this command writes into the same committable directory a capture
    // does, so it owes the same notice.
    const placement = repoGuard.inspectCheckout(process.cwd());
    log.lines(postProcessLines(Object.assign({}, target.session, {
        placement: placement.shouldWarn ? placement : null,
        postProcess: state
    })));
    return postProcessExitCode(state, false);
}

function status(args) {
    const roots = args.dir ? [path.resolve(args.dir)] : capturesSearchRoots();
    const sessionDir = resolveSession(args);
    if (!sessionDir) {
        log.info(`capture-har: no captures under ${roots.join(' or ')}`);
        return 0;
    }
    const session = readJson(path.join(sessionDir, SESSION_FILE)) || {};
    process.stdout.write(JSON.stringify({
        sessionDir,
        uri: session.uri,
        mode: session.mode,
        cdpEndpoint: session.cdpEndpoint,
        outputPath: session.outputPath,
        // A crashed driver never writes endedUtc, so its absence does not mean
        // "still recording" -- only a live driver does. Reporting a dead
        // session as recording sends the operator to wait for a HAR that
        // nothing will ever write.
        recording: !session.endedUtc && isDriverAlive(session),
        endedBy: session.endedBy,
        driverLost: !session.endedUtc && !isDriverAlive(session),
        postProcess: session.postProcess || null,
        summary: session.summary || summarize(session.harPath)
    }, null, 2) + '\n');
    return 0;
}

async function main() {
    const argv = process.argv.slice(2);
    const command = argv[0];
    const args = parseArgs(argv.slice(1));
    // Applied before anything else runs, and to every command: the level has
    // to be in force before the first message, and `stop` reports the same
    // artifacts `start` does.
    if (args['log-level'] !== undefined) {
        try {
            setLogLevel(args['log-level']);
        } catch (e) {
            return usage(e.message);
        }
    }
    switch (command) {
        case 'start': return await start(args);
        case 'stop': return await stop(args);
        case 'status': return status(args);
        case 'catalogue': return catalogueCommand(args);
        default: return usage(command ? `unknown command '${command}'` : 'a command is required');
    }
}

module.exports = {
    START_OPTIONS,
    LOG_LEVELS,
    setLogLevel,
    renderLines,
    startBannerLines,
    postProcessLines,
    buildEntry,
    assembleFromLog,
    resolveSessionPaths,
    uriFolder,
    resolveSession,
    findProfileConflict,
    findFreePort,
    discoverStorageState,
    pathTemplate,
    buildDigest,
    buildCatalogueScaffold,
    decideCatalogueRunner,
    postProcess,
    catalogueCommand,
    postProcessExitCode,
    publishFile,
    sweepAbandonedTemps,
    PUBLISH_TEMP_PREFIX,
    PUBLISH_RENAME_ATTEMPTS,
    findingSummaryLines,
    catalogueTableLines,
    isScaffoldOnly,
    referenceNoticeLines,
    describeReference,
    referenceFileName,
    referenceRelativePath,
    deriveActionSlug,
    providerSlug,
    outputDestinationWarning,
    ensureCapturesRootIgnored,
    capturesRootProbe,
    CAPTURE_GITIGNORE_ENTRIES,
    REFERENCE_DIR,
    runNode,
    IncrementalRecorder
};

// Only run as a command when invoked as one: requiring this module from a test
// must not launch a capture or print a usage error.
if (require.main === module) {
    main().then((code) => process.exit(code)).catch((err) => {
        process.stderr.write('capture-har: ' + (err && err.stack ? err.stack : err) + '\n');
        process.exit(1);
    });
}
