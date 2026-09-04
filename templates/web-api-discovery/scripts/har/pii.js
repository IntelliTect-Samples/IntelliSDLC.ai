#!/usr/bin/env node
/**
 * pii.js -- shared typed-PII detection + deterministic faker for the
 * web-api-discovery scrub pipeline (issue #46).
 *
 * Exports:
 *   detectPii(har, policy?)     -> [{ type, value, location }]
 *   fakeFor(type, original)     -> string (deterministic, obviously-fake)
 *   scrubPii(har, policy?)      -> { substitutions: [...], retained: [...] }
 *                                  (mutates har)
 *   PII_TYPES                   -> array of supported type strings
 *
 * `policy` is the MERGED scrub policy (`har-policy.loadPolicy`). It is
 * OPTIONAL and absent means the shipped defaults, so no caller breaks; passing
 * it is what makes a consuming project's `piiFields` and `cardIssuers` govern
 * the SCRUB as well as the gate (issue #334), its `classes` too (issue
 * #346), and its `identifierFields` (issue #360): an identity class set to
 * `off` is still DETECTED and still REPORTED -- in `retained`, as counts and
 * never values -- but is not replaced. That is the meaning `off` already
 * carries on the gate side, where a disabled finding is returned marked rather
 * than dropped. An identity value at a declared identifier field is reported
 * the same way, carrying `identifierField: true`, which is the mark the gate
 * puts on the same decision. Secret classes are exempt from the setting
 * entirely and can never reach the identifier rule; see `scrubSettingFor`.
 *
 * Determinism: seed = SHA-256(original).hexSlice(0, 16). Same input always
 * yields same fake. No external dependencies; pure Node stdlib.
 *
 * Substitutions returned by scrubPii contain only { type, originalHash,
 * replacement, locations }. The originalHash is the first 8 hex chars of
 * the SHA-256 -- never the plaintext original -- so the resulting
 * .substitutions.json file is safe to commit.
 */

'use strict';

const crypto = require('crypto');

// The recorder's key for an unretained-request-body descriptor (#442),
// IMPORTED rather than spelled again. A second copy of a node name is how the
// scrub and the recorder end up disagreeing about which node exists, and the
// disagreement is silent in the direction that ships: the scrub simply never
// visits it. `request-body-descriptor.js` requires nothing, so naming it from
// here cannot make a cycle.
const { DESCRIPTOR_KEY: BODY_DESCRIPTOR_KEY } = require('../capture/request-body-descriptor.js');

const PII_TYPES = [
    'email', 'phone', 'person-name', 'street-address',
    'city', 'region', 'postal-code', 'country',
    'dob', 'ssn', 'credit-card', 'ip-address', 'geo-coordinates',
    'iban', 'mac-address', 'device-id'
];

// --- minimal embedded word lists (no external dependencies) ---
const FIRST_NAMES = [
    'Avery','Blair','Casey','Dakota','Emery','Finley','Gray','Hayden','Ira','Jules',
    'Kai','Lane','Morgan','Nico','Oakley','Parker','Quinn','Reese','Sage','Tatum',
    'Umi','Vesper','Wren','Xen','Yarrow','Zion','Ash','Briar','Cleo','Darcy',
    'Elliot','Frey','Gale','Harper','Indigo','Jess','Kit','Lior','Marin','Niles',
    'Olin','Pax','Rio','Sasha','Tyne','Uriah','Vance','Wynn','Yale','Zephyr'
];
const SURNAMES = [
    'Archer','Brooks','Carter','Doyle','Ellis','Fisher','Grant','Hayes','Irving','Jensen',
    'Kerr','Lowell','Mercer','Nash','Oates','Pratt','Quincy','Reeves','Stone','Tate',
    'Underwood','Vega','Walsh','Xiong','York','Zimmer','Abram','Blake','Crane','Dean',
    'Emerson','Frost','Gibson','Hale','Inman','Jordan','Knox','Lyle','Monroe','Noble',
    'Orton','Paige','Quill','Rhodes','Sterling','Thorne','Underhill','Vail','Wilde','Yates'
];
const STREETS = [
    'Birch','Cedar','Dogwood','Elm','Forest','Garnet','Hawthorn','Ivy','Juniper','Kestrel',
    'Larch','Maple','Nutmeg','Oak','Poplar','Quince','Rowan','Sycamore','Tamarack','Umbra',
    'Vine','Willow','Yarrow','Zephyr','Acacia','Beech','Cypress','Dunwood','Elderberry','Fern',
    'Greenway','Hollow','Iron','Jasper','Knoll','Linden','Mulberry','Northgate','Olive','Pinecrest',
    'Quail','Redwood','Spruce','Thistle','Upland','Violet','Wisteria','Yew','Zinnia','Aspen'
];
const CITIES = [
    'Aldenbrook','Bramblefield','Cinderwood','Dunmoor','Everwillow','Fallowcrest','Glenhaven','Hartshollow','Inglevale','Junipercove',
    'Kettlebrook','Larchmount','Mistford','Northwillow','Oakhurst','Pinecliff','Quietford','Ravenstead','Stonebriar','Thornehaven',
    'Underglen','Vesperton','Wickburn','Yarrowfield','Zephyrport','Ashendell','Briarholt','Cresthollow','Drystwood','Elderfen'
];
const REGIONS = ['ZZ','XA','XB','XC','XD','XE','XF','XG','XH','XI'];

// --- field-name dictionaries (case-insensitive match on JSON key tail) ---
//
// The names are DATA and live in `har-policy.default.json`, so the scrubber and
// both gates read one list and a consuming project can extend it. Each type
// carries `exact` (whole-key names), `tail` (trailing words that denote the
// type) and `qualifiers` -- the words allowed to precede an ambiguous tail, or
// the string `any` where the tail speaks for itself. See `fieldTypeFor`.
const harPolicy = require('./har-policy.js');
// ONE definition of "credit card", consumed rather than copied (issue #334).
// `har-shapes.js` is the gate; it requires an assigned issuer identifier at a
// length that issuer mints before calling a Luhn-valid run a card. This module
// drives a REPLACE, so holding a looser definition here did not leak -- it
// CORRUPTED, rewriting provider object ids into generated fake card numbers in
// committed references. A second copy of the predicate here would only drift
// again, so the predicate is imported and the issuer table is not duplicated.
const { hasAssignedIin, LEAK_PATTERNS, settingFor, isIdentifierShaped } = require('./har-shapes.js');

/**
 * One slot of the gate's own leak table, taken from the gate rather than
 * copied -- for the card slot, its PATTERN and its fake marker.
 *
 * A card predicate has two halves -- the pattern that finds candidates and the
 * check that validates them -- and unifying only the check leaves the other
 * half free to drift. It had. `har-shapes.js` carries lookarounds that keep a
 * digit run which is part of a DECIMAL NUMBER out of the card slot (#292/#293);
 * this module carried a bare 13-19 digit run between word boundaries, on the
 * reasoning that an assigned-IIN check makes those lookarounds redundant
 * because a fractional part begins with digits no issuer owns. That holds only
 * until the run happens to begin with an assigned IIN at a length that issuer
 * mints -- thirteen digits starting at `4` will do it -- at which point the
 * gate passes a price clean and this pass rewrites its integer part into a
 * fake card number. Corruption, in a case the gate already guarded, and
 * reachable anywhere `detectInString` scans: headers, cookies, query
 * parameters, the URL, or a non-JSON body.
 *
 * So the pattern is CONSUMED, not re-typed here with the lookarounds added by
 * hand -- which would only leave a third copy to drift on the next change.
 *
 * Sharing the RegExp object is safe: both sides reach it through
 * `String.prototype.match`, which resets `lastIndex` on a global pattern
 * before it scans, and neither call site is re-entrant. A missing pattern
 * throws at load rather than silently disabling card detection, because an
 * upstream rename must not be able to switch this pass off quietly.
 */
