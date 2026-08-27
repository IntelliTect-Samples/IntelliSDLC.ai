#!/usr/bin/env node
/**
 * capture-har.js -- record a whole browser session to a raw HAR.
 *
 * This is the front half of the capture workflow: everything downstream
 * (extract-har-reference.js, verify-har-reference.js, the catalogue) needs a
 * raw capture to exist, and until now nothing produced one. The operator's
 * entire surface is a URL:
 *
 *   Start-HarRecording https://example.com
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
 * ## Why there are two artifacts
 *
 * Playwright's recordHar buffers the entire session in the driver and
 * serializes it once, during a client-initiated context.close(). That has a
 * sharp edge, measured rather than assumed: when the operator closes the
 * BROWSER WINDOW, Chrome exits, the connection drops before any close call
 * can run, and **nothing is written at all** -- the whole recording is lost
 * silently.
 *
 * So a second, independent recorder runs alongside it. Every finished request
 * is appended to a line-delimited snapshot every few seconds. It costs only
 * the entries just recorded, never a rewrite of the whole document, which is
 * what makes a short interval affordable on a capture that runs to hundreds
 * of megabytes.
 *
 *   clean stop   -> raw.har           Playwright's, authoritative
 *   lost driver  -> raw.snapshot.har  ours, everything up to the last flush
 *
 * The snapshot is a RECOVERY artifact and says so: it is assembled from what
 * the browser reported at the time, and response bodies are captured
 * best-effort and capped. Prefer the real HAR whenever one exists; the
 * snapshot exists so that an unexpected ending costs minutes, not a session.
 *
 * Other behaviours pinned to a defect that has cost real diagnosis time:
 *
 *  - Nothing is ever killed. Not the browser, not the driver: a developer's
 *    machine may hold real signed-in windows, and killing a browser destroys
 *    unrelated work. `stop` asks the context to close and waits.
 *  - Ctrl+C is TRAPPED rather than forbidden -- it performs the same clean
 *    stop as ENTER, because the reflex gesture should do the right thing
 *    instead of costing a capture.
 *  - The capture is UNFILTERED. No HAR glob is applied, ever. Media and
 *    upload protocols routinely run over hosts you did not predict, and a
 *    premature filter silently discards exactly what you were hunting.
 *  - A capture that produced nothing, or something trivially small, is
 *    reported as a FAILURE rather than handed back as data.
 *
 * Usage:
 *   node capture-har.js start --uri <url> [--profile <name|path>] [--isolated]
 *                             [--storage-state <p>] [--port <n>]
 *                             [--dir <captures-dir>]
 *                             [--snapshot-seconds <n>] [--no-wait]
 *   node capture-har.js stop  [--session <dir>] [--min-bytes <n>]
 *   node capture-har.js status
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
 *   --no-wait        do not read ENTER from stdin (for non-interactive use;
 *                    the session then ends via `stop`, SIGINT, or the window).
 *   --validate-only  resolve and print paths without launching a browser.
 *
 * Exit codes:
 *   0 -- recording started, or stopped with a HAR written
 *   1 -- I/O or runtime error
 *   2 -- usage error
 *   3 -- no capture session found to stop
 *   4 -- the capture produced no usable recording
 *   5 -- the driver was lost; only the recovery snapshot survives
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const DEFAULT_PORT = 9333;
const DEFAULT_MIN_BYTES = 1024;
const DEFAULT_CAPTURES_DIR = '.har-captures';
const DEFAULT_SNAPSHOT_SECONDS = 5;
const MAX_SNAPSHOT_BODY_BYTES = 262144;
const STOP_SENTINEL = 'STOP';
const SESSION_FILE = 'session.json';
const CURRENT_FILE = 'current.json';
const RAW_HAR = 'raw.har';
const SNAPSHOT_LOG = 'raw.snapshot.ndjson';
const SNAPSHOT_HAR = 'raw.snapshot.har';
const POLL_MS = 200;
const STOP_TIMEOUT_MS = 60000;
const LAUNCH_TIMEOUT_MS = 45000;
const CDP_PROBE_MS = 1500;

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
 * Ask a debugging port whether a browser is already there. Used to turn the
 * profile-already-in-use case into an immediate, actionable message instead
 * of a three-minute hang.
 *
 * Deliberately NOT a liveness check for a session: a port answers for any
 * browser that holds it, including one orphaned by a crashed driver. Use
 * isDriverAlive() for "is this recording still running".
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
        'usage: node capture-har.js start --uri <url> [--isolated] [--storage-state <p>] [--port <n>]\n' +
        '       node capture-har.js stop [--session <dir>] [--min-bytes <n>]\n' +
        '       node capture-har.js status\n');
    return 2;
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
// Snapshot recorder
// ---------------------------------------------------------------------------

function toHeaderArray(headers) {
    return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * Append-only recorder. Entries are buffered and flushed on an interval;
 * a flush writes ONLY what arrived since the last one, so the cost of a short
 * interval does not grow with the size of the capture.
 */
