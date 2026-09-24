'use strict';

/**
 * har-blunt.js -- the scrub's floor: blunt what it could not clean, and never
 * withhold the artifact over it (issue #511).
 *
 * WHAT A REFUSAL USED TO COST. When the leak gate still found a live secret
 * after the scrub, the whole scrubbed capture was quarantined and nothing
 * downstream ran -- no catalogue, no reference, no API document. The raw is
 * kept forever, but a real recording produced no shareable output at all, and
 * over a store that is a silent coverage hole.
 *
 * WHAT HAPPENS NOW. The scrubber asks the GATE'S OWN QUESTION -- the same
 * `collectFindings` and `classifyFindings` `verify-scrub.js` runs -- over its
 * own output, and replaces every value the gate would block with a typed
 * sentinel. The gate is not softened: it still decides what is a live secret,
 * and it still runs afterwards over the written file. What changes is the
 * remedy. The artifact comes out, and it never carries the secret.
 *
 * THREE RULES CARRY THE DESIGN.
 *
 *  1. GATING FINDINGS ONLY. An advisory finding -- identity evidence by shape
 *     alone -- is not blunted. Shape carries no provenance, and rewriting a
 *     card-shaped trip id is how 1413 of them lost their reference once.
 *     Waived, disabled and identifier-field findings have left the gate and
 *     are not touched either.
 *
 *  2. SURGICAL FIRST, WHOLE VALUE ONLY WHEN NOTHING ELSE WORKS. A shape hit is
 *     replaced where its bytes stand, at EVERY occurrence -- the gate groups by
 *     value and reports one location, so blunting that location alone would
 *     leave the rest. A known secret name is blunted through the same nested
 *     traversal the scrubber and the gate share. Only a hit visible solely in
 *     the percent-DECODED view, which has no bytes of its own to replace,
 *     blunts its whole containing value: that costs fidelity, never a leak,
 *     and the bytes lost are counted so the cost is visible.
 *
 *  3. RECORDED, NEVER QUOTED. Every blunt goes into a record on the artifact:
 *     kind, entry, key path, occurrences, bytes, and a SALTED fingerprint. The
 *     gate's own fingerprint is an unsalted digest of a live value -- fine in a
 *     gitignored findings report, wrong in a file a committed reference is cut
 *     from (#459). No value, anywhere.
 *
 * PER ENTRY, BY CONSTRUCTION. `bluntEntry` holds no state across entries, so a
 * streamed scrub (#539) can drive it one entry at a time. `bluntHar` is only
 * the loop and the record.
 *
 * A finding that cannot be attributed to any entry cannot be blunted. It is
 * returned in `unblunted`, the scrubber writes the file anyway, and the gate
 * refuses it exactly as before -- a hard error with a defect to file, never a
 * steady state.
 */

const crypto = require('crypto');
const path = require('path');

const harShapes = require(path.join(__dirname, 'har-shapes.js'));
const harSecrets = require(path.join(__dirname, 'har-secrets.js'));
const { transformNested } = require(path.join(__dirname, 'har-nested.js'));
// The gate's own question, not a copy of it (see har-gate.js).
const harGate = require(path.join(__dirname, 'har-gate.js'));

/**
 * Where the record lives: under `log`, beside the entries and never inside
 * one. The gate walks `log.entries` for shapes, so our own annotation is not
 * read as wire data; the named-credential walk does see it, and holds nothing
 * it could fire on (no `{name, value}` pairs, no secret field names as keys).
 */
const RECORD_KEY = '_blunted';
const RECORD_SCHEMA_VERSION = 1;

/**
 * The issue that would let the scrubber CLEAN each kind instead of blunting
 * it. Blunting is the floor; these raise the ceiling, and as each lands the
 * blunted count for its kind should fall. Printed with every blunt so the
 * debt is never anonymous.
 */