function gateSlot(name) {
    const found = LEAK_PATTERNS.find((p) => p.name === name);
    if (!found) {
        throw new Error(`pii.js: har-shapes.js no longer defines a "${name}" pattern`);
    }
    return found;
}

// The whole card slot -- pattern, and the marker that recognises this
// scrubber's OWN output. Every other detector below skips its fake before
// reporting (`@example.invalid`, the 555 area code, the 9XX SSN prefix, `ZZ00`,
// `06:F0:0D`, `192.0.2.`); the card slot did not, so re-scrubbing an already
// scrubbed capture churned one fake card into a different fake card. The gate
// has always ignored `4242...` for exactly this reason, and taking the test
// from it keeps the two from disagreeing about what a fake is either.
const GATE_CARD = gateSlot('credit-card');

const DEFAULT_PII_POLICY = harPolicy.loadDefaultPolicy();

// The secret axis, taken from the default policy rather than listed again here
// -- adding a secret class upstream must not require a second edit, and two
// lists are how the scrubber and the gate come to disagree.
const SECRET_KINDS = new Set(Object.keys(DEFAULT_PII_POLICY.classes.secret));

// The identity axis, read the same way and from the same place. Which class a
// kind belongs to is ESTABLISHED here rather than assumed from "not a secret":
// a kind the shipped policy names on neither axis has no class, and a decision
// that keys off `class === 'identity'` must not silently claim it.
const IDENTITY_KINDS = new Set(Object.keys(DEFAULT_PII_POLICY.classes.identity));

/**
 * Which class the SHIPPED policy puts a detector kind on, or null.
 *
 * Read from the default document, never from the merged one. A project may set
 * a kind's SETTING; it may not move a kind between axes, and reading the merged
 * classes here would make the axis itself project-controlled -- which is the
 * one lever that could walk a secret kind onto the identity path.
 */
function piiClassFor(type) {
    if (SECRET_KINDS.has(type)) return 'secret';
    if (IDENTITY_KINDS.has(type)) return 'identity';
    return null;
}

/**
 * Is this detection an identity value sitting at a field the policy declares
 * to hold object ids -- the question the GATE already asks?
 *
 * Asked THROUGH `har-shapes.isIdentifierShaped`, not re-derived here. That
 * function states the scope in one place (identity class only, secret never, a
 * resolved key path only) and owns the field-name extraction; a second copy of
 * it in this file is exactly the divergence that let the gate agree a value was
 * an object id while this pass rewrote it into a fake card number.
 *
 * `fieldKey` is the JSON key that DIRECTLY holds the scanned string, and it is
 * `null` for every value that has no structural key: headers, cookies, query
 * parameters, the request URL, a non-JSON body, and the elements of a top-level
 * array. A finding with no resolved path gets no suppression -- reading the
 * enclosing HAR node's name (`request.url`, `response.content`) instead would
 * decline a replacement on no evidence at all.
 */
function atIdentifierField(type, fieldKey, policy) {
    if (typeof fieldKey !== 'string' || fieldKey === '') return false;
    // The floor, restated on this path and not merely inherited. `piiClassFor`
    // already refuses a secret kind, and `isIdentifierShaped` refuses anything
    // that is not identity; a secret kind must fail BOTH, because a caller
    // cannot forget a check it never makes.
    if (SECRET_KINDS.has(type)) return false;
    return isIdentifierShaped({ class: piiClassFor(type) }, fieldKey, policy);
}

/**
 * What the policy says about REPLACING one PII type -- `gate`, `advise` or
 * `off` (issue #346).
 *
 * `off` means DETECT, REPORT, DO NOT ACT. That is not a new semantic invented
 * for the scrubber: it is exactly what `off` already means on the gate, where
 * `findLeaks` still returns a disabled finding carrying `setting: 'off'` and
 * `gating: false`, and `blocksLeak` declines to fail on it. The finding has
 * left the gate, not the report. Mirroring it here is the point -- a second
 * meaning of `off` would be the same drift that produced the card predicate,
 * the fake markers, `piiFields` and `cardIssuers` in turn.
 *
 * `gate` and `advise` both replace. The distinction between them is about
 * whether a SURVIVING value fails the build, which is the gate's question; on
 * this side there is nothing to distinguish, because a replaced value cannot
 * survive either way. Only `off` reaches the scrub as a decision.
 *
 * THE FLOOR, ENFORCED HERE AND NOT ONLY IN THE LOADER. The loader refuses a
 * project file that lowers a secret class, and that is the check operators
 * meet. It is not the check that makes the guarantee true: this function is
 * reachable with a policy object nobody loaded. So a secret kind resolves to
 * `gate` before any lookup happens, on EITHER axis -- a caller cannot forget a
 * check it never makes, and a secret grants access, so it is removed
 * unconditionally. Per-value relief is a waiver, never a class setting.
 *
 * An identity type is read from `classes.identity` alone, so a setting parked
 * on the secret axis loosens nothing. An absent policy, or a type the policy
 * does not name, is `gate` -- `settingFor`'s own default, and the only safe
 * reading: a missing file must never be the thing that quietly stops a scrub.
 */
function scrubSettingFor(policy, type) {
    if (SECRET_KINDS.has(type)) return 'gate';
    return settingFor(policy, 'identity', type);
}

/**
 * The identity classes this policy turns off, sorted.
 *
 * Read from the policy rather than from what a capture happened to contain:
 * disabling a class is a standing decision to publish personal data, and it is
 * true of the run whether or not this particular capture exercised it.
 */
function disabledIdentityClasses(policy) {
    const identity = (policy && policy.classes && policy.classes.identity) || {};
    return Object.keys(identity)
        .filter((kind) => identity[kind] === 'off' && !SECRET_KINDS.has(kind))
        .sort();
}

function compileDictionaries(policy) {
    const source = (policy && policy.piiFields) || DEFAULT_PII_POLICY.piiFields;
    return Object.keys(source).map((type) => {
        const d = source[type];
        return [type, {
            exact: new Set((d.exact || []).map((n) => n.toLowerCase())),
            tail: new Set((d.tail || []).map((n) => n.toLowerCase())),
            qualifiers: d.qualifiers === 'any' ? 'any'
                : new Set((d.qualifiers || []).map((n) => n.toLowerCase())),
        }];
    });
}

const DEFAULT_DICTIONARIES = compileDictionaries(null);
function piiDictionaries(policy) {
    return policy && policy.piiFields ? compileDictionaries(policy) : DEFAULT_DICTIONARIES;
}

// Retained for the callers that still read it directly; derived from the
// policy so there is one source rather than two that can disagree.
const FIELD = Object.fromEntries(
    DEFAULT_DICTIONARIES.map(([type, d]) => [type, new Set([...d.exact])]));

/**
 * Split a JSON key into its words.
 *
 * `first_name`, `first-name`, `firstName`, `FirstName` and `billing.city` are
 * the same field wearing five conventions, and snake_case is dominant in the
 * APIs this targets -- which is why an exact-match lookup missed almost all of
 * them. A trailing ordinal is dropped: `address_line_1` and `phone_2` are how
 * an API spells repetition, not part of the field's name.
 */
function keyWords(key) {
    if (typeof key !== 'string') return [];
    const words = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase());
    while (words.length > 1 && /^\d+$/.test(words[words.length - 1])) words.pop();
    // ...and an ordinal fused onto the last word, which is the same repetition
    // spelled without a separator: `addr1`, `addr2`, `address2`, `phone2`.
    // Only the trailing digits go, and only when letters remain, so `sha256`
    // becomes `sha` -- a word no dictionary lists -- rather than anything.
    if (words.length > 0) {
        const fused = /^([a-z]+)\d+$/.exec(words[words.length - 1]);
        if (fused) words[words.length - 1] = fused[1];
    }
    return words;
}

