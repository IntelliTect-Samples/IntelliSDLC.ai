#!/usr/bin/env node
/**
 * generate-wrapper.js -- HAR -> C# wrapper project codegen pipeline.
 *
 * Pipeline:
 *   1. Load HAR(s) + auth-detection JSON + project metadata.
 *   2. Extract endpoints, detect GraphQL, dedup path patterns.
 *   3. Infer + merge JSON shapes -> typed models.
 *   4. Emit Client.Generated.cs + Models.Generated.cs (partial classes).
 *   5. Substitute existing csharp/*.tmpl files (Client.cs, ISessionStore.cs, etc.).
 *   6. Emit .csproj with NuGet metadata.
 *   7. Emit README.md (recipes + polite-crawl note).
 *   8. Emit tests/fixtures/*.json (one per endpoint).
 *
 * Deterministic: same HAR + flags = byte-identical output. Stable sort, no timestamps in output.
 *
 * Usage:
 *   node generate-wrapper.js --har <p1[,p2,...]> --out <dir> \
 *     --project-name <Name> --namespace <Ns> --base-url <https://x> \
 *     [--auth-model cookie|cookie+csrf|bearer|...] [--auth-detection <path>] \
 *     [--authors <s>] [--description <s>] [--repository-url <s>] [--package-tags <s>]
 *
 * Zero npm deps. Pure Node stdlib.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { emitTestScaffold } = require('./tests-emit.js');
const { emitSolution } = require('./sln-emit.js');
const { emitSecretGate, secretGateReadmeSection } = require('./secret-gate-emit.js');
const { sdlcIntegrationReadmeSection } = require('./sdlc-integration.js');
const { detectAntiBotCookies } = require('./detect-auth.js');

// -------------------- CLI --------------------

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) { out[key] = true; }
            else { out[key] = next; i++; }
        }
    }
    return out;
}

function fail(msg) { console.error('generate-wrapper: ' + msg); process.exit(1); }

// -------------------- Consumer .gitignore maintenance --------------------

// Entries this skill owns. They live in the consumer's repo-root .gitignore
// (not upstream IntelliSDLC.ai's .gitignore -- moved here per issue #119) so
// only repos that actually scaffold a wrapper carry them.
//
// - Samples/HAR-Original/    real captures, always contain real PII/tokens.
// - Samples/MobileApp-Binaries/  downloaded apk/ipa binaries; documented as
//                            "always gitignored" in SKILL.md Phase 1.
const SCAFFOLD_GITIGNORE_ENTRIES = [
    'Samples/HAR-Original/',
    'Samples/MobileApp-Binaries/',
];

function ensureRepoRootGitignoreHasScaffoldEntries(outDir, entries) {
    // Idempotent: appends only entries that are not already present (exact
    // line match, ignoring leading/trailing whitespace). Creates the file
    // when absent. Returns the array of entries actually added (empty when
    // already in sync).
    const list = entries || SCAFFOLD_GITIGNORE_ENTRIES;
    const target = path.join(outDir, '.gitignore');
    let existing = '';
    let hadFile = false;
    if (fs.existsSync(target)) {
        existing = fs.readFileSync(target, 'utf8');
        hadFile = true;
    }
    const present = new Set(
        existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    );
    const missing = list.filter((e) => !present.has(e.trim()));
    if (missing.length === 0) return [];
    // Detect existing line ending. Default LF.
    const eol = /\r\n/.test(existing) ? '\r\n' : '\n';
    let block = '';
    if (hadFile && existing.length > 0 && !existing.endsWith('\n') && !existing.endsWith('\r')) {
        block += eol;
    }
    if (hadFile && existing.length > 0) {
        block += eol;
        block += '# Added by api-wrapper-scaffold (see .github/skills/api-wrapper-scaffold/SKILL.md).' + eol;
        block += '# HAR-Original/ contains real PII; MobileApp-Binaries/ contains downloaded apk/ipa.' + eol;
    } else {
        block += '# Added by api-wrapper-scaffold (see .github/skills/api-wrapper-scaffold/SKILL.md).' + eol;
        block += '# HAR-Original/ contains real PII; MobileApp-Binaries/ contains downloaded apk/ipa.' + eol;
    }
    block += missing.join(eol) + eol;
    fs.writeFileSync(target, existing + block);
    return missing;
}

// -------------------- HAR loading --------------------

function loadHar(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const sha = crypto.createHash('sha256').update(text).digest('hex');
    return { har: JSON.parse(text), sha, path: filePath };
}

function* iterEntries(harBundles) {
    for (const b of harBundles) {
        const entries = (b.har && b.har.log && b.har.log.entries) || [];
        for (const e of entries) { yield { entry: e, sourceSha: b.sha }; }
    }
}

// -------------------- Endpoint extraction + GraphQL detection --------------------

function isGraphQL(entry) {
    const req = entry.request || {};
    if (req.method !== 'POST') return false;
    const ct = headerValue(req.headers, 'content-type') || '';
    if (ct.toLowerCase().includes('application/graphql')) return true;
    const body = req.postData && req.postData.text;
    if (!body) return false;
    try {
        const parsed = JSON.parse(body);
        return typeof parsed === 'object' && parsed !== null && typeof parsed.query === 'string';
    } catch { return false; }
}

function headerValue(headers, name) {
    if (!Array.isArray(headers)) return null;
    const lname = name.toLowerCase();
    for (const h of headers) {
        if (h && typeof h.name === 'string' && h.name.toLowerCase() === lname) return h.value;
    }
    return null;
}

function parseUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        // Split path into segments, drop empty leading segment.
        const segs = u.pathname.split('/').filter(Boolean);
        return { host: u.host, segments: segs, pathname: u.pathname };
    } catch { return null; }
}

// -------------------- Path-pattern dedup --------------------

// A segment is a likely path param if it matches one of these intrinsic patterns
// OR if it varies while neighboring segments are stable across captures.
const INTRINSIC_PARAM = [
    { re: /^\d+$/, type: 'int', name: 'id' },
    { re: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, type: 'string', name: 'id' },
    { re: /^[0-9a-fA-F]{24,}$/, type: 'string', name: 'id' }, // long hex (mongo ObjectId, etc.)
];

function classifySegment(seg) {
    for (const p of INTRINSIC_PARAM) { if (p.re.test(seg)) return p; }
    return null;
}

// "Opaque id-like" -- numeric, hex, UUID, or base64-ish noise lacking vowel runs.
// These are the values we are confident represent a path *parameter*, not a
// stable resource name. (See issue #62: TripIt endpoints like `appConfig`,
// `gtmDataAsJson`, `purchasedProductInfo` were being mis-classified as `{id}`.)
function isOpaqueIdLike(seg) {
    if (typeof seg !== 'string' || seg.length === 0) return false;
    if (/^\d+$/.test(seg)) return true;                                    // all-numeric
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(seg)) return true; // UUID
    if (/^[0-9a-fA-F]{24,}$/.test(seg)) return true;                       // long hex (ObjectId, sha, etc.)
    // base64-ish noise: >= 8 chars from the base64url alphabet with no vowel anywhere.
    if (/^[A-Za-z0-9_-]{8,}$/.test(seg) && !/[aeiouyAEIOUY]/.test(seg)) return true;
    return false;
}

// "Named segment" -- looks like a stable identifier word a developer would
// hand-write as a literal path segment (e.g. `appConfig`, `gtmDataAsJson`).
function isNamedSegment(seg) {
    if (typeof seg !== 'string') return false;
    if (!/^[A-Za-z][A-Za-z0-9]{2,}$/.test(seg)) return false;
    return !isOpaqueIdLike(seg);
}

/**
 * Group entries by (method, host, segCount) then within each group find segments
 * that should collapse to {param}. Returns array of pattern descriptors:
 *   { method, host, segments: [{ literal: 'users' } | { param: 'id', type: 'int' }], samples: [entry,...] }
 */