const DEBT = Object.freeze({
    // The gate and the scrubber disagree about a shape: the gate blocks what
    // the scrubber has no rule to replace at that position.
    shape: '#408',
    // A secret NAME the scrubber did not reach.
    'known-secret': '#480',
    // A value visible only once percent-decoded.
    'whole-value': '#484',
});

// Twelve hex, like the gate's fingerprint, so the two read alike -- but keyed.
function saltedFingerprint(value, salt) {
    return crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 12);
}

// A tag spelled in the letters a..p, never digits: `a-p` cannot complete a
// hex run, a card, a phone number, an SSN or an IBAN, so no shape pattern can
// ever fire on a sentinel -- the property test 4 asks of the gate itself.
function letterTag(value, salt, kind) {
    const digest = crypto.createHmac('sha256', salt).update(`${kind}\0${value}`).digest();
    let out = '';
    for (let i = 0; i < 4; i++) {
        out += String.fromCharCode(97 + (digest[i] >> 4)) + String.fromCharCode(97 + (digest[i] & 15));
    }
    return out;
}

/**
 * The replacement for one blunted value: typed, deterministic per value, and
 * non-reversible without the operator's salt. `<...>` is what the named
 * credential check already reads as redacted, so a blunted secret is not
 * reported a second time.
 */
function sentinelFor(kind, value, salt) {
    if (typeof salt !== 'string' || salt === '') {
        throw new Error('har-blunt: a salt is required -- a sentinel without one would be a reversible digest');
    }
    return `<BLUNTED:${kind}:${letterTag(value, salt, kind)}>`;
}

const PATTERN_BY_KIND = new Map(harShapes.LEAK_PATTERNS.map((p) => [p.name, p]));

function gatingFindings(entry, policy) {
    const doc = { log: { entries: [entry] } };
    return harGate.classifyFindings(harGate.collectFindings(doc, policy)).gating;
}

/**
 * Visit every string leaf of an entry with a setter, skipping the handful of
 * fields WE wrote (`har-shapes.ENTRY_OWN_FIELDS`) -- the gate skips them too.
 */
function forEachLeaf(entry, visit) {
    const walk = (node, keyPath, parent, key) => {
        if (typeof node === 'string') {
            visit(node, keyPath, (v) => { parent[key] = v; }, parent, key);
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((v, i) => walk(v, `${keyPath}[${i}]`, node, i));
            return;
        }
        if (node !== null && typeof node === 'object') {
            for (const k of Object.keys(node)) walk(node[k], keyPath ? `${keyPath}.${k}` : k, node, k);
        }
    };
    for (const k of Object.keys(entry)) {
        if (harShapes.ENTRY_OWN_FIELDS.has(k)) continue;
        walk(entry[k], k, entry, k);
    }
}

/**
 * Resolve a gate key path down to the HAR-envelope string that holds it.
 *
 * The gate's paths continue INTO parsed bodies (`response.content.text.a.b`),
 * and there is no object to follow past the envelope string; the walk stops
 * at the first string it reaches. A path ending at a `{name, value}` pair
 * resolves to its value.
 */
function resolveLeaf(entry, keyPath) {
    if (typeof keyPath !== 'string' || keyPath === '') return null;
    const segments = [];
    keyPath.replace(/([^.[\]]+)|\[(\d+)\]/g, (m, name, index) => {
        segments.push(index !== undefined ? Number(index) : name);
        return m;
    });
    let parent = null;
    let key = null;
    let node = entry;
    for (const seg of segments) {
        if (typeof node === 'string') break;
        if (node === null || typeof node !== 'object' || !(seg in node)) return null;
        parent = node;
        key = seg;
        node = node[seg];
    }
    if (typeof node === 'string') return { parent, key, value: node };
    if (node && typeof node === 'object' && typeof node.value === 'string') {
        return { parent: node, key: 'value', value: node.value };
    }
    return null;
}

/**
 * Blunt every gating finding in one entry, in place.
 *
 * @returns {{findings: object[], unblunted: object[]}} one row per (kind,
 *   value) blunted in this entry, and the gating findings that survived both
 *   passes. Rows carry no value.
 */