/**
 * Which PII type a JSON key denotes, or null.
 *
 * Three rules, in order of confidence:
 *
 *   1. The whole key, words joined, is a name the policy lists exactly.
 *   2. A trailing run of words joins to a listed `tail` token, and the type
 *      accepts any qualifier before it.
 *   3. Same, but the type qualifies its tail, and the immediately preceding
 *      word is on that type's allowlist.
 *
 * Why rule 3 exists, and why the allowlist runs that way round: this function
 * does not report a value, it REPLACES it. A key ending in the word `name` is
 * overwhelmingly not a person -- `file_name`, `event_name`, `column_name`,
 * `bucket_name` -- and scrubbing those writes `Avery Brooks` over a filename,
 * corrupting the payload the reference exists to document, undetectably, after
 * the fact. `address` is sharper still: `ip_address` and `email_address` are
 * not streets.
 *
 * A DENYLIST of non-person qualifiers would fail open -- every convention
 * nobody anticipated becomes a corrupted field, silently, in the artifact
 * itself. The allowlist fails toward a MISS instead.
 *
 * BE HONEST ABOUT WHAT A MISS COSTS. It is tempting to say the literal pass
 * catches it, and for the operator's own identifiers it does -- but
 * `.har-profile.json` holds *the operator's* account id, display name and
 * email, by design and by enforcement. It knows nothing about the third
 * parties who make up most of the PII in a real capture: a friend list, a
 * search result, an order recipient. `email`, `phone`, `ssn` and `credit-card`
 * have shape detectors that catch those regardless of field name; `person-name`,
 * `street-address`, `city` and `region` DO NOT, because no shape distinguishes
 * a person's name from any other short string.
 *
 * So a missed name field is a real residual risk, not a covered one. The
 * allowlist is still the right trade -- a corrupted reference is undetectable
 * after the fact and destroys the artifact's whole purpose, while a miss is
 * visible to anyone who reads the capture and fixable by adding a qualifier --
 * but it is a trade, not a free lunch, and the qualifier list is meant to grow
 * as real field names turn up.
 */
function fieldTypeFor(key, policy) {
    const words = keyWords(key);
    if (words.length === 0) return null;
    const dictionaries = piiDictionaries(policy);
    const joined = words.join('');

    for (const [type, dict] of dictionaries) {
        if (dict.exact.has(joined)) return type;
    }

    // Longest tail first, so `dateofbirth` wins over a bare `birth` and
    // `postalcode` over `code`.
    for (let start = 0; start < words.length; start++) {
        const tail = words.slice(start).join('');
        for (const [type, dict] of dictionaries) {
            if (!dict.tail.has(tail)) continue;
            if (dict.qualifiers === 'any') return type;
            // No bare-word shortcut here. Returning a match merely because the
            // tail began at word zero skipped the allowlist entirely -- which
            // stayed invisible only because every tail token also happened to
            // be an `exact` name, a coincidence nothing enforces and the merge
            // explicitly allows a project to break. A legitimate bare-word
            // match is rule 1's job.
            if (start > 0 && dict.qualifiers.has(words[start - 1])) return type;
        }
    }
    return null;
}

function fieldType(key) {
    return fieldTypeFor(key, null);
}

// --- regex detectors (context-free) ---
// Email is already handled by sanitize-har.js's legacy pattern, but we also
// detect it here so detectPii() reports it for the substitutions store.
const RE = {
    // RFC 5321 caps the local part at 64 characters and the domain at 255.
    // The bounds are not pedantry: an unbounded `[chars]+@` backtracks
    // quadratically over a long run that never reaches an `@`, and capture
    // bodies are routinely hundreds of KB.
    email:        /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/g,
    // E.164, and the national spellings a US API actually emits. The
    // punctuated forms carry their own evidence -- a run grouped 3-3-4 with
    // separators is a phone number far more often than anything else -- so
    // they are safe to match without a field name.
    //
    // The lookarounds keep the match off a longer digit run: without them
    // `555-123-45678` and the tail of a formatted card would both match.
    phone:        /\+\d{10,15}\b/g,
    phonePunctuated: /(?<![\d-])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\d-])/g,
    // Ten digits with no punctuation and no context is an order id, a product
    // code, or a timestamp. It is only a phone number when the field says so
    // -- the credit-card lesson, applied before it bites rather than after.
    phoneBare:    /^\+?1?\d{10}$/,
    ssn:          /\b\d{3}-\d{2}-\d{4}\b/g,
    // The GATE's pattern, shared rather than copied -- see `gatePattern`.
    creditDigits: GATE_CARD.re,
    ipv4:         /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g,
    // Same treatment, same reason: a maximal run of colon-separated hex groups,
    // with the count deciding.
    //
    // This one is PRE-EXISTING. main carves two eight-GROUP matches out of a
    // twenty-group certificate fingerprint and then replaces each with a fake
    // IPv4 sentinel, so the fingerprint comes back as
    // `192.0.2.234:192.0.2.4:AB:CD:EF:01`. The IPv4-looking output is the
    // FAKE, not the match -- worth saying, because a reviewer read the
    // original wording as an IPv4 example misfiled under IPv6. Fixed here
    // because it is the identical defect in the identical value, and shipping
    // only the MAC half would leave the reproduction case still corrupting.
    //
    // ACCEPTED LIMIT, pre-existing and unchanged: `::` compression is not
    // matched, so a compressed IPv6 address is missed. main's exact-seven-colon
    // pattern did not handle it either. A miss, not a corruption.
    ipv6:         /\b(?:[A-Fa-f0-9]{1,4}:)+[A-Fa-f0-9]{1,4}\b/g,
    isoDate:      /^\d{4}-\d{2}-\d{2}$/,
    // An IBAN is two country letters, two check digits, then up to 30
    // alphanumerics -- and a mod-97 checksum over the lot. The arithmetic is
    // what makes this safe to match without a field name: shape alone would be
    // another "Luhn-valid digit run", firing on identifiers an API just mints.
    iban:         /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    // A MAC is a maximal run of EXACTLY six hex pairs. Match the whole run and
    // let the count decide -- do not try to express "six" in the pattern.
    //
    // Two wrong answers were tried first. A bare six-pair pattern carves a MAC
    // out of a TLS thumbprint (which is hex pairs too) and the scrub then
    // destroys real protocol evidence. Anchoring it with a hex-character
    // lookbehind fixes that and silently breaks `device:AA:BB:...`, because
    // `a` through `f` are ordinary letters and the anchor cannot tell the last
    // letter of an English word from the second digit of a hex pair.
    //
    // Matching the run and counting says what a MAC actually is, so neither
    // failure is reachable.
    //
    // ACCEPTED LIMITS -- found by review, not oversights, and both are MISSES
    // rather than corruptions:
    //
    //  1. Mixed separators (`AA:BB-CC:DD:EE:FF`) split into two sub-runs,
    //     neither of which is six pairs, so nothing is reported. No tool emits
    //     a MAC with inconsistent separators.
    //  2. A MAC glued directly to trailing hex with no delimiter
    //     (`...EE:FFcafe1234`) leaves the closing `\b` unable to fire. This is
    //     inherent to any word-bounded maximal-run definition.
    //
    // Both need an input no real capture produces, and both fail toward a miss
    // that the literal and name controls still cover. If either turns up in a
    // real capture, the answer is a proper tokeniser, not another lookaround --
    // the lookaround is what produced the `device:` regression in the first
    // place.
    mac:          /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})+\b|\b[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2})+\b/g,
    uuid:         /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
};

