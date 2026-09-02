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
 *  - It fails loudly when the selection is empty rather than writing an empty
 *    reference.
 *  - API calls are the DEFAULT selection, and the run reports what it dropped,
 *    by category. See "Which entries are kept" below.
 *
 * Which entries are kept (#410)
 * -----------------------------
 * `--match` used to be REQUIRED, on the reasoning that which entries matter is
 * a judgement a tool cannot make. Asked directly for one, the operator said:
 * "I couldn't provide a regex. All I know is that the focus should be on the
 * API calls, not the fonts, images, etc." That retires the premise -- "API
 * call, not static asset" is a mechanical classification, and the data to make
 * it is already in every entry.
 *
 * So the default selection is the API traffic:
 *
 *  - A Playwright capture records `_resourceType` on every entry (`xhr`,
 *    `fetch`, `document`, `image`, `font`, `stylesheet`, `script`, `media`,
 *    `ping`, ...). Where it is present it DECIDES.
 *  - A mitmproxy capture has no `_resourceType` at all. There, the request's
 *    own body and the response content-type answer the same question.
 *
 * The classifier is deliberately conservative about what it DROPS rather than
 * clever about what it keeps, because a wrongly dropped entry is invisible and
 * a wrongly kept one is merely noise:
 *
 *  - Only a POSITIVE identification as a static asset or as a beacon drops an
 *    entry. Everything else -- including a resource type this script has never
 *    heard of -- is kept as `unclassified`.
 *  - `document` entries are KEPT. An HTML document response can carry a token,
 *    and a redirect chain or an OAuth callback lands here. Dropping those
 *    would silently destroy the very thing a reference is for.
 *  - kept + dropped MUST equal the number of entries scanned. That is asserted
 *    at runtime, not assumed: a filter that silently loses entries is worse
 *    than one that keeps too many.
 *  - The per-category counts are PRINTED, so a wrong drop is noticeable at
 *    extraction time rather than months later. `scrubbed.har` also stays in
 *    the session directory, so re-extracting with other criteria is always
 *    possible and nothing is lost.
 *
 * Usage:
 *   node extract-har-reference.js --in <raw.har> [--match <pattern> ...]
 *
 *   --match               OPTIONAL, repeatable. Case-insensitive regular
 *                         expression tested against the request URL and the
 *                         request/response bodies. It narrows WITHIN the API
 *                         set; it does not replace the classification, so
 *                         supplying one can never drag a font back in.
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
 *   2 -- usage error (no way to name the output, or a bad argument)
 *   3 -- the selection was empty; no reference was written
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
        'usage: node extract-har-reference.js --in <raw.har> [--match <pattern> ...]',
        '  (default)             API calls only -- xhr/fetch/websocket, documents and anything',
        '                        not provably a static asset or a beacon. No selector needed.',
        '  --match               OPTIONAL, repeatable; case-insensitive regex over URL and bodies.',
        '                        Narrows WITHIN the API set; it never re-admits a dropped asset',
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

// --- API-vs-asset classification (#410) -------------------------------------
//
// Categories. The first three are KEPT, the last two are DROPPED. Every entry
// lands in exactly one, and `classifyEntries` asserts that.
const KEPT_CATEGORIES = ['api', 'document', 'unclassified'];
const DROPPED_CATEGORIES = ['asset', 'telemetry'];

const CATEGORY_LABEL = {
    api: 'API calls',
    document: 'documents -- HTML, redirects and auth callbacks, kept because they carry tokens',
    unclassified: 'unclassified -- kept, because nothing PROVED these were assets',
    asset: 'static assets',
    telemetry: 'telemetry / beacon',
};

// Playwright's own answer to the question, where it recorded one. Anything NOT
// in this table -- `other`, `manifest`, or a resource type a future Playwright
// invents -- falls through to `unclassified` and is KEPT. That default is the
// whole safety property: a new resource type cannot silently start being
// dropped.
const RESOURCE_TYPE_CATEGORY = {
    xhr: ['api', 'xhr'],
    fetch: ['api', 'fetch'],
    websocket: ['api', 'websockets'],
    document: ['document', 'html'],
    image: ['asset', 'images'],
    font: ['asset', 'fonts'],
    stylesheet: ['asset', 'css'],
    script: ['asset', 'scripts'],
    media: ['asset', 'media'],
    // Playwright's `ping` is `navigator.sendBeacon` and `<a ping>`: telemetry
    // by construction, not by URL guesswork. Analytics endpoints served over
    // `xhr` are NOT detected here -- tuning that is a follow-up, and guessing
    // at it from a URL is exactly the judgement this change removed.
    ping: ['telemetry', 'beacons'],
};

function normalizeMimeType(value) {
    if (typeof value !== 'string') return '';
    return value.split(';')[0].trim().toLowerCase();
}

// Content types that are an API payload by grammar, not by guess.
function isApiMimeType(mime) {
    return /^application\/(json|graphql|x-www-form-urlencoded|x-ndjson|x-protobuf|protobuf|grpc|xml|.*\+json|.*\+xml)/.test(mime)
        || mime === 'text/xml'
        || mime === 'multipart/form-data';
}

function isDocumentMimeType(mime) {
    return mime === 'text/html' || mime === 'application/xhtml+xml';
}

// The DROP list, and it is the only thing that drops an entry on the fallback
// path. Written as an explicit enumeration rather than "everything that is not
// an API type" so that adding a content type cannot accidentally widen it.
const ASSET_MIME_KIND = [
    [/^image\//, 'images'],
    [/^font\//, 'fonts'],
    [/^application\/(font-|x-font-|vnd\.ms-fontobject)/, 'fonts'],
    [/^video\//, 'media'],
    [/^audio\//, 'media'],
    [/^text\/css$/, 'css'],
    [/^(application\/(x-)?(java|ecma)script|text\/(java|ecma)script)$/, 'scripts'],
    [/^application\/wasm$/, 'scripts'],
];

/**
 * Classify one HAR entry as API traffic or as something a reference does not
 * need. Returns `{ category, kind, basis }` -- `basis` records WHICH signal
 * decided, so the report can say whether a capture was classified by resource
 * type or by content type.
 */
function classifyEntry(entry) {
    const resourceType = entry && typeof entry._resourceType === 'string'
        ? entry._resourceType.toLowerCase() : null;
    if (resourceType) {
        const known = RESOURCE_TYPE_CATEGORY[resourceType];
        if (known) return { category: known[0], kind: known[1], basis: 'resourceType' };
        // A resource type we do not model. Keep it.
        return { category: 'unclassified', kind: 'unmodelled resource type', basis: 'resourceType' };
    }

    // No `_resourceType`: a mitmproxy capture, or any exporter that does not
    // write Playwright's extension fields.
    const request = (entry && entry.request) || {};
    const postData = request.postData;
    if (postData && (typeof postData.text === 'string' && postData.text.length > 0
        || Array.isArray(postData.params) && postData.params.length > 0)) {
        // A request that CARRIES A BODY is an API call whatever it responds
        // with. This is checked before the response type on purpose: a
        // multipart upload answering `image/jpeg` is the single most
        // interesting entry in a capture, and response-type-first would drop it.
        return { category: 'api', kind: 'request bodies', basis: 'requestBody' };
    }

    const mime = normalizeMimeType(entry && entry.response && entry.response.content
        && entry.response.content.mimeType);
    if (isApiMimeType(mime)) return { category: 'api', kind: 'API content types', basis: 'contentType' };
    if (isDocumentMimeType(mime)) return { category: 'document', kind: 'html', basis: 'contentType' };
    for (const [pattern, kind] of ASSET_MIME_KIND) {
        if (pattern.test(mime)) return { category: 'asset', kind, basis: 'contentType' };
    }
    // Empty, `x-unknown`, `application/octet-stream`, `text/plain`, a 204 or a
    // 302 with no body at all. None of those PROVE an asset, and a bodiless
    // 302 is exactly the redirect hop an auth flow turns on. Kept.
    return { category: 'unclassified', kind: 'unknown content type', basis: 'contentType' };
}

/**
 * Classify every entry and return `{ classified, counts, kinds, bases }`.
 * Throws if the categories do not partition the input -- the "kept + dropped
 * equals total" invariant, checked rather than assumed.
 */
function classifyEntries(entries) {
    const counts = {};
    const kinds = {};
    const bases = {};
    for (const c of KEPT_CATEGORIES.concat(DROPPED_CATEGORIES)) { counts[c] = 0; kinds[c] = {}; }

    const classified = entries.map((entry) => {
        const c = classifyEntry(entry);
        if (counts[c.category] === undefined) {
            throw new Error(`classifier produced an unknown category '${c.category}'`);
        }
        counts[c.category] += 1;
        kinds[c.category][c.kind] = (kinds[c.category][c.kind] || 0) + 1;
        bases[c.basis] = (bases[c.basis] || 0) + 1;
        return Object.assign({ entry }, c);
    });

    const kept = KEPT_CATEGORIES.reduce((n, c) => n + counts[c], 0);
    const dropped = DROPPED_CATEGORIES.reduce((n, c) => n + counts[c], 0);
    if (kept + dropped !== entries.length) {
        // Not reachable through the classifier above -- which is the point.
        // If it ever becomes reachable, the run must stop, not quietly write a
        // reference that lost entries nobody counted.
        throw new Error(
            `classification lost entries: kept ${kept} + dropped ${dropped} != ${entries.length} scanned`);
    }
    return { classified, counts, kinds, bases, kept, dropped };
}

function renderKinds(kindCounts) {
    const parts = Object.entries(kindCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([kind, n]) => `${kind} ${n}`);
    return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * The per-category report. It is load-bearing, not decoration: it is how a
 * wrong drop becomes visible at extraction time. Counts, category names and
 * content-type CATEGORIES only -- never a captured value.
 */
function reportLines(report, total) {
    const lines = [];
    for (const category of KEPT_CATEGORIES) {
        if (report.counts[category] === 0) continue;
        lines.push(`  kept     ${String(report.counts[category]).padEnd(5)}${CATEGORY_LABEL[category]}` +
            renderKinds(report.kinds[category]));
    }
    for (const category of DROPPED_CATEGORIES) {
        if (report.counts[category] === 0) continue;
        lines.push(`  dropped  ${String(report.counts[category]).padEnd(5)}${CATEGORY_LABEL[category]}` +
            renderKinds(report.kinds[category]));
    }
    lines.push(`  total    ${String(total).padEnd(5)}` +
        `entries scanned = ${report.kept} kept + ${report.dropped} dropped`);
    // WHICH SIGNAL decided. A capture classified entirely by content type is a
    // recorder that wrote no `_resourceType` -- mitmproxy, say -- and that is
    // worth knowing when a drop count looks wrong, because the fallback is the
    // weaker of the two paths and the operator cannot otherwise tell which ran.
    const basisOrder = ['resourceType', 'requestBody', 'contentType'];
    const basisParts = basisOrder
        .filter((b) => report.bases[b])
        .map((b) => `${b} ${report.bases[b]}`);
    if (basisParts.length > 0) lines.push(`  basis    ${''.padEnd(5)}${basisParts.join(', ')}`);
    return lines;
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

    // The classification runs FIRST and always. `--match` then narrows within
    // what it kept -- it does not replace it.
    //
    // Why narrowing and not replacing: the two answer different questions.
    // The classification answers "is this an API call?", mechanically, from
    // data already in the entry. `--match` answers "which of those API calls
    // am I documenting?", which is the operator's judgement. If a selector
    // REPLACED the classification, then `--match upload` would re-admit every
    // image whose URL happens to contain "upload" -- reinstating exactly the
    // failure this default exists to remove, and doing it only for operators
    // who took the trouble to narrow. Composition also keeps the report
    // honest: the drop counts describe the same classification whether or not
    // a selector was supplied.
    let report;
    try {
        report = classifyEntries(all);
    } catch (e) {
        fail(e.message);
    }
    const apiEntries = report.classified
        .filter((c) => KEPT_CATEGORIES.includes(c.category))
        .map((c) => c.entry);

    const selected = selectors.length === 0 ? apiEntries : apiEntries.filter((entry) => {
        const text = entryText(entry);
        return selectors.some((re) => re.test(text));
    });

    // The report is printed BEFORE any failure exit as well as before the
    // write, because the counts are most valuable precisely when the run did
    // not produce what the operator expected.
    for (const line of reportLines(report, all.length)) console.log(line);

    if (apiEntries.length === 0) {
        // Never write an empty reference. One that exists and proves nothing
        // is worse than none at all: the next reader trusts it.
        fail(
            `no entry in ${args.in} was classified as an API call (${all.length} entries scanned; ` +
            `all of them static assets or beacons). No reference written.`, 3);
    }
    if (selected.length === 0) {
        // Distinguished from the case above on purpose: "there were no API
        // calls" and "your selector excluded all of them" call for different
        // next actions.
        fail(
            `no API entry in ${args.in} matched ${args.match.map((m) => JSON.stringify(m)).join(', ')} ` +
            `(${apiEntries.length} API entries of ${all.length} scanned). ` +
            'No reference written. --match narrows within the API set; it cannot re-admit a dropped asset.', 3);
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

    const narrowing = selectors.length === 0
        ? ''
        : `, narrowed from ${apiEntries.length} kept by --match`;
    console.log(
        `extract-har-reference: wrote ${outPath} (${selected.length} of ${all.length} entries${narrowing})`);
    // The endpoint is recoverable from the file. What you did to provoke it is
    // not -- and that is the half a reader is actually looking for.
    console.log(
        `extract-har-reference: now add the catalogue row in ${path.join(REFERENCE_ROOT, 'README.md')} ` +
        'naming what you did to record this, the entry-by-entry sequence, and the failure modes it caught. ' +
        `Then run verify-har-reference.js.`);
    process.exit(0);
}

main();
