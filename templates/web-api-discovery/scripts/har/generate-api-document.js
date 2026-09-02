#!/usr/bin/env node
/**
 * generate-api-document.js -- the per-provider description of the SERVER.
 *
 * A HAR is a record of one session. It is not a specification. It carries one
 * account's data, one set of feature flags, one incidental ordering, one
 * moment's persisted-query id -- and two captures of the same flow produce
 * different files that should produce the SAME description of the API. Until
 * something computes that description, nothing in the pipeline can tell
 * "the provider changed" from "this capture differs", and every conformance
 * question is answered by a human reading a capture.
 *
 * This aggregates a provider's committed references into `api.json`: the
 * endpoints, methods, observed statuses, request and response field names,
 * persisted-operation ids, and the credentials a request must carry. Drift is
 * then a diff.
 *
 * GENERATED, NEVER HAND-AUTHORED, for the reason settled for the catalogue in
 * #379: a hand-maintained specification is a fourth artifact free to drift,
 * and it will assert things the references do not contain. Two properties make
 * that rule enforceable, and `--check` enforces both:
 *
 *   IDEMPOTENCE -- regenerating from unchanged references is byte-identical,
 *   so a diff always means something changed. Every collection here has a
 *   DECLARED total order; none inherits the filesystem's. Without this the
 *   check fires on every run and gets disabled, which costs the repository
 *   every other thing the check carries.
 *
 *   TRACEABILITY -- every endpoint, field, credential and persisted id names
 *   the reference and entry that witnesses it, and `--check` RE-OPENS that
 *   entry to confirm the claim is there. That verification is a separate code
 *   path from the aggregation, so it is not the generator marking its own
 *   homework, and a claim somebody typed in by hand cannot survive it.
 *
 * NOTHING MORE AND NOTHING LESS. The document says what the captures PROVED.
 *
 *   - "Nothing more" -- no shape, status or field is described that no entry
 *     carried. Every positive claim names an entry that witnesses it.
 *   - "Nothing less" -- where the captures leave a question OPEN, the document
 *     says so in `unproven` and names the capture that would close it, and
 *     `capturesNeeded` rolls those up into a work list. Silence would let a
 *     reader mistake an untested corner for a settled one, which is the same
 *     defect as an unsupported claim wearing the opposite face.
 *
 * Three decisions that follow, and the reason for each:
 *
 *   - A field observed in one capture and absent in another is recorded with
 *     the witnesses it actually has, counted (`observedIn` of
 *     `observedEntries`), and reported as VARYING. It is labelled NEITHER
 *     "optional" NOR "provider-changed": one corpus cannot tell those apart,
 *     and picking one would put back exactly the guesswork this replaces.
 *   - An error shape nobody provoked is not invented -- but the fact that
 *     nobody provoked one IS recorded, as `no-success-observed` or
 *     `no-response-body-observed`. The gap is the finding.
 *   - Fields are named at the TOP LEVEL only -- form parameters, query
 *     parameters, and the top-level keys of a JSON body. Same depth as
 *     `digest.json`'s payload shape, and the depth at which every claim stays
 *     cheap to re-check against the entry that witnesses it. Going deeper is a
 *     later change, not a quietly wider claim now.
 *
 * The document is per PROVIDER, and the check regenerates the WHOLE provider.
 * Aggregation makes the blast radius wider than it looks: re-scrubbing ONE
 * reference invalidates the document for all of them, so a check that
 * regenerated only what appeared to have changed would be a proxy for the
 * thing it is meant to measure.
 *
 * Usage:
 *   node generate-api-document.js --dir <provider-dir> [--check]
 *
 *   --dir     REQUIRED. The directory holding a provider's `*.har` references.
 *             `api.json` is written beside them. The walk is NOT recursive: a
 *             host folder holds one directory per provider, and each gets its
 *             own document.
 *   --check   Write nothing. Fail when the committed `api.json` is missing,
 *             carries a claim the references do not witness, omits a reference
 *             that is present, or differs from a fresh regeneration.
 *
 * Exit codes:
 *   0 -- generated, or the check passed
 *   1 -- the directory is missing, holds no reference, or a reference cannot
 *        be parsed
 *   2 -- usage error
 *   3 -- one or more check violations (reported on stderr)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const harSecrets = require(path.join(__dirname, 'har-secrets.js'));
// The SAME path templating the digest uses. `api.json` is the aggregate of
// what `digest.json` already computes per session, so a second, subtly
// different notion of "the same endpoint" here would make the two artifacts
// disagree about the API they both describe.
const { pathTemplate } = require(path.join(__dirname, '..', 'capture', 'capture-har.js'));

const DOCUMENT_FILE = 'api.json';
const SCHEMA_VERSION = 1;

/**
 * Parameter names that carry a PERSISTED-OPERATION id.
 *
 * A persisted query is sent as an id rather than as its text, so the id is the
 * only name the operation has on the wire -- and it is the value providers
 * rotate. A client's hard-coded default drifting away from the id live traffic
 * carries is the case this document exists to turn into a diff: the client
 * keeps sending an id the server retired, and nothing reports it until a
 * publish fails.
 *
 * An observed set, not an exhaustive one. A provider spelling it differently
 * is a missing operation, not a wrong one -- the document under-claims rather
 * than inventing, which is the safe direction for an artifact whose whole
 * value is that its claims can be checked.
 */