class SnapshotRecorder {
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
            // A failed snapshot flush must never take the recording down with
            // it -- the live capture is the more valuable of the two.
            process.stderr.write(`capture-har: snapshot flush failed: ${e.message}\n`);
        }
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.flush();
    }
}

/**
 * Attach the snapshot recorder to a context. Response bodies are captured
 * best-effort and capped: a body that cannot be read (a redirect, a streamed
 * response, one already discarded) must not cost the entry itself.
 */
function attachSnapshot(context, recorder) {
    context.on('response', async (response) => {
      // The whole handler is guarded, not just the two calls known to be
      // fragile: an unhandled rejection here would crash the driver mid-
      // capture, which is the exact loss this recorder exists to prevent.
      try {
        const request = response.request();
        const entry = {
            startedDateTime: new Date().toISOString(),
            time: 0,
            request: {
                method: request.method(),
                url: request.url(),
                httpVersion: 'HTTP/1.1',
                headers: toHeaderArray(await request.allHeaders().catch(() => ({}))),
                queryString: [],
                cookies: [],
                headersSize: -1,
                bodySize: -1
            },
            response: {
                status: response.status(),
                statusText: response.statusText(),
                httpVersion: 'HTTP/1.1',
                headers: toHeaderArray(await response.allHeaders().catch(() => ({}))),
                cookies: [],
                content: { size: -1, mimeType: '', text: undefined },
                redirectURL: '',
                headersSize: -1,
                bodySize: -1
            },
            cache: {},
            timings: { send: -1, wait: -1, receive: -1 },
            _snapshot: true
        };

        const postData = request.postData();
        if (postData !== null && postData !== undefined) {
            entry.request.postData = { mimeType: '', text: postData, params: [] };
        }

        try {
            const body = await response.body();
            if (body && body.length <= MAX_SNAPSHOT_BODY_BYTES) {
                entry.response.content.text = body.toString('utf8');
                entry.response.content.size = body.length;
            } else if (body) {
                entry.response.content.size = body.length;
                entry.response.content.comment = 'body omitted from snapshot (over cap)';
            }
        } catch (e) {
            entry.response.content.comment = 'body unavailable in snapshot';
        }

        recorder.add(entry);
      } catch (e) {
        // Losing one entry from a best-effort recovery artifact is a rounding
        // error; losing the capture is not.
        process.stderr.write(`capture-har: snapshot entry skipped: ${e.message}\n`);
      }
    });
}

/**
 * Assemble the append-only log into a valid HAR. A truncated final line is
 * expected after an abrupt ending and is dropped rather than failing the
 * recovery -- salvaging the rest is the entire point of the artifact.
 */
function assembleSnapshot(logPath, outPath) {
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
            creator: { name: 'capture-har.js (recovery snapshot)', version: '1.0' },
            comment: 'RECOVERY ARTIFACT -- assembled from an incremental snapshot after the ' +
                'recording ended unexpectedly. Response bodies are best-effort and capped; ' +
                'timings are not recorded. Prefer a clean re-capture when one is affordable.' +
                (dropped ? ` ${dropped} truncated entr${dropped === 1 ? 'y was' : 'ies were'} dropped.` : ''),
            pages: [],
            entries
        }
    };
    writeJson(outPath, har);
    return { entries: entries.length, dropped };
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