function bluntEntry(entry, entryIndex, opts) {
    const { policy, salt } = opts || {};
    const rows = new Map();
    const note = (kind, value, keyPath, mode, bytes, extra) => {
        const fingerprint = saltedFingerprint(value, salt);
        const id = `${kind}:${fingerprint}:${mode}`;
        const row = rows.get(id);
        if (row) {
            row.occurrences++;
            row.bytes += bytes;
            return;
        }
        rows.set(id, Object.assign({
            kind,
            entryIndex,
            keyPath,
            mode,
            occurrences: 1,
            bytes,
            fingerprint,
            debt: mode === 'whole-value' ? DEBT['whole-value'] : (DEBT[kind] || DEBT.shape),
        }, extra || {}));
    };

    let gating = gatingFindings(entry, policy);
    if (gating.length === 0) return { findings: [], unblunted: [], blocked: [] };
    // What the gate WOULD have blocked, in its own words, for the console
    // only. Never written into the record: it carries the gate's unsalted
    // fingerprint, which is what a waiver keys on.
    const blocked = gating.map((f) => Object.assign({}, f, { entryIndex }));

    // --- Pass 1: surgical. -------------------------------------------------
    const shapeKeys = new Set();
    const shapeKinds = new Set();
    let knownSecret = false;
    for (const f of gating) {
        if (f.kind === 'known-secret') knownSecret = true;
        else if (PATTERN_BY_KIND.has(f.kind) && typeof f.fingerprint === 'string') {
            shapeKeys.add(`${f.kind}:${f.fingerprint}`);
            shapeKinds.add(f.kind);
        }
    }

    const bluntShapes = (text, keyPath) => {
        let out = text;
        for (const kind of shapeKinds) {
            const re = new RegExp(PATTERN_BY_KIND.get(kind).re.source, 'g');
            out = out.replace(re, (m) => {
                if (!shapeKeys.has(`${kind}:${harShapes.fingerprint(m)}`)) return m;
                note(kind, m, keyPath, 'value', m.length, { class: PATTERN_BY_KIND.get(kind).class });
                return sentinelFor(kind, m, salt);
            });
        }
        return out;
    };

    // A hit the gate found STRUCTURALLY but whose bytes the raw pass cannot
    // match: the value is spelled with JSON escapes on the wire (`/`,
    // `\/`), so the escaped text never forms the run the pattern needs while
    // the parsed string does. Re-read each JSON string token in the text,
    // blunt it decoded, and write back ONLY that token -- rather than letting
    // pass 2 flatten the whole body over one escaped slash.
    const bluntEscapedTokens = (text, keyPath) => {
        if (!text.includes('\\')) return text;
        return text.replace(/"(?:[^"\\\n]|\\.)*"/g, (token) => {
            if (!token.includes('\\')) return token;
            let decoded;
            try { decoded = JSON.parse(token); } catch { return token; }
            if (typeof decoded !== 'string') return token;
            const blunted = bluntShapes(decoded, keyPath);
            return blunted === decoded ? token : JSON.stringify(blunted);
        });
    };

    const bluntSecret = (name, value, keyPath) => {
        note('known-secret', value, keyPath, 'value', value.length, { field: name });
        return sentinelFor('known-secret', value, salt);
    };

    forEachLeaf(entry, (text, keyPath, set, parent, key) => {
        let out = shapeKinds.size ? bluntEscapedTokens(bluntShapes(text, keyPath), keyPath) : text;
        if (knownSecret) {
            // A HAR pair (header, cookie, query, form param) is named by its
            // sibling; a JSON key names its own value.
            const pairName = key === 'value' && parent && typeof parent.name === 'string' ? parent.name : null;
            if (pairName && harSecrets.isUnredactedSecret(pairName, out, policy)) {
                out = bluntSecret(pairName, out, keyPath);
            } else if (typeof key === 'string' && harSecrets.isUnredactedSecret(key, out, policy)) {
                out = bluntSecret(key, out, keyPath);
            } else {
                out = transformNested(out, (node) => {
                    let v = node.value;
                    if (node.name && harSecrets.isUnredactedSecret(node.name, v, policy)) {
                        return bluntSecret(node.name, v, keyPath);
                    }
                    v = harSecrets.replaceMultipartSecretFields(v, (n, val) => bluntSecret(n, val, keyPath), policy);
                    return v;
                });
                out = harSecrets.replaceMultipartSecretFields(out, (n, val) => bluntSecret(n, val, keyPath), policy);
            }
        }
        if (out !== text) set(out);
    });

    // --- Pass 2: whole containing value, for what pass 1 could not reach. ---
    gating = gatingFindings(entry, policy);
    for (const f of gating) {
        const leaf = resolveLeaf(entry, f.keyPath || f.enclosing);
        if (!leaf || leaf.value.startsWith('<BLUNTED:')) continue;
        note(f.kind, leaf.value, f.keyPath || f.enclosing, 'whole-value', leaf.value.length,
            f.class ? { class: f.class } : null);
        leaf.parent[leaf.key] = sentinelFor(f.kind, leaf.value, salt);
    }

    // Location and kind only -- the same non-echoing shape as the findings
    // report, never a value.
    const unblunted = gatingFindings(entry, policy).map((f) => ({
        kind: f.kind, entryIndex, keyPath: f.keyPath, enclosing: f.enclosing,
        fingerprint: f.fingerprint, field: f.kind === 'known-secret' ? f.sample : undefined,
    }));
    return { findings: [...rows.values()], unblunted, blocked };
}

