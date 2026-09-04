#!/usr/bin/env node
/**
 * request-body-descriptor.js -- say that a request body was NOT retained,
 * instead of reporting `bodySize: 0` and letting a reader conclude there was
 * none (#442).
 *
 * ## The defect this exists to remove
 *
 * `recordHar` runs with `content: 'embed'`, which embeds RESPONSE bodies.
 * Request payloads travel a different path and do not survive: measured
 * read-only across six real creation captures, an Instagram run that uploaded
 * 67 MB of video has no request body anywhere above 10 KB, and the two
 * `rupload_igvideo` POSTs that carried 19 MB and 52 MB both read
 *
 *     "bodySize": 0        with no `postData` at all
 *
 * while their own `content-length` headers say 19299725 and 52164051. HAR's
 * `bodySize: 0` is the SAME text a genuinely bodyless GET produces, so the two
 * facts -- "there was no body" and "the body was not retained" -- share one
 * representation, and the false one is what every downstream consumer reads.
 *
 * The payload cannot be recovered later, so the fix is not to capture it. The
 * fix is to STOP LYING about it: record a descriptor, a few hundred bytes
 * against a 52 MB payload, saying that a body was declared and not kept.
 *
 * ## What is recorded, and what is refused
 *
 * NEVER THE BYTES. Not the bytes, not a hash of them, not a prefix. A file a
 * person uploaded is their content and a fingerprint of it is still about
 * them, so this module reads a body buffer only to find MIME part boundaries
 * and to measure lengths, and copies nothing out of a part's content region.
 *
 * What is recorded is structure and lengths: that the body was not retained,
 * the declared `content-length`, how much of it we did hold, the mime type,
 * and -- for multipart -- each part's order, field name, `filename`,
 * `Content-Type` and byte length.
 *
 * ## A `filename` IS captured data
 *
 * `IMG_2024.jpg` is harmless; `emily-watson-birthday-2019.jpg` carries a
 * person, a date and an occasion. The descriptor is therefore NOT a side
 * channel around the scrub -- it is placed at `entry.request._bodyCapture`,
 * inside the entry, where `sanitize-har.js`'s whole-document `walk` reaches
 * every string it holds, where `har-shapes.collectEntryStrings` (the gate)
 * walks every entry key it does not own, and where `pii.js` and
 * `audit-scrub-drift.js` were EXTENDED to reach it, because their walks are
 * selective node lists rather than a generic descent and would otherwise have
 * skipped it silently. See #442's notes on each.
 *
 * ## Three states, not two
 *
 *   no descriptor + bodySize 0   -- there was genuinely no body
 *   no descriptor + bodySize n   -- the body is here, all n bytes of it
 *   descriptor    + bodySize -1  -- a body was declared and is NOT here
 *
 * `-1` is HAR's own "not available", already used by this recorder for a
 * response body it could not read. A descriptor is emitted ONLY for the third
 * state: a request that genuinely had no body is untouched, so the new state
 * cannot swallow the old one.
 */

'use strict';

/** Where the descriptor sits on an entry's request. Underscore per HAR's
 *  convention for non-standard fields (`_resourceType` is Playwright's own). */
const DESCRIPTOR_KEY = '_bodyCapture';

function headerLookup(headers) {
    const lower = new Map();
    if (Array.isArray(headers)) {
        for (const h of headers) {
            if (h && typeof h.name === 'string') lower.set(h.name.toLowerCase(), h.value);
        }
    } else if (headers && typeof headers === 'object') {
        for (const k of Object.keys(headers)) lower.set(k.toLowerCase(), headers[k]);
    }
    return (name) => {
        const v = lower.get(name);
        if (typeof v === 'string') return v;
        return v === undefined || v === null ? null : String(v);
    };
}

/**
 * The declared body length, or null when the request does not state one.
 *
 * null is not zero. A chunked request declares no length at all, and reporting
 * 0 for it would reintroduce the exact conflation this module removes.
 */
function declaredLengthOf(get) {
    const raw = get('content-length');
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

function boundaryOf(mimeType) {
    if (typeof mimeType !== 'string') return null;
    const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(mimeType);
    return m ? (m[1] || m[2]) : null;
}

/**
 * One part's `name`, `filename` and `Content-Type` from its header block.
 *
 * The header block only. The content region is never read, never measured for
 * anything but its length, and never copied.
 */
function partMetaFrom(headerText) {
    const meta = { fieldName: null, filename: null, contentType: null };
    for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === 'content-type') {
            meta.contentType = value;
        } else if (name === 'content-disposition') {
            const n = /;\s*name=(?:"([^"]*)"|([^;\s]+))/i.exec(value);
            const f = /;\s*filename\*?=(?:"([^"]*)"|([^;\s]+))/i.exec(value);
            if (n) meta.fieldName = n[1] !== undefined ? n[1] : n[2];
            if (f) meta.filename = f[1] !== undefined ? f[1] : f[2];
        }
    }
    return meta;
}