function luhnOk(s) {
    let sum = 0, alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
        let d = s.charCodeAt(i) - 48;
        if (d < 0 || d > 9) return false;
        if (alt) { d *= 2; if (d > 9) d -= 9; }
        sum += d; alt = !alt;
    }
    return sum % 10 === 0;
}

function hashOf(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}
function hashPrefix(s) { return hashOf(s).slice(0, 8); }
function seed(s) { return hashOf(s); }
function intFromHex(hex, start, len) {
    return parseInt(hex.slice(start, start + len), 16);
}

// --- deterministic faker ---
function fakeFor(type, original) {
    const h = seed(String(original));
    switch (type) {
        case 'email':
            return `user-${h.slice(0, 8)}@example.invalid`;
        case 'phone': {
            const tail = (intFromHex(h, 0, 8) % 10000000).toString().padStart(7, '0');
            return `+1555${tail}`;
        }
        case 'ssn': {
            const a = 900 + (intFromHex(h, 0, 4) % 100);   // 900-999
            const b = (intFromHex(h, 4, 4) % 100).toString().padStart(2, '0');
            const c = (intFromHex(h, 8, 4) % 10000).toString().padStart(4, '0');
            return `${a}-${b}-${c}`;
        }
        case 'iban':
            // ZZ is unassigned, and the check digits are left as 00 so the
            // value fails its own mod-97 -- a fake that validated would be
            // indistinguishable from a real account number.
            return `ZZ00${h.slice(0, 18).toUpperCase()}`;
        case 'mac-address': {
            const octets = [];
            for (let i = 0; i < 3; i++) octets.push(h.slice(i * 2, i * 2 + 2).toUpperCase());
            return `06:F0:0D:${octets.join(':')}`;
        }
        case 'device-id':
            return `DEADBEEF-${h.slice(0, 4)}-4${h.slice(4, 7)}-8${h.slice(7, 10)}-${h.slice(10, 22)}`.toUpperCase();
        case 'credit-card': {
            // Build 15-digit body then compute Luhn check digit -> 16 total.
            let body = '4242';
            for (let i = 0; i < 11; i++) {
                body += ((intFromHex(h, i * 2, 2)) % 10).toString();
            }
            // Compute Luhn check digit for body + '0', then derive correct check.
            let sum = 0, alt = true;
            for (let i = body.length - 1; i >= 0; i--) {
                let d = body.charCodeAt(i) - 48;
                if (alt) { d *= 2; if (d > 9) d -= 9; }
                sum += d; alt = !alt;
            }
            const check = (10 - (sum % 10)) % 10;
            return body + String(check);
        }
        case 'person-name': {
            const f = FIRST_NAMES[intFromHex(h, 0, 4) % FIRST_NAMES.length];
            const l = SURNAMES[intFromHex(h, 4, 4) % SURNAMES.length];
            return `${f} ${l}`;
        }
        case 'street-address': {
            const num = 100 + (intFromHex(h, 0, 4) % 9900);
            const street = STREETS[intFromHex(h, 4, 4) % STREETS.length];
            return `${num} ${street} St`;
        }
        case 'city':
            return CITIES[intFromHex(h, 0, 4) % CITIES.length];
        case 'region':
            return REGIONS[intFromHex(h, 0, 4) % REGIONS.length];
        case 'postal-code':
            return (90000 + (intFromHex(h, 0, 4) % 10000)).toString();
        case 'country':
            return 'ZZ';
        case 'dob': {
            const year = 1950 + (intFromHex(h, 0, 4) % 50);
            const month = 1 + (intFromHex(h, 4, 4) % 12);
            const day = 1 + (intFromHex(h, 8, 4) % 28);
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
        case 'ip-address': {
            // 192.0.2.0/24 is RFC 5737 TEST-NET-1, never routable.
            return `192.0.2.${intFromHex(h, 0, 2) % 254 + 1}`;
        }
        case 'geo-coordinates':
            return 0;
        default:
            return `<REDACTED-${h.slice(0, 8)}>`;
    }
}

// --- detection ---
function pushDetection(out, type, value, location, identifierField) {
    const detection = { type, value, location };
    // Present only when true, and never removed from the detection list. The
    // finding stays visible and marked -- exactly what the gate does with one
    // (`blocksLeak` reads the mark rather than the finding being dropped).
    // A loosening that made findings disappear would be an invisible one.
    if (identifierField) detection.identifierField = true;
    out.push(detection);
}

// The scrubber emits `+1555XXXXXXX` and nothing else, so the exemption is that
// EXACT string -- unpunctuated, E.164, no spaces.
//
// Normalising punctuation away before this test looks tidier and is wrong: it
// turns a real `+1 (555) 123-4567` into the fake's shape and exempts it. An
// exemption is a hole by construction, so it must recognise our own output and
// not one character more.
/**
 * ISO 13616 mod-97: move the first four characters to the end, map letters to
 * two-digit numbers, and the whole value modulo 97 must be 1.
 *
 * This is the entire reason `iban` may match without a field name. A shape
 * that fires on `AB12...` and nothing else would be the credit-card mistake
 * again -- the checksum is what turns a shape into evidence.
 */
function ibanChecksumOk(value) {
    const s = String(value).toUpperCase();
    if (s.length < 15 || s.length > 34) return false;
    const rearranged = s.slice(4) + s.slice(0, 4);
    let remainder = 0;
    for (const ch of rearranged) {
        const code = ch.charCodeAt(0);
        let part;
        if (code >= 48 && code <= 57) part = String(code - 48);
        else if (code >= 65 && code <= 90) part = String(code - 55);
        else return false;
        for (const digit of part) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
    return remainder === 1;
}

// The scrubber's own output, recognised exactly. `ZZ` is an unassigned country
// code and `06:F0:0D` is an arbitrary locally administered MAC prefix -- NOT
// `02:00:00`, which is the textbook one that real virtualisation and sandbox
// tools emit, and which therefore made real addresses look already-scrubbed.
// A fake marker must be a shape the world does not already use, so neither fake can
// be mistaken for a real value -- and neither is re-detected as a leak.
function isFakeIban(v) { return /^ZZ00/i.test(String(v)); }
// A delimited hex run is a MAC only at exactly six pairs, and an IPv6 address
// only at exactly eight groups. Anything longer is a fingerprint, a digest or
// a key -- protocol evidence, not an identifier.
function isMacRun(m) { return String(m).split(/[:-]/).length === 6; }
function isIpv6Run(m) { return String(m).split(":").length === 8; }

function isFakeMac(v) { return /^06[:-]F0[:-]0D[:-]/i.test(String(v)); }
function isFakeDeviceId(v) { return /^DEADBEEF-/i.test(String(v)); }

function isFakePhone(value) {
    return /^\+1555\d{7}$/.test(String(value));
}

/**
 * The context-free shape detectors.
 *
 * `fieldKey` is the JSON key directly holding `str`, or null/absent when there
 * is none -- see `atIdentifierField`. It marks findings, and never suppresses
 * one.
 */
function detectInString(str, entryIndex, loc, out, policy, fieldKey) {
    if (typeof str !== 'string' || str.length === 0) return;
    const atId = (type) => atIdentifierField(type, fieldKey, policy);
    // emails
    (str.match(RE.email) || []).forEach(m => {
        // skip already-fake markers
        if (/@example\.invalid$/i.test(m)) return;
        pushDetection(out, 'email', m, { entryIndex, ...loc }, atId('email'));
    });
    // phones -- E.164 and the punctuated national spellings
    for (const re of [RE.phone, RE.phonePunctuated]) {
        (str.match(re) || []).forEach(m => {
            if (isFakePhone(m)) return;
            pushDetection(out, 'phone', m, { entryIndex, ...loc }, atId('phone'));
        });
    }
    // ssn
    (str.match(RE.ssn) || []).forEach(m => {
        if (/^9\d{2}-/.test(m)) return;
        pushDetection(out, 'ssn', m, { entryIndex, ...loc }, atId('ssn'));
    });
    // credit card -- the GATE's predicate, not a looser local one (issue #334).
    // An assigned issuer identifier at a length that issuer mints, AND Luhn.
    // Bare Luhn accepts ~10% of all digit runs by chance, and since this pass
    // replaces what it finds, that arithmetic accident was being written into
    // references as a fake card number over the top of a real object id.
    (str.match(RE.creditDigits) || []).forEach(m => {
        if (!hasAssignedIin(m, policy) || !luhnOk(m)) return;
        if (GATE_CARD.isFake(m)) return;
        pushDetection(out, 'credit-card', m, { entryIndex, ...loc }, atId('credit-card'));
    });
    // iban -- shape AND checksum, which is what licenses a context-free match
    (str.match(RE.iban) || []).forEach(m => {
        if (!ibanChecksumOk(m) || isFakeIban(m)) return;
        pushDetection(out, 'iban', m, { entryIndex, ...loc }, atId('iban'));
    });
    // mac address
    (str.match(RE.mac) || []).forEach(m => {
        if (!isMacRun(m) || isFakeMac(m)) return;
        pushDetection(out, 'mac-address', m, { entryIndex, ...loc }, atId('mac-address'));
    });
    // ipv4
    (str.match(RE.ipv4) || []).forEach(m => {
        if (/^192\.0\.2\./.test(m)) return; // fake range
        pushDetection(out, 'ip-address', m, { entryIndex, ...loc }, atId('ip-address'));
    });
    // ipv6
    (str.match(RE.ipv6) || []).forEach(m => {
        if (!isIpv6Run(m)) return;
        pushDetection(out, 'ip-address', m, { entryIndex, ...loc }, atId('ip-address'));
    });
}

function detectInValue(value, key, entryIndex, loc, out, policy) {
    const fType = fieldTypeFor(key, policy);
    // Context-driven detections (run first; do not also report as raw email/etc.)
    if (fType && typeof value === 'string' && value.length > 0) {
        if (fType === 'person-name') {
            pushDetection(out, 'person-name', value, { entryIndex, ...loc });
            return true;
        }
        if (fType === 'street-address') {
            pushDetection(out, 'street-address', value, { entryIndex, ...loc });
            return true;
        }
        if (fType === 'city')        { pushDetection(out, 'city',        value, { entryIndex, ...loc }); return true; }
        if (fType === 'region')      { pushDetection(out, 'region',      value, { entryIndex, ...loc }); return true; }
        if (fType === 'postal-code') { pushDetection(out, 'postal-code', value, { entryIndex, ...loc }); return true; }
        if (fType === 'country')     { pushDetection(out, 'country',     value, { entryIndex, ...loc }); return true; }
        if (fType === 'device-id') {
            // A UUID is the most common identifier shape in any API -- request
            // ids, trace ids, idempotency keys. There is no shape evidence
            // here at all, so the FIELD NAME is the only evidence, and a
            // pattern for this deliberately does not exist in har-shapes.js.
            if (RE.uuid.test(value) && !isFakeDeviceId(value)) {
                pushDetection(out, 'device-id', value, { entryIndex, ...loc });
                return true;
            }
            return false;
        }
        if (fType === 'phone') {
            // The field says phone, so a bare run is evidence enough. Anything
            // punctuated is caught context-free by detectInString anyway.
            const digits = value.replace(/[ .()-]/g, '');
            if (RE.phoneBare.test(digits) && !isFakePhone(digits)) {
                pushDetection(out, 'phone', value, { entryIndex, ...loc });
                return true;
            }
            return false;
        }
        if (fType === 'dob' && RE.isoDate.test(value)) {
            pushDetection(out, 'dob', value, { entryIndex, ...loc });
            return true;
        }
    }
    if ((fType === 'geo-lat' || fType === 'geo-lng') && typeof value === 'number') {
        const ok = fType === 'geo-lat' ? (value >= -90 && value <= 90)
                                        : (value >= -180 && value <= 180);
        if (ok && value !== 0) {
            pushDetection(out, 'geo-coordinates', value, { entryIndex, ...loc, axis: fType === 'geo-lat' ? 'lat' : 'lng' });
            return true;
        }
    }
    return false;
}

function walkJsonForDetect(node, key, entryIndex, jsonPath, out, policy) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
        const handled = detectInValue(node, key, entryIndex, { jsonPath }, out, policy);
        if (!handled) detectInString(node, entryIndex, { jsonPath }, out, policy, key);
        return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
        detectInValue(node, key, entryIndex, { jsonPath }, out, policy);
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((v, i) => walkJsonForDetect(v, key, entryIndex, `${jsonPath}[${i}]`, out, policy));
        return;
    }
    if (typeof node === 'object') {
        for (const k of Object.keys(node)) {
            walkJsonForDetect(node[k], k, entryIndex, jsonPath ? `${jsonPath}.${k}` : k, out, policy);
        }
    }
}

