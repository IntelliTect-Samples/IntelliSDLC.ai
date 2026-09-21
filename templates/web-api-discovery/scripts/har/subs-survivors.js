#!/usr/bin/env node
/**
 * subs-survivors.js -- the substitution table as a POST-CONDITION (issue #475).
 *
 * ## The question nothing was asking
 *
 * `sanitize-har.js` writes a key into its substitution table, and a key exists
 * only because the scrub decided the value it names must be replaced. That is
 * ground truth produced by the run itself. Nothing checked the output against
 * it, and the output did not satisfy it: 119 occurrences of one cookie value,
 * 116 replaced and 3 left standing inside a 5.38 MB response body; 128
 * occurrences of one field value, 1 replaced. `verify-scrub.js` passed both
 * runs with `0 blocking leaks`.
 *
 * The gate is not broken. It asks two questions -- does this match a SHAPE,
 * does this match a profile LITERAL -- and neither reaches a value whose only
 * evidence is that the scrubber already said so. This module asks the third.
 *
 * ## Two halves, and neither substitutes for the other
 *
 *   `applySweep`     replaces every remaining occurrence of every original the
 *                    run substituted. The survivors carry no name the policy
 *                    knows and no shape any pattern matches, so no name-reach
 *                    fix (#484, #330, #487) can ever reach them -- only the
 *                    scrubber's own record of the value can. This is the FIX.
 *   `findSurvivors`  asserts the post-condition on what is about to be
 *                    written. This is the GUARD. Without it the sweep regresses
 *                    silently the next time a pass is added downstream of it;
 *                    without the sweep the guard refuses every affected
 *                    capture forever.
 *
 * ## Originals are RECORDED, never parsed out of keys
 *
 * A table key is `${kind}:${name}:${value}` at one call site and
 * `${kind}:${value}` at another, and values routinely contain colons. Parsing
 * one back into an original is wrong by construction -- #475's own
 * reproduction did it and produced two "unrelated originals" of 16 and 19
 * characters that are almost certainly one misparse. So the scrub hands this
 * module the originals it actually substituted, in memory, and this module
 * never reads a key.
 *
 * ## THIS RUN's table, never the merged one
 *
 * `sanitize-har.js` merges each run into a running project table. The merged
 * table holds OTHER captures' credentials: asking whether one of those appears
 * here is a different question with a different false-positive profile, and it
 * is not the question the issue poses. Only this run's substitutions are swept
 * and checked.
 *
 * ## What is deliberately out of scope
 *
 *   * ENCODED spellings. A value surviving only inside a percent-encoded or
 *     base64 blob is not matched here. That axis belongs to the gate's shape
 *     checks and to the nested-reach work; claiming it here would be a reach
 *     fix wearing a post-condition's clothes.
 *   * Originals carrying WHITESPACE, and originals shorter than
 *     `MIN_SWEEPABLE_LENGTH`. Both are the same axis: a value captured by
 *     its field NAME is routinely prose -- #529's locale bundle holds the
 *     label `"Password"` under the key `"Password"`, and the same list carries
 *     `confirm_password`, which an i18n bundle keys a whole sentence on.
 *     Sweeping one rewrites the whole capture to fix one site. Those stay
 *     name- and shape-scrubbed only. See `PROSE_RE` and
 *     `MIN_SWEEPABLE_LENGTH`.
 *   * The TYPED-PII table. `pii.js` returns hash prefixes rather than
 *     originals, by design, so its substitutions cannot feed this check and
 *     are not covered by it. The same class of survivor is therefore still
 *     unguarded for typed PII; closing it means changing what `pii.js` hands
 *     back, which is a larger change than this one and belongs to its own
 *     issue. Stated here so the coverage is not mistaken for total.
 *   * Object KEYS. Only string VALUES are swept and checked; a JSON key that
 *     is itself a credential is not a shape this scrub has ever produced.
 *
 * ## Locations, never values
 *
 * Every finding is a PLACE and a COUNT: kind, key namespace, entry index, JSON
 * key path, length and occurrence count. No original and no replacement is
 * ever emitted. The table's keys ARE the plaintext credential store -- #475
 * learned that by printing `Object.keys(subs)` and rendering live session
 * cookies -- so this module treats it as write-only.
 */

