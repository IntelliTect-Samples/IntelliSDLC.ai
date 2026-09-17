#!/usr/bin/env node
'use strict';

/**
 * Where a Node dependency is looked for, and what to say when it is not there
 * (issue #512).
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `require('playwright')` resolves upward from
 * the SCRIPT's own directory. The recorder lives in the upstream checkout, so
 * an operator standing in a fresh folder got a failure whose printed remedy --
 * `npm install playwright`, run where they were standing -- installed into a
 * folder the resolver never looked at. Following the advice changed nothing,
 * twice, which is worse than no advice: it moves the suspicion onto the
 * operator's machine.
 *
 * So resolution asks FOUR places, in an order that puts the operator first:
 *
 *   1. the folder you are in          -- a project with its own copy wins
 *   2. the recorder's own install     -- today's behaviour, so a consumer repo
 *                                        that synced the skill is unchanged
 *   3. this machine's global npm root -- one install per machine is enough
 *   4. NODE_PATH                      -- Node's own pointing mechanism
 *
 * NO NEW OPTION AND NO NEW ENVIRONMENT VARIABLE. Steps 1, 2 and 4 are all
 * mechanisms Node already has and step 4 was already named in the old error
 * text; step 3 is npm's own documented default location. "Point it somewhere"
 * is answered by something the operator may already have set, not by a switch
 * this tool invents.
 *
 * TWO KINDS OF LOCATION, and they are not interchangeable:
 *
 *   UPWARD    a starting directory. Node walks it and every ancestor looking
 *             for `node_modules/<name>`. Locations 1 and 2.
 *   CONTAINER a `node_modules`-shaped directory holding packages by name, with
 *             no walk at all. Locations 3 and 4.
 *
 * Starting an upward walk inside a container would look for
 * `<container>/node_modules/<name>` and never match, which is how a location
 * comes to be listed as "searched" while being incapable of answering.
 */

const fs = require('fs');
const path = require('path');

// Ordered, and the order is the contract. Rendering and resolution both read
// this list rather than repeating the sequence, so there is one place to
// change if a location is ever added.
const CWD = 'cwd';
const TOOL = 'tool';
const GLOBAL = 'global';
const NODE_PATH = 'node-path';

const UPWARD = 'upward';
const CONTAINER = 'container';

const PLAYWRIGHT = 'playwright';

// The command that fetches the browser BINARY, which no `npm install` does.
const BROWSER_INSTALL_COMMAND = 'npx playwright install chromium';

/**
 * Split a NODE_PATH value into its container directories.
 *
 * Empty entries are dropped rather than resolved: a trailing delimiter is
 * ordinary, and `path.resolve('')` would turn it into the working directory --
 * a place NODE_PATH never named, reported to the operator as though it had.
 */
function nodePathEntries(value, delimiter) {
    if (!value) return [];
    return String(value).split(delimiter || path.delimiter)
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => path.resolve(e));
}

/**
 * The ordered locations, each one a place that can be named to a human.
 *
 * A location with no directory is still LISTED, with `dir: null` and a label
 * saying it is unset. Dropping it would hide an option the operator has, and
 * substituting a plausible-looking path for one that was never configured
 * sends them somewhere irrelevant.
 */
function searchLocations(opts) {
    const o = opts || {};
    const cwd = o.cwd ? path.resolve(o.cwd) : null;
    const toolDir = o.toolDir ? path.resolve(o.toolDir) : null;
    const globalRoot = o.globalRoot ? path.resolve(o.globalRoot) : null;
    const nodePaths = nodePathEntries(o.nodePath, o.delimiter);

    const list = [
        {
            key: CWD, kind: UPWARD, dir: cwd,
            label: cwd ? 'the folder you are in' : 'the folder you are in (unknown)'
        },
        {
            key: TOOL, kind: UPWARD, dir: toolDir,
            label: toolDir ? "the recorder's own install" : "the recorder's own install (unknown)"
        },
        {
            key: GLOBAL, kind: CONTAINER, dir: globalRoot,
            label: globalRoot
                ? "this machine's global npm modules"
                : "this machine's global npm modules (location unknown)"
        }
    ];
    if (nodePaths.length === 0) {
        list.push({ key: NODE_PATH, kind: CONTAINER, dir: null, label: 'NODE_PATH (unset)' });
    } else {
        for (const dir of nodePaths) {
            list.push({ key: NODE_PATH, kind: CONTAINER, dir, label: 'NODE_PATH' });
        }
    }
    return list;
}

