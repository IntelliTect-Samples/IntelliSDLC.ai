#!/usr/bin/env node
/**
 * har-policy.js -- the merged scrub policy shared by the scrubber and both
 * verifiers (issue #297, Stage 1).
 *
 * Three inputs, one merge, one definition:
 *
 *   har-policy.default.json     synced from IntelliSDLC.ai, committed, stringent
 *   .har-policy.project.json    the consuming project's overrides, committed
 *   .har-profile.json           the operator's literals, GITIGNORED (har-profile.js)
 *
 * The split that matters is VALUES vs RULES, not project vs operator. Names,
 * patterns and decisions live in the two policy files and are reviewable in a
 * diff; a raw identity value may only ever live in the profile.
 *
 * Why a merged policy at all: the scrubber and the two gates currently carry
 * three different ideas of what is sensitive -- `pii.js` scrubs 13 types while
 * `har-shapes.js` gates 8 -- so a type can be scrubbed and never gated, or
 * gated and never scrubbed. One document consumed by all three cannot drift.
 *
 * The two axes:
 *
 *   secret   grants access.  Name, literal AND shape evidence all gate.
 *   identity names a person. Literal evidence gates; shape evidence advises,
 *                            because shape carries no provenance -- a
 *                            Luhn-valid 16-digit run is a card, a trip id, or
 *                            ~10% of digit runs by chance.
 *
 * The floor lives HERE, not in the callers: a project file may lower an
 * identity class, but any attempt to lower a secret CLASS is a load-time
 * error. A caller cannot forget a check it never makes.
 *
 * What the floor does NOT forbid, deliberately, is removing an individual
 * name: `notSecretFields` may subtract a name the synced default shipped,
 * because a name list has false positives and a gate with no escape hatch is
 * the undisableable gate this issue exists to replace. Since `named-credential`
 * is caught by NAME or not at all, that subtraction is the one input that can
 * hollow out a secret class while its setting still reads `gate` -- so every
 * upstream name a project removes is recorded in `loosenedSecretNames` for the
 * gates to report. Allowed, never silent.
 *
 * The sanctioned escape for a specific false-positive VALUE is a `waiver`,
 * which is keyed on the non-reversible fingerprint, must carry a reason, and
 * expires -- so a reviewer sees THAT something was waived and why, without the
 * value ever entering the repo.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { findUpward } = require('./har-profile.js');

const POLICY_FILENAME = '.har-policy.project.json';
const DEFAULT_POLICY_FILENAME = 'har-policy.default.json';

// The only schema this loader understands. A file declaring a newer one is a
// hard failure: silently ignoring a schema we cannot interpret would apply a
// policy nobody wrote.
const SUPPORTED_SCHEMA_VERSION = 1;

// `gate` blocks, `advise` reports without blocking, `off` neither detects nor
// reports as a finding. A disabled class still surfaces as a warning at the
// call sites (Stage 2 onward), so the cost of a loosening stays visible.
const SETTINGS = ['gate', 'advise', 'off'];

// Lists of names that a project file APPENDS to rather than replaces.
// Replacement would mean a project adding one field name silently discarded
// every default -- the loosening nobody intended and nobody sees.
const APPEND_LISTS = ['identifierFields', 'secretFields', 'secretHeaders', 'notSecretFields'];

// har-shapes.js emits a 12-hex non-reversible fingerprint; a waiver keys on it.
const FINGERPRINT_RE = /^[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WAIVER_KEYS = ['kind', 'fingerprint', 'reason', 'expires'];

class PolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PolicyError';
    }
}

const HOWTO =
    `Declare project overrides in ${POLICY_FILENAME}, which merges over the ` +
    `synced ${DEFAULT_POLICY_FILENAME}. It holds rules only -- names, patterns ` +
    `and decisions. A raw identity value belongs in the gitignored ` +
    `.har-profile.json and nowhere else.`;

// `_comment` is documentation for the humans reading the JSON. It is stripped
// before validation and before the version hash, so re-wording a comment does
// not read as a policy change.
function stripComments(doc) {
    const out = {};
    for (const key of Object.keys(doc)) {
        if (key === '_comment') continue;
        out[key] = doc[key];
    }
    return out;
}

function readJson(file, label) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw new PolicyError(`${file}: cannot read the ${label} policy -- ${e.message}`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new PolicyError(`${file}: cannot parse JSON -- ${e.message}`);
    }
}

function requireObject(value, file, what) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new PolicyError(`${file}: "${what}" must be an object.`);
    }
}

function requireStringArray(value, file, what) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new PolicyError(`${file}: "${what}" must be an array of strings.`);
    }
}

/**
 * Validate one document against the vocabulary the DEFAULT policy declares.
 *
 * The default file is the schema authority: it lists every top-level key,
 * every class, every class kind and every PII field dictionary. A project file
 * naming anything outside that vocabulary is a typo, and a typo that is
 * silently ignored is how a repo ends up believing it changed a gate it never
 * touched. So an unknown key is a hard error, never a shrug.
 */
