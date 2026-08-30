#!/usr/bin/env node
/**
 * extract-har-reference.js -- turn a raw capture into a committable reference.
 *
 * A capture is the single most valuable artifact of a reverse-engineering
 * session: it is the only thing in the repo that is ground truth about
 * someone else's API. When a provider rotates an id or changes a payload, the
 * correct fix is re-capture and diff against the stored reference -- which is
 * only possible if a trustworthy reference exists.
 *
 * Raw captures are never committed: they run to hundreds of MB and carry live
 * credentials. This script selects the entries that matter, scrubs them
 * through sanitize-har.js, and writes a trimmed extract to
 * <provider>/<provider>-<action>-<yyyy-MM-dd>.har beside the capture output.
 *
 * Non-negotiable behaviours, each pinned to a defect that shipped:
 *
 *  - Request bodies are NEVER truncated. A reference whose request bodies
 *    were capped looks authoritative and proves nothing -- it cannot be
 *    replayed and cannot be diffed against a fresh capture. Only response
 *    bodies are capped, and a capped response records what was dropped.
 *  - Decoded postData.params[] are emitted alongside the scrubbed wire text.
 *    A percent-encoded form body is not greppable; the decoded copy is what
 *    makes the reference searchable for a field name.
 *  - It refuses to run without a selector, and fails loudly when nothing
 *    matches rather than writing an empty reference.
 *
 * Usage:
 *   node extract-har-reference.js --in <raw.har> --match <pattern> [...]
 *
 *   --match               REQUIRED, repeatable. Case-insensitive regular
 *                         expression tested against the request URL and the
 *                         request/response bodies.
 *   --out                 default: <provider>/ in the current directory
 *                                  <provider>-<action>-<yyyy-MM-dd>.har
 *   --provider --action   name the output; --action names what a HUMAN did
 *                         to record it (login-flow-2fa, video-upload).
 *   --max-response-bytes  OPT-IN. Absent, no response body is truncated.
 *                         Requests are never capped, with or without it.
 *   --profile             the operator profile (see har-profile.js)
 *
 * Exit codes:
 *   0 -- reference written
 *   1 -- I/O, parse, scrub, or profile error
 *   2 -- usage error (no selector, or no way to name the output)
 *   3 -- the selector matched nothing; no reference was written
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const harProfile = require(path.join(__dirname, 'har-profile.js'));
const harLiterals = require(path.join(__dirname, 'har-literals.js'));

// The reference root is the CURRENT DIRECTORY. The cataloguer runs with its cwd
// set to the capture's output path, which is already the host-named folder, so
// anchoring on 'docs/har-reference' here appended a second copy of that path
// underneath it -- contradicting what catalogue-prompt.md promises.
const REFERENCE_ROOT = '.';

function parseArgs(argv) {
    const out = { match: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) usage(`unexpected positional argument '${a}'`);
        const key = a.slice(2);
        const next = argv[i + 1];
        const value = next === undefined || next.startsWith('--') ? true : (i++, next);
        if (key === 'match') out.match.push(value);
        else out[key] = value;
    }
    return out;
}

function usage(msg) {
    if (msg) console.error(`extract-har-reference: ${msg}`);
    console.error([
        'usage: node extract-har-reference.js --in <raw.har> --match <pattern> [--match <pattern> ...]',
        '  --match               REQUIRED, repeatable; case-insensitive regex over URL and bodies',
        `  --out                 default: ${REFERENCE_ROOT}/<provider>/<provider>-<action>-<yyyy-MM-dd>.har`,
        '  --provider --action   name the output; --action names what you DID to record it',
        `  --max-response-bytes  optional; absent, nothing is truncated. Requests are never capped`,
        '  --profile             the operator profile carrying salt and literals',
    ].join('\n'));
    process.exit(2);
}

function fail(message, code) {
    console.error(`extract-har-reference: ${message}`);
    process.exit(code === undefined ? 1 : code);
}

// `<action>` is a slug so it survives a filename: what the human did, not what
// the endpoint is called.
function slug(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function today() {
    return new Date().toISOString().slice(0, 10);
}

function entryText(entry) {
    const parts = [entry.request && entry.request.url];
    if (entry.request && entry.request.postData) parts.push(entry.request.postData.text);
    if (entry.response && entry.response.content) parts.push(entry.response.content.text);
    return parts.filter((p) => typeof p === 'string').join('\n');
}

function capResponses(entries, maxBytes) {
    // A null cap means no cap. The caller decides; this function does not
    // invent a bound of its own.
    if (maxBytes === null || maxBytes === undefined) return;
    for (const entry of entries) {
        const content = entry.response && entry.response.content;
        if (!content || typeof content.text !== 'string') continue;
        if (content.text.length <= maxBytes) continue;
        const originalBytes = content.text.length;
        content.text = content.text.slice(0, maxBytes);
        // Record what was dropped. A reader must be able to tell a short
        // response from a shortened one.
        content.truncated = { originalBytes, keptBytes: maxBytes };
    }
}

function addDecodedParams(entries) {
    for (const entry of entries) {
        const postData = entry.request && entry.request.postData;
        if (!postData || typeof postData.text !== 'string') continue;
        if (!postData.text.includes('=')) continue;

        const params = [];
        for (const pair of postData.text.split('&')) {
            const eq = pair.indexOf('=');
            if (eq < 0) continue;
            const name = pair.slice(0, eq);
            const raw = pair.slice(eq + 1);
            let value = raw;
            try {
                value = decodeURIComponent(raw.replace(/\+/g, ' '));
            } catch {
                // Not an encoded value; the wire spelling is the value.
            }
            params.push({ name, value });
        }
        if (params.length > 0) postData.params = params;
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.in) usage('--in is required');
    if (args.match.length === 0) {
        usage('at least one --match selector is required -- there is no "extract everything" default');
    }

    let profile;
    try {
        profile = harProfile.loadProfile({ profilePath: args.profile });
    } catch (e) {
        fail(e.message);
    }

    const provider = args.provider ? slug(args.provider) : null;
    const action = args.action ? slug(args.action) : null;
    let outPath = args.out;
    if (!outPath) {
        if (!provider || !action) {
            usage('either --out, or both --provider and --action, are required');
        }
        // The provider appears in the FILENAME as well as the directory. That
        // looks redundant and is not: the directory is invisible the moment
        // the file is opened in an editor tab, attached to an issue, pasted
        // into a diff, or downloaded.
        outPath = path.join(REFERENCE_ROOT, provider, `${provider}-${action}-${today()}.har`);
    }

    let har;
    try {
        har = JSON.parse(fs.readFileSync(args.in, 'utf8'));
    } catch (e) {
        fail(`cannot read ${args.in}: ${e.message}`);
    }

    let selectors;
    try {
        selectors = args.match.map((m) => new RegExp(m, 'i'));
    } catch (e) {
        usage(`invalid --match pattern: ${e.message}`);
    }

    const all = (har.log && har.log.entries) || [];
    const selected = all.filter((entry) => {
        const text = entryText(entry);
        return selectors.some((re) => re.test(text));
    });

    if (selected.length === 0) {
        // Never write an empty reference. One that exists and proves nothing
        // is worse than none at all: the next reader trusts it.
        fail(
            `no entry in ${args.in} matched ${args.match.map((m) => JSON.stringify(m)).join(', ')} ` +
            `(${all.length} entries scanned). No reference written.`, 3);
    }

    // No cap unless one is ASKED FOR. Requirement 7 of #297: scrub by
    // sensitivity, not by size. A response body is not dangerous because it is
    // large -- asset and minified-JS bodies carry the reverse-engineerable
    // protocol constants a reference exists to preserve, and the 65536 default
    // silently discarded exactly those. One such body was the only
    // documentation of how photo upload worked, and nothing reported its loss.
    //
    // The flag stays for the operator who genuinely wants a bound. It is the
    // DEFAULT that was wrong, not the capability.
    // `parseArgs` gives a flag with no value the boolean `true`, and
    // `Number(true)` is 1 -- so `--max-response-bytes` with the number left off
    // silently kept ONE BYTE of every response and stamped it truncated. A typo
    // that destroys every body while exiting 0 is the failure shape this whole
    // issue exists to remove, so it is refused by TYPE before any coercion.
    const rawMax = args['max-response-bytes'];
    if (rawMax === true) {
        usage('--max-response-bytes needs a number, e.g. --max-response-bytes 65536');
    }
    const maxResponseBytes = rawMax === undefined ? null : Number(rawMax);
    if (maxResponseBytes !== null && (!Number.isFinite(maxResponseBytes) || maxResponseBytes <= 0)) {
        usage('--max-response-bytes must be a positive number');
    }

    const trimmed = {
        log: Object.assign({}, har.log, { entries: selected }),
    };

    // Scrub by delegating to sanitize-har.js rather than reimplementing it,
    // so a reference is scrubbed by exactly the tool the rest of the pipeline
    // is gated on.
    // Everything below runs with a temp working directory holding the
    // UNSCRUBBED selected entries. Every exit from here on must remove it --
    // the early failure paths are precisely the ones most likely to leave real
    // credentials on disk.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'har-reference-'));
    const discardWork = () => {
        // A cleanup failure must never displace the error we are trying to
        // report. On Windows a just-exited child can still hold a handle, and
        // a throw from here inside the uncaughtException handler would be
        // fatal, losing the original diagnostic entirely.
        try {
            fs.rmSync(work, { recursive: true, force: true });
        } catch {
            // Best effort; the caller's message is the one that matters.
        }
    };
    const failAndDiscard = (message, code) => {
        discardWork();
        fail(message, code);
    };
    // `process.exit` does not unwind, so a `finally` here would not run on the
    // failure paths. Instead every deliberate exit goes through
    // `failAndDiscard`, and this handler catches anything that throws -- a
    // full disk or a read-only temp directory on a constrained CI runner would
    // otherwise strand the unscrubbed staging on disk with nothing reported.
    // Scoped deliberately: removed the moment staging is over. Left
    // registered it would catch a failure writing the FINAL reference and
    // report it as a staging failure -- pointing the operator at the wrong
    // half of the pipeline -- and would replace Node's stack trace with a
    // one-line message for any unrelated bug later in the run.
    const onStagingThrow = (e) => failAndDiscard(`unexpected failure while staging: ${e.message}`);
    process.on('uncaughtException', onStagingThrow);

    const stagedIn = path.join(work, 'selected.har');
    const stagedOut = path.join(work, 'scrubbed.har');
    fs.writeFileSync(stagedIn, JSON.stringify(trimmed, null, 2), 'utf8');

    const scrub = spawnSync(process.execPath, [
        path.join(__dirname, 'sanitize-har.js'),
        '--in', stagedIn,
        '--out', stagedOut,
        '--subs', path.join(work, 'subs.json'),
        '--pii-subs', path.join(work, 'pii-subs.json'),
        '--profile', profile.path,
    ], { encoding: 'utf8' });
    if (scrub.status !== 0) {
        process.stderr.write(scrub.stderr || '');
        failAndDiscard('sanitize-har failed; no reference written');
    }

    let scrubbed;
    try {
        scrubbed = JSON.parse(fs.readFileSync(stagedOut, 'utf8'));
    } catch (e) {
        failAndDiscard(`cannot read the scrubbed intermediate: ${e.message}`);
    }

    const scrubbedEntries = (scrubbed.log && scrubbed.log.entries) || [];
    capResponses(scrubbedEntries, maxResponseBytes);
    addDecodedParams(scrubbedEntries);

    const serialized = JSON.stringify(scrubbed, null, 2);
    discardWork();
    process.removeListener('uncaughtException', onStagingThrow);

    // Check BEFORE writing. This script's own post-processing can reveal a
    // literal the scrub never saw -- decoding a parameter to emit
    // `postData.params[]` peels a layer of encoding off it. Reporting that on
    // stdout and exiting 0 is not a gate: an automated caller reads the exit
    // code, sees success, and commits the reference.
    const literalHits = harLiterals.findLiteralHits(serialized, profile.literals);
    if (literalHits.length > 0) {
        fail(
            `the extract still carries ${literalHits.map((h) => `${h.sentinel} (x${h.count})`).join(', ')} ` +
            'after scrubbing. No reference written. This usually means the value appears in an ' +
            'encoding the scrub pass does not cover -- widen it before keeping this capture.', 3);
    }

    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, serialized, 'utf8');

    console.log(
        `extract-har-reference: wrote ${outPath} (${selected.length} of ${all.length} entries)`);
    // The endpoint is recoverable from the file. What you did to provoke it is
    // not -- and that is the half a reader is actually looking for.
    console.log(
        `extract-har-reference: now add the catalogue row in ${path.join(REFERENCE_ROOT, 'README.md')} ` +
        'naming what you did to record this, the entry-by-entry sequence, and the failure modes it caught. ' +
        `Then run verify-har-reference.js.`);
    process.exit(0);
}

main();