'use strict';

/**
 * The floor, shared by the sweep and the check so they can never disagree
 * about which originals are in play.
 *
 * Sixteen, not #475's suggested eight, and the difference is a measured
 * regression rather than caution. The scrub captures a value by its field
 * NAME, and a name can over-capture: #529 records a locale bundle whose
 * `"Password"` key holds the UI label `"Password"`. Redacting that at its own
 * site damages one string. Sweeping it globally rewrites every `Password` in
 * the capture -- "Forgot Password?" becomes a redaction sentinel -- which is
 * this issue's own fix re-creating #529's defect on the axis it did not
 * consider.
 *
 * Sixteen is not arbitrary either: it is `COOKIE_TOKEN_MIN_LENGTH` in
 * `sanitize-har.js`, this tree's existing answer to "is this value token-ish
 * or is it prose". Both survivors #475 measured are longer -- 17 and 24
 * characters -- so nothing the issue is about is given away.
 *
 * The residual, stated rather than hidden: a 16-character-or-longer value that
 * is prose, under a secret field name, is still swept globally. It is also
 * still redacted at its own site by the name control, so the two at least
 * agree; the name list is where that class is decided, not here.
 */
const MIN_SWEEPABLE_LENGTH = 16;

// Alternatives per compiled matcher. A single pattern over a 13,000-entry
// table is hundreds of kilobytes of source, which is where a regex engine
// stops being predictable. Several smaller patterns scanned against the SAME
// input and merged afterwards is equivalent and bounded -- see `replaceAll`.
const MATCHER_CHUNK_SIZE = 2000;

/**
 * An original this sweep declines to act on globally, whatever its length.
 *
 * The length floor closes the single-word case and not the rest of it. The
 * secret field list carries `confirm_password`, `new_password`,
 * `security_code` -- precisely the names an i18n bundle reuses as translation
 * KEYS -- so a locale string like "Confirm your password" is captured by name,
 * clears any sane floor, and would be swept into every other place that
 * sentence appears. Length cannot tell a 22-character token from a
 * 22-character sentence; whitespace can.
 *
 * A credential travelling as a bare form or JSON value does not contain a
 * space. A cookie value cannot carry one, a URL-borne token cannot, and the
 * hex, JWT and UUID shapes cannot. Neither survivor #475 measured does. A
 * sentence almost always does.
 *
 * Only the GLOBAL edit is declined. The value is still replaced at its own
 * site by the control that captured it, and it is excluded from the check as
 * well as the sweep, so the two cannot disagree and refuse the capture over a
 * value the sweep is not allowed to remove.
 *
 * THE RESIDUAL, and it is an assumption rather than a guarantee for exactly
 * one kind. "A credential does not contain a space" is structurally true for
 * the shape-matched kinds, forced by the `\S+` capture for `bearer`, and true
 * of cookie-octet syntax for `cookie`. It is NOT true for `field`: a
 * passphrase-style password legitimately contains spaces, and the
 * password-family names are the same ones the i18n collision lives on. So a
 * passphrase echoed back elsewhere in the capture -- a validation error
 * quoting it, say -- is exempted from both the sweep and the check by this
 * rule. That is the cost of not corrupting every locale string keyed on those
 * same names, and it is recorded here rather than argued away, because the
 * class it exempts is the one this module exists to catch.
 */
const PROSE_RE = /\s/;