function validateDocument(doc, file, vocabulary) {
    requireObject(doc, file, 'policy');

    for (const key of Object.keys(doc)) {
        if (!vocabulary.topLevel.includes(key)) {
            throw new PolicyError(
                `${file}: unknown policy key "${key}". Known keys: ` +
                `${vocabulary.topLevel.join(', ')}. ${HOWTO}`);
        }
    }

    if (doc.schemaVersion !== undefined && doc.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        throw new PolicyError(
            `${file}: "schemaVersion" ${JSON.stringify(doc.schemaVersion)} is not supported ` +
            `(this loader understands ${SUPPORTED_SCHEMA_VERSION}).`);
    }

    if (doc.classes !== undefined) validateClasses(doc.classes, file, vocabulary);
    for (const list of APPEND_LISTS) {
        if (doc[list] !== undefined) requireStringArray(doc[list], file, list);
    }
    if (doc.identifierFields !== undefined) validateIdentifierFields(doc.identifierFields, file);
    if (doc.piiFields !== undefined) validatePiiFields(doc.piiFields, file, vocabulary);
    if (doc.cardIssuers !== undefined) validateCardIssuers(doc.cardIssuers, file);
    if (doc.waivers !== undefined) validateWaivers(doc.waivers, file, vocabulary);
}

/**
 * Extra issuer identification ranges, as DATA.
 *
 * The shipped table lives in `har-shapes.js`, because an IIN range is a public
 * payment-network standard rather than anybody's project concept. What is a
 * project concept is which markets a consumer is IN: a repo capturing a payment
 * flow in a Maestro or RuPay market has cards the shipped table does not name,
 * and "patch upstream" is not an override path.
 *
 * So this list APPENDS to the standard and can never subtract from it. Card
 * detection is loosened by lowering `classes.identity.credit-card`, which reads
 * as a setting a reviewer can see; deleting the range that would have caught
 * something is the invisible loosening this whole policy model exists to stop.
 *
 * Every field is validated rather than trusted, because a range that loads and
 * does not mean what its author wrote is worse than one that fails: `[5, 69]`
 * looks like "5 through 69" and actually claims every prefix from 05 to 69,
 * since the matcher consumes as many leading digits as the HIGH bound is wide.
 */
function validateCardIssuers(issuers, file) {
    if (!Array.isArray(issuers)) {
        throw new PolicyError(
            `${file}: "cardIssuers" must be an array of issuer ranges.`);
    }
    issuers.forEach((issuer, i) => validateCardIssuer(issuer, `${file}: cardIssuers[${i}]`, file, i));
}

const CARD_ISSUER_KEYS = ['brand', 'prefixes', 'lengths'];

// The window is the DETECTOR's, not the payment industry's. The credit-card
// pattern in har-shapes.js matches a bounded run of 13 to 19 digits, so that is the
// only thing the predicate is ever offered -- and 12 is where this is easy to get
// wrong, because 12 IS a real Maestro length. A consumer adding the range for
// the cards their market actually mints would pass validation and then detect
// nothing, forever, silently. That is precisely the rule-that-can-never-fire
// this validator exists to refuse, so the bound tracks the detector rather than
// the standard. `har-card-issuers.test.js` case 8 probes the pattern for its own
// floor and ceiling and fails if these two numbers stop agreeing with it.
const CARD_LENGTH_MIN = 13;
const CARD_LENGTH_MAX = 19;