function dedupePatterns(restEntries) {
    const groups = new Map();
    for (const item of restEntries) {
        const u = parseUrl(item.entry.request.url);
        if (!u) continue;
        const key = item.entry.request.method + ' ' + u.host + ' /' + u.segments.length;
        let g = groups.get(key);
        if (!g) { g = { method: item.entry.request.method, host: u.host, len: u.segments.length, items: [] }; groups.set(key, g); }
        g.items.push({ ...item, url: u });
    }

    const patterns = [];
    // Sort groups for deterministic output: by method then host then path.
    const sortedKeys = Array.from(groups.keys()).sort();
    for (const key of sortedKeys) {
        const g = groups.get(key);
        for (const p of processGroup(g)) patterns.push(p);
    }

    // Now merge patterns that have identical (method, host, segments-shape).
    const merged = new Map();
    for (const p of patterns) {
        const sig = patternSignature(p);
        const ex = merged.get(sig);
        if (ex) { ex.samples.push(...p.samples); }
        else { merged.set(sig, p); }
    }
    return Array.from(merged.values()).sort((a, b) =>
        patternSignature(a).localeCompare(patternSignature(b)));
}

// Process one (method, host, segCount) group into one or more pattern descriptors.
// If a varying segment index contains named-looking values (and no opaque values),
// split the group by that segment's value and recurse so each named value becomes
// its own pattern with a literal segment at that index. (Issue #62.)
function processGroup(g) {
    for (let i = 0; i < g.len; i++) {
        const values = g.items.map((it) => it.url.segments[i]);
        const unique = Array.from(new Set(values));
        if (unique.length <= 1) continue;
        // Intrinsic param (all values match same intrinsic) -> param, no split.
        const intrinsics = values.map(classifySegment);
        if (intrinsics.every((x) => x) && allSameType(intrinsics)) continue;
        // Opaque varying (e.g. /trip/123 vs /trip/456) -> param, no split.
        if (values.every(isOpaqueIdLike)) continue;
        // Named varying with no opaque mixed in -> split this group by segment value
        // so each becomes a distinct pattern with a literal segment here.
        if (unique.every(isNamedSegment)) {
            const subgroups = new Map();
            for (const it of g.items) {
                const v = it.url.segments[i];
                if (!subgroups.has(v)) {
                    subgroups.set(v, { method: g.method, host: g.host, len: g.len, items: [] });
                }
                subgroups.get(v).items.push(it);
            }
            const result = [];
            // Deterministic order: sort by segment value.
            const sortedSubKeys = Array.from(subgroups.keys()).sort();
            for (const k of sortedSubKeys) {
                for (const p of processGroup(subgroups.get(k))) result.push(p);
            }
            return result;
        }
        // Mixed (some named, some opaque, or unclassifiable) -> fall through to
        // legacy behavior, which will emit {id} for this index.
    }

    // No named-split applied; build segDescs from this group as a single pattern.
    const segDescs = [];
    for (let i = 0; i < g.len; i++) {
        const values = g.items.map((it) => it.url.segments[i]);
        const unique = Array.from(new Set(values));
        const intrinsics = values.map(classifySegment);
        if (intrinsics.every((x) => x) && allSameType(intrinsics)) {
            segDescs.push({ param: intrinsics[0].name, type: intrinsics[0].type });
        } else if (unique.length === 1) {
            segDescs.push({ literal: unique[0] });
        } else if (unique.length > 1 && g.items.length >= 2) {
            // Varies across captures with same len -> path param. Guess type.
            const allInts = values.every((v) => /^\d+$/.test(v));
            segDescs.push({ param: 'id', type: allInts ? 'int' : 'string' });
        } else {
            segDescs.push({ literal: unique[0] });
        }
    }
    // Disambiguate duplicate param names (rare): id, id2, id3...
    let idCount = 0;
    for (const s of segDescs) {
        if (s.param) {
            if (idCount > 0) s.param = s.param + (idCount + 1);
            idCount++;
        }
    }
    return [{
        method: g.method,
        host: g.host,
        segments: segDescs,
        samples: g.items,
    }];
}

function allSameType(intrinsics) {
    const t = intrinsics[0].type;
    return intrinsics.every((x) => x.type === t);
}

function patternSignature(p) {
    const path = '/' + p.segments.map((s) => s.literal ? s.literal : '{' + s.param + '}').join('/');
    return p.method + ' ' + p.host + ' ' + path;
}

function patternPath(p) {
    return '/' + p.segments.map((s) => s.literal ? s.literal : '{' + s.param + '}').join('/');
}

// -------------------- JSON shape inference + merge --------------------

/**
 * Infer a shape descriptor from a JSON value:
 *   { kind: 'object', fields: { name: { type, nullable, optional } } }
 *   { kind: 'array', element: shape }
 *   { kind: 'primitive', type: 'string'|'int'|'long'|'double'|'bool', nullable }
 *   { kind: 'unknown' }
 */
