'use strict';

/**
 * har-nested.js -- ONE traversal of the encoding layers inside a string,
 * shared by the gate (`har-secrets.js`) and the scrubber (`sanitize-har.js`).
 *
 * WHY THIS EXISTS (issue #454).
 *
 * The two engines each grew their own descent into nested payloads, and they
 * did not descend equally:
 *
 *   - `sanitize-har.js:scrubString` recursed only when `looksFormEncoded(out)`
 *     held. That predicate's character class excludes `{` and `"`, so once the
 *     scrubber decoded a form parameter and landed on a JSON document it could
 *     never re-enter -- structurally, at any depth.
 *   - `har-secrets.js:walkForUnredactedSecrets` had no such limit and
 *     descended through JSON at unbounded depth.
 *
 * So the gate could SEE secrets the scrubber could not REACH, and reported
 * them as unremovable. Three real captures in one day were refused that way,
 * every one for a value both engines already had a rule for.
 *
 * This is the third instance of the same class:
 *
 *   #378  gate did NOT decode form params, scrubber did      -> failed OPEN
 *   #395  gate detected pwd-envelope, scrubber had no rule   -> failed CLOSED
 *   #454  gate descended past JSON, scrubber stopped at it   -> failed CLOSED
 *
 * Note the directions. Unequal reach is not "the gate is too strict" or "the
 * scrubber is too weak" -- it is a single defect that surfaces as whichever
 * engine happens to be behind. Sharing the PREDICATE was already tried
 * (commit b4c1a57) and was not enough, because each engine still owned its own
 * walk. This module shares the WALK.
 *
 * TWO PROPERTIES CARRY THE DESIGN.
 *
 * 1. BYTE PRESERVATION. A level whose subtree is unchanged returns its
 *    ORIGINAL bytes -- never a re-encoded or re-serialized equivalent. The
 *    committed reference is diffed against fresh captures, and re-spelling an
 *    untouched value would churn every such diff for no gain. Only a subtree
 *    that actually changed is written back.
 *
 * 2. ONE `MAX_DEPTH`, EXPORTED, USED BY BOTH CALLERS. This is the parity
 *    guarantee, and it is the whole point. Leaving the gate uncapped while the
 *    scrubber capped at 3 is what reintroduces this bug one layer further
 *    down; two different caps are two different reaches wearing the same name.
 *
 * REACHING THE CAP IS REPORTABLE, NOT SILENT. A traversal that stopped early
 * has, by definition, not looked everywhere -- and a gate that stops early
 * while reporting nothing is a gate that fails OPEN, which is the D3 half of
 * #454 all over again. `onDepthLimit` fires when the cap is hit so the caller
 * can treat "I stopped before the bottom" as a finding rather than as silence.
 */

const {
    decodeNestedJson,
    transformEncodedParams,
} = require('./har-literals.js');

/**
 * How many encoding layers deep either engine will go.
 *
 * Real Meta traffic nests three to four layers routinely -- a form body
 * carrying `variables=<urlencoded JSON>` whose fields carry further JSON
 * documents as strings -- so 3 (the scrubber's old cap) stopped inside the
 * payloads this tooling exists to read. Eight is chosen to sit well past
 * observed traffic while still bounding the work, and hitting it is reported
 * rather than swallowed.
 */
const MAX_DEPTH = 8;