function validateCardIssuer(issuer, at, file, index) {
    requireObject(issuer, file, `cardIssuers[${index}]`);
    for (const key of Object.keys(issuer)) {
        if (!CARD_ISSUER_KEYS.includes(key)) {
            throw new PolicyError(
                `${at}: unknown issuer key "${key}". Known: ${CARD_ISSUER_KEYS.join(', ')}.`);
        }
    }
    if (typeof issuer.brand !== 'string' || issuer.brand.trim() === '') {
        throw new PolicyError(
            `${at}: "brand" is required and must be a non-empty string. It is what a ` +
            `reviewer reads to know which market this range was added for.`);
    }
    validateCardLengths(issuer.lengths, at);
    validateCardPrefixes(issuer.prefixes, at);
}

function validateCardLengths(lengths, at) {
    if (!Array.isArray(lengths) || lengths.length === 0) {
        throw new PolicyError(
            `${at}: "lengths" must be a non-empty array. An issuer with no lengths matches ` +
            `nothing while reading as though it matches something.`);
    }
    for (const len of lengths) {
        if (!Number.isInteger(len) || len < CARD_LENGTH_MIN || len > CARD_LENGTH_MAX) {
            throw new PolicyError(
                `${at}: length ${JSON.stringify(len)} must be a whole number from ` +
                `${CARD_LENGTH_MIN} to ${CARD_LENGTH_MAX} -- the card pattern never offers ` +
                `the predicate a run outside that window, so any other value is a rule ` +
                `that can never fire. This refuses 12 even though 12 is a real card ` +
                `length: a range that validates and then detects nothing is worse than ` +
                `one that fails at load.`);
        }
    }
}

function validateCardPrefixes(prefixes, at) {
    if (!Array.isArray(prefixes) || prefixes.length === 0) {
        throw new PolicyError(`${at}: "prefixes" must be a non-empty array of [low, high] ranges.`);
    }
    for (const range of prefixes) {
        if (!Array.isArray(range) || range.length !== 2
            || !range.every((n) => Number.isInteger(n) && n >= 0)) {
            throw new PolicyError(
                `${at}: every prefix must be a [low, high] pair of whole numbers. ` +
                `A single value is written as an equal pair, e.g. [50, 50].`);
        }
        const [low, high] = range;
        if (low > high) {
            throw new PolicyError(`${at}: prefix range [${low}, ${high}] has its bounds reversed.`);
        }
        if (String(low).length !== String(high).length) {
            throw new PolicyError(
                `${at}: prefix range [${low}, ${high}] mixes digit widths. A range is ` +
                `matched at the width of its own bounds, so [${low}, ${high}] would compare ` +
                `the first ${String(high).length} digits and claim far more than it names. ` +
                `Write one range per width.`);
        }
    }
}

function validateClasses(classes, file, vocabulary) {
    requireObject(classes, file, 'classes');
    for (const className of Object.keys(classes)) {
        const kinds = vocabulary.classes[className];
        if (!kinds) {
            throw new PolicyError(
                `${file}: unknown class "${className}". The policy model has exactly two ` +
                `axes: ${Object.keys(vocabulary.classes).join(' and ')}.`);
        }
        requireObject(classes[className], file, `classes.${className}`);
        for (const kind of Object.keys(classes[className])) {
            if (!kinds.includes(kind)) {
                throw new PolicyError(
                    `${file}: unknown ${className} class "${kind}". Known: ${kinds.join(', ')}.`);
            }
            const setting = classes[className][kind];
            if (!SETTINGS.includes(setting)) {
                throw new PolicyError(
                    `${file}: classes.${className}.${kind} is ${JSON.stringify(setting)}; ` +
                    `it must be one of ${SETTINGS.join(', ')}.`);
            }
        }
    }
}

function validatePiiFields(piiFields, file, vocabulary) {
    requireObject(piiFields, file, 'piiFields');
    for (const type of Object.keys(piiFields)) {
        if (!vocabulary.piiTypes.includes(type)) {
            throw new PolicyError(
                `${file}: unknown piiFields type "${type}". Known: ${vocabulary.piiTypes.join(', ')}.`);
        }
        requireStringArray(piiFields[type], file, `piiFields.${type}`);
    }
}

/**
 * A waiver is a committed, reviewable exception to a gating finding.
 *
 * Every field it demands exists so the waiver is auditable without the value:
 * `fingerprint` identifies the finding non-reversibly, `kind` stops one
 * fingerprint waiving an unrelated detector, `reason` is what a reviewer reads,
 * and `expires` is what stops a one-off exception becoming permanent. A waiver
 * that matches nothing is worse than no waiver at all -- it reads as cover --
 * so a malformed fingerprint is rejected rather than tolerated.
 */