/**
 * @param {object} har
 * @param {object} [policy] the MERGED scrub policy, as `har-policy.loadPolicy`
 *   returns it. OPTIONAL: absent means the shipped defaults, which is what
 *   every caller got before issue #334 and what the direct-call test suites
 *   still expect. Supplying it is what makes a consuming project's `piiFields`
 *   and `cardIssuers` reach the SCRUBBER and not only the gate -- before this
 *   parameter existed, they were validated, merged, loaded, and then never
 *   consulted on this side, so the whole project-policy surface was inert here.
 */
function detectPii(har, policy) {
    const out = [];
    const entries = (har && har.log && har.log.entries) || [];
    entries.forEach((entry, entryIndex) => {
        // headers
        const allHeaders = [
            ...((entry.request && entry.request.headers) || []).map(h => ({ ...h, _ctx: 'request' })),
            ...((entry.response && entry.response.headers) || []).map(h => ({ ...h, _ctx: 'response' }))
        ];
        for (const h of allHeaders) {
            if (!h || typeof h.value !== 'string') continue;
            detectInString(h.value, entryIndex, { headerName: h.name, headerCtx: h._ctx }, out, policy);
        }
        // cookies, both directions. The raw `Cookie` HEADER sweep caught some
        // of this incidentally, and incidentally is not a control: the
        // structured arrays are where a cookie's name and value are actually
        // addressable, and `response.cookies` was never scanned at all.
        //
        // The NAME gates the value exactly as a JSON key does, so
        // `billing_city` in a cookie is classified like `billing_city` in a
        // body. Session handles (`_ga`, `sessionid`) tokenise to words no PII
        // dictionary lists, so they fall through to the shape detectors --
        // which is right: they are secrets by NAME, and har-secrets.js owns
        // them. Running one through the PII faker would write a fake city over
        // a session token.
        const allCookies = [
            ...((entry.request && entry.request.cookies) || []).map(c => ({ ...c, _ctx: 'request' })),
            ...((entry.response && entry.response.cookies) || []).map(c => ({ ...c, _ctx: 'response' })),
        ];
        for (const c of allCookies) {
            if (!c || typeof c.value !== 'string') continue;
            const loc = { cookieName: c.name, cookieCtx: c._ctx };
            const handled = detectInValue(c.value, c.name, entryIndex, loc, out, policy);
            if (!handled) detectInString(c.value, entryIndex, loc, out, policy);
        }

        // query string
        const qs = (entry.request && entry.request.queryString) || [];
        for (const q of qs) {
            if (!q || typeof q.value !== 'string') continue;
            detectInString(q.value, entryIndex, { queryParam: q.name }, out, policy);
        }
        // request URL
        if (entry.request && typeof entry.request.url === 'string') {
            detectInString(entry.request.url, entryIndex, { jsonPath: 'request.url' }, out, policy);
        }
        // request body
        if (entry.request && entry.request.postData && typeof entry.request.postData.text === 'string') {
            tryWalkJsonText(entry.request.postData.text, entryIndex, 'request.postData', out, policy);
        }
        // response body
        if (entry.response && entry.response.content && typeof entry.response.content.text === 'string') {
            tryWalkJsonText(entry.response.content.text, entryIndex, 'response.content', out, policy);
        }
        // The unretained-request-body descriptor (#442). A `filename` IS
        // captured data -- `emily-watson-birthday-2019.jpg` carries a person,
        // a date and an occasion -- so the descriptor must be scrubbed like
        // any other captured value and must NOT become a channel that bypasses
        // the scrub. This walk is a SELECTIVE node list, not a generic descent,
        // so a new node is invisible to it until it is named here; the legacy
        // regex pass in `sanitize-har.js` walks the whole document and would
        // have caught an email- or card-shaped filename, but a person's NAME is
        // only ever found by THIS pass, which is context-driven.
        const descriptor = entry.request && entry.request[BODY_DESCRIPTOR_KEY];
        if (descriptor && typeof descriptor === 'object') {
            walkJsonForDetect(descriptor, null, entryIndex,
                `request.${BODY_DESCRIPTOR_KEY}`, out, policy);
        }
    });
    return out;
}