/**
 * Ask one location, in the way that location is shaped.
 *
 * Both branches go through the real resolver rather than an existence check:
 * a directory named after a package is not a resolvable package, and a probe
 * that stopped at the folder would report success for a half-deleted install
 * and then fail at `require` time with a different message.
 */
function resolveAt(name, location, resolve) {
    if (!location.dir) return { path: null };
    try {
        const request = location.kind === UPWARD
            ? name
            // CONTAINER: the package sits directly inside, addressed by path.
            : path.join(location.dir, name);
        return { path: resolve(request, { paths: [location.dir] }) };
    } catch (e) {
        // "NOT THERE" AND "THERE BUT UNREADABLE" ARE DIFFERENT FACTS.
        //
        // A blanket catch reports a corrupt `package.json`, a permission-denied
        // global install and a broken symlink in the same words as an absent
        // module -- and the remedy printed for an absent module is "go install
        // it", which for a permissions problem installs a second copy somewhere
        // else and still does not work. That is the same shape of unusable
        // advice this whole issue exists to remove.
        //
        // MODULE_NOT_FOUND stays silent, because that is the ordinary answer.
        // Anything else is carried up and said.
        if (e && e.code === 'MODULE_NOT_FOUND') return { path: null };
        return { path: null, problem: (e && (e.code || e.message)) || String(e) };
    }
}

/**
 * Find `name`, and report everything that was asked on the way.
 *
 * The search STOPS at the first answer, and `searched` records that: every
 * location before the winner is marked not-found, the winner is marked found,
 * and locations after it are listed unasked (also not-found). An operator
 * reading the report can see which copy is in play, which is the question the
 * old failure could not answer at all.
 */
function resolveDependency(name, opts) {
    const o = opts || {};
    const resolve = o.resolve || require.resolve;
    const searched = searchLocations(o).map((l) => Object.assign({ found: false }, l));

    for (const location of searched) {
        const attempt = resolveAt(name, location, resolve);
        if (attempt.problem) { location.problem = attempt.problem; }
        if (attempt.path) {
            location.found = true;
            return { found: true, path: attempt.path, location: location.key, searched };
        }
    }
    return { found: false, path: null, location: null, searched };
}

// A command this module is willing to build a Windows command line out of.
// Deliberately narrow: letters, digits, dot, dash, underscore, @ and /. Every
// argument this module actually passes is a literal written here in the source
// -- `root -g`, `install -g playwright` -- so nothing outside this set is a
// case that exists today, and refusing loudly is how it stays that way.
const SAFE_ARGUMENT = /^[A-Za-z0-9@._/-]+$/;

/**
 * Run a Node CLI shim and wait for it.
 *
 * WHY THIS IS NOT `spawnSync('npm.cmd', args)`. On Windows `npm` and `npx` are
 * batch shims, and since the CVE-2024-27980 fix Node REFUSES to spawn a `.cmd`
 * or `.bat` without a shell: the call fails with EINVAL and never starts a
 * process. `spawnSync` reports that in `result.error` rather than throwing, so
 * the failure is easy to swallow and then describe as "the install ran and did
 * not work" -- which sends the operator to debug an install that never began.
 *
 * `shell: true` works but hands the arguments to a command interpreter as one
 * concatenated string, which Node now warns about (DEP0190). So on Windows the
 * interpreter is invoked EXPLICITLY, with `/d /s /c` and a command line built
 * from arguments this module validates first. Everywhere else the executable is
 * spawned directly with its argument vector, which needs no interpreter at all.
 */