function validateWaivers(waivers, file, vocabulary) {
    if (!Array.isArray(waivers)) {
        throw new PolicyError(`${file}: "waivers" must be an array.`);
    }
    const allKinds = [];
    for (const kinds of Object.values(vocabulary.classes)) allKinds.push(...kinds);
    waivers.forEach((waiver, i) => validateWaiver(waiver, `${file}: waivers[${i}]`, file, i, allKinds));
}

function validateWaiver(waiver, at, file, index, allKinds) {
    requireObject(waiver, file, `waivers[${index}]`);
    for (const key of Object.keys(waiver)) {
        if (!WAIVER_KEYS.includes(key)) {
            throw new PolicyError(`${at}: unknown waiver key "${key}".`);
        }
    }
    if (!allKinds.includes(waiver.kind)) {
        throw new PolicyError(
            `${at}: unknown kind "${waiver.kind}". A waiver may only cover a ` +
            `classified finding. Known: ${allKinds.join(', ')}.`);
    }
    if (typeof waiver.fingerprint !== 'string' || !FINGERPRINT_RE.test(waiver.fingerprint)) {
        throw new PolicyError(
            `${at}: "fingerprint" must be the 12-character hex fingerprint reported ` +
            `by the verifier. A waiver that matches nothing reads as cover for a ` +
            `finding nobody triaged.`);
    }
    if (typeof waiver.reason !== 'string' || waiver.reason.trim() === '') {
        throw new PolicyError(
            `${at}: "reason" is required. A committed waiver exists so a reviewer ` +
            `can see WHY a finding was accepted.`);
    }
    if (waiver.expires !== undefined
        && (typeof waiver.expires !== 'string' || !ISO_DATE_RE.test(waiver.expires)
            || Number.isNaN(Date.parse(`${waiver.expires}T00:00:00Z`)))) {
        throw new PolicyError(`${at}: "expires" must be a YYYY-MM-DD date.`);
    }
}

/**
 * `identifierFields` -- names of fields whose CONTENTS are an object id.
 *
 * The one legitimate use of the field-name axis against a shape finding. A
 * shape carries no provenance, but a KEY NAME does: a card-shaped digit run
 * sitting at `media_id` is a card only in the sense that ~10% of digit runs
 * are. Measured in the field: 176 residual card findings, every one a false
 * positive, from 16 provider object ids echoed across a corpus.
 *
 * Keying on the NAME rather than the value is the whole point. A per-value
 * waiver has to be rewritten every time the provider rotates an id; a field
 * name is stable, so declaring it once is a configuration rather than a chore.
 *
 * This is emphatically NOT "the value looks safe, so it is safe" -- that
 * inversion is the bug this subsystem has now shipped four times. It is
 * "this field is documented to hold an id", which is a claim about
 * provenance that a human wrote down and a reviewer can read in a diff.
 *
 * An entry is a SEGMENT PATTERN, not a regular expression. See
 * `IDENTIFIER_SYNTAX` below for the accepted language and why it is restricted.
 * The upstream default carries generic patterns only; a specific provider's
 * field name is a consumer concept and belongs in `.har-policy.project.json`.
 */