const MAX_DEPTH = 60;

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The substitutions this run may sweep, longest original first.
 *
 * Longest-first is not cosmetic. One original is routinely a substring of
 * another -- a cookie value and the same value inside a longer handle -- and
 * replacing the short one first would leave a mangled fragment of the long one
 * behind, which no later pass could recognise as anything.
 *
 * `produced` is an IDENTITY test, the same discipline as `alreadySubstituted`
 * in the scrubber: a value this run emitted as a replacement is passed over,
 * because sweeping a fake would rewrite the scrub's own output.
 *
 * Ties are broken on the key, sorted, first wins. A deterministic choice
 * matters because the scrub currently records the same datum under two keys in
 * one case -- the JSON field pass passes `"name":"` as the NAME -- so two
 * entries can legitimately carry one original. Determinism here means two runs
 * over one input produce the same bytes.
 *
 * @param {Array<{key: string, kind: string, name: ?string, original: string, replacement: string}>} entries
 * @param {Set<string>} [produced] replacements this run emitted
 */
function sweepableEntries(entries, produced) {
    const byOriginal = new Map();
    const sorted = entries.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    // Every replacement this run recorded, as a second identity guard beside
    // `produced`. `produced` is populated at one call site and not at the
    // others, so a fake could otherwise be recorded as some entry's original
    // and swept -- rewriting a replacement this run had just inserted, which
    // is exactly how a scrub corrupts its own sentinels (#529).
    const replacements = new Set(entries.map((e) => e.replacement));
    for (const e of sorted) {
        if (typeof e.original !== 'string' || typeof e.replacement !== 'string') continue;
        if (e.original.length < MIN_SWEEPABLE_LENGTH) continue;
        if (PROSE_RE.test(e.original)) continue;
        if (e.original === e.replacement) continue;
        if (replacements.has(e.original)) continue;
        if (produced && produced.has(e.original)) continue;
        if (!byOriginal.has(e.original)) byOriginal.set(e.original, e);
    }
    return [...byOriginal.values()]
        .sort((a, b) => b.original.length - a.original.length
            || (a.original < b.original ? -1 : a.original > b.original ? 1 : 0));
}

/**
 * Compile the sweepable originals into scanners plus an original -> entry map.
 */
function compileMatcher(entries) {
    const map = new Map();
    for (const e of entries) map.set(e.original, e);
    const regexes = [];
    for (let i = 0; i < entries.length; i += MATCHER_CHUNK_SIZE) {
        const chunk = entries.slice(i, i + MATCHER_CHUNK_SIZE);
        regexes.push(new RegExp(chunk.map((e) => escapeRegExp(e.original)).join('|'), 'g'));
    }
    return { map, regexes, size: entries.length };
}

/**
 * Every match of any original in `text`, as `{index, original}`, non-overlapping.
 *
 * Collected from ALL scanners against the ORIGINAL text and merged once,
 * rather than running each scanner over the output of the last. Sequential
 * passes would let a later chunk match inside a replacement an earlier chunk
 * had just inserted, which is how a scrub corrupts its own sentinels (#529).
 * Earliest wins, and at one index the longest wins. A later hit STARTING
 * inside an accepted one is dropped whole, including when it would have
 * extended past it -- two overlapping replacements have no well-defined
 * result, and the alternative (splitting one) would leave the fragment this
 * function exists to prevent. Reaching that case needs two independently
 * salted high-entropy values to share a straddling substring, which the corpus
 * has never produced; it is recorded as an accepted limitation rather than
 * handled.
 */
function findMatches(text, matcher) {
    const hits = [];
    for (const re of matcher.regexes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            hits.push({ index: m.index, original: m[0] });
            if (m[0].length === 0) re.lastIndex++;
        }
    }
    if (hits.length < 2) return hits;
    hits.sort((a, b) => a.index - b.index || b.original.length - a.original.length);
    const merged = [];
    let end = -1;
    for (const h of hits) {
        if (h.index < end) continue;
        merged.push(h);
        end = h.index + h.original.length;
    }
    return merged;
}