function runCommand(name, args, opts) {
    const o = opts || {};
    const spawn = o.spawn || require('child_process').spawnSync;
    const platform = o.platform || process.platform;
    const parts = [name].concat(args || []);
    for (const part of parts) {
        if (!SAFE_ARGUMENT.test(part)) {
            throw new Error(`refusing to run a command with an unsafe argument: ${part}`);
        }
    }
    const settings = {
        encoding: 'utf8',
        stdio: o.stdio || 'pipe',
        timeout: o.timeout
    };
    const result = platform === 'win32'
        ? spawn(o.comspec || process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', parts.join(' ')], settings)
        : spawn(name, args || [], settings);
    return {
        ok: result.status === 0,
        status: result.status,
        // Named so a caller can tell "started and failed" from "never started".
        started: !result.error,
        error: result.error,
        stdout: result.stdout
    };
}

/**
 * npm's global module root, WITHOUT a subprocess.
 *
 * `npm root -g` is authoritative and costs most of a second; this runs on the
 * way in to every capture, so the documented default location is computed
 * instead and the subprocess is kept for `npmGlobalRoot()`, which the failure
 * path calls when a second is already being spent printing an error.
 *
 * Returns null rather than a half-built path when the inputs are not there. A
 * location reported as searched has to be a place that was actually searched.
 */
function defaultGlobalRoot(opts) {
    const o = opts || {};
    const env = o.env || process.env;
    const platform = o.platform || process.platform;
    if (platform === 'win32') {
        // npm's Windows default: the prefix is %APPDATA%\npm, and node.exe's
        // own directory is not it.
        return env.APPDATA ? path.join(env.APPDATA, 'npm', 'node_modules') : null;
    }
    const execPath = o.execPath || process.execPath;
    if (!execPath) return null;
    // <prefix>/bin/node -> <prefix>/lib/node_modules
    return path.join(path.dirname(path.dirname(execPath)), 'lib', 'node_modules');
}

/**
 * npm's global root as npm itself reports it. FAILURE PATH ONLY -- see
 * defaultGlobalRoot for why this is not on the way in to every capture.
 *
 * Returns null on any failure, including npm not being installed. This refines
 * an error message; it can never be the reason a run stops.
 *
 * The timeout is SHORT for that reason. This runs on the way out of a failed
 * run, so every second it waits is a second added to a message the operator is
 * already waiting for -- and the thing it is waiting on is npm, which behind a
 * misconfigured proxy or registry can hang for a long time. Five seconds is
 * generous for a local prefix lookup, and giving up early costs only the
 * precision of one printed path.
 */
function npmGlobalRoot(opts) {
    const o = opts || {};
    const run = o.run || runCommand;
    try {
        const r = run('npm', ['root', '-g'], Object.assign({ timeout: 5000 }, o));
        if (!r.ok) return null;
        const line = String(r.stdout || '').split(/\r?\n/)
            .map((l) => l.trim()).filter(Boolean)[0];
        return line ? path.resolve(line) : null;
    } catch (e) {
        void e;
        return null;
    }
}

/**
 * Where Playwright keeps its browser binaries on this machine.
 *
 * Its own per-machine default, which is why one `npx playwright install
 * chromium` serves every folder -- the same shape the module resolution above
 * gives the module.
 */
function browsersPath(opts) {
    const o = opts || {};
    const env = o.env || process.env;
    if (env.PLAYWRIGHT_BROWSERS_PATH) return path.resolve(env.PLAYWRIGHT_BROWSERS_PATH);
    const platform = o.platform || process.platform;
    if (platform === 'win32') {
        return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'ms-playwright') : null;
    }
    const home = o.homedir || require('os').homedir();
    if (!home) return null;
    return platform === 'darwin'
        ? path.join(home, 'Library', 'Caches', 'ms-playwright')
        : path.join(home, '.cache', 'ms-playwright');
}

/**
 * Is a Chromium build actually installed?
 *
 * ON THE CONTENTS, not on the directory. The browsers directory exists after
 * any install attempt, successful or not, so a check written against the
 * folder reports success and the browser launch fails minutes later -- after
 * the operator has already been prompted and a profile scaffolded.
 *
 * Chromium specifically: another browser being present says nothing about the
 * one this recorder launches.
 *
 * DELIBERATELY NOT A REVISION MATCH. This answers "has a browser ever been
 * installed here", which is the question an operator setting up a machine is
 * actually failing at. Whether the build is the revision this Playwright wants
 * is Playwright's own question, and it already answers it at launch with a
 * message naming the exact executable and the exact command. Duplicating that
 * check here would mean tracking Playwright's revision pinning, and getting it
 * wrong would refuse a working install.
 */