function tryWalkJsonText(text, entryIndex, basePath, out, policy) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }
    if (parsed !== null && typeof parsed === 'object') {
        walkJsonForDetect(parsed, null, entryIndex, basePath, out, policy);
    } else {
        detectInString(text, entryIndex, { jsonPath: basePath }, out, policy);
    }
}

// --- scrubbing: apply faker substitutions in-place on the HAR ---
function scrubPii(har, policy) {
    const detections = detectPii(har, policy);
    if (detections.length === 0) return { substitutions: [], retained: [] };

    // Split out the detections the policy asked us to leave alone (issue #346).
    // DETECTION is untouched above: a disabled class is still found, and is
    // still reported below, exactly as the gate reports one. What a setting of
    // `off` changes is only whether the value gets rewritten.
    const replaceable = [];
    const retainedDetections = [];
    for (const d of detections) {
        if (scrubSettingFor(policy, d.type) === 'off') {
            retainedDetections.push({ detection: d, reason: 'off' });
        } else {
            replaceable.push(d);
        }
    }

    // --- identifierFields alignment (issue #360) ---------------------------
    //
    // The gate already declines to FAIL a card-shaped identity value sitting
    // at a declared identifier field. Until now this pass still REPLACED it,
    // so the two engines disagreed on the half where a false positive is
    // silent and permanent rather than noisy and reversible.
    //
    // The decision is taken per (type, value) over the WHOLE run and not per
    // site, because the replacement set is keyed on the value: one entry is
    // applied to every occurrence by a blind text pass. So a value seen at an
    // identifier field in one place and a plain field in another has to be
    // decided ONE WAY for the whole run, and the direction is what matters.
    //
    // ANY declared-identifier-field site declines the replacement everywhere.
    //
    // The gate's `findLeaksInHar` resolves the same mixed evidence the OTHER
    // way -- it promotes the finding back and blocks. That is not a
    // contradiction and this must not be "made consistent" with it: the two
    // engines sit on opposite axes and beat 2 gives them opposite safe
    // directions. On the gate, erring toward more findings is noisy, visible
    // and reversible. On the replace path, erring toward more replacements is
    // plausible corruption that nobody can detect afterwards -- and worse here
    // than anywhere, because the replacement is this scrubber's own recognised
    // fake, so no gate will ever report the corrupted id again. Fail toward a
    // MISS on a replace path.
    //
    // What makes the miss safe is the gate, measured rather than assumed:
    // `findLeaksInHar` groups on (kind, fingerprint) and promotes the whole
    // group when ANY site is not an identifier field, order-independently. So a
    // mixed-evidence value left in place FAILS THE RUN LOUDLY. A real card
    // cannot ship silently through this path; it is stopped by the engine whose
    // false positives are cheap. The two compose exactly as designed -- and
    // `pii-identifier-fields-scrub.test.js` asserts that composition directly,
    // because it is now load-bearing rather than incidental.
    const declined = new Set();
    const alsoAtPlainField = new Set();
    for (const d of replaceable) {
        const key = `${d.type}${d.value}`;
        if (d.identifierField) declined.add(key); else alsoAtPlainField.add(key);
    }
    const survivors = [];
    for (const d of replaceable) {
        const key = `${d.type}${d.value}`;
        if (!declined.has(key)) survivors.push(d);
        else retainedDetections.push({
            detection: d,
            reason: 'identifier-field',
            // MIXED EVIDENCE, carried rather than smoothed over. The audit's
            // `verdictFor` calls this shape UNADJUDICABLE and refuses to guess;
            // the scrub cannot refuse -- it either rewrites or does not -- so it
            // takes the safe direction and SAYS which values it took it on.
            mixed: alsoAtPlainField.has(key),
        });
    }
    replaceable.length = 0;
    replaceable.push(...survivors);

    if (replaceable.length === 0) {
        return { substitutions: [], retained: summariseRetained(retainedDetections, new Set()) };
    }

    // Group by (type, original value) so we record one substitution per unique original.
    const byKey = new Map();
    for (const d of replaceable) {
        const key = `${d.type}\u0001${d.value}`;
        if (!byKey.has(key)) {
            byKey.set(key, {
                type: d.type,
                value: d.value,
                replacement: fakeFor(d.type, d.value),
                originalHash: hashPrefix(d.value),
                locations: []
            });
        }
        // Sanitize location: never include the raw value.
        byKey.get(key).locations.push(d.location);
    }

    // Build replacement set sorted longest-first to avoid partial-overlap issues
    // (e.g. "Alice Marie Johnson" before "Alice").
    const replacements = Array.from(byKey.values()).sort((a, b) => {
        return String(b.value).length - String(a.value).length;
    });

    const entries = (har && har.log && har.log.entries) || [];
    for (const entry of entries) {
        applyReplacementsToEntry(entry, replacements, policy);
    }

    // Strip raw values out of the returned substitutions (safe-store schema).
    const safe = replacements.map(r => ({
        type: r.type,
        originalHash: r.originalHash,
        replacement: r.replacement,
        locations: r.locations
    }));
    safe.sort((a, b) => {
        if (a.type !== b.type) return a.type < b.type ? -1 : 1;
        return a.originalHash < b.originalHash ? -1 : 1;
    });
    const replacedValues = new Set(replacements.map((r) => String(r.value)));
    return { substitutions: safe, retained: summariseRetained(retainedDetections, replacedValues) };
}

/**
 * What this run did NOT replace, per class and reason, and never a value.
 *
 * `replacedValues` is the set of originals the replacement pass DID rewrite.
 * The replacement set is keyed on the value, not on the location, so a string
 * detected as a disabled type in one field and an enabled type in another is
 * rewritten everywhere -- the safe direction, and the only coherent one: the
 * alternative rewrites one occurrence and leaves the identical string beside
 * it. Such a value is therefore NOT retained, and must not be counted as if it
 * were: a report that overstates what shipped is the noise this subsystem
 * measured at 1134 findings and 3 real ones.
 *
 * The finding wears the gate's vocabulary -- `kind`, `class`, `setting` --
 * because it is the same decision, taken on the other axis. Counts only: this
 * is exactly the `occurrences` / `distinct` shape #346 published, which is what
 * a report of identity data may safely carry.
 */