/**
 * Why this is a restricted language and not a regular expression.
 *
 * `isIdentifierField` runs a POLICY-supplied pattern against field names
 * lifted out of a CAPTURED body -- third-party data, in a tool whose whole
 * purpose is capturing third-party APIs. While the pattern was an arbitrary
 * regular expression, an ordinary anti-pattern in a policy file plus a long
 * field name in a response hung both verifiers: `/(a+)+b/` against 28
 * characters was measured at 51 SECONDS.
 *
 * DETECTING the bad ones was tried and abandoned, and it is worth saying why
 * so nobody re-proposes it. A probe has to derive an adversarial alphabet for
 * the pattern, and character classes, `\w`, `\d`, backreferences and
 * lookaround each defeat that in a different way. Two patterns that sailed
 * through a probe which looked convincing:
 *
 *     /(?:12345678)?(a+)+b/                      loads in  9 ms -> 83,949 ms
 *     /^(stripe|square|adyen|klarna)_(\w+)+id$/i loads in 12 ms ->  6,243 ms
 *
 * The second is exactly what a project author writes to catch several
 * providers' id-suffixed fields, and it hangs on a 38-character name. That is
 * a whack-a-mole nobody wins, and passing it means certifying arbitrary regex
 * as safe -- a claim no cheap check can make.
 *
 * So the vulnerability is made UNREPRESENTABLE instead of detected. This is
 * the design rule this subsystem keeps relearning, one level up: stop
 * inspecting shape for badness, restrict the input space so badness cannot be
 * expressed. Same lesson as requiring an assigned issuer identifier instead of
 * tuning Luhn, and as deciding "already scrubbed" by identity rather than by
 * what a value looks like.
 *
 * Narrowing the syntax is safe TODAY and would not be later: `identifierFields`
 * ships empty, this has not merged, and there are no consumers. The day a
 * project writes a regular expression into `.har-policy.project.json` it
 * becomes a breaking change forever.
 *
 * THE LANGUAGE. A field name is first split into SEGMENTS on `_`, `-`, `.`
 * and camel-case boundaries, lowercased. A pattern is one of five forms, where
 * `word` is one or more segments written with `_` or `-` between them:
 *
 *     word            the whole name is exactly these segments
 *     *word           the name ENDS WITH these segments
 *     word*           the name STARTS WITH these segments
 *     word*word       the name starts with the first and ends with the second
 *     *word*          these segments appear anywhere, as whole segments
 *
 * Matching is array comparison over segments: linear in the length of the
 * name, with nothing to backtrack over. Segment awareness is the point -- it
 * is what makes `*id` match `media_id`, `item-id` and `objectId` while
 * leaving `valid`, `paid` and `android` alone. A substring matcher could not
 * tell those apart, and a regular expression could, at the cost above.
 *
 * What the language deliberately cannot express is alternation. A project
 * wanting four providers writes four entries, which a reviewer reads more
 * easily than one pattern anyway.
 */
const IDENTIFIER_SYNTAX =
    'a segment pattern: "word", "*word", "word*", "word*word" or "*word*", where word is one or ' +
    'more alphanumeric segments joined by "_" or "-" (for example "*id", "user*", "trip_slug"). ' +
    'Regular expressions are NOT accepted -- a policy pattern runs against field names taken from ' +
    'captured response bodies, and an arbitrary regex there can hang the gate.';

const IDENTIFIER_LIMITS = Object.freeze({
    // A JSON key or HTTP field name longer than this is not a field name, so
    // there is nothing to decide. Kept alongside the restricted language
    // because it costs nothing and bounds the input space regardless: it is
    // five times the longest name in the shipped vocabulary,
    // `x-instagram-rupload-params` at 26.
    maxFieldNameChars: 128,
});

// One or more alphanumeric segments joined by `_` or `-`. No `*`, no
// whitespace, no leading or trailing separator.
const IDENTIFIER_WORD_RE = /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/;

/**
 * Split a field name into lowercase segments.
 *
 * Separator characters and camel-case boundaries both start a new segment, so
 * `media_id`, `item-id`, `media.id` and `mediaId` all segment identically.
 * The second replacement keeps an acronym whole -- `HTTPServer` is
 * `http`,`server`, not `h`,`t`,`t`,`p`,`server` -- and requires two or more
 * capitals so that `mediaIDs` stays `media`,`ids` rather than splitting the
 * plural off its acronym.
 */
function identifierSegments(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_.-]+/)
        .filter((part) => part !== '')
        .map((part) => part.toLowerCase());
}

function startsWithSegments(segments, prefix) {
    if (prefix.length > segments.length) return false;
    for (let i = 0; i < prefix.length; i++) if (segments[i] !== prefix[i]) return false;
    return true;
}

function endsWithSegments(segments, suffix) {
    if (suffix.length > segments.length) return false;
    const offset = segments.length - suffix.length;
    for (let i = 0; i < suffix.length; i++) if (segments[offset + i] !== suffix[i]) return false;
    return true;
}

function containsSegments(segments, run) {
    if (run.length > segments.length) return false;
    for (let start = 0; start + run.length <= segments.length; start++) {
        let hit = true;
        for (let i = 0; i < run.length; i++) {
            if (segments[start + i] !== run[i]) { hit = false; break; }
        }
        if (hit) return true;
    }
    return false;
}

