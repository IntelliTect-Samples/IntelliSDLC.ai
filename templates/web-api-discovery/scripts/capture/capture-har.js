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
 * gitignored `.har-captures/` and no option can redirect it. `--output-path`
 * receives only what has already been scrubbed and verified, so the guard is
 * structural rather than a check somebody has to remember to run. The scrub
 * therefore writes its candidate into the session directory and it is COPIED
 * out only once the gate has passed on it: a file the gate has not judged
 * never exists in a committable directory, and a scrub the gate refuses is
 * renamed to `scrubbed.rejected.har` where it stands, never deleted. One false
 * positive used to destroy the whole capture (#297).
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
 *   node capture-har.js start --uri <url> [--profile <name|path>] [--isolated]
 *                             [--port <n>] [--output-path <dir>]
 *                             [--describe <text>]
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
 *   --describe       an intent hint that helps an AI segment the session. It
 *                    is never the source of action names -- those come from
 *                    the traffic.
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
const repoGuard = require(path.join(__dirname, '..', 'lib', 'repo-workflow-guard.js'));

const DEFAULT_PORT = 9333;
const DEFAULT_MIN_BYTES = 1024;
const CAPTURES_DIR = '.har-captures';
const DEFAULT_SNAPSHOT_SECONDS = 5;
const STORAGE_STATE_FILENAME = '.har-storage-state.json';
const CATALOGUE_PROMPT = 'catalogue-prompt.md';
const STOP_SENTINEL = 'STOP';
const SESSION_FILE = 'session.json';
const CURRENT_FILE = 'current.json';
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
        'usage: node capture-har.js start --uri <url> [--isolated] [--port <n>]\n' +
        '                                 [--output-path <dir>] [--describe <text>]\n' +
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
 * It is resolved against the working directory rather than being absolute, so
 * a capture lands beside the project it belongs to -- and so a test harness
 * can contain one by choosing where it runs, without an override that would
 * reopen the redirect for everyone else.
 */
function capturesRoot() {
    return path.resolve(CAPTURES_DIR);
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
 * WHERE THE DEFAULT OUTPUT LANDS (#300). It used to be the working directory,
 * unconditionally. That is right outside a repository and wrong inside one:
 * run from a checkout's subdirectory, artifacts appeared wherever the operator
 * happened to be standing, which in the reported incident was a project's root
 * checkout on the protected branch. Inside a repo the default now anchors to
 * the repo root, which is where artifact locations are standardized; outside
 * one nothing changes.
 *
 * Anchoring is scoped to the DEFAULT. An explicit `outputPath` still resolves
 * against the working directory, because a relative path the operator typed has
 * to mean what they typed.
 */
function resolveSessionPaths(opts = {}) {
    const root = opts.capturesRoot ? path.resolve(opts.capturesRoot) : capturesRoot();
    const folder = uriFolder(opts.uri);
    const sessionDir = path.join(root, folder, opts.stamp || stamp(new Date()));
    const cwd = opts.cwd || process.cwd();
    const outputRoot = opts.outputPath
        ? path.resolve(cwd, opts.outputPath)
        : repoGuard.resolveDefaultOutputRoot(cwd);
    return {
        capturesRoot: root,
        uriFolder: folder,
        sessionDir,
        harPath: path.join(sessionDir, RAW_HAR),
        recordLog: path.join(sessionDir, RECORD_LOG),
        outputPath: path.join(outputRoot, folder)
    };
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
function pathTemplate(pathname) {
    return pathname.split('/').map((segment) => {
        if (!segment) return segment;
        if (/^\d+$/.test(segment)) return '{id}';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return '{uuid}';
        if (/^[0-9a-f]{16,}$/i.test(segment)) return '{hash}';
        // Mixed alphanumeric with enough digits to be an id rather than a word.
        if (segment.length >= 8 && /\d/.test(segment) && /^[A-Za-z0-9_-]+$/.test(segment)
            && (segment.replace(/\D/g, '').length / segment.length) > 0.3) return '{id}';
        return segment;
    }).join('/');
}

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
        const key = `${url.host}|${entry.request.method}|${template}|${status}`;

        let group = groups.get(key);
        if (!group) {
            group = {
                host: url.host,
                method: entry.request.method,
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
        Methods: [group.method],
        Endpoints: [`${group.host}${group.pathTemplate}`],
        EntryCount: group.count,
        Status: 'Observed',
        HarFile: null,
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
            writeJson(cataloguePath, buildCatalogueScaffold(digest));
        }
        state.catalogue = Object.assign(
            { path: cataloguePath, actions: [], files: [] },
            runCatalogue(session, digestPath, cataloguePath, state));
    } catch (e) {
        state.errors.push(`digest: ${e.message}`);
    }
    return state;
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
 * Nothing under `.har-captures/` is ever deleted or overwritten, and a second
 * rejection in a session that already holds one is exactly where a careless
 * implementation would overwrite the first -- which is the evidence the
 * operator is still triaging.
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
    }
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

async function askLine(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
        describe: args.describe || null,
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

    // A busy port is no longer a conflict -- we moved. A persistent profile
    // genuinely is single-instance, though, and that stays a hard error naming
    // what holds it.
    const conflict = await findProfileConflict(profileDir, paths.capturesRoot);
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
    writeJson(path.join(paths.capturesRoot, CURRENT_FILE), { sessionDir: paths.sessionDir });

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
    try { fs.unlinkSync(path.join(paths.capturesRoot, CURRENT_FILE)); } catch (e) { /* already gone */ }

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
 */
function listSessionDirs(root) {
    if (!fs.existsSync(root)) return [];
    const found = [];
    for (const host of fs.readdirSync(root)) {
        const hostDir = path.join(root, host);
        let stamps;
        try {
            if (!fs.statSync(hostDir).isDirectory()) continue;
            stamps = fs.readdirSync(hostDir);
        } catch (e) {
            continue;   // current.json and anything else non-traversable
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
 * Resolve which capture to act on: an explicit --session, the one a running
 * driver registered, or the newest on disk. The last case is what makes
 * "catalogue that capture" work after a session already ended.
 */
function resolveSession(args) {
    if (args.session) return path.resolve(args.session);
    const root = args.dir ? path.resolve(args.dir) : capturesRoot();
    const current = readJson(path.join(root, CURRENT_FILE));
    if (current && current.sessionDir && fs.existsSync(current.sessionDir)) {
        // The pointer is only trustworthy while it names a session that has
        // not ended. A driver killed before its own cleanup leaves the file
        // behind, and following it forever would pin every later status/stop
        // to a dead session while newer captures are ignored.
        // `!endedUtc` alone is NOT enough: a driver killed mid-recording never
        // writes endedUtc either, which is precisely the case that leaves the
        // pointer behind. The pointer is trustworthy only while its driver is
        // still running.
        const pointed = readJson(path.join(current.sessionDir, SESSION_FILE));
        if (pointed && !pointed.endedUtc && isDriverAlive(pointed)) return current.sessionDir;
    }
    const candidates = listSessionDirs(root);
    if (!candidates.length) return null;
    // Sort by STAMP, not by the joined path. The host now comes first in the
    // path, so a path sort would answer with the alphabetically-last host
    // rather than the most recent capture.
    candidates.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
    return candidates[candidates.length - 1].dir;
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
    const root = args.dir ? path.resolve(args.dir) : capturesRoot();
    const sessionDir = resolveSession(args);
    if (!sessionDir) {
        log.info(`capture-har: no captures under ${root}`);
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