const PERSISTED_ID_FIELDS = new Set([
    'doc_id', 'docid', 'persisted_query_id', 'query_id', 'queryid', 'sha256hash',
]);

/** Parameter names carrying a human-readable name for the operation above. */
const OPERATION_NAME_FIELDS = new Set([
    'operationname', 'fb_api_req_friendly_name',
]);

/**
 * Headers that carry a credential whatever the provider calls it.
 *
 * `har-secrets.js` knows the provider-specific names; these two are structural
 * and belong to HTTP itself, so neither list is complete without the other.
 */
const CREDENTIAL_HEADERS = new Set(['cookie', 'authorization']);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) usage(`unexpected positional argument '${a}'`);
        const key = a.slice(2);
        const next = argv[i + 1];
        out[key] = next === undefined || next.startsWith('--') ? true : (i++, next);
    }
    return out;
}

function usage(msg) {
    if (msg) console.error(`generate-api-document: ${msg}`);
    console.error('usage: node generate-api-document.js --dir <provider-dir> [--check]');
    process.exit(2);
}

function fail(msg) {
    console.error(`generate-api-document: ${msg}`);
    process.exit(1);
}

/**
 * Every `*.har` in the directory, in filename order, parsed.
 *
 * Being pointed at a directory with no reference is a WIRING MISTAKE, not a
 * pass: an empty document is a specification asserting the API has nothing in
 * it, and it would be committed and believed. Same reading
 * `verify-har-reference.js` takes of an empty reference directory.
 *
 * A reference that will not parse is likewise an error rather than a skip. A
 * committed reference has already been through the leak gate; one that is not
 * JSON any more means something upstream is wrong, and silently omitting it
 * would drop every claim it witnesses without saying so.
 */
function readReferences(dir) {
    let names;
    try {
        names = fs.readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.har'))
            .map((d) => d.name)
            .sort();
    } catch (e) {
        fail(`cannot read directory '${dir}': ${e.message}`);
    }
    if (names.length === 0) fail(`no *.har reference in '${dir}'`);

    return names.map((harFile) => {
        let har;
        try {
            har = JSON.parse(fs.readFileSync(path.join(dir, harFile), 'utf8'));
        } catch (e) {
            fail(`cannot parse '${harFile}': ${e.message}`);
        }
        // Parsing is not enough: a file can be valid JSON and still not be a
        // HAR. Left to the fold, a non-array `entries` threw a raw stack trace
        // -- the right exit code wearing somebody else's error message.
        const entries = (har && har.log && har.log.entries) || [];
        if (!Array.isArray(entries)) fail(`'${harFile}' has a log.entries that is not a list`);
        return { harFile, entries };
    });
}

// ---------------------------------------------------------------------------
// What one entry says
// ---------------------------------------------------------------------------

/** Top-level keys of a JSON payload -- the SHAPE, never the values. */
function topLevelKeys(text) {
    if (typeof text !== 'string' || text.trim() === '') return [];
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return []; }
    const target = Array.isArray(parsed) ? parsed[0] : parsed;
    return target && typeof target === 'object' ? Object.keys(target) : [];
}