function inferShape(val) {
    if (val === null) return { kind: 'primitive', type: 'object', nullable: true };
    if (Array.isArray(val)) {
        if (val.length === 0) return { kind: 'array', element: { kind: 'unknown' } };
        let acc = inferShape(val[0]);
        for (let i = 1; i < val.length; i++) acc = mergeShapes(acc, inferShape(val[i]));
        return { kind: 'array', element: acc };
    }
    const t = typeof val;
    if (t === 'string')  return { kind: 'primitive', type: 'string', nullable: false };
    if (t === 'boolean') return { kind: 'primitive', type: 'bool', nullable: false };
    if (t === 'number') {
        if (Number.isInteger(val)) {
            return { kind: 'primitive', type: (Math.abs(val) > 2147483647 ? 'long' : 'int'), nullable: false };
        }
        return { kind: 'primitive', type: 'double', nullable: false };
    }
    if (t === 'object') {
        const fields = {};
        const keys = Object.keys(val).sort();
        for (const k of keys) {
            const sub = inferShape(val[k]);
            // Field-level nullability: was THIS field observed as null in this sample?
            // (Distinct from primitive shape.nullable, which is the value-side flag and
            // gets lost when a null sample is merged with an object/array sample.)
            fields[k] = { shape: sub, optional: false, presentCount: 1, nullable: val[k] === null };
        }
        return { kind: 'object', fields, sampleCount: 1 };
    }
    return { kind: 'unknown' };
}

function isNullSentinel(s) {
    return !!s && s.kind === 'primitive' && s.type === 'object' && s.nullable === true;
}

function mergeShapes(a, b) {
    if (!a || a.kind === 'unknown') return b;
    if (!b || b.kind === 'unknown') return a;
    if (a.kind !== b.kind) {
        // A `null` JSON value infers as { kind:'primitive', type:'object', nullable:true }.
        // When merged against a real object/array shape from another sample, prefer the
        // real shape and let field-level nullability tracking record the null observation
        // (otherwise the shape collapses to JsonElement and the diff is lost).
        if (isNullSentinel(a)) return b;
        if (isNullSentinel(b)) return a;
        // genuinely mixed -> fall back to unknown (will emit as JsonElement)
        return { kind: 'unknown' };
    }
    if (a.kind === 'primitive') {
        const type = widenPrimitive(a.type, b.type);
        return { kind: 'primitive', type, nullable: a.nullable || b.nullable };
    }
    if (a.kind === 'array') {
        return { kind: 'array', element: mergeShapes(a.element, b.element) };
    }
    if (a.kind === 'object') {
        const allKeys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
        const fields = {};
        const newCount = (a.sampleCount || 1) + (b.sampleCount || 1);
        for (const k of Array.from(allKeys).sort()) {
            const fa = a.fields[k];
            const fb = b.fields[k];
            if (fa && fb) {
                fields[k] = {
                    shape: mergeShapes(fa.shape, fb.shape),
                    optional: fa.optional || fb.optional,
                    presentCount: (fa.presentCount || 0) + (fb.presentCount || 0),
                    nullable: (fa.nullable || false) || (fb.nullable || false),
                };
            } else if (fa) {
                fields[k] = { shape: fa.shape, optional: true, presentCount: fa.presentCount || 0, nullable: fa.nullable || false };
            } else {
                fields[k] = { shape: fb.shape, optional: true, presentCount: fb.presentCount || 0, nullable: fb.nullable || false };
            }
        }
        return { kind: 'object', fields, sampleCount: newCount };
    }
    return a;
}

function widenPrimitive(a, b) {
    if (a === b) return a;
    const order = ['int', 'long', 'double', 'string', 'bool', 'object'];
    // Numeric widening
    if ((a === 'int' || a === 'long' || a === 'double') &&
        (b === 'int' || b === 'long' || b === 'double')) {
        if (a === 'double' || b === 'double') return 'double';
        if (a === 'long' || b === 'long') return 'long';
        return 'int';
    }
    if (a === 'object' || b === 'object') return a === 'object' ? b : a;
    return 'string';
}

// -------------------- Envelope detection (issue #64) --------------------

/**
 * Metadata-name regex: top-level field names that, when present alongside
 * exactly one substantial payload field, indicate a wrapper envelope (e.g.
 * { data, meta }, { items, count }, { result, errors }).
 *
 * Word-anchored, case-insensitive. Underscores are optional between word
 * fragments (so `has_more`, `hasmore`, `hasMore` all match).
 */
const METADATA_NAME_RE = /^(count|total|page|pages|cursor|next|prev|previous|has_?more|timestamp|status|offset|limit|size|per_?page|total_?pages|total_?count|page_?size|errors?|meta|metadata|pagination|links?|info|warnings?|debug)$/i;

/**
 * True when an object shape is "metadata-typed": every field is a primitive
 * scalar AND every field name matches METADATA_NAME_RE. An empty object
 * counts as metadata as well (carries no payload).
 *
 * The structural primitive-only check alone is too aggressive: a payload like
 * `{ id, name }` is also primitive-only, yet clearly the real payload. The
 * name check is what distinguishes wrapper boilerplate (`{ count, page }`)
 * from a small but meaningful payload (`{ id, name }`).
 */
function isMetadataObjectShape(shape) {
    if (!shape || shape.kind !== 'object') return false;
    const keys = Object.keys(shape.fields);
    if (keys.length === 0) return true;
    for (const k of keys) {
        const f = shape.fields[k];
        if (!f || !f.shape) return false;
        if (f.shape.kind !== 'primitive') return false;
        if (f.shape.type === 'object') return false; // JsonElement sentinel
        if (!METADATA_NAME_RE.test(k)) return false;
    }
    return true;
}

/**
 * Classify a top-level field as `substantial` (the real payload candidate)
 * or `metadata` (boilerplate envelope sibling). Returns 'substantial',
 * 'metadata', or 'ambiguous'.
 *
 * Rules:
 *   - primitive scalar -> metadata
 *   - key matches METADATA_NAME_RE AND shape is object-of-primitives or
 *     array-of-primitives or array-of-metadata-objects -> metadata
 *   - object with >= 1 non-primitive field -> substantial
 *   - object that is purely metadata-typed -> metadata
 *   - array of objects -> substantial (unless key matches metadata regex)
 *   - array of primitives -> metadata only if key matches regex; else
 *     substantial (e.g. a `tags: string[]` payload)
 *   - unknown / JsonElement -> ambiguous (treated as substantial so the
 *     heuristic abstains)
 */
function classifyEnvelopeField(key, shape) {
    if (!shape) return 'ambiguous';
    const keyIsMeta = METADATA_NAME_RE.test(key);
    if (shape.kind === 'primitive') {
        return 'metadata';
    }
    if (shape.kind === 'object') {
        if (isMetadataObjectShape(shape)) return 'metadata';
        if (keyIsMeta) return 'metadata';
        return 'substantial';
    }
    if (shape.kind === 'array') {
        const el = shape.element;
        if (!el || el.kind === 'unknown') return keyIsMeta ? 'metadata' : 'ambiguous';
        if (el.kind === 'primitive') {
            return keyIsMeta ? 'metadata' : 'substantial';
        }
        if (el.kind === 'object') {
            if (keyIsMeta && isMetadataObjectShape(el)) return 'metadata';
            return 'substantial';
        }
        return 'ambiguous';
    }
    return 'ambiguous';
}