// A form-encoded body or query string worth DECODING: `k=v` pairs that
// actually carry percent escapes. Without an escape there is nothing hidden --
// the value is already visible on the wire in the spelling it will be read in.
//
// A `; `-separated string is a Cookie header, not a form body; it has its own
// scrubber and must keep its separators intact.
//
// THE SINGLE DEFINITION. `sanitize-har.js` and `har-secrets.js` each carried a
// byte-identical private copy, and the comment above the second said outright
// that nothing could detect their drift because neither imported the other.
function looksFormEncoded(text) {
    return typeof text === 'string'
        && /%[0-9A-Fa-f]{2}/.test(text)
        && !/;\s/.test(text)
        && /^[^=&\s{[\]}"]+=[^&]*(?:&|$)/.test(text);
}

/** A string that is ONE percent-encoded payload rather than `k=v` pairs. */
function looksWhollyEncoded(text) {
    return typeof text === 'string'
        && /%[0-9A-Fa-f]{2}/.test(text)
        && !/[=&]/.test(text);
}

/**
 * Walk the encoding layers inside one string, visiting every nested value.
 *
 * `visit({ name, value, depth })` returns the replacement for that value.
 * READ-ONLY MODE IS JUST A CALLER WHOSE `visit` RETURNS ITS INPUT -- the
 * pattern `transformEncodedParams` already established, and the reason the
 * gate and the scrubber can share one traversal without the gate acquiring the
 * ability to rewrite anything.
 *
 * @param {string} text the string to walk
 * @param {(node: {name: string|null, value: string, depth: number}) => string} visit
 * @param {{depth?: number, name?: string|null,
 *          onDepthLimit?: (info: {name: string|null, depth: number}) => void}} [options]
 * @returns {string} `text` with every changed subtree written back, or the
 *   ORIGINAL bytes when nothing changed
 */
function transformNested(text, visit, options) {
    if (typeof text !== 'string' || text.length === 0) return text;
    const opts = options || {};
    const depth = opts.depth || 0;
    const name = opts.name === undefined ? null : opts.name;

    if (depth >= MAX_DEPTH) {
        if (typeof opts.onDepthLimit === 'function') opts.onDepthLimit({ name, depth });
        return text;
    }

    const descend = (childName, childValue) => {
        const replaced = visit({ name: childName, value: childValue, depth: depth + 1 });
        const next = typeof replaced === 'string' ? replaced : childValue;
        return transformNested(next, visit, {
            depth: depth + 1,
            name: childName,
            onDepthLimit: opts.onDepthLimit,
        });
    };

    // 1. A form-encoded body: `k=v&k=v`. Its parameter names are not object
    //    keys, so nothing that walks parsed JSON can see them.
    //    `transformEncodedParams` already preserves the original bytes of any
    //    parameter whose value comes back unchanged.
    if (looksFormEncoded(text)) {
        return transformEncodedParams(text, (paramName, decoded) => descend(paramName, decoded));
    }

    // 2. A JSON document, percent-encoded or not. `decodeNestedJson` parses
    //    first and only percent-decodes as a fallback (#454 D3).
    const parsed = decodeNestedJson(text);
    if (parsed !== null) return transformJsonDocument(text, parsed, descend);

    // 3. One wholly percent-encoded payload carrying neither `=` nor `&`.
    if (looksWhollyEncoded(text)) {
        let decoded;
        try {
            decoded = decodeURIComponent(text.replace(/\+/g, ' '));
        } catch {
            return text;
        }
        const replaced = descend(name, decoded);
        return replaced === decoded ? text : encodeURIComponent(replaced);
    }

    // A plain string: there is no further layer here. The caller's own flat
    // passes are what act on it.
    return text;
}

/**
 * Rewrite the string leaves of an already-parsed JSON document.
 *
 * Returns `originalText` UNCHANGED when no leaf changed -- `JSON.stringify`
 * would otherwise re-spell the document's whitespace and drop its original
 * formatting, churning a committed reference that nothing actually edited.
 */
function transformJsonDocument(originalText, parsed, descend) {
    let changed = false;

    const walk = (node, key) => {
        if (typeof node === 'string') {
            const replaced = descend(key, node);
            if (replaced !== node) changed = true;
            return replaced;
        }
        if (Array.isArray(node)) return node.map((item) => walk(item, key));
        if (node !== null && typeof node === 'object') {
            // A `{name, value}` pair is keyed by its SIBLING, not by its key.
            //
            // HAR stores headers, cookies, query parameters and form params
            // this way, and those objects turn up inside nested payloads too
            // -- a batched request carrying its own header list, say. Under
            // the plain rule the traversal would offer `('value', <secret>)`,
            // and `value` is on nobody's secret-name list, so BOTH engines
            // would miss it.
            //
            // Resolving it HERE rather than in either caller is what keeps the
            // engines symmetric. The gate's old private walk had this rule and
            // the scrubber's did not, so a nested pair was reported as an
            // unremovable secret and gated the capture -- this issue's exact
            // failure, one layer further down. One traversal, one rule, and
            // the gate reports it while the scrubber removes it.
            const pairKeyed = typeof node.name === 'string' && typeof node.value === 'string';
            const out = {};
            for (const k of Object.keys(node)) {
                out[k] = walk(node[k], pairKeyed && k === 'value' ? node.name : k);
            }
            return out;
        }
        return node;
    };

    const result = walk(parsed, null);
    if (!changed) return originalText;

    const serialized = JSON.stringify(result);
    // The document reached us percent-encoded, so it must leave that way or
    // the surrounding layer stops being able to read it.
    return decodeNestedJson(originalText) !== null && looksWhollyEncodedJson(originalText)
        ? encodeURIComponent(serialized)
        : serialized;
}

/** Was this JSON document carried percent-encoded rather than as literal JSON? */
function looksWhollyEncodedJson(text) {
    const trimmed = String(text).trim();
    return !trimmed.startsWith('{') && !trimmed.startsWith('[');
}

module.exports = {
    MAX_DEPTH,
    looksFormEncoded,
    transformNested,
};