function chromiumPresent(opts) {
    const dir = browsersPath(opts);
    if (!dir) return false;
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch (e) {
        void e;
        return false;
    }
    return entries.some((e) => /^chromium(-|_|$)/i.test(e));
}

/**
 * The failure, written so that following it works.
 *
 * Every location is named with its absolute path -- including the ones that
 * are unset, said as unset -- and then the remedies, cheapest first. The
 * module and the browser are SEPARATE lines because they are separate facts:
 * `npm install` does not fetch a browser, and a message that implies it does
 * gets run, appears to succeed, and fails again.
 */
function describeMissing(name, result, opts) {
    const o = opts || {};
    const searched = (result && result.searched) || [];
    const lines = [`the ${name} module was not found. Searched, in order:`];
    for (const s of searched) {
        const where = s.dir ? `  ${s.label}: ${s.dir}` : `  ${s.label}`;
        // A location that could not be READ is not a location that did not
        // have it, and the difference decides what the operator should do.
        lines.push(s.problem ? `${where}  (could not be read: ${s.problem})` : where);
    }
    lines.push('');
    lines.push('  Install it once for this machine:');
    lines.push(`    npm install -g ${name}`);
    if (o.browser === false) {
        // Playwright's own command, spelled literally rather than built from
        // `name`. The browser half of this module is Playwright-specific
        // already -- browsersPath reads PLAYWRIGHT_BROWSERS_PATH -- and a
        // command assembled from a package name would be a plausible-looking
        // line that does not exist for any other package.
        lines.push(`    ${BROWSER_INSTALL_COMMAND}`);
    }
    lines.push('  Or just for this folder, which is now the first place searched:');
    lines.push(`    npm install ${name}`);
    lines.push('  Or point NODE_PATH at an install that has it.');
    return lines.join('\n');
}

/**
 * The browser driver, found the way every entry point in this subsystem must
 * find it.
 *
 * ONE implementation, not one per caller. `capture-har.js` and `capture-cdp.js`
 * both had their own bare `require('playwright')` with their own wrong advice,
 * which is exactly the duplication the four-location search exists to end --
 * two copies would drift on the day the second one was written.
 *
 * `npm root -g` is consulted ONLY when the cheap answer came back empty. It
 * costs the better part of a second and this sits on the way in to every
 * capture, so the happy path uses npm's documented default location and the
 * subprocess is spent where a second is already going on printing an error.
 * A refined root that still does not have it changes nothing but the accuracy
 * of the folder named in the message -- which is the point.
 */
function resolvePlaywright(opts) {
    const o = opts || {};
    const env = o.env || process.env;
    const platform = o.platform || process.platform;
    const base = {
        cwd: o.cwd || process.cwd(),
        toolDir: o.toolDir,
        nodePath: env.NODE_PATH,
        resolve: o.resolve
    };
    const cheap = defaultGlobalRoot({ env, platform, execPath: o.execPath });
    let result = resolveDependency(PLAYWRIGHT, Object.assign({ globalRoot: cheap }, base));
    if (result.found) return result;

    const refined = (o.npmGlobalRoot || npmGlobalRoot)({ platform });
    if (refined && refined !== cheap) {
        result = resolveDependency(PLAYWRIGHT, Object.assign({ globalRoot: refined }, base));
    }
    return result;
}

module.exports = {
    BROWSER_INSTALL_COMMAND,
    PLAYWRIGHT,
    runCommand,
    resolvePlaywright,
    CWD,
    TOOL,
    GLOBAL,
    NODE_PATH,
    UPWARD,
    CONTAINER,
    searchLocations,
    resolveDependency,
    defaultGlobalRoot,
    npmGlobalRoot,
    browsersPath,
    chromiumPresent,
    describeMissing
};