/**
 * Detect whether a response shape is a single-payload envelope worth
 * unwrapping. Conservative: returns `{ envelope: false }` whenever the
 * heuristic is uncertain. See docs/designs/2026-05-15-envelope-unwrap-plan.md.
 *
 * @param {object} shape - shape descriptor from inferShape/mergeShapes
 * @param {object} [opts]
 * @param {number} [opts.maxFields=5] - maximum top-level field count
 * @returns {{envelope: false} | {envelope: true, payloadField: string, payloadShape: object}}
 */
function detectEnvelope(shape, opts) {
    const maxFields = (opts && opts.maxFields) || 5;
    if (!shape || shape.kind !== 'object') return { envelope: false };
    const fieldKeys = Object.keys(shape.fields);
    if (fieldKeys.length < 1 || fieldKeys.length > maxFields) return { envelope: false };

    const substantial = [];
    let hasAmbiguous = false;
    for (const k of fieldKeys) {
        const f = shape.fields[k];
        // Conservatism: the payload field must appear in every sample.
        // Optional fields (missing from some merged samples) cannot anchor
        // an unwrap -- callers would get null at runtime for the missing
        // case. Cf. issue #64 requirement 4 ("stable name across samples").
        if (f && f.optional) continue;
        const verdict = classifyEnvelopeField(k, f && f.shape);
        if (verdict === 'substantial') substantial.push(k);
        else if (verdict === 'ambiguous') hasAmbiguous = true;
    }

    // Exactly one substantial field, no ambiguous siblings.
    if (substantial.length !== 1) return { envelope: false };
    if (hasAmbiguous) return { envelope: false };

    const payloadField = substantial[0];

    // Field-name conflict: pascalCase of payload field must not collide with
    // pascalCase of any sibling top-level key.
    const payloadPascal = pascalCase(payloadField);
    for (const k of fieldKeys) {
        if (k === payloadField) continue;
        if (pascalCase(k) === payloadPascal) return { envelope: false };
    }

    return {
        envelope: true,
        payloadField,
        payloadShape: shape.fields[payloadField].shape,
    };
}

// -------------------- Name helpers --------------------

function pascalCase(s) {
    if (!s) return '';
    return s.replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase())
            .replace(/^(.)/, (_, c) => c.toUpperCase())
            .replace(/[^A-Za-z0-9]/g, '');
}

function singularize(s) {
    if (/ies$/i.test(s)) return s.slice(0, -3) + 'y';
    if (/ses$/i.test(s) || /xes$/i.test(s) || /zes$/i.test(s)) return s.slice(0, -2);
    if (/s$/i.test(s) && !/ss$/i.test(s)) return s.slice(0, -1);
    return s;
}

// URL path prefixes that carry no semantic meaning for a method name.
const IGNORED_PATH_PREFIXES = new Set(['api', 'v1', 'v2', 'v3', 'rest', 'graphql']);

function meaningfulSegments(segments) {
    let i = 0;
    while (i < segments.length && segments[i].literal && IGNORED_PATH_PREFIXES.has(segments[i].literal.toLowerCase())) {
        i++;
    }
    // Always keep at least one segment so the method name is non-empty.
    if (i >= segments.length) return segments.slice(-1);
    return segments.slice(i);
}

function methodNameFor(pattern) {
    const verbMap = { GET: 'Get', POST: 'Create', PUT: 'Update', PATCH: 'Update', DELETE: 'Delete' };
    const verb = verbMap[pattern.method] || pascalCase(pattern.method.toLowerCase());
    const segs = meaningfulSegments(pattern.segments);
    const parts = [];
    for (const s of segs) {
        if (s.literal) parts.push(pascalCase(s.literal));
        else parts.push('By' + pascalCase(s.param));
    }
    return verb + parts.join('') + 'Async';
}

function modelNameFor(pattern) {
    const segs = meaningfulSegments(pattern.segments).filter((s) => s.literal).map((s) => s.literal);
    const hasParam = pattern.segments.some((s) => s.param);
    let base = segs.map(pascalCase).join('') || 'Root';
    if (hasParam && segs.length > 0) {
        // Singularize the last literal segment for "by id" endpoints
        const last = segs[segs.length - 1];
        base = segs.slice(0, -1).map(pascalCase).join('') + pascalCase(singularize(last));
    }
    return base + 'Response';
}

function describeFor(pattern) {
    const verbWord = { GET: 'Gets', POST: 'Creates', PUT: 'Updates', PATCH: 'Updates', DELETE: 'Deletes' }[pattern.method] || pattern.method;
    const segs = meaningfulSegments(pattern.segments);
    const literals = segs.filter((s) => s.literal).map((s) => s.literal.replace(/[-_]/g, ' '));
    const hasParam = segs.some((s) => s.param);
    const noun = literals.length > 0 ? literals[literals.length - 1] : 'resource';
    // Keep the plural form for the noun; only suffix " by id" when a path param is present.
    const subject = hasParam ? noun + ' by id' : noun;
    return verbWord + ' ' + subject + '.';
}

// -------------------- Response shape extraction --------------------

function parseResponseJson(entry) {
    const resp = entry.response || {};
    const text = resp.content && resp.content.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}

// -------------------- C# emission --------------------

function csTypeFor(shape, modelMap, nameHint) {
    if (!shape || shape.kind === 'unknown') return 'JsonElement';
    if (shape.kind === 'primitive') {
        const base = { string: 'string', int: 'int', long: 'long', double: 'double', bool: 'bool', object: 'JsonElement' }[shape.type] || 'string';
        if (shape.nullable && shape.type !== 'object') return base + '?';
        return base;
    }
    if (shape.kind === 'array') {
        const inner = csTypeFor(shape.element, modelMap, singularize(nameHint || 'Item'));
        return 'IReadOnlyList<' + inner + '>';
    }
    if (shape.kind === 'object') {
        // Lazily register an inline record.
        const name = registerModel(modelMap, nameHint || 'Anon', shape);
        return name;
    }
    return 'JsonElement';
}

function registerModel(modelMap, hint, shape) {
    const baseName = pascalCase(hint) || 'Anon';
    // If an identical shape was already registered with this base, reuse it.
    const sig = shapeSignature(shape);
    for (const [n, info] of modelMap) {
        if (info.baseName === baseName && info.sig === sig) return n;
    }
    let name = baseName;
    let n = 2;
    while (modelMap.has(name)) { name = baseName + n; n++; }
    modelMap.set(name, { baseName, sig, shape });
    return name;
}