/**
 * Parse one entry into a matcher, or fail the load.
 *
 * A pattern that cannot be parsed must fail the LOAD, not match nothing at
 * match time: a policy that loads without meaning what its author wrote is the
 * silent failure this loader exists to refuse.
 */
function compileIdentifierField(entry, file, index) {
    const at = `${file}: identifierFields[${index}]`;
    const refuse = (why) => {
        throw new PolicyError(`${at}: ${JSON.stringify(entry)} ${why}. Expected ${IDENTIFIER_SYNTAX}`);
    };
    if (typeof entry !== 'string' || entry === '') refuse('is empty');

    const stars = (entry.match(/\*/g) || []).length;
    if (stars > 2) refuse('has more than two "*"');

    const parts = entry.split('*');
    const words = parts.map((part) => {
        if (part === '') return null;
        if (!IDENTIFIER_WORD_RE.test(part)) refuse(`contains ${JSON.stringify(part)}, which is not a word`);
        return identifierSegments(part);
    });

    // Five forms, keyed on where the stars fall. Anything else is refused --
    // including a bare `*`, which would match every field in every payload and
    // so disable the identity shape classes wholesale without ever saying so.
    if (parts.length === 1) return { kind: 'exact', segments: words[0], source: entry };
    if (parts.length === 2) {
        const [head, tail] = words;
        if (head && tail) return { kind: 'bracket', head, tail, source: entry };
        if (tail) return { kind: 'suffix', segments: tail, source: entry };
        if (head) return { kind: 'prefix', segments: head, source: entry };
        refuse('is a bare "*", which would match every field name');
    }
    if (parts.length === 3 && !words[0] && words[1] && !words[2]) {
        return { kind: 'contains', segments: words[1], source: entry };
    }
    return refuse('does not match any accepted form');
}

/**
 * Compile at LOAD time, not at match time.
 */
function validateIdentifierFields(entries, file) {
    entries.forEach((entry, index) => compileIdentifierField(entry, file, index));
}

// Compiled matchers for a merged policy. The policy is frozen, so the cache
// hangs beside it rather than on it.
const IDENTIFIER_MATCHERS = new WeakMap();

function identifierMatchers(policy) {
    let matchers = IDENTIFIER_MATCHERS.get(policy);
    if (!matchers) {
        matchers = (policy.identifierFields || [])
            .map((entry, index) => compileIdentifierField(entry, policy.path || policy.defaultPath || 'policy', index));
        IDENTIFIER_MATCHERS.set(policy, matchers);
    }
    return matchers;
}

function matchesIdentifierPattern(matcher, segments) {
    switch (matcher.kind) {
        case 'exact':
            return segments.length === matcher.segments.length
                && startsWithSegments(segments, matcher.segments);
        case 'suffix': return endsWithSegments(segments, matcher.segments);
        case 'prefix': return startsWithSegments(segments, matcher.segments);
        case 'contains': return containsSegments(segments, matcher.segments);
        case 'bracket':
            return segments.length >= matcher.head.length + matcher.tail.length
                && startsWithSegments(segments, matcher.head)
                && endsWithSegments(segments, matcher.tail);
        default: return false;
    }
}

/**
 * True when `key` names a field the policy declares to hold an object id.
 *
 * `key` is a single field name -- the field that DIRECTLY holds the value, not
 * a path. An ancestor is not evidence: `ids[0].card_number` holds a card
 * number, and matching any segment of the path would silence it because a
 * container happens to be an id collection.
 */
function isIdentifierField(policy, key) {
    if (!policy || typeof key !== 'string' || key === '') return false;
    // The cap comes FIRST. A field name longer than this is not a field name,
    // so there is nothing to decide, and it bounds the input regardless of
    // what the language grows later.
    if (key.length > IDENTIFIER_LIMITS.maxFieldNameChars) return false;
    const matchers = identifierMatchers(policy);
    if (matchers.length === 0) return false;
    const segments = identifierSegments(key);
    if (segments.length === 0) return false;
    for (const matcher of matchers) {
        if (matchesIdentifierPattern(matcher, segments)) return true;
    }
    return false;
}

/** Append `additions` to `base`, preserving order and dropping repeats. */
function appendNames(base, additions) {
    const merged = [];
    const seen = new Set();
    for (const name of [...(base || []), ...(additions || [])]) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(name);
    }
    return merged;
}