function describe(summary) {
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

async function start(args) {
    if (!args.uri) return usage('start requires --uri');
    const capturesDir = path.resolve(args.dir || DEFAULT_CAPTURES_DIR);
    const sessionDir = path.join(capturesDir, stamp(new Date()));
    const harPath = path.join(sessionDir, RAW_HAR);
    const snapshotLog = path.join(sessionDir, SNAPSHOT_LOG);
    // `|| DEFAULT` would swallow a deliberate 0. Port 0 stays unsupported --
    // Chrome would pick a random one and the endpoint printed for an agent to
    // attach to would be a lie -- but a 0-second snapshot interval means
    // "flush as fast as the timer allows" and must be honoured.
    const port = Number(args.port) || DEFAULT_PORT;
    const snapshotSeconds = numberOr(args['snapshot-seconds'], DEFAULT_SNAPSHOT_SECONDS);
    const snapshotMs = snapshotSeconds * 1000;
    const isolated = !!args.isolated;
    const profileDir = isolated
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'har-capture-'))
        : resolveProfileDir(args.profile);
    const externalProfile = !isolated && !profileDir.startsWith(captureProfileRoot());

    if (args['storage-state'] && !fs.existsSync(args['storage-state'])) {
        process.stderr.write(`capture-har: --storage-state file not found: ${args['storage-state']}\n`);
        return 1;
    }

    const session = {
        uri: args.uri,
        sessionDir,
        harPath,
        snapshotLog,
        snapshotHarPath: path.join(sessionDir, SNAPSHOT_HAR),
        profileDir,
        mode: isolated ? 'isolated-chromium' : 'chrome-profile',
        cdpEndpoint: `http://localhost:${port}`,
        port,
        snapshotSeconds: snapshotMs / 1000
    };

    if (args['validate-only']) {
        // stdout stays pure JSON so a caller can parse it; the human note goes
        // to stderr rather than corrupting that.
        process.stdout.write(JSON.stringify(session, null, 2) + '\n');
        process.stderr.write('capture-har: --validate-only OK (no browser launched)\n');
        return 0;
    }

    // A persistent profile is single-instance: a second launch against a
    // profile Chrome already holds does not fail, it HANGS until Playwright's
    // 180s timeout. Probing the debugging port names the culprit immediately,
    // and the answer is never to kill the other browser -- it may be a live
    // capture, or a window holding a signed-in session.
    const inUse = await probeCdp(port);
    if (inUse) {
        process.stderr.write(
            `capture-har: a browser is already listening on port ${port}` +
            (inUse.Browser ? ` (${inUse.Browser})` : '') + '.\n' +
            '  That is almost certainly a capture still running. End it first:\n' +
            '    node capture-har.js status      # what it is recording\n' +
            '    node capture-har.js stop        # end it and write its HAR\n' +
            '  Or record alongside it with --port <other> --isolated.\n');
        return 1;
    }

    fs.mkdirSync(sessionDir, { recursive: true });
    const playwright = requirePlaywright();

    const options = {
        headless: false,
        timeout: LAUNCH_TIMEOUT_MS,
        recordHar: { path: harPath, mode: 'full', content: 'embed' },
        args: [`--remote-debugging-port=${port}`]
    };
    // Bundled Chromium can silently close against a Chrome-created profile,
    // so the default path pins the system Chrome channel.
    if (!isolated) options.channel = 'chrome';
    if (args['storage-state']) options.storageState = args['storage-state'];

    let context;
    try {
        context = await playwright.chromium.launchPersistentContext(profileDir, options);
    } catch (e) {
        // The profile can also be held by a browser that is NOT exposing a
        // debugging port, which the probe above cannot see. Launch then stalls
        // rather than erroring, so a timeout here means "in use" far more often
        // than it means "broken".
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

    const recorder = new SnapshotRecorder(snapshotLog, snapshotMs);
    attachSnapshot(context, recorder);
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
    writeJson(path.join(sessionDir, SESSION_FILE), session);
    writeJson(path.join(capturesDir, CURRENT_FILE), { sessionDir });

    const page = context.pages()[0] || await context.newPage();
    await page.goto(args.uri, { waitUntil: 'domcontentloaded' }).catch((e) => {
        process.stdout.write(`capture-har: initial navigation failed (${e.message}); recording anyway\n`);
    });

    process.stdout.write(
        `\ncapture-har: recording ${args.uri}\n` +
        (externalProfile
            ? `  profile:  ${profileDir}\n` +
              '            (not a capture profile -- whatever tool owns it cannot\n' +
              '             use it until this recording ends)\n'
            : '') +
        `  har:      ${harPath}\n` +
        `  cdp:      ${session.cdpEndpoint}\n` +
        `  snapshot: every ${snapshotMs / 1000}s, so an unexpected ending costs minutes, not the session\n` +
        '\n  Browse. Then press ENTER here to end the recording and write the HAR.\n' +
        '  (Ctrl+C does the same. Closing the browser window instead falls back\n' +
        '   to the recovery snapshot -- it cannot write the real HAR.)\n\n');

    // Whichever ending arrives first wins. All of them route through the same
    // clean close, because that close is what serializes the HAR. (The
    // window-closed ending is already armed, above.)
    const sentinel = path.join(sessionDir, STOP_SENTINEL);
    const endings = [];
    endings.push((async () => {
        while (!reason && !fs.existsSync(sentinel)) await sleep(POLL_MS);
        settle('stop-command');
    })());

    let rl = null;
    if (!args['no-wait'] && process.stdin.isTTY) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        endings.push(new Promise((resolve) => rl.once('line', () => { settle('enter'); resolve(); })));
    }
    endings.push(new Promise((resolve) => {
        process.once('SIGINT', () => { settle('ctrl-c'); resolve(); });
    }));

    await Promise.race(endings);
    if (rl) rl.close();
    recorder.stop();

    if (reason !== 'window-closed') {
        await context.close().catch((e) => {
            process.stderr.write(`capture-har: closing the context failed: ${e.message}\n`);
        });
    }

    // Playwright writes the HAR during close; give a slow flush a moment
    // before judging the capture missing.
    for (let i = 0; i < 25 && !fs.existsSync(harPath); i++) await sleep(POLL_MS);

    let summary = summarize(harPath);
    let recovered = null;
    if (!summary.exists) {
        recovered = assembleSnapshot(snapshotLog, session.snapshotHarPath);
        summary = summarize(session.snapshotHarPath);
    } else {
        // The real HAR supersedes the snapshot; keeping both invites someone
        // to analyze the weaker artifact by accident.
        try { fs.unlinkSync(snapshotLog); } catch (e) { /* nothing to remove */ }
    }

    session.endedUtc = new Date().toISOString();
    session.endedBy = reason;
    session.summary = summary;
    session.recoveredFromSnapshot = !!recovered;
    writeJson(path.join(sessionDir, SESSION_FILE), session);
    try { fs.unlinkSync(path.join(capturesDir, CURRENT_FILE)); } catch (e) { /* already gone */ }

    if (recovered) {
        process.stdout.write(
            `\ncapture-har: the browser window was closed, so Playwright never wrote a HAR.\n` +
            `  Recovered ${recovered.entries} entries from the snapshot:\n` +
            `    ${session.snapshotHarPath}\n` +
            '  This is a RECOVERY artifact: bodies are best-effort and timings absent.\n' +
            '  End the next recording with ENTER to get a full HAR.\n');
        return 5;
    }
    process.stdout.write(`\ncapture-har: stopped (${reason}) -- ${describe(summary)}\n`);
    return summary.exists ? 0 : 4;
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
    const capturesDir = path.resolve(args.dir || DEFAULT_CAPTURES_DIR);
    const current = readJson(path.join(capturesDir, CURRENT_FILE));
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
    if (!fs.existsSync(capturesDir)) return null;
    const candidates = fs.readdirSync(capturesDir)
        .map((n) => path.join(capturesDir, n))
        .filter((p) => fs.existsSync(path.join(p, SESSION_FILE)))
        .sort();
    return candidates.length ? candidates[candidates.length - 1] : null;
}