/** How many parts one descriptor may list. A ceiling, not a policy: a
 *  malformed boundary must not turn into an unbounded loop. */
const MAX_PARTS = 512;

/**
 * The part structure of a multipart body, from whatever bytes we hold.
 *
 * Returns null when nothing can be resolved -- no buffer, no boundary, no
 * part found -- because "the structure is unknown" and "there are no parts"
 * are different facts and this module exists to keep such pairs apart.
 *
 * A part whose closing boundary is missing (the buffer stops mid-part, which
 * is the normal shape of a body we only partly hold) reports `length: null`
 * and `complete: false` rather than a length measured against the end of what
 * we happen to have.
 */
function parseMultipartStructure(buffer, boundary) {
    if (!buffer || !boundary || typeof buffer.length !== 'number') return null;
    const delim = Buffer.from('--' + boundary, 'latin1');
    const crlf2 = Buffer.from('\r\n\r\n', 'latin1');
    const parts = [];
    let cursor = buffer.indexOf(delim);
    if (cursor < 0) return null;
    let order = 0;
    while (cursor >= 0 && order < MAX_PARTS) {
        const headerStart = cursor + delim.length;
        // `--` after the delimiter is the closing boundary: no part follows.
        if (buffer.slice(headerStart, headerStart + 2).toString('latin1') === '--') break;
        const headerEnd = buffer.indexOf(crlf2, headerStart);
        if (headerEnd < 0) break;
        const headerText = buffer.slice(headerStart, headerEnd).toString('latin1');
        const contentStart = headerEnd + crlf2.length;
        const next = buffer.indexOf(delim, contentStart);
        const complete = next >= 0;
        // The trailing CRLF belongs to the delimiter, not to the content.
        const length = complete ? Math.max(0, next - contentStart - 2) : null;
        const meta = partMetaFrom(headerText);
        parts.push({
            order,
            // `fieldName`, NOT `name`. `pii.fieldTypeFor('name')` returns
            // `person-name`, so a part key spelled `name` would make the typed
            // PII pass read every multipart FIELD NAME as somebody's name and
            // overwrite `caption` with a fake person -- destroying the very
            // structure this descriptor exists to record. That is #369/#374's
            // bug (an envelope property mistaken for a captured field name)
            // arriving on the SCRUB side, and the defence is to not spell our
            // own keys like the data's.
            fieldName: meta.fieldName,
            filename: meta.filename,
            contentType: meta.contentType,
            length,
            complete,
        });
        order++;
        if (!complete) break;
        cursor = next;
    }
    return parts.length ? parts : null;
}

/**
 * The descriptor for one observed request, or null when there is nothing to
 * say.
 *
 * null in exactly two cases, and both matter:
 *
 *   - the request declared no body at all -- a GET, a bodiless POST. It keeps
 *     `bodySize: 0`, which is TRUE of it, and gains no descriptor. This is
 *     what keeps the new state from swallowing the old one.
 *   - the body is fully retained. `postData` already carries it and a
 *     descriptor would be noise; on the real Instagram capture that is 35 of
 *     the 43 requests that declare a body.
 */
function describeRequestBody(observed) {
    const o = observed || {};
    const get = headerLookup(o.headers);
    const declaredLength = declaredLengthOf(get);
    const transferEncoding = get('transfer-encoding');
    const chunked = typeof transferEncoding === 'string' && /chunked/i.test(transferEncoding);
    const buf = o.postDataBuffer || null;
    const retainedLength = buf && typeof buf.length === 'number' ? buf.length : 0;

    const declaresBody = (declaredLength !== null && declaredLength > 0) || chunked || retainedLength > 0;
    if (!declaresBody) return null;
    // Everything the request said it would send is in hand.
    if (declaredLength !== null && retainedLength >= declaredLength) return null;
    // No declared length and no chunked marker, yet bytes are present: the
    // buffer IS the body and there is nothing unaccounted for.
    if (declaredLength === null && !chunked && retainedLength > 0) return null;

    const mimeType = o.postMimeType || get('content-type') || '';
    const descriptor = {
        bodyRetained: false,
        declaredLength,
        retainedLength,
        mimeType,
    };
    if (chunked) descriptor.transferEncoding = 'chunked';
    const boundary = boundaryOf(mimeType);
    if (boundary) {
        // null when the bytes we hold resolve nothing -- unknown, not empty.
        descriptor.parts = parseMultipartStructure(buf, boundary);
    }
    return descriptor;
}