/**
 * `text` with every substituted original replaced by its recorded fake.
 *
 * Returns the input string itself when nothing matched, so an unaffected
 * document is not merely equal to what it was but IS what it was.
 */
function replaceAll(text, matcher) {
    const hits = findMatches(text, matcher);
    if (hits.length === 0) return text;
    return spliceMatches(text, hits, matcher);
}

/**
 * `text` with each already-found match replaced. One definition, shared by
 * `replaceAll` and by the sweep's per-leaf callback -- which needs the hit
 * count as well as the new text, and would otherwise carry a second copy of
 * this loop to get it.
 */
function spliceMatches(text, hits, matcher) {
    let out = '';
    let pos = 0;
    for (const h of hits) {
        out += text.slice(pos, h.index) + matcher.map.get(h.original).replacement;
        pos = h.index + h.original.length;
    }
    return out + text.slice(pos);
}

/**
 * Walk the string values of a parsed HAR, with a location for each.
 *
 * Parsed leaves rather than serialized text, for two reasons. JSON escaping:
 * a response body is a STRING inside the document, so an original carrying a
 * quote or a backslash appears escaped in the serialized form and a literal
 * match over that text would miss it. And location: the walk yields the entry
 * index and the JSON key path for free, which is what lets a finding name a
 * place without naming a value.
 *
 * `visit` returns a replacement string, or undefined to leave the leaf alone.
 */
function walkStringValues(har, visit) {
    const entries = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : null;

    function walk(node, keyPath, entryIndex, depth) {
        if (depth > MAX_DEPTH || node === null || node === undefined) return;
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const child = node[i];
                if (typeof child === 'string') {
                    const next = visit(child, `${keyPath}[${i}]`, entryIndex);
                    if (next !== undefined) node[i] = next;
                } else {
                    walk(child, `${keyPath}[${i}]`, entryIndex, depth + 1);
                }
            }
            return;
        }
        if (typeof node !== 'object') return;
        for (const key of Object.keys(node)) {
            const child = node[key];
            const at = keyPath ? `${keyPath}.${key}` : key;
            if (typeof child === 'string') {
                const next = visit(child, at, entryIndex);
                if (next !== undefined) node[key] = next;
            } else {
                walk(child, at, entryIndex, depth + 1);
            }
        }
    }

    if (entries) {
        entries.forEach((entry, i) => walk(entry, '', i, 0));
        // Everything outside `log.entries` -- creator, comment, pages -- still
        // gets swept. A scrub that covered only the entries would leave a
        // value standing in a field the tooling itself wrote.
        for (const key of Object.keys(har.log)) {
            if (key === 'entries') continue;
            const child = har.log[key];
            if (typeof child === 'string') {
                const next = visit(child, `log.${key}`, null);
                if (next !== undefined) har.log[key] = next;
            } else {
                walk(child, `log.${key}`, null, 0);
            }
        }
        return;
    }
    walk(har, '', null, 0);
}

/**
 * Replace every surviving occurrence of every substituted original, in place.
 *
 * @returns {{entries: number, occurrences: number, leaves: number}} counts only
 */
function applySweep(har, entries, produced) {
    const sweepable = sweepableEntries(entries, produced);
    if (sweepable.length === 0) return { entries: 0, occurrences: 0, leaves: 0 };
    const matcher = compileMatcher(sweepable);
    let occurrences = 0;
    let leaves = 0;
    walkStringValues(har, (text) => {
        const hits = findMatches(text, matcher);
        if (hits.length === 0) return undefined;
        occurrences += hits.length;
        leaves++;
        return spliceMatches(text, hits, matcher);
    });
    return { entries: sweepable.length, occurrences, leaves };
}

/**
 * Every place a substituted original still survives in `har`.
 *
 * The post-condition, run on the document immediately before it is written.
 * The only steps that follow are serialization and the literal pass, and
 * neither can put an original back: serialization escapes, and the literal
 * pass only removes.
 *
 * @returns {Array<{kind, namespace, entryIndex, keyPath, length, count}>}
 */