async function stop(args) {
    const sessionDir = resolveSession(args);
    if (!sessionDir) {
        process.stderr.write('capture-har: no capture session found to stop\n');
        return 3;
    }
    const sessionFile = path.join(sessionDir, SESSION_FILE);
    const session = readJson(sessionFile);
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
    if (!session.endedUtc) {
        // A driver that already died will never answer the sentinel, and
        // waiting the full timeout for it looks identical to a healthy stop
        // that is merely slow. Ask about the driver process, not the debugging
        // port: a crashed driver can leave an orphaned browser answering that
        // port, and believing it would reinstate the silent 60-second hang.
        if (!isDriverAlive(session)) {
            process.stderr.write(
                `capture-har: the recorder for ${sessionDir} is no longer running.\n` +
                '  Nothing can write the real HAR now; recovering the snapshot instead.\n');
        } else {
            fs.writeFileSync(path.join(sessionDir, STOP_SENTINEL), '', 'utf8');
            const deadline = Date.now() + STOP_TIMEOUT_MS;
            while (Date.now() < deadline) {
                const updated = readJson(sessionFile);
                if (updated && updated.endedUtc) break;
                await sleep(POLL_MS);
            }
        }
    }

    let summary = summarize(session.harPath);
    let recovered = false;
    if (!summary.exists) {
        // The driver never got to write one -- salvage the snapshot itself,
        // which is the case where the driver died rather than closed.
        assembleSnapshot(session.snapshotLog, session.snapshotHarPath);
        summary = summarize(session.snapshotHarPath);
        recovered = summary.exists;
    }

    if (!summary.exists) {
        process.stderr.write(
            `capture-har: nothing was recorded for ${sessionDir}.\n` +
            '  No HAR and no snapshot: the recording was lost entirely.\n' +
            '  Re-record, and end the capture with ENTER (or Stop-HarRecording).\n');
        return 4;
    }
    if (summary.bytes < minBytes) {
        process.stderr.write(
            `capture-har: ${summary.path} is only ${summary.bytes} bytes ` +
            `(minimum ${minBytes}) -- treat this as a failed capture, not data.\n`);
        return 4;
    }

    process.stdout.write(
        `capture-har: ${describe(summary)}\n` +
        `  raw: ${summary.path}  (unscrubbed -- never commit it)\n` +
        (recovered ? '  NOTE: recovery snapshot, not a full HAR -- bodies best-effort, timings absent.\n' : '') +
        '  next: ask Claude to catalogue this capture, or run\n' +
        `        node extract-har-reference.js --in "${summary.path}" --match <pattern>\n`);
    return recovered ? 5 : 0;
}