/**
 * The key that pairs a log entry's descriptor with the SAME request in a HAR
 * this process did not write.
 *
 * Method, URL and declared length. Not `startedDateTime`: the two recorders
 * timestamp from different clocks and at different moments, so equality there
 * is not a property either one guarantees. Chunked uploads repeat the same
 * method and URL many times, so the key is deliberately not unique -- matching
 * consumes descriptors in observation order, which is the order both recorders
 * saw the requests in.
 */
function matchKey(method, url, declaredLength) {
    const declared = declaredLength === null || declaredLength === undefined ? '' : declaredLength;
    return String(method || '').toUpperCase() + ' ' + (url || '') + ' ' + declared;
}

function keyForEntry(entry) {
    const req = (entry && entry.request) || {};
    const get = headerLookup(req.headers);
    return matchKey(req.method, req.url, declaredLengthOf(get));
}

/**
 * Attach descriptors from `logEntries` (the record log) onto `harEntries`.
 *
 * THE POINT OF THIS FUNCTION IS THAT IT RUNS ON BOTH RAW.HAR PATHS.
 *
 * `raw.har` comes either from Playwright's `recordHar` -- buffered in the
 * driver, serialised during `context.close()`, authored by code this process
 * does not run -- or from assembling `raw.ndjson`, which this process does
 * author. There is no moment inside the first path at which an entry can be
 * annotated while it is built. But the descriptor's knowledge does not come
 * from the HAR: it comes from OUR OWN observation of the request, which
 * happened either way, and which is written to `raw.ndjson` -- kept since #377
 * even when `recordHar` wins. So the descriptors are read back out of the log
 * and merged into whichever `raw.har` exists.
 *
 * On the assembled path the entries already carry their descriptors from
 * `buildEntry`, and the merge is a no-op: an entry that already has one is
 * skipped rather than matched again. That idempotence is what lets one call
 * site serve both paths, including the `stop` subcommand, which runs in a
 * DIFFERENT PROCESS from the recorder and so holds no in-memory index at all
 * -- it reads both files from disk exactly as this does.
 *
 * Returns how many entries were annotated.
 */
function attachDescriptors(harEntries, logEntries) {
    const queues = new Map();
    for (const logged of logEntries || []) {
        const descriptor = logged && logged.request && logged.request[DESCRIPTOR_KEY];
        if (!descriptor) continue;
        const key = keyForEntry(logged);
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(descriptor);
    }
    if (!queues.size) return 0;

    let annotated = 0;
    for (const entry of harEntries || []) {
        if (!entry || !entry.request) continue;
        if (entry.request[DESCRIPTOR_KEY]) continue;
        // A TARGET THAT ALREADY CARRIES THE BODY IS NEVER ANNOTATED.
        //
        // The two recorders read the request through genuinely different code
        // paths -- Playwright's own HAR writer inside the driver, and this
        // process's `request.postDataBuffer()` -- which is the entire reason
        // this merge exists. They can therefore disagree, and the disagreement
        // that matters is the one where the driver DID keep the body and our
        // observation did not: attaching `bodyRetained: false` beside a
        // populated `postData` would write a self-contradicting entry, which is
        // the very class of false statement this descriptor exists to remove,
        // arriving from the opposite direction.
        //
        // "Both recorders saw the same request" is an observation about the
        // measured failure mode, not an invariant. It is enforced here rather
        // than argued in a comment.
        if (entry.request.postData) continue;
        const queue = queues.get(keyForEntry(entry));
        if (!queue || !queue.length) continue;
        entry.request[DESCRIPTOR_KEY] = queue.shift();
        annotated++;
        // Correct the false statement in the standard field too, since
        // `bodySize` is what a consumer reads first. Only when it currently
        // claims 0 or says nothing: a recorder that DID measure a body is
        // more authoritative about it than we are.
        if (!entry.request.bodySize) entry.request.bodySize = -1;
    }
    return annotated;
}

module.exports = {
    DESCRIPTOR_KEY,
    describeRequestBody,
    parseMultipartStructure,
    attachDescriptors,
    keyForEntry,
    matchKey,
};