function shapeSignature(shape) {
    if (!shape) return 'null';
    if (shape.kind === 'primitive') return 'P:' + shape.type + (shape.nullable ? '?' : '');
    if (shape.kind === 'array') return 'A:' + shapeSignature(shape.element);
    if (shape.kind === 'object') {
        const parts = Object.keys(shape.fields).sort().map((k) => {
            const f = shape.fields[k];
            return k + (f.optional ? '?' : '') + (f.nullable ? 'n' : '') + ':' + shapeSignature(f.shape);
        });
        return 'O:{' + parts.join(',') + '}';
    }
    return '?';
}

function emitModels(modelMap) {
    // csTypeFor may register additional models (array elements) while we emit.
    // Iterate to fixed point so every reachable model gets a body.
    const emitted = new Map(); // name -> body
    let progressed = true;
    while (progressed) {
        progressed = false;
        const names = Array.from(modelMap.keys()).sort();
        for (const name of names) {
            if (emitted.has(name)) continue;
            const info = modelMap.get(name);
            if (!info || info.shape.kind !== 'object') { emitted.set(name, ''); continue; }
            const buf = [];
            buf.push('/// <summary>Auto-generated model for ' + name + '.</summary>');
            buf.push('public sealed partial class ' + name);
            buf.push('{');
            const keys = Object.keys(info.shape.fields).sort();
            for (const k of keys) {
                const f = info.shape.fields[k];
                const propName = pascalCase(k);
                let type = csTypeFor(f.shape, modelMap, propName);
                if ((f.optional || f.nullable) && !type.endsWith('?')) type = type + '?';
                buf.push('    [JsonPropertyName("' + escapeCs(k) + '")]');
                const init = initializerFor(type);
                buf.push('    public ' + type + ' ' + propName + ' { get; init; }' + (init ? init + ';' : ''));
            }
            buf.push('}');
            buf.push('');
            emitted.set(name, buf.join('\n'));
            progressed = true;
        }
    }
    const ordered = Array.from(emitted.keys()).sort();
    return ordered.map((n) => emitted.get(n)).filter(Boolean).join('\n');
}

/**
 * Returns a C# property initializer suffix (e.g., " = default!"). Used to
 * silence CS8618 ("non-nullable property must contain a non-null value") on
 * generated DTOs that are populated by JsonSerializer reflection.
 *
 * Value types (int, bool, double, long) and nullable types are zero-initialized
 * already; only non-nullable reference types need the explicit default.
 */
function initializerFor(type) {
    if (!type) return '';
    if (type.endsWith('?')) return '';
    const valueTypes = new Set(['int', 'long', 'double', 'bool']);
    if (valueTypes.has(type)) return '';
    return ' = default!';
}