function status(args) {
    const capturesDir = path.resolve(args.dir || DEFAULT_CAPTURES_DIR);
    const sessionDir = resolveSession(args);
    if (!sessionDir) {
        process.stdout.write(`capture-har: no captures under ${capturesDir}\n`);
        return 0;
    }
    const session = readJson(path.join(sessionDir, SESSION_FILE)) || {};
    process.stdout.write(JSON.stringify({
        sessionDir,
        uri: session.uri,
        mode: session.mode,
        cdpEndpoint: session.cdpEndpoint,
        // A crashed driver never writes endedUtc, so its absence does not mean
        // "still recording" -- only a live driver does. Reporting a dead
        // session as recording sends the operator to wait for a HAR that
        // nothing will ever write.
        recording: !session.endedUtc && isDriverAlive(session),
        endedBy: session.endedBy,
        driverLost: !session.endedUtc && !isDriverAlive(session),
        summary: session.summary || summarize(session.harPath)
    }, null, 2) + '\n');
    return 0;
}

async function main() {
    const argv = process.argv.slice(2);
    const command = argv[0];
    const args = parseArgs(argv.slice(1));
    switch (command) {
        case 'start': return await start(args);
        case 'stop': return await stop(args);
        case 'status': return status(args);
        default: return usage(command ? `unknown command '${command}'` : 'a command is required');
    }
}

main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write('capture-har: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
});