/**
 * Blunt a whole parsed capture in place and attach the record.
 *
 * @returns {{values: number, bytes: number, findings: object[],
 *   unblunted: object[]}} `values` counts DISTINCT values (by kind and salted
 *   fingerprint) -- the same token in fifty requests is one value blunted
 *   fifty times, and the occurrences are in the rows.
 */
function bluntHar(har, opts) {
    const entries = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : [];
    const findings = [];
    const unblunted = [];
    const blocked = [];
    entries.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') return;
        const r = bluntEntry(entry, i, opts);
        findings.push(...r.findings);
        unblunted.push(...r.unblunted);
        blocked.push(...r.blocked);
    });

    const values = new Set(findings.map((f) => `${f.kind}:${f.fingerprint}`)).size;
    const bytes = findings.reduce((n, f) => n + f.bytes, 0);
    if (har && har.log) {
        // A re-scrub replaces the record rather than appending to it: a stale
        // record must never read as current.
        delete har.log[RECORD_KEY];
        if (findings.length) {
            har.log[RECORD_KEY] = {
                schemaVersion: RECORD_SCHEMA_VERSION,
                stage: 'scrub',
                policyVersion: opts && opts.policy && opts.policy.version || null,
                values,
                bytes,
                findings,
            };
        }
    }
    return { values, bytes, findings, unblunted, blocked };
}

/**
 * One line per blunted kind for the console: counts, locations and debt,
 * never a value. The UNSALTED gate fingerprint is printed for shape kinds
 * because it is what a policy waiver keys on -- the same exposure the gate's
 * own stderr has always had -- so the operator can still choose to waive a
 * false positive rather than live with its blunt.
 */
function summarize(result) {
    const byKind = new Map();
    for (const f of result.findings) {
        const k = f.mode === 'whole-value' ? `${f.kind} (whole value)` : f.kind;
        const cur = byKind.get(k) || { occurrences: 0, bytes: 0, debt: f.debt };
        cur.occurrences += f.occurrences;
        cur.bytes += f.bytes;
        byKind.set(k, cur);
    }
    return [...byKind].map(([k, v]) => `${k} x${v.occurrences}, ${v.bytes} byte(s) -- cleaned instead once ${v.debt} lands`);
}

module.exports = {
    RECORD_KEY,
    DEBT,
    bluntEntry,
    bluntHar,
    sentinelFor,
    saltedFingerprint,
    summarize,
};