function escapeCs(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function emitClient(opts, patterns, sourceShas, hasGraphQL, modelMap) {
    const header = autoGenHeader(sourceShas);
    const ns = opts.namespace;
    const projectName = opts.projectName;
    const lines = [];
    lines.push(header);
    lines.push('using System.ComponentModel;');
    lines.push('using System.Net.Http;');
    lines.push('using System.Text.Json;');
    lines.push('using System.Text.Json.Serialization;');
    lines.push('');
    lines.push('namespace ' + ns + ';');
    lines.push('');
    lines.push('public sealed partial class ' + projectName + 'Client');
    lines.push('{');

    if (hasGraphQL) {
        lines.push('    /// <summary>Issues a GraphQL operation against the target endpoint and deserializes the response.</summary>');
        lines.push('    [Description("Executes a GraphQL query or mutation and returns the typed response.")]');
        lines.push('    public async Task<T> GraphQLAsync<T>(string query, object? variables = null, CancellationToken ct = default)');
        lines.push('    {');
        lines.push('        var payload = JsonSerializer.Serialize(new { query, variables });');
        lines.push('        var raw = await SendRawJsonAsync("/graphql", payload, ct).ConfigureAwait(false);');
        lines.push('        return Deserialize<T>(raw);');
        lines.push('    }');
        lines.push('');
    }

    for (const p of patterns) {
        const methodName = methodNameFor(p);
        const modelName = p.responseModel || 'JsonElement';
        const pathArgs = p.segments
            .filter((s) => s.param)
            .map((s) => ({ name: s.param, type: s.type }));
        const httpVerb = (p.method || 'GET').toUpperCase();
        const verbExpr = 'HttpMethod.' + (httpVerb.charAt(0) + httpVerb.slice(1).toLowerCase());
        const acceptsBody = httpVerb === 'POST' || httpVerb === 'PUT' || httpVerb === 'PATCH';
        const sigArgs = pathArgs.map((a) => a.type + ' ' + a.name);
        if (acceptsBody) sigArgs.push('string? body = null');
        sigArgs.push('CancellationToken ct = default');
        const sig = sigArgs.join(', ');
        const pathExpr = pathExpression(p);
        const bodyArg = acceptsBody ? 'body' : 'null';
        lines.push('    /// <summary>' + describeFor(p) + '</summary>');
        lines.push('    [Description("' + escapeCs(describeFor(p)) + '")]');
        lines.push('    public async Task<' + modelName + '> ' + methodName + '(' + sig + ')');
        lines.push('    {');
        lines.push('        var raw = await SendRawAsync(' + pathExpr + ', ' + verbExpr + ', jsonBody: ' + bodyArg + ', query: null, ct: ct).ConfigureAwait(false);');
        if (p.envelope && p.wrapperModel) {
            // Deserialize the wrapper record (kept available in Models.Generated.cs)
            // then return the inner payload property. Conservatism: heuristic
            // only fires for shapes with a single substantial field, so the
            // PascalCase property is guaranteed to exist on the wrapper.
            const propName = pascalCase(p.envelope.payloadField);
            lines.push('        var envelope = Deserialize<' + p.wrapperModel + '>(raw);');
            lines.push('        return envelope.' + propName + '!;');
        } else {
            lines.push('        return Deserialize<' + modelName + '>(raw);');
        }
        lines.push('    }');
        lines.push('');
    }

    lines.push('    private async Task<string> SendRawJsonAsync(string path, string json, CancellationToken ct)');
    lines.push('    {');
    lines.push('        // POST helper used by GraphQLAsync; delegates to the hand-written Client.cs partial.');
    lines.push('        return await SendRawAsync(path, HttpMethod.Post, jsonBody: json, query: null, ct: ct).ConfigureAwait(false);');
    lines.push('    }');
    lines.push('}');
    lines.push('');
    return lines.join('\n');
}

function pathExpression(p) {
    // Build a C# interpolated string for the URL path.
    const segs = p.segments.map((s) => s.literal ? s.literal : '{' + s.param + '}').join('/');
    if (p.segments.every((s) => s.literal)) {
        return '"/' + segs + '"';
    }
    return '$"/' + segs + '"';
}

function autoGenHeader(sourceShas) {
    const lines = [];
    lines.push('// <auto-generated>');
    lines.push('//   This file was generated by api-wrapper-scaffold (generate-wrapper.js).');
    lines.push('//   Do not edit -- changes will be lost on regeneration.');
    for (const s of sourceShas) {
        lines.push('//   source HAR sha-256: ' + s);
    }
    lines.push('// </auto-generated>');
    lines.push('#nullable enable');
    return lines.join('\n');
}

function emitModelsFile(modelMap, sourceShas, opts) {
    const lines = [];
    lines.push(autoGenHeader(sourceShas));
    lines.push('using System.Text.Json;');
    lines.push('using System.Text.Json.Serialization;');
    lines.push('');
    lines.push('namespace ' + opts.namespace + ';');
    lines.push('');
    lines.push(emitModels(modelMap));
    return lines.join('\n');
}

// -------------------- Project metadata files --------------------

function emitCsproj(opts) {
    const tags = opts.packageTags || '';
    const repo = opts.repositoryUrl || '';
    return [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        '    <TargetFramework>net8.0</TargetFramework>',
        '    <OutputType>Exe</OutputType>',
        '    <Nullable>enable</Nullable>',
        '    <ImplicitUsings>enable</ImplicitUsings>',
        '    <PackageId>' + xmlEscape(opts.projectName) + '</PackageId>',
        '    <Description>' + xmlEscape(opts.description || '') + '</Description>',
        '    <Authors>' + xmlEscape(opts.authors || '') + '</Authors>',
        '    <RepositoryUrl>' + xmlEscape(repo) + '</RepositoryUrl>',
        '    <PackageTags>' + xmlEscape(tags) + '</PackageTags>',
        '  </PropertyGroup>',
        '  <ItemGroup>',
        '    <PackageReference Include="Microsoft.Extensions.Hosting" Version="10.0.0" />',
        '    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="10.0.0" />',
        '    <PackageReference Include="Microsoft.Playwright" Version="1.49.0" />',
        '    <PackageReference Include="ModelContextProtocol" Version="0.4.1-preview.1" />',
        '    <PackageReference Include="System.Security.Cryptography.ProtectedData" Version="8.0.0" />',
        '  </ItemGroup>',
        '</Project>',
        ''
    ].join('\n');
}

function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function emitReadme(opts, patterns, hasGraphQL) {
    const lines = [];
    lines.push('# ' + opts.projectName);
    lines.push('');
    lines.push(opts.description || ('Wrapper for ' + opts.baseUrl));
    lines.push('');
    lines.push('> Auto-generated by api-wrapper-scaffold. Re-run the generator to refresh; hand-written code goes in `Client.cs` (a `partial class` paired with `' + opts.projectName + 'Client.Generated.cs`).');
    lines.push('');
    lines.push('## Polite-crawl policy');
    lines.push('');
    lines.push('When re-capturing HAR fixtures, the recommended throttle is **1 request/second** with a descriptive `User-Agent`. Respect `robots.txt`. The bundled `capture-cdp.js` defaults to a ~1000 ms inter-request delay.');
    lines.push('');
    lines.push('## Recipes');
    lines.push('');
    const recipes = buildRecipes(opts, patterns, hasGraphQL);
    for (const r of recipes) {
        lines.push('### ' + r.title);
        lines.push('');
        lines.push('```csharp');
        lines.push(r.code);
        lines.push('```');
        lines.push('');
    }
    lines.push(secretGateReadmeSection());
    lines.push('');
    lines.push(mobileImportReadmeSection());
    lines.push('');
    lines.push(sdlcIntegrationReadmeSection());
    if (Array.isArray(opts.antiBotCookies) && opts.antiBotCookies.length > 0) {
        lines.push('');
        lines.push(antiBotWarningSection(opts.antiBotCookies));
    }
    return lines.join('\n');
}

/**
 * Build the "Adding mobile-app coverage" README section (issue #90.a).
 *
 * A scaffolded project starts from web traffic only. The skill's Phase 1.5
 * lets the user opt into mobile-app HAR / endpoint-list capture, but
 * scaffolds driven by `run-agent.js` skip that prompt entirely. This
 * section is rendered into every generated README so consumers know how
 * to add mobile coverage retroactively without having to re-read SKILL.md.
 *
 * The section is intentionally generic (no project-specific paths): the
 * commands work identically against any wrapper that this generator emits.
 */
function mobileImportReadmeSection() {
    return [
        '## Adding mobile-app coverage',
        '',
        'A scaffold built from web HAR alone misses any endpoints that only',
        'appear in the target service\'s iOS or Android app. Mobile traffic',
        'frequently exposes richer data, internal APIs not visible on the web,',
        'and different auth shapes.',
        '',
        'To add mobile coverage to this project, run the importer from the',
        'IntelliSDLC.ai repo and feed the captured traffic back through this',
        'project\'s pipeline:',
        '',
        '```pwsh',
        '# 1. Print the platform-specific capture instructions and create the',
        '#    target paths under Samples/HAR-Original/ (proxy mode) or',
        '#    Samples/MobileApp-Discovered/ (decompile mode).',
        'node <IntelliSDLC.ai>/templates/api-wrapper-scaffold/scripts/import-mobile-app.js `',
        '  --platform=<ios|android|both> `',
        '  --mode=<proxy|decompile|both>',
        '',
        '# 2. Follow the on-screen instructions to:',
        '#    - PROXY mode: install a TLS-intercepting proxy (mitmproxy, Charles,',
        '#      Proxyman, Fiddler), trust its CA on the device, exercise the app,',
        '#      then export the captured session as HAR.',
        '#    - DECOMPILE mode: use a static-analysis tool (jadx for Android,',
        '#      class-dump for iOS) to dump candidate endpoint URLs to a sorted',
        '#      unique list at Samples/MobileApp-Discovered/<platform>-endpoints.txt.',
        '',
        '# 3. Re-run the wrapper pipeline against the new mobile HAR. Each',
        '#    captured mobile HAR is processed exactly like a web HAR.',
        'node <IntelliSDLC.ai>/templates/api-wrapper-scaffold/scripts/run-agent.js `',
        '  --har Samples/HAR-Original/mobile-android-<timestamp>.har `',
        '  --out . --project <Name> --namespace <Namespace>',
        '```',
        '',
        '### Legal note on decompilation',
        '',
        'Only decompile apps you are **legally permitted to inspect** -- apps',
        'tied to your own account, or apps whose Terms of Service explicitly',
        'allow security research. The importer surfaces this warning before it',
        'prints decompile-mode instructions and will not proceed without your',
        'explicit acknowledgement.',
        '',
        '### What gets merged',
        '',
        'Re-running the pipeline merges the new mobile endpoints into the same',
        '`(method, path-template)` catalog used for the web HARs. Generated',
        'files (`*.g.cs`, fixtures) are rewritten in place; any hand-written',
        'partials and user-edited `Client.cs` content are preserved.',
    ].join('\n');
}

/**
 * Build the "Anti-bot challenge warning" README section (issue #66).
 *
 * Rendered only when the captured HAR contained one or more Akamai
 * bot-management cookies (`_abck`, `bm_sz`, `bm_sv`, `ak_bmsc`). The section
 * does NOT implement a bypass -- it warns the human consumer that a pure
 * session-replay wrapper may hit a non-200 anti-bot challenge response and
 * points at a documented warm-up workaround.
 */
function antiBotWarningSection(cookies) {
    const list = cookies.map((c) => '`' + c + '`').join(', ');
    return [
        '## Anti-bot challenge warning',
        '',
        'The captured HAR contains Akamai bot-management cookies (' + list + '). ' +
        'This API almost certainly fronts traffic with Akamai Bot Manager, which ' +
        'means a **session-replay-only wrapper may hit a non-200 anti-bot ' +
        'challenge response** instead of the expected payload. This generator ' +
        'does not attempt to derive a bypass from the HAR alone.',
        '',
        '### Documented workaround',
        '',
        'Before issuing the first authenticated request, send a plain `GET` to ' +
        "the target's **public landing page** with no auth headers. That request " +
        'lets Akamai seed `_abck` / `bm_sz` on the client; subsequent ' +
        'authenticated calls then ride a cookie jar Akamai recognises as ' +
        'human-shaped. If you still see challenge responses, add a brief delay ' +
        'and retry once before surfacing the error to callers.',
        '',
        'Detected cookies: ' + list + '.',
    ].join('\n');
}

function buildRecipes(opts, patterns, hasGraphQL) {
    const out = [];
    const client = opts.projectName + 'Client';
    // Recipe 0: construction
    out.push({
        title: 'Construct the client',
        code: [
            'var session = await new ' + opts.projectName + 'Authenticator(store).AuthenticateAsync();',
            'using var client = new ' + client + '(session);',
        ].join('\n'),
    });
    if (hasGraphQL) {
        out.push({
            title: 'Run a GraphQL query',
            code: [
                'var result = await client.GraphQLAsync<MyResponse>(',
                '    "query { me { id name } }");',
            ].join('\n'),
        });
    }
    for (const p of patterns.slice(0, 4)) {
        const m = methodNameFor(p);
        const paramArgs = p.segments.filter((s) => s.param).map((s) => s.type === 'int' ? '1' : '"abc"').join(', ');
        out.push({
            title: p.method + ' ' + patternPath(p),
            code: 'var result = await client.' + m + '(' + paramArgs + ');',
        });
    }
    return out;
}

function emitTestFixtures(outDir, patterns, hasGraphQL, graphqlEntries) {
    const fixDir = path.join(outDir, 'tests', 'fixtures');
    fs.mkdirSync(fixDir, { recursive: true });
    for (const p of patterns) {
        const sample = p.samples[0];
        const json = parseResponseJson(sample.entry);
        if (json === null) continue;
        const fname = (p.method + '_' + patternPath(p).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')) + '.json';
        const content = JSON.stringify(json, null, 2) + '\n';
        fs.writeFileSync(path.join(fixDir, fname), content);
    }
    if (hasGraphQL && graphqlEntries.length > 0) {
        const json = parseResponseJson(graphqlEntries[0].entry);
        if (json !== null) {
            fs.writeFileSync(path.join(fixDir, 'graphql.json'), JSON.stringify(json, null, 2) + '\n');
        }
    }
}

// -------------------- Template substitution --------------------

function substituteTemplates(opts, outDir) {
    const templatesDir = path.resolve(__dirname, '..', 'csharp');
    if (!fs.existsSync(templatesDir)) return;
    const manifestPath = path.join(templatesDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const tokens = buildTokenMap(opts);
    const projDir = path.join(outDir, 'src', opts.projectName);
    fs.mkdirSync(projDir, { recursive: true });

    // Only substitute templates whose required tokens are all available.
    for (const t of manifest.templates) {
        const required = t.requiredTokens || [];
        if (required.some((tok) => tokens[tok] === undefined)) continue;
        const src = path.join(templatesDir, t.file);
        if (!fs.existsSync(src)) continue;
        const body = fs.readFileSync(src, 'utf8');
        const subbed = body.replace(/\{\{(\w+)\}\}/g, (m, k) => tokens[k] !== undefined ? tokens[k] : m);
        // Strip ".tmpl" suffix; ".gitignore.tmpl" -> ".gitignore"
        const outName = t.file.replace(/\.tmpl$/, '');
        // Friendly remappings:
        //   Client.cs -> src/<Project>/Client.cs (hand-written partial)
        //   manifest.json -> not emitted
        if (outName === 'manifest.json') continue;
        fs.writeFileSync(path.join(projDir, outName), subbed);
    }
}

function buildTokenMap(opts) {
    return {
        ProjectName: opts.projectName,
        Namespace: opts.namespace,
        BaseUrl: opts.baseUrl,
        AuthModel: opts.authModel || 'cookie',
        IdpName: opts.idpName || 'Google',
        IdpAuthorizeUrl: opts.idpAuthorizeUrl || 'https://accounts.google.com/o/oauth2/v2/auth',
        IdpTokenUrl: opts.idpTokenUrl || 'https://oauth2.googleapis.com/token',
        IdpClientId: opts.idpClientId || 'REPLACE_WITH_CLIENT_ID',
        IdpScopes: opts.idpScopes || 'openid email profile',
        HasMobileCoverage: opts.hasMobileCoverage || 'false',
        MobileHarPaths: opts.mobileHarPaths || '',
    };
}

// -------------------- Pipeline orchestration --------------------

function run(args) {
    if (!args.har) fail('missing --har <path[,path,...]>');
    if (!args.out) fail('missing --out <dir>');
    if (!args['project-name']) fail('missing --project-name <Name>');
    if (!args.namespace) fail('missing --namespace <Ns>');
    if (!args['base-url']) fail('missing --base-url <url>');

    const opts = {
        projectName: args['project-name'],
        namespace: args.namespace,
        baseUrl: args['base-url'],
        authModel: args['auth-model'] || 'cookie',
        authors: args.authors || '',
        description: args.description || '',
        repositoryUrl: args['repository-url'] || '',
        packageTags: args['package-tags'] || '',
    };

    const harPaths = String(args.har).split(',').map((s) => s.trim()).filter(Boolean);
    const bundles = harPaths.map(loadHar);
    const sourceShas = bundles.map((b) => b.sha).sort();

    // Detect Akamai bot-management cookies across all input HARs (issue #66).
    // Union the per-HAR detections so a multi-HAR run still surfaces every
    // cookie the consumer should be warned about.
    const antiBotSet = new Set();
    for (const b of bundles) {
        for (const name of detectAntiBotCookies(b.har)) antiBotSet.add(name);
    }
    if (antiBotSet.size > 0) {
        // Preserve canonical detector ordering for deterministic README output.
        const canonical = ['_abck', 'bm_sz', 'bm_sv', 'ak_bmsc'];
        opts.antiBotCookies = canonical.filter((n) => antiBotSet.has(n));
    }

    // Partition entries into GraphQL vs REST.
    const gql = [], rest = [];
    for (const item of iterEntries(bundles)) {
        if (isGraphQL(item.entry)) gql.push(item);
        else rest.push(item);
    }

    // Dedup REST patterns.
    const patterns = dedupePatterns(rest);

    // Infer response shapes per pattern.
    const modelMap = new Map();
    for (const p of patterns) {
        let merged = null;
        for (const s of p.samples) {
            const json = parseResponseJson(s.entry);
            if (json === null || json === undefined) continue;
            const inferred = inferShape(json);
            merged = merged ? mergeShapes(merged, inferred) : inferred;
        }
        if (merged && merged.kind === 'object') {
            // Always register the wrapper model so consumers retain access to
            // the raw envelope via a strongly-typed record (issue #64 req. 3).
            const wrapperModel = registerModel(modelMap, modelNameFor(p), merged);
            p.wrapperModel = wrapperModel;

            const env = detectEnvelope(merged);
            if (env.envelope) {
                // Hint must match what emitModels uses for the wrapper's
                // property of the same name, so the inner model is registered
                // once (not duplicated under a different baseName). emitModels
                // calls csTypeFor with hint = pascalCase(fieldKey); for arrays
                // csTypeFor singularizes that for the element type. Mirroring
                // that here guarantees a single shared model.
                const hint = pascalCase(env.payloadField);
                p.responseModel = csTypeFor(env.payloadShape, modelMap, hint);
                p.envelope = { payloadField: env.payloadField };
            } else {
                p.responseModel = wrapperModel;
            }
        } else if (merged && merged.kind === 'array') {
            // Array response: emit a list type directly; introduce a wrapper model.
            const itemModel = registerModel(modelMap, singularize(modelNameFor(p).replace(/Response$/, '')) + 'Item', merged.element.kind === 'object' ? merged.element : { kind: 'object', fields: {} });
            p.responseModel = 'IReadOnlyList<' + itemModel + '>';
        } else {
            p.responseModel = 'JsonElement';
        }
    }

    // Out dirs.
    const outDir = path.resolve(args.out);
    const projDir = path.join(outDir, 'src', opts.projectName);
    fs.mkdirSync(projDir, { recursive: true });

    // Substitute templates first (writes Client.cs, ISessionStore.cs, etc).
    substituteTemplates(opts, outDir);

    // Emit generated C# files.
    const clientCs = emitClient(opts, patterns, sourceShas, gql.length > 0, modelMap);
    const modelsCs = emitModelsFile(modelMap, sourceShas, opts);
    fs.writeFileSync(path.join(projDir, opts.projectName + 'Client.Generated.cs'), clientCs);
    fs.writeFileSync(path.join(projDir, 'Models.Generated.cs'), modelsCs);

    // .csproj
    fs.writeFileSync(path.join(projDir, opts.projectName + '.csproj'), emitCsproj(opts));

    // README + recipes + polite-crawl note
    fs.writeFileSync(path.join(outDir, 'README.md'), emitReadme(opts, patterns, gql.length > 0));

    // Test fixtures
    emitTestFixtures(outDir, patterns, gql.length > 0, gql);

    // xUnit + Pester test-project scaffold (one [Fact] per detected endpoint).
    emitTestScaffold({
        outDir,
        opts,
        patterns,
        hasGraphQL: gql.length > 0,
        methodNameFor,
        patternPath,
    });

    // Secret-gate (pre-commit hook + .gitleaks.toml + secret-scan/ci workflows).
    emitSecretGate({ outDir, opts });

    // Top-level .slnx referencing every emitted csproj so `dotnet build` from
    // the wrapper root "just works" without -p arguments. Runs LAST so all
    // csprojs (client + tests) are already on disk for discovery.
    emitSolution({ outDir, projectName: opts.projectName });

    // Ensure consumer repo-root .gitignore carries the entries this skill
    // owns (Samples/HAR-Original/ and Samples/MobileApp-Binaries/). Idempotent
    // on re-run. See issue #119 -- these moved out of upstream IntelliSDLC.ai's
    // .gitignore so only repos that actually scaffold a wrapper carry them.
    const addedIgnores = ensureRepoRootGitignoreHasScaffoldEntries(outDir);
    if (addedIgnores.length > 0) {
        console.log('generate-wrapper: added to .gitignore: ' + addedIgnores.join(', '));
    }

    console.log('generate-wrapper: wrote ' + patterns.length + ' REST pattern(s)' +
        (gql.length ? ' + GraphQL' : '') + ' to ' + outDir);
    console.log('generate-wrapper: next step -- activate the pre-commit hook with:');
    console.log('                  git -C ' + outDir + ' config core.hooksPath .githooks');
}

if (require.main === module) {
    try { run(parseArgs(process.argv.slice(2))); }
    catch (e) { fail(e && e.stack ? e.stack : String(e)); }
}

module.exports = {
    parseArgs,
    isGraphQL,
    inferShape,
    mergeShapes,
    registerModel,
    emitModels,
    detectEnvelope,
    classifyEnvelopeField,
    dedupePatterns,
    methodNameFor,
    pascalCase,
    singularize,
    isOpaqueIdLike,
    isNamedSegment,
    emitReadme,
    antiBotWarningSection,
    ensureRepoRootGitignoreHasScaffoldEntries,
    SCAFFOLD_GITIGNORE_ENTRIES,
};