function findSurvivors(har, entries, produced) {
    const sweepable = sweepableEntries(entries, produced);
    if (sweepable.length === 0) return [];
    const matcher = compileMatcher(sweepable);
    const findings = [];
    walkStringValues(har, (text, keyPath, entryIndex) => {
        const hits = findMatches(text, matcher);
        if (hits.length === 0) return undefined;
        const perOriginal = new Map();
        for (const h of hits) perOriginal.set(h.original, (perOriginal.get(h.original) || 0) + 1);
        for (const [original, count] of perOriginal) {
            const entry = matcher.map.get(original);
            findings.push({
                kind: 'substitution-survivor',
                substitutionKind: entry.kind,
                namespace: namespaceOf(entry),
                entryIndex,
                keyPath,
                length: original.length,
                count,
            });
        }
        return undefined;
    });
    return findings;
}

/**
 * The key namespace of an entry -- `cookie:datr`, `hex32` -- and nothing more.
 *
 * The NAME half is a field or header name, which the policy publishes and the
 * gate already prints; the VALUE half is the credential and never appears.
 */
function namespaceOf(entry) {
    return entry.name ? `${entry.kind}:${String(entry.name).toLowerCase()}` : entry.kind;
}

/**
 * Substitutions that are not reversible: distinct originals sharing one fake.
 *
 * The table exists to be read backwards. Two unrelated originals mapping to
 * one replacement makes that ambiguous for the pair, which is #475's second,
 * narrower defect.
 *
 * A shared replacement is NOT automatically a defect. When one original is a
 * substring of the other the collapse is correct -- the sweep replaces the
 * longer one and the shorter never appears independently. Only unrelated
 * originals are reported.
 *
 * Reported, never blocking, and lengths only. Widening `fakeFor`'s hash would
 * change every fake in every merged table and every committed reference, which
 * is an owner's decision and not a scrub's.
 */
function findCollisions(entries) {
    const byReplacement = new Map();
    for (const e of entries) {
        if (typeof e.original !== 'string' || typeof e.replacement !== 'string') continue;
        if (!byReplacement.has(e.replacement)) byReplacement.set(e.replacement, new Map());
        byReplacement.get(e.replacement).set(e.original, e);
    }
    const collisions = [];
    for (const [, originals] of byReplacement) {
        if (originals.size < 2) continue;
        const list = [...originals.keys()];
        const unrelated = list.filter((a) => !list.some((b) => b !== a && b.includes(a)));
        if (unrelated.length < 2) continue;
        collisions.push({
            kind: 'non-reversible-substitution',
            namespaces: unrelated.map((o) => namespaceOf(originals.get(o))).sort(),
            lengths: unrelated.map((o) => o.length).sort((a, b) => a - b),
            count: unrelated.length,
        });
    }
    return collisions;
}

/**
 * One operator-facing line per finding. Places and counts; never a value.
 */
function describeSurvivor(f) {
    const at = f.entryIndex === null || f.entryIndex === undefined
        ? (f.keyPath || 'outside log.entries')
        : `entry ${f.entryIndex} ${f.keyPath}`;
    return `${f.namespace} (${f.length} chars) x${f.count} at ${at}`;
}

function describeCollision(c) {
    return `${c.count} originals share one replacement: ` +
        `${c.namespaces.join(', ')} (lengths ${c.lengths.join(', ')})`;
}

module.exports = {
    MIN_SWEEPABLE_LENGTH,
    MATCHER_CHUNK_SIZE,
    sweepableEntries,
    compileMatcher,
    findMatches,
    replaceAll,
    walkStringValues,
    applySweep,
    findSurvivors,
    findCollisions,
    namespaceOf,
    describeSurvivor,
    describeCollision,
};