const pairs = (list) => (Array.isArray(list) ? list.filter((p) => p && typeof p.name === 'string') : []);

/**
 * The endpoint an entry belongs to, or null when its URL is not one.
 *
 * Returning null rather than guessing keeps a malformed URL out of the
 * document instead of inventing a host for it.
 */
function endpointKeyOf(entry) {
    let url;
    try { url = new URL(entry.request.url); } catch (e) { return null; }
    return { host: url.host, method: entry.request.method, pathTemplate: pathTemplate(url.pathname) };
}

/**
 * Every named field an entry carries on the request side, tagged with where it
 * lives. `in` is part of the claim: a name in the query string and the same
 * name in a form body are different facts about the endpoint, and the check
 * has to know which one to look for.
 */
function requestNamesOf(entry) {
    const req = entry.request || {};
    const out = [];
    for (const p of pairs(req.queryString)) out.push({ name: p.name, in: 'query', value: p.value });
    if (req.postData) {
        for (const p of pairs(req.postData.params)) out.push({ name: p.name, in: 'param', value: p.value });
        for (const k of topLevelKeys(req.postData.text)) out.push({ name: k, in: 'body', value: undefined });
    }
    return out;
}

/**
 * The credentials a request must carry -- NAMES ONLY.
 *
 * The names come from the same list the leak gate uses, so this document and
 * `verify-har-reference.js` cannot disagree about what a credential is. The
 * value is never read: a document that echoed one would relocate the leak into
 * the artifact the containment rule exists to keep clean.
 */
function credentialNamesOf(entry) {
    const req = entry.request || {};
    const out = [];
    for (const h of pairs(req.headers)) {
        const lower = h.name.toLowerCase();
        if (CREDENTIAL_HEADERS.has(lower) || harSecrets.isKnownSecretHeader(lower)) {
            out.push({ name: lower, in: 'header' });
        }
    }
    for (const c of pairs(req.cookies)) {
        if (harSecrets.isKnownSecretField(c.name)) out.push({ name: c.name, in: 'cookie' });
    }
    // Every place a request can name a field, body included. Classification
    // needs the NAME, which a top-level JSON key already gives -- excluding
    // bodies described a provider's CSRF token as ordinary API surface, and a
    // GraphQL API that posts JSON rather than form-encoding is exactly where
    // that lands (found by independent review).
    for (const f of requestNamesOf(entry)) {
        if (harSecrets.isKnownSecretField(f.name)) out.push({ name: f.name, in: f.in });
    }
    return out;
}