function without(names, excluded) {
    const drop = new Set(excluded.map((n) => n.toLowerCase()));
    return names.filter((n) => !drop.has(n.toLowerCase()));
}

function mergeDocuments(base, override) {
    const merged = {
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        classes: {},
        piiFields: {},
        // Issuer ranges append, exactly like the name lists and for the same
        // reason: a project naming one issuer must not silently discard the
        // standard table it did not name.
        cardIssuers: [...(base.cardIssuers || []), ...(override.cardIssuers || [])],
        waivers: [...(base.waivers || []), ...(override.waivers || [])],
    };

    // classes: a project setting replaces exactly the kind it names, leaving
    // its siblings at the default. Replacing the whole class object would mean
    // naming one kind silently reset every other.
    for (const className of Object.keys(base.classes)) {
        merged.classes[className] = Object.assign(
            {}, base.classes[className], (override.classes || {})[className]);
    }

    for (const list of APPEND_LISTS) {
        merged[list] = appendNames(base[list], override[list]);
    }

    for (const type of Object.keys(base.piiFields)) {
        merged.piiFields[type] = appendNames(base.piiFields[type], (override.piiFields || {})[type]);
    }

    // The subtraction runs AFTER the append, so `notSecretFields` can remove a
    // default name and can veto a name the same file just added -- which is
    // what a consumer reaches for when a default flags a header that is
    // configuration in their API, not a credential.
    merged.secretFields = without(merged.secretFields, merged.notSecretFields);
    merged.secretHeaders = without(merged.secretHeaders, merged.notSecretFields);

    // ...but `named-credential` is the one secret class with no shape backup:
    // `sessionid`, `fb_dtsg`, `c_user` are caught by NAME or not at all. So a
    // subtraction can hollow that class out while `classes.secret` still reads
    // `gate` -- the floor checks the setting, and the setting is not where the
    // class lives. Forbidding it is wrong (the issue's own sketch removes
    // `x-asbd-id`, and a name list with no escape hatch is the undisableable
    // gate this issue exists to replace); leaving it INVISIBLE is what must
    // not happen. Record which upstream names a project removed, so the gates
    // can report the loosening on every run and its cost stays visible.
    // Reported in merged `notSecretFields` order -- which is the order the
    // project wrote them while the shipped default carries none of its own,
    // and default-then-project if it ever does. Only names the synced default
    // actually carried are reported: vetoing a name the same file just added
    // loosens nothing, and a report that cries wolf is the failure mode this
    // issue measured at 1134 findings.
    const upstream = new Set(
        [...(base.secretFields || []), ...(base.secretHeaders || [])].map((n) => n.toLowerCase()));
    merged.loosenedSecretNames = merged.notSecretFields
        .filter((name) => upstream.has(name.toLowerCase()));

    return merged;
}

/**
 * The floor. A consumer may disable any identity class; a secret class may
 * not be lowered at all -- not to `off`, and not to `advise`, which is `off`
 * wearing a hat: a secret finding that does not gate is a secret finding that
 * ships. Per-value relief is a waiver.
 */
function enforceFloor(merged, source) {
    for (const kind of Object.keys(merged.classes.secret)) {
        const setting = merged.classes.secret[kind];
        if (setting !== 'gate') {
            throw new PolicyError(
                `${source}: the secret class "${kind}" is set to "${setting}". Secret classes ` +
                `always gate and cannot be lowered -- a secret grants access, so it is removed ` +
                `unconditionally. To accept one specific finding, add a waiver for its ` +
                `fingerprint with a reason and an expiry.`);
        }
    }
}

/** Stable JSON with sorted keys, so the version hash tracks content only. */
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function deepFreeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return value;
}

/**
 * The default file is the schema authority: the classes it declares and the
 * PII dictionaries it carries ARE the vocabulary every document is checked
 * against. Deriving it rather than hardcoding it means adding a class upstream
 * needs no second edit here -- and no way for the two to disagree.
 */
function buildVocabulary(baseDoc, defaultPath) {
    requireObject(baseDoc.classes, defaultPath, 'classes');
    requireObject(baseDoc.piiFields, defaultPath, 'piiFields');
    return {
        topLevel: ['schemaVersion', 'classes', 'identifierFields', 'secretFields',
            'secretHeaders', 'notSecretFields', 'piiFields', 'cardIssuers', 'waivers'],
        classes: Object.fromEntries(
            Object.keys(baseDoc.classes).map((c) => [c, Object.keys(baseDoc.classes[c])])),
        piiTypes: Object.keys(baseDoc.piiFields),
    };
}