function summariseRetained(entries, replacedValues) {
    const byBucket = new Map();
    for (const { detection: d, reason, mixed } of entries) {
        if (replacedValues.has(String(d.value))) continue;
        const key = `${d.type}${reason}${mixed ? 'mixed' : 'pure'}`;
        if (!byBucket.has(key)) {
            byBucket.set(key, { kind: d.type, reason, mixed: !!mixed, occurrences: 0, values: new Set() });
        }
        const bucket = byBucket.get(key);
        bucket.occurrences += 1;
        bucket.values.add(String(d.value));
    }
    return [...byBucket.values()]
        .map((bucket) => {
            const row = {
                kind: bucket.kind,
                class: 'identity',
                // A field-name downgrade is not a class being switched off. The
                // class is still `gate`; what declined to act is the identifier
                // rule, and the row says which -- reading `setting: 'off'` here
                // would report a standing policy decision nobody made.
                setting: bucket.reason === 'off' ? 'off' : 'gate',
                occurrences: bucket.occurrences,
                distinct: bucket.values.size,
            };
            if (bucket.reason === 'identifier-field') row.identifierField = true;
            // The operator needs to tell the two apart. A PURE row is a value
            // the gate also passes; a MIXED row is one the gate will BLOCK on,
            // and that is the difference between "this run is finished" and
            // "this run is about to fail and here is why".
            if (bucket.mixed) row.mixedEvidence = true;
            return row;
        })
        .sort((a, b) => {
            if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
            if (!!a.identifierField !== !!b.identifierField) {
                return (a.identifierField ? 1 : 0) - (b.identifierField ? 1 : 0);
            }
            return (a.mixedEvidence ? 1 : 0) - (b.mixedEvidence ? 1 : 0);
        });
}

function applyReplacementsToEntry(entry, replacements, policy) {
    // headers
    for (const ctx of ['request', 'response']) {
        const hs = entry[ctx] && entry[ctx].headers;
        if (Array.isArray(hs)) {
            for (const h of hs) {
                if (typeof h.value === 'string') h.value = replaceAll(h.value, replacements);
            }
        }
    }
    // cookies -- the same two arrays detectPii walks. Detection that never
    // reaches the scrub is a report nobody acts on, and the two walks have to
    // cover the same nodes or the gate fails a value the scrubber was never
    // asked to remove.
    for (const ctx of ['request', 'response']) {
        const cs = entry[ctx] && entry[ctx].cookies;
        if (Array.isArray(cs)) {
            for (const c of cs) {
                if (typeof c.value === 'string') c.value = replaceAll(c.value, replacements);
            }
        }
    }
    // query string
    const qs = entry.request && entry.request.queryString;
    if (Array.isArray(qs)) {
        for (const q of qs) {
            if (typeof q.value === 'string') q.value = replaceAll(q.value, replacements);
        }
    }
    // url
    if (entry.request && typeof entry.request.url === 'string') {
        entry.request.url = replaceAll(entry.request.url, replacements);
    }
    // bodies (request/response)
    if (entry.request && entry.request.postData && typeof entry.request.postData.text === 'string') {
        entry.request.postData.text = replaceJsonOrText(entry.request.postData.text, replacements, policy);
    }
    if (entry.response && entry.response.content && typeof entry.response.content.text === 'string') {
        entry.response.content.text = replaceJsonOrText(entry.response.content.text, replacements, policy);
    }
    // The unretained-request-body descriptor (#442). Paired with the walk in
    // `detectPii` for the reason stated on the cookie arrays above: detection
    // that never reaches the scrub is a report nobody acts on, and the gate
    // would then fail a value the scrubber was never asked to remove.
    const descriptor = entry.request && entry.request[BODY_DESCRIPTOR_KEY];
    if (descriptor && typeof descriptor === 'object') {
        entry.request[BODY_DESCRIPTOR_KEY] = replaceInJson(descriptor, null, replacements, policy);
    }
}

function replaceJsonOrText(text, replacements, policy) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }
    if (parsed !== null && typeof parsed === 'object') {
        const rebuilt = replaceInJson(parsed, null, replacements, policy);
        return JSON.stringify(rebuilt);
    }
    return replaceAll(text, replacements);
}

function replaceInJson(node, parentKey, replacements, policy) {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') {
        // Honor field-typed replacements: if the parent key declares a context
        // type, swap the entire value out for the matching fake.
        const fType = fieldTypeFor(parentKey, policy);
        if (fType && fType !== 'geo-lat' && fType !== 'geo-lng') {
            // Find a matching replacement by exact original value, since detection
            // already enrolled this exact string.
            const target = indexFor(replacements).byTypeValue.get(`${pickContextType(fType)}${node}`);
            if (target) return target.replacement;
        }
        return replaceAll(node, replacements);
    }
    if (typeof node === 'number') {
        const fType = fieldTypeFor(parentKey, policy);
        // A coordinate is the one type replaced by FIELD NAME alone, without
        // consulting the replacement set -- a number has no string form to
        // enrol. That makes it the one path a class setting could not reach by
        // being applied to the replacement set, so it is asked here directly
        // (issue #346). Miss this and `geo-coordinates: off` reads as honoured
        // while 37,422 coordinates are still zeroed.
        if ((fType === 'geo-lat' || fType === 'geo-lng')
            && scrubSettingFor(policy, 'geo-coordinates') !== 'off') {
            return 0;
        }
        return node;
    }
    if (Array.isArray(node)) {
        return node.map(v => replaceInJson(v, parentKey, replacements, policy));
    }
    if (typeof node === 'object') {
        const out = {};
        for (const k of Object.keys(node)) {
            out[k] = replaceInJson(node[k], k, replacements, policy);
        }
        return out;
    }
    return node;
}

function pickContextType(fType) {
    // map fieldType labels to detection types
    if (fType === 'geo-lat' || fType === 'geo-lng') return 'geo-coordinates';
    return fType; // 'person-name', 'street-address', 'city', 'region', 'postal-code', 'country', 'dob'
}

// --- single-pass replacement index (issue #326) -------------------------
//
// The replacement pass used to loop the whole replacement list for EVERY
// string it touched, building an escaped pattern and a fresh RegExp each time
// and scanning the string once per value. Distinct detected values grow with
// body size, so the two factors multiplied and the pass went quadratic: on a
// real capture a single 6.3 MB JSON list response took over 45 s while the
// other 314 entries together took ~10 s, and a 27.8 MB capture did not finish
// in 420 s. A profile put ~67% of self time in `replaceAll` and a further ~21%
// in `escapeRe` -- the escape ran once per (value, string) pair.
//
// The values are literals, not patterns, so a literal matcher does the whole
// job in ONE walk of each string regardless of how many values there are. The
// index below is a trie over every needle, built once per replacement list and
// memoised on that list, so the per-string cost is O(string) instead of
// O(string x values).
//
// PRIORITY IS INSERTION ORDER, and reproducing it exactly is the whole
// difficulty. `scrubPii` sorts the replacement list longest value first, and
// the sequential loop turned that into a guarantee: a longer value was
// replaced EVERYWHERE before a shorter one was even considered.
//
// Preferring the earliest-enrolled needle among those starting at the current
// character is NOT that guarantee, and the difference leaks PII. Two values can
// overlap in two ways:
//
//   NESTED      "Alice Marie Johnson" and "Alice" share a start position. A
//               left-to-right scanner picks the longer one there and is right.
//   STAGGERED   "Ann Marie" and "Marie Louise Johnson" inside
//               "contacted Ann Marie Louise Johnson yesterday" share characters
//               at DIFFERENT start positions, and the SHORTER one starts first.
//               A left-to-right scanner matches "Ann Marie", consumes the
//               "Marie" the longer value needed, and never scans its tail --
//               so "Louise Johnson", real detected PII, ships in the clear and
//               the substitutions table records a fake that is nowhere in the
//               body.
//
// So arbitration cannot be per start position. This collects EVERY match in one
// walk, then resolves them in priority order: each match claims its span unless
// a higher-priority match already holds part of it. A longer value therefore
// wins wherever it occurs no matter what starts earlier, which is exactly what
// the priority-ordered global replace did.
//
// What is deliberately NOT reproduced is that loop scanning its own output.
// Because each pass ran over text already carrying earlier fakes, a value
// occurring inside an emitted fake overwrote part of it, leaving a string that
// was neither an original nor the recorded replacement. Resolving against the
// ORIGINAL text drops that, which is the one intended behaviour change here.