/** The persisted-operation ids an entry carries, with a name when it has one. */
function operationsOf(entry) {
    const fields = requestNamesOf(entry);
    const name = fields.find((f) => OPERATION_NAME_FIELDS.has(f.name.toLowerCase())
        && typeof f.value === 'string' && f.value !== '');
    return fields
        .filter((f) => PERSISTED_ID_FIELDS.has(f.name.toLowerCase())
            && typeof f.value === 'string' && f.value !== '')
        .map((f) => ({ persistedId: f.value, name: name ? name.value : null }));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Does this entry carry a request body at all?
 *
 * `{}` and `[]` are legal minimal bodies, so emptiness is measured on the
 * absence of postData rather than on the length of its text.
 */
function hasRequestBody(entry) {
    const post = entry.request && entry.request.postData;
    if (!post) return false;
    return (Array.isArray(post.params) && post.params.length > 0)
        || (typeof post.text === 'string' && post.text.length > 0);
}

function responseText(entry) {
    const content = entry.response && entry.response.content;
    return (content && typeof content.text === 'string' && content.text.length > 0)
        ? content.text : '';
}

/**
 * A capped response, in the STRUCTURAL spelling the reference contract
 * requires. A field list derived from a capped body is partial by
 * construction, and a document that did not say so would present a prefix as
 * the whole shape.
 */
function isTruncated(entry) {
    const content = entry.response && entry.response.content;
    return !!(content && content.truncated);
}

/** Methods for which a missing request body is a HOLE rather than normal. */
const BODY_BEARING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * At most ONE witness per reference per claim: the first entry in that file
 * that carries it.
 *
 * A field appearing in five hundred entries does not need five hundred
 * citations -- and a document whose size tracked entry count rather than API
 * surface would stop being reviewable, which is half of why it exists. What a
 * reader needs is WHICH REFERENCE witnesses the claim, and one checkable entry
 * per reference is exactly that.
 */
function addWitness(claim, harFile, entry) {
    if (!claim.witnesses.some((w) => w.harFile === harFile)) claim.witnesses.push({ harFile, entry });
}

function claimIn(map, key, make) {
    let claim = map.get(key);
    if (!claim) { claim = Object.assign(make(), { witnesses: [] }); map.set(key, claim); }
    return claim;
}

/** A fresh endpoint, with one accumulator per kind of claim it can carry. */
function newEndpoint(key) {
    return Object.assign({}, key, {
        // Counters, because a reader needs to know how THIN the evidence is.
        // "This field was seen" and "this field was seen in one of eleven
        // calls" are different facts, and only the second says whether the
        // captures settled anything.
        observedEntries: 0,
        requestBodyEntries: 0,
        responseBodyEntries: 0,
        truncatedResponses: 0,
        statuses: new Set(),
        requestContentTypes: new Set(),
        responseContentTypes: new Set(),
        credentialFields: new Map(),
        operations: new Map(),
        requestFields: new Map(),
        responseFields: new Map(),
    });
}

/**
 * The request side: every named thing the request carries, split into the
 * credentials it must present and the ordinary fields it sends.
 *
 * A credential is NOT also an ordinary request field. Listing one twice would
 * read as two facts about the endpoint when it is one, and the second listing
 * would say nothing the first does not.
 */
function absorbRequestNames(endpoint, entry, harFile, index) {
    const credentials = credentialNamesOf(entry);
    for (const c of credentials) {
        addWitness(claimIn(endpoint.credentialFields, `${c.in}|${c.name}`,
            () => ({ name: c.name, in: c.in })), harFile, index);
    }

    const isCredential = new Set(credentials.map((c) => `${c.in}|${c.name}`));
    for (const f of requestNamesOf(entry)) {
        if (isCredential.has(`${f.in}|${f.name}`)) continue;
        const claim = claimIn(endpoint.requestFields, `${f.in}|${f.name}`,
            () => ({ name: f.name, in: f.in, observedIn: 0 }));
        claim.observedIn++;
        addWitness(claim, harFile, index);
    }
}

/** Fold everything one entry says about its endpoint into the accumulators. */
function absorbEntry(endpoint, entry, harFile, index) {
    addWitness(endpoint, harFile, index);
    endpoint.observedEntries++;
    if (hasRequestBody(entry)) endpoint.requestBodyEntries++;
    if (responseText(entry)) endpoint.responseBodyEntries++;
    if (isTruncated(entry)) endpoint.truncatedResponses++;

    const status = (entry.response && entry.response.status) || 0;
    if (status) endpoint.statuses.add(status);

    const requestMime = entry.request.postData && entry.request.postData.mimeType;
    if (requestMime) endpoint.requestContentTypes.add(requestMime);
    const responseMime = entry.response && entry.response.content && entry.response.content.mimeType;
    if (responseMime) endpoint.responseContentTypes.add(responseMime);

    absorbRequestNames(endpoint, entry, harFile, index);

    for (const k of topLevelKeys(entry.response && entry.response.content
        && entry.response.content.text)) {
        addWitness(claimIn(endpoint.responseFields, k, () => ({ name: k })), harFile, index);
    }

    for (const op of operationsOf(entry)) {
        const claim = claimIn(endpoint.operations, op.persistedId,
            () => ({ persistedId: op.persistedId, name: op.name }));
        // The first reference to name the operation names it. A later capture
        // of the same persisted id that omits the friendly name must not erase
        // a name an earlier one witnessed.
        if (!claim.name && op.name) claim.name = op.name;
        addWitness(claim, harFile, index);
    }
}

function buildDocument(provider, references) {
    const endpoints = new Map();

    for (const { harFile, entries } of references) {
        entries.forEach((entry, index) => {
            const key = endpointKeyOf(entry);
            if (!key) return;
            const id = `${key.host}|${key.method}|${key.pathTemplate}`;
            absorbEntry(claimIn(endpoints, id, () => newEndpoint(key)), entry, harFile, index);
        });
    }

    const emitted = [...endpoints.values()].sort(byEndpoint).map(emitEndpoint);
    return {
        schemaVersion: SCHEMA_VERSION,
        provider,
        references: references.map((r) => ({ harFile: r.harFile, entryCount: r.entries.length })),
        capturesNeeded: capturesNeeded(emitted),
        endpoints: emitted,
    };
}

/**
 * The holes, rolled up into a work list.
 *
 * Per-endpoint holes say what is unknown; this says what to go and RECORD. A
 * reader asking "what capture is missing" should not have to walk every
 * endpoint to assemble the answer, and a list nobody can act on is a list
 * nobody reads.
 */
function capturesNeeded(endpoints) {
    const byAction = new Map();
    for (const endpoint of endpoints) {
        for (const gap of endpoint.unproven) {
            const at = `${endpoint.method} ${endpoint.host}${endpoint.pathTemplate}`;
            let row = byAction.get(gap.closedBy);
            if (!row) { row = { capture: gap.closedBy, endpoints: [] }; byAction.set(gap.closedBy, row); }
            if (!row.endpoints.includes(at)) row.endpoints.push(at);
        }
    }
    return [...byAction.values()]
        .map((r) => ({ capture: r.capture, endpoints: r.endpoints.slice().sort() }))
        .sort((a, b) => compare(a.capture, b.capture));
}

// Declared total orders. Every one of these is load-bearing: the map iteration
// they replace follows the order the references happened to be read in, and a
// document that reordered itself when a file was renamed would churn a diff
// on every run.
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byEndpoint = (a, b) => compare(a.host, b.host) || compare(a.pathTemplate, b.pathTemplate)
    || compare(a.method, b.method);
const byPlacedName = (a, b) => compare(a.in, b.in) || compare(a.name, b.name);
const byName = (a, b) => compare(a.name, b.name);
/**
 * Witnesses need no sort of their own: references are read in filename order
 * and at most one witness per reference is recorded, so the list is already in
 * the declared order by construction. A sort here would be a branch no test
 * could ever falsify.
 */
function emitWitnesses(claim) {
    return claim.witnesses.slice();
}

/**
 * What the captures did NOT establish about this endpoint.
 *
 * The document is authoritative about what the references PROVED -- nothing
 * more and nothing less. "Nothing more" is satisfied by describing only what
 * was observed. "Nothing less" is this: where the captures leave a question
 * open, the document SAYS SO and names the capture that would close it, so the
 * hole is a work item rather than a silence a reader mistakes for
 * completeness.
 *
 * Every hole here is DERIVED from the entries, never guessed, and each is
 * re-checkable against them -- `--check` rejects a hole the captures
 * contradict exactly as it rejects an invented endpoint. A hole is a claim
 * about the references too.
 *
 * What is deliberately NOT here: any word that resolves a question the
 * captures left open. A field present in some calls and absent in others is
 * reported as VARYING, never as "optional" -- one corpus cannot tell an
 * optional field from a provider that changed, and picking one would be the
 * guesswork this artifact exists to replace.
 */
function gapsFor(endpoint) {
    const gaps = [];
    const add = (kind, subjects, detail, closedBy) => gaps.push({
        kind, subjects: subjects.slice().sort(), detail, closedBy,
        witnesses: emitWitnesses(endpoint),
    });

    if (![...endpoint.statuses].some((s) => s >= 200 && s < 300)) {
        add('no-success-observed', [],
            `every observed status is ${[...endpoint.statuses].sort((a, b) => a - b).join(', ') || 'absent'}; `
            + 'no successful response has been captured, so the success shape is unknown',
            'capture a successful call to this endpoint');
    }

    if (BODY_BEARING_METHODS.has(endpoint.method) && endpoint.requestBodyEntries === 0) {
        add('no-request-body-observed', [],
            `none of the ${endpoint.observedEntries} observed call(s) carried a request body, `
            + 'so nothing is known about what a caller must send',
            'capture this operation with the request body preserved -- a reference whose '
            + 'request side is empty cannot be replayed or diffed');
    }

    if (endpoint.responseBodyEntries === 0) {
        add('no-response-body-observed', [],
            `none of the ${endpoint.observedEntries} observed call(s) retained a response body`,
            'capture a call whose response body is kept');
    }

    if (endpoint.truncatedResponses > 0) {
        add('response-truncated', [],
            `${endpoint.truncatedResponses} observed response(s) were capped, so the response `
            + 'field list is a prefix of the real shape, not the whole of it',
            're-capture without a response cap');
    }

    const unnamed = [...endpoint.operations.values()]
        .filter((o) => !o.name).map((o) => o.persistedId);
    if (unnamed.length > 0) {
        add('operation-name-unknown', unnamed,
            `persisted id(s) ${unnamed.slice().sort().join(', ')} were observed with no `
            + 'accompanying operation name, so what they DO is unknown',
            'capture a call that carries the operation name alongside the persisted id');
    }

    const varying = [...endpoint.requestFields.values()]
        .filter((f) => f.observedIn > 0 && f.observedIn < endpoint.observedEntries)
        .map((f) => f.name);
    if (varying.length > 0) {
        add('request-field-presence-varies', varying,
            `${varying.slice().sort().join(', ')} appear in some observed calls and not others `
            + `(of ${endpoint.observedEntries} observed); whether that is a per-call difference `
            + 'or a change on the provider side is not established by these captures',
            'capture the same operation again and compare -- one corpus cannot tell the two apart');
    }

    return gaps.sort((a, b) => compare(a.kind, b.kind));
}

function emitEndpoint(endpoint) {
    return {
        host: endpoint.host,
        method: endpoint.method,
        pathTemplate: endpoint.pathTemplate,
        observedEntries: endpoint.observedEntries,
        statuses: [...endpoint.statuses].sort((a, b) => a - b),
        requestContentTypes: [...endpoint.requestContentTypes].sort(),
        responseContentTypes: [...endpoint.responseContentTypes].sort(),
        credentialFields: [...endpoint.credentialFields.values()].sort(byPlacedName)
            .map((c) => ({ name: c.name, in: c.in, witnesses: emitWitnesses(c) })),
        operations: [...endpoint.operations.values()]
            .sort((a, b) => compare(a.persistedId, b.persistedId))
            .map((o) => ({ persistedId: o.persistedId, name: o.name || null, witnesses: emitWitnesses(o) })),
        requestFields: [...endpoint.requestFields.values()].sort(byPlacedName)
            .map((f) => ({
                name: f.name, in: f.in, observedIn: f.observedIn, witnesses: emitWitnesses(f),
            })),
        responseFields: [...endpoint.responseFields.values()].sort(byName)
            .map((f) => ({ name: f.name, witnesses: emitWitnesses(f) })),
        unproven: gapsFor(endpoint),
        witnesses: emitWitnesses(endpoint),
    };
}

function serialize(doc) {
    return JSON.stringify(doc, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Does the entry a claim names actually carry it?
 *
 * This is deliberately NOT a call back into the aggregation above. A check
 * that re-ran the generator could only ever say "the file differs"; re-opening
 * the named entry and looking for the claim is what makes a hand-planted claim
 * fail and what lets the failure name WHICH claim has no support.
 *
 * BE PRECISE ABOUT WHAT THAT BUYS. This is independent of the FOLD -- the
 * accumulation, the witness bookkeeping, the ordering -- but it shares the
 * extraction primitives (`endpointKeyOf`, `requestNamesOf`, `credentialNamesOf`,
 * `topLevelKeys`) with it. A mistake INSIDE one of those would be made
 * identically on both sides and would not be caught here. The byte comparison
 * against a fresh regeneration is the backstop for that class, which is why
 * `--check` runs both and reports both rather than short-circuiting on either.
 */
function entrySupports(entry, endpoint, claim, kind) {
    const key = endpointKeyOf(entry);
    if (!key || key.host !== endpoint.host || key.method !== endpoint.method
        || key.pathTemplate !== endpoint.pathTemplate) return false;

    if (kind === 'endpoint') return true;
    if (kind === 'responseField') {
        return topLevelKeys(entry.response && entry.response.content
            && entry.response.content.text).includes(claim.name);
    }
    if (kind === 'operation') {
        return requestNamesOf(entry).some((f) => PERSISTED_ID_FIELDS.has(f.name.toLowerCase())
            && f.value === claim.persistedId);
    }
    if (kind === 'credentialField') {
        return credentialNamesOf(entry).some((c) => c.name === claim.name && c.in === claim.in);
    }
    // An ordinary request field is one the entry carries AND that is not a
    // credential. Without the second half a credential re-listed as a plain
    // field was supported here and left to the byte comparison to notice --
    // which reports that the file differs, never which claim is wrong.
    if (credentialNamesOf(entry).some((c) => c.name === claim.name && c.in === claim.in)) return false;
    return requestNamesOf(entry).some((f) => f.name === claim.name && f.in === claim.in);
}

function describeClaim(endpoint, claim, kind) {
    const at = `${endpoint.method} ${endpoint.host}${endpoint.pathTemplate}`;
    if (kind === 'endpoint') return `endpoint ${at}`;
    if (kind === 'gap') return `unproven '${claim.kind}' on ${at}`;
    if (kind === 'operation') return `persisted id '${claim.persistedId}' on ${at}`;
    return `${kind} '${claim.name}' on ${at}`;
}

/**
 * Every claim in the committed document, checked against the references on
 * disk; every reference on disk, checked for representation in the document.
 *
 * Both directions matter and neither implies the other. A claim with no
 * witness is a specification asserting something the artifacts do not contain
 * -- the defect class that let four hollow references carry catalogue rows
 * describing request-side behaviour the files have none of. A reference with
 * no representation is the opposite failure: ground truth nobody described.
 */
/**
 * Re-derive a hole from the references, independently of the fold that emitted
 * it.
 *
 * A hole asserts something about the WHOLE endpoint ("no call succeeded"), not
 * about one entry, so it is checked by re-walking every entry that belongs to
 * the endpoint rather than by opening the entries it cites. An unrecognised
 * kind is a violation: a hand-written hole spelled in a vocabulary the
 * generator does not produce is exactly the invented claim this rejects.
 */
function gapHolds(references, endpoint, gap) {
    const entries = [];
    for (const { entries: list } of references) {
        for (const entry of list) {
            const key = endpointKeyOf(entry);
            if (key && key.host === endpoint.host && key.method === endpoint.method
                && key.pathTemplate === endpoint.pathTemplate) entries.push(entry);
        }
    }
    const subjects = Array.isArray(gap.subjects) ? gap.subjects : [];
    const carriesName = (entry) => requestNamesOf(entry).some(
        (f) => OPERATION_NAME_FIELDS.has(f.name.toLowerCase()) && f.value);

    switch (gap.kind) {
    case 'no-success-observed':
        return !entries.some((e) => {
            const s = (e.response && e.response.status) || 0;
            return s >= 200 && s < 300;
        });
    case 'no-request-body-observed':
        return BODY_BEARING_METHODS.has(endpoint.method) && !entries.some(hasRequestBody);
    case 'no-response-body-observed':
        return !entries.some(responseText);
    case 'response-truncated':
        return entries.some(isTruncated);
    case 'operation-name-unknown':
        return subjects.length > 0 && subjects.every((id) => !entries.some(
            (e) => carriesName(e) && requestNamesOf(e).some(
                (f) => PERSISTED_ID_FIELDS.has(f.name.toLowerCase()) && f.value === id)));
    case 'request-field-presence-varies':
        return subjects.length > 0 && subjects.every((name) => {
            const seen = entries.filter((e) => requestNamesOf(e).some((f) => f.name === name)).length;
            return seen > 0 && seen < entries.length;
        });
    default:
        return false;
    }
}

/** Every claim an endpoint carries, paired with the kind that says how to check it. */
function claimsOf(endpoint) {
    const claims = [[endpoint, 'endpoint']];
    for (const c of endpoint.requestFields || []) claims.push([c, 'requestField']);
    for (const c of endpoint.responseFields || []) claims.push([c, 'responseField']);
    for (const c of endpoint.credentialFields || []) claims.push([c, 'credentialField']);
    for (const c of endpoint.operations || []) claims.push([c, 'operation']);
    return claims;
}

/** One claim, checked against every entry it names. */
function verifyClaim(byFile, endpoint, claim, kind) {
    const what = describeClaim(endpoint, claim, kind);
    const witnesses = Array.isArray(claim.witnesses) ? claim.witnesses : [];
    if (witnesses.length === 0) {
        return [`${what} names no witness; every claim must name a reference and entry`];
    }

    const violations = [];
    for (const w of witnesses) {
        const entries = byFile.get(w && w.harFile);
        if (!entries) {
            violations.push(`${what} is witnessed by '${w && w.harFile}', which is not a reference in this directory`);
        } else if (!Number.isInteger(w.entry) || w.entry < 0 || w.entry >= entries.length) {
            violations.push(`${what} names entry ${w.entry} of '${w.harFile}', which has ${entries.length} entries`);
        } else if (!entrySupports(entries[w.entry], endpoint, claim, kind)) {
            violations.push(`${what} is not supported by entry ${w.entry} of '${w.harFile}'`);
        }
    }
    return violations;
}

/** The reference direction: what is on disk and what the document says is. */
function verifyRepresentation(committed, byFile) {
    const violations = [];
    const described = new Set((committed.references || []).map((r) => r && r.harFile));
    for (const harFile of byFile.keys()) {
        if (!described.has(harFile)) {
            violations.push(`reference '${harFile}' is present in the directory but has no representation in ${DOCUMENT_FILE}`);
        }
    }
    for (const r of committed.references || []) {
        if (!byFile.has(r && r.harFile)) {
            violations.push(`${DOCUMENT_FILE} names reference '${r && r.harFile}', which does not exist`);
        }
    }
    return violations;
}

/**
 * Every claim in the committed document, checked against the references on
 * disk; every reference on disk, checked for representation in the document.
 *
 * Both directions matter and neither implies the other. A claim with no
 * witness is a specification asserting something the artifacts do not contain
 * -- the defect class that let four hollow references carry catalogue rows
 * describing request-side behaviour the files have none of. A reference with
 * no representation is the opposite failure: ground truth nobody described.
 */
function verifyTraceability(committed, references) {
    const byFile = new Map(references.map((r) => [r.harFile, r.entries]));
    const violations = [];
    for (const endpoint of committed.endpoints || []) {
        for (const [claim, kind] of claimsOf(endpoint)) {
            violations.push(...verifyClaim(byFile, endpoint, claim, kind));
        }
        for (const gap of endpoint.unproven || []) {
            if (!gapHolds(references, endpoint, gap)) {
                violations.push(`${describeClaim(endpoint, gap, 'gap')} is contradicted by the references`);
            }
        }
    }
    violations.push(...verifyRepresentation(committed, byFile));
    return violations;
}

function check(dir, references, regenerated) {
    const file = path.join(dir, DOCUMENT_FILE);
    if (!fs.existsSync(file)) {
        return [`${DOCUMENT_FILE} has never been generated; run without --check to create it`];
    }

    const text = fs.readFileSync(file, 'utf8');
    let committed;
    try {
        committed = JSON.parse(text);
    } catch (e) {
        return [`${DOCUMENT_FILE} is not parseable JSON: ${e.message}`];
    }

    // Traceability FIRST, and the stale comparison after, both reported. A
    // planted claim also makes the regeneration differ, and a check that
    // short-circuited on the byte comparison would tell a reader only to run
    // the generator -- never which claim had no support.
    const violations = verifyTraceability(committed, references);
    if (text !== regenerated) {
        violations.push(`${DOCUMENT_FILE} is stale: regenerating from the references in this directory produces a different document`);
    }
    return violations;
}

// ---------------------------------------------------------------------------

function main(argv) {
    const args = parseArgs(argv);
    if (!args.dir || args.dir === true) usage('--dir is required');

    const dir = path.resolve(args.dir);
    const references = readReferences(dir);
    const document = serialize(buildDocument(path.basename(dir), references));

    if (args.check) {
        const violations = check(dir, references, document);
        if (violations.length > 0) {
            for (const v of violations) console.error(`generate-api-document: ${v}`);
            process.exit(3);
        }
        console.log(`${path.join(dir, DOCUMENT_FILE)}: up to date, every claim witnessed`);
        return;
    }

    fs.writeFileSync(path.join(dir, DOCUMENT_FILE), document, 'utf8');
    console.log(`${path.join(dir, DOCUMENT_FILE)}: ${references.length} reference(s)`);
}

module.exports = { buildDocument, serialize, verifyTraceability, readReferences };

// Only run as a command when invoked as one: requiring this module from a test
// must not write a document or print a usage error.
if (require.main === module) main(process.argv.slice(2));
