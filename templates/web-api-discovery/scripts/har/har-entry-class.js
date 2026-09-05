#!/usr/bin/env node
/**
 * har-entry-class.js -- is this entry an API call, or is it cruft?
 *
 * ONE answer to that question, shared by everything that needs it. The
 * classification began inside extract-har-reference.js (#410) because that was
 * the only caller. It has two now -- the extractor, which keeps API traffic to
 * build a committed reference, and trim-har-capture.js, which drops cruft from
 * a raw capture to make it small enough to keep.
 *
 * Two implementations that agree today are how a filter and the thing it feeds
 * drift into disagreeing about what a beacon is, so the definition lives here
 * and both import it (#435, and the same reasoning as #429).
 *
 * The safety property is in the DEFAULT, not in the cleverness: only a positive
 * identification as an asset or a beacon drops an entry, and everything else --
 * including a resource type this file has never heard of -- is kept as
 * `unclassified`. A wrongly dropped entry is invisible; a wrongly kept one is
 * merely noise.
 */

'use strict';

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
//
// It decides everything EXCEPT an entry carrying a request body, which outranks
// it (#435). The label describes what the browser thought it was fetching; a
// request body is evidence of what was actually sent, and the label can be
// `image` for a POST that uploaded one.
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
    // A REQUEST BODY OUTRANKS EVERY OTHER SIGNAL, including Playwright's own
    // label. This test used to sit below the `_resourceType` branch, where it
    // was unreachable for any capture Playwright had labelled -- so a POST
    // carrying a form body, recorded as `image` because that is what it
    // answered with, was classified as a static asset and dropped.
    //
    // The reasoning was already written down one branch further along and
    // simply was not applied here: a multipart upload answering `image/jpeg` is
    // the single most interesting entry in a capture. A request body is also
    // the half of an entry that cannot be reconstructed from anything else, so
    // of all the ways to be wrong, dropping one is the worst available.
    //
    // Deliberately ANY non-empty body, not a body that parses. This decides
    // whether to KEEP something; a placeholder body still means the request
    // sent something, and erring toward keeping is free where erring toward
    // dropping is not.
    const resourceType = entry && typeof entry._resourceType === 'string'
        ? entry._resourceType.toLowerCase() : null;
    const labelled = resourceType ? RESOURCE_TYPE_CATEGORY[resourceType] : null;

    // SCOPED, not absolute: a body outranks a label that describes THE
    // RESPONSE, and does not outrank one that describes HOW THE REQUEST WAS
    // SENT.
    //
    // `image`, `font`, `stylesheet`, `media`, `script` all say what came back,
    // and the browser can be wrong about a POST that merely answered with one.
    // `ping` says the request went out through `navigator.sendBeacon` or
    // `<a ping>` -- telemetry by construction, and not wrong in that way.
    //
    // The distinction earns its keep. sendBeacon exists to ship a payload, so
    // most real beacons CARRY a body; an unscoped rule would keep every one of
    // them, and beacon volume is much of why a capture reaches gigabytes. It
    // would have quietly gutted the command that exists to shrink them.
    const labelIsAboutTheResponse = !labelled || labelled[0] !== 'telemetry';

    const request = (entry && entry.request) || {};
    const postData = request.postData;
    if (labelIsAboutTheResponse && postData
        && (typeof postData.text === 'string' && postData.text.length > 0
            || Array.isArray(postData.params) && postData.params.length > 0)) {
        return { category: 'api', kind: 'request bodies', basis: 'requestBody' };
    }

    if (resourceType) {
        const known = RESOURCE_TYPE_CATEGORY[resourceType];
        if (known) return { category: known[0], kind: known[1], basis: 'resourceType' };
        // A resource type we do not model. Keep it.
        return { category: 'unclassified', kind: 'unmodelled resource type', basis: 'resourceType' };
    }

    // No `_resourceType`: a mitmproxy capture, or any exporter that does not
    // write Playwright's extension fields.

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

module.exports = {
    KEPT_CATEGORIES,
    DROPPED_CATEGORIES,
    CATEGORY_LABEL,
    RESOURCE_TYPE_CATEGORY,
    normalizeMimeType,
    isApiMimeType,
    isDocumentMimeType,
    classifyEntry,
    classifyEntries,
    renderKinds,
    reportLines,
};