// The trie is keyed by UTF-16 code UNIT, matching `` and keeping surrogate
// pairs consistent with the rest of the file. Codes rather than one-character
// strings: `text[i]` allocates a string per character, and this walks every
// character of every body.
function isWordCode(code) {
    // NaN (index past either end of the string) fails every comparison, which
    // is what `` wants at a boundary of the text.
    return (code >= 48 && code <= 57)
        || (code >= 97 && code <= 122)
        || (code >= 65 && code <= 90)
        || code === 95;
}

function newNode() {
    return { next: new Map(), hit: null };
}

function addNeedle(root, needle, replacement, boundary, priority) {
    if (!needle) return;
    let node = root;
    for (let k = 0; k < needle.length; k++) {
        const ch = needle.charCodeAt(k);
        let child = node.next.get(ch);
        if (!child) { child = newNode(); node.next.set(ch, child); }
        node = child;
    }
    // First enrolment wins: the same literal can be detected under two types,
    // and the sequential loop applied whichever came first in the list.
    if (node.hit === null) {
        node.hit = { length: needle.length, replacement, boundary, priority };
    }
}

// Keyed on the replacement list itself, which holds because `scrubPii` finishes
// building that array before any replacing starts and never touches it again.
// That is a convention, not something the type enforces: anyone who later
// appends to a live replacement list must invalidate this entry, or the new
// values will silently go unscrubbed.
const INDEX_CACHE = new WeakMap();

function indexFor(replacements) {
    let idx = INDEX_CACHE.get(replacements);
    if (idx) return idx;

    const root = newNode();
    const byTypeValue = new Map();
    let priority = 0;

    for (const r of replacements) {
        const v = String(r.value);
        const typeKey = `${r.type}${v}`;
        if (!byTypeValue.has(typeKey)) byTypeValue.set(typeKey, r);
        if (v.length === 0) continue;

        // Context-typed values (person-name etc.) may have very short literals
        // (e.g. "Alice") that risk false-positive matches inside unrelated
        // text, so a purely alphabetic value only matches on word boundaries.
        const boundary = /^[A-Za-z]+( [A-Za-z]+)*$/.test(v);
        addNeedle(root, v, r.replacement, boundary, priority++);

        // The same value can appear percent-encoded in the very same entry:
        // detection reads the decoded `queryString` pair, while the `url`
        // carries `phone=%2B1...`. Replacing only the raw spelling leaves the
        // encoded copy readable -- one value, several spellings, which is the
        // failure literal-value scrubbing exists to close (see har-literals.js).
        const encoded = encodeURIComponent(v);
        if (encoded !== v) {
            addNeedle(root, encoded, encodeURIComponent(r.replacement), false, priority++);
        }
    }

    // Direct dispatch for the ASCII first character, so the overwhelmingly
    // common case -- a character that begins no needle at all -- costs an array
    // index rather than a Map lookup.
    const rootAscii = new Array(128);
    for (const [code, node] of root.next) {
        if (code < 128) rootAscii[code] = node;
    }

    idx = { root, rootAscii, byTypeValue, empty: root.next.size === 0 };
    INDEX_CACHE.set(replacements, idx);
    return idx;
}

// One walk of the text, recording EVERY needle that matches anywhere -- nested
// and overlapping matches included. Arbitration happens afterwards, because a
// match cannot be judged against a competitor that has not been found yet.
//
// Matches are held as two parallel arrays rather than objects. This runs over
// every character of every body, and a per-match object is an allocation the
// garbage collector then has to chase; the `hit` records already live in the
// trie, so a reference plus a start offset is the whole match.
function collectMatches(text, idx, outStarts, outHits) {
    const root = idx.root;
    const rootAscii = idx.rootAscii;
    const n = text.length;
    let count = 0;
    for (let i = 0; i < n; i++) {
        const code = text.charCodeAt(i);
        let node = code < 128 ? rootAscii[code] : root.next.get(code);
        if (node === undefined) continue;
        let j = i;
        for (;;) {
            const hit = node.hit;
            if (hit !== null
                && (!hit.boundary
                    || (!isWordCode(text.charCodeAt(i - 1))
                        && !isWordCode(text.charCodeAt(i + hit.length))))) {
                outStarts[count] = i;
                outHits[count] = hit;
                count++;
            }
            j++;
            if (j >= n) break;
            const child = node.next.get(text.charCodeAt(j));
            if (child === undefined) break;
            node = child;
        }
    }
    return count;
}

// Scratch buffers reused across calls. `replaceAll` runs once per string leaf
// and never re-enters itself, so a single set is safe, and reusing them keeps
// a body of many small leaves from allocating two typed arrays per leaf.
let CLAIMED = new Uint8Array(0);
let ACCEPTED = new Uint8Array(0);

function scratch(buf, need) {
    if (buf.length < need) return new Uint8Array(need < 1024 ? 1024 : need * 2);
    buf.fill(0, 0, need);
    return buf;
}

function replaceAll(text, replacements) {
    const idx = indexFor(replacements);
    if (idx.empty || text.length === 0) return text;

    const starts = [];
    const hits = [];
    const count = collectMatches(text, idx, starts, hits);
    if (count === 0) return text;

    // Resolve highest priority first; ties (the same needle occurring more than
    // once) left to right, the order the global replace visited them in. The
    // order array is sorted, not the match arrays, so the matches stay in
    // ascending start order for the emit pass below and need no second sort.
    const order = new Array(count);
    for (let k = 0; k < count; k++) order[k] = k;
    order.sort((a, b) => (hits[a].priority - hits[b].priority) || (starts[a] - starts[b]));

    CLAIMED = scratch(CLAIMED, text.length);
    ACCEPTED = scratch(ACCEPTED, count);
    const claimed = CLAIMED;
    const accepted = ACCEPTED;

    // Each match takes its span unless a higher-priority one already holds part
    // of it -- so a longer value wins wherever it occurs, whatever starts first.
    for (let k = 0; k < count; k++) {
        const m = order[k];
        const from = starts[m];
        const to = from + hits[m].length;
        let free = true;
        for (let q = from; q < to; q++) {
            if (claimed[q]) { free = false; break; }
        }
        if (!free) continue;
        for (let q = from; q < to; q++) claimed[q] = 1;
        accepted[m] = 1;
    }

    let out = '';
    let copiedTo = 0;   // everything before this index is already in `out`
    for (let k = 0; k < count; k++) {
        if (!accepted[k]) continue;
        const from = starts[k];
        out += text.slice(copiedTo, from) + hits[k].replacement;
        copiedTo = from + hits[k].length;
    }
    return copiedTo === 0 ? text : out + text.slice(copiedTo);
}

module.exports = {
    PII_TYPES,
    FIELD,
    fieldType,
    fieldTypeFor,
    keyWords,
    detectPii,
    fakeFor,
    scrubPii,
    scrubSettingFor,
    disabledIdentityClasses,
    hashPrefix,
    luhnOk
};