/**
 * An EXPLICIT path that does not exist is a hard failure -- the operator named
 * a file and meant it. A discovered path that does not exist is not: standing
 * on the synced default is the correct posture for a project that has declared
 * no overrides.
 */
function resolveProjectPath(opts) {
    if (!opts.policyPath) return findUpward(POLICY_FILENAME, opts.startDir, opts.stopAt);
    const resolved = path.resolve(opts.policyPath);
    if (!fs.existsSync(resolved)) {
        throw new PolicyError(`${resolved}: project policy not found. ${HOWTO}`);
    }
    return resolved;
}

/**
 * Load and merge the scrub policy.
 *
 * @param {object} [opts]
 * @param {string} [opts.policyPath]  explicit project policy (the `--policy` override)
 * @param {string} [opts.startDir]    where upward discovery begins
 * @param {string} [opts.stopAt]      highest directory discovery may reach
 * @param {string} [opts.defaultPath] explicit default policy (tests only)
 * @returns {object} frozen merged policy: { path, defaultPath, version, schemaVersion,
 *                   classes, identifierFields, secretFields, secretHeaders,
 *                   notSecretFields, loosenedSecretNames, piiFields, cardIssuers,
 *                   waivers }
 * @throws {PolicyError} on an unreadable, unknown-keyed, or floor-violating policy
 */
function loadPolicy(opts = {}) {
    const defaultPath = opts.defaultPath
        ? path.resolve(opts.defaultPath)
        : path.join(__dirname, DEFAULT_POLICY_FILENAME);
    const baseDoc = stripComments(readJson(defaultPath, 'default'));
    const vocabulary = buildVocabulary(baseDoc, defaultPath);
    validateDocument(baseDoc, defaultPath, vocabulary);

    const projectPath = resolveProjectPath(opts);

    // An absent project policy is not an error: the synced default is the
    // stringent baseline and standing on it is the correct default posture.
    const overrideDoc = projectPath
        ? stripComments(readJson(projectPath, 'project'))
        : {};
    if (projectPath) validateDocument(overrideDoc, projectPath, vocabulary);

    const merged = mergeDocuments(baseDoc, overrideDoc);
    enforceFloor(merged, projectPath || defaultPath);

    return deepFreeze(Object.assign({}, merged, {
        path: projectPath,
        defaultPath,
        // Identifies the MERGED document, so a reference stamped with it
        // records the rules that actually produced it -- not merely which
        // upstream default was in the tree at the time.
        version: crypto.createHash('sha256').update(canonicalJson(merged)).digest('hex').slice(0, 16),
    }));
}

/**
 * The synced default policy alone, with no project discovery.
 *
 * For callers that need the shipped names at module-load time and must not
 * depend on where the process happens to have been started from. Discovery
 * walks upward from the working directory, which is the right behaviour for a
 * tool run inside a project and the wrong one for a module-level constant.
 */
function loadDefaultPolicy(defaultPath) {
    return loadPolicy({ defaultPath, policyPath: null, startDir: __dirname, stopAt: __dirname });
}

function todayIso(now) {
    return (now || new Date()).toISOString().slice(0, 10);
}

/**
 * True when `policy` waives a finding of `kind` with `fingerprint`.
 *
 * An expired waiver does not match. The expiry is the whole reason a waiver is
 * safe to commit: without it, one accepted false positive is a permanent hole
 * that nobody revisits because nothing ever asks them to.
 */
function isWaived(policy, kind, fingerprint, now) {
    if (!policy || !Array.isArray(policy.waivers) || typeof fingerprint !== 'string') return false;
    const wanted = fingerprint.toLowerCase();
    const today = todayIso(now);
    return policy.waivers.some((w) =>
        w.kind === kind
        && w.fingerprint.toLowerCase() === wanted
        && (w.expires === undefined || w.expires >= today));
}

module.exports = {
    POLICY_FILENAME,
    loadDefaultPolicy,
    DEFAULT_POLICY_FILENAME,
    SUPPORTED_SCHEMA_VERSION,
    SETTINGS,
    PolicyError,
    loadPolicy,
    isWaived,
    isIdentifierField,
    IDENTIFIER_LIMITS,
};
