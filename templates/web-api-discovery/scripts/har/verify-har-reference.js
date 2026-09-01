#!/usr/bin/env node
/**
 * verify-har-reference.js -- the gate on committed HAR references.
 *
 * Verify the ARTIFACT, not the report of it. A capture-extraction commit once
 * stated "structure and all keys preserved verbatim" while the file it
 * described had every request body truncated away. The defect was found by
 * parsing the artifact, not by reading the description of it -- so this script
 * parses every committed reference and asserts on its content.
 *
 * Seven gates:
 *
 *   1. A truncated request body, in either spelling -- the structured
 *      `truncated` marker or one written into the payload. Only responses may
 *      be capped; a reference whose request bodies were shortened cannot be
 *      replayed or diffed, and it looks authoritative anyway. The inline
 *      spelling is claimed HERE rather than by gate 7, which would otherwise
 *      call it a replacement and tell the reader no marker exists.
 *   2. An unredacted credential header or parameter (the key-name control),
 *      including a multipart field, where the name lives in a header and the
 *      value on its own line.
 *   3. A secret nested inside a JSON-valued parameter -- the class that
 *      escapes any flat scan, because the wire body is percent-encoded.
 *   4. A forbidden literal from the operator profile (the literal-value
 *      control), reported by SENTINEL only.
 *   5. A shape-detected secret -- a JWT, a long hex token, a bearer header,
 *      an email. Gates 2-4 only catch what somebody named or declared; a
 *      per-session token belongs to neither set, and the reference is the
 *      file that actually ships. Same list verify-scrub.js uses, so the
 *      committed artifact is gated at least as hard as the intermediate.
 *   6. A substitution table anywhere in the directory. Both tables are keyed
 *      by the plaintext values the scrub replaced, so either one here is a
 *      reverse lookup of live credentials one `git add -A` away from a
 *      remote. The scrub no longer writes them here, but a copy left by an
 *      earlier run is exactly what a gate is for (issue #294).
 *   7. A request body that is PRESENT but belongs to no wire grammar -- a
 *      placeholder standing in for a body. Gate 1 catches a body that was
 *      SHORTENED; nothing caught one that was REPLACED, so a reference could
 *      carry a 29-character sentinel where a form body used to be, pass every
 *      gate, and be catalogued as documenting a protocol it contains none of
 *      (issue #358). A body is a body when it belongs to a recognised wire
 *      grammar: composite JSON, form-urlencoded, multipart, NDJSON, or XML. Two
 *      earlier versions counted punctuation instead and both fell to a
 *      hand-written note; see the gate for why the answer was not a third
 *      threshold.
 *
 * No failure message ever echoes an offending value: that would relocate the
 * leak into the CI log that reports it.
 *
 * The profile is gitignored and therefore absent in CI, where gate 4 reports
 * as skipped rather than silently passing. Gates 1-3 always run.
 *
 * Usage:
 *   node verify-har-reference.js [--dir <references>] [--profile <path>]
 *
 * PASS --dir IN CI. It defaults to the current directory, which is right when
 * run from a capture's own output folder (where the cataloguer runs it) and
 * wrong anywhere else: the walk is recursive, so from a repo root it sweeps in
 * every unrelated .har in the tree -- test fixtures with deliberately planted
 * secrets included -- and reports them as violations of a reference they have
 * nothing to do with. It fails loudly rather than silently passing, but the
 * findings are noise. `.har-captures`, `node_modules` and `.git` are skipped
 * outright; nothing else is guessed at.
 *
 * Exit codes:
 *   0 -- every reference is clean
 *   1 -- the reference directory is missing or a file cannot be parsed
 *   3 -- one or more gate violations (reported on stderr)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const harProfile = require(path.join(__dirname, 'har-profile.js'));
const harLiterals = require(path.join(__dirname, 'har-literals.js'));
const harSecrets = require(path.join(__dirname, 'har-secrets.js'));
const harShapes = require(path.join(__dirname, 'har-shapes.js'));
const harPolicy = require(path.join(__dirname, 'har-policy.js'));

// Matches extract-har-reference.js: references live beside the capture output,
// not under a second 'docs/har-reference' nested inside it.
const DEFAULT_DIR = '.';

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const next = argv[i + 1];
        out[a.slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
    }
    return out;
}

// Directories the walk never descends into.
//
// `.har-captures` is the one that matters: it holds the UNSCRUBBED capture, and
// it sits directly beside the reference the default `--dir .` scans. Walking
// into it gates the one file that is deliberately never committed, reporting
// its secrets as violations of the reference and burying every real finding
// under them. The rest are excluded for size and noise.
const SKIP_DIRS = new Set(['.har-captures', 'node_modules', '.git']);

// Recorder state, never a deliverable: the substitution tables are keyed by
// the plaintext values the scrub replaced. `.har-captures` is already skipped
// above, which is where they now belong, so anything this walk reaches is in
// a directory the operator commits.
// Compared lower-cased: readdirSync reports the name as stored, and Windows --
// this project's primary platform -- is case-preserving but case-insensitive.
// An exact-case lookup would wave `.Substitutions.json` through while git, on
// the same filesystem, still treats it as the ignored file.
const FORBIDDEN_FILENAMES = new Set(['.substitutions.json', '.har-substitutions.json']);
const isForbiddenFilename = (name) => FORBIDDEN_FILENAMES.has(name.toLowerCase());

function listForbiddenFiles(dir) {
    const found = [];
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
            if (SKIP_DIRS.has(name.toLowerCase())) continue;
            found.push(...listForbiddenFiles(full));
        } else if (isForbiddenFilename(name)) found.push(full);
    }
    return found.sort();
}

// Both comparisons are lower-cased, for the reason the comment above already
// gives: Windows is case-preserving but case-insensitive. The two directions
// fail differently and both are wrong. An exact-case SKIP_DIRS lookup descends
// into `.Har-Captures` and gates the raw captures inside it as though they were
// references -- noisy. An exact-case `.har` test skips `capture.HAR`
// ENTIRELY, so a reference nobody verified sits in the committed tree looking
// checked, which is the worse of the two by far.
function listHarFiles(dir) {
    const found = [];
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
            if (SKIP_DIRS.has(name.toLowerCase())) continue;
            found.push(...listHarFiles(full));
        } else if (name.toLowerCase().endsWith('.har')) found.push(full);
    }
    return found.sort();
}

// The inline marker the consumer-side `Export-HarReference.ps1` appends INSIDE
// the body text. A structured scan alone is a false negative for every
// reference that tool produced -- measured on the consuming repo, a scan for
// `content.truncated` found ZERO across 12 references while this found 27
// truncated entries across 6 of them.
//
// It is also worse than a missing marker: cutting mid-string leaves the payload
// unparseable, so a consumer calling JSON.parse gets an exception rather than a
// truncation signal, and a consumer reading it sees plausible JSON that
// silently lacks everything after the cut.
//
// Recognised here until both tools emit the same structured marker (SKILL.md
// documents the contract). Until then, "no truncated references" would keep
// meaning "none that THIS tool truncated".
const INLINE_TRUNCATION_MARKER = /\[\s*(?:response|request)?\s*body truncated[^\]]*\]/i;

function checkTruncation(entries, report) {
    for (const [i, entry] of entries.entries()) {
        const postData = entry.request && entry.request.postData;
        if (postData && postData.truncated) {
            report(`entry ${i}: request body is marked truncated -- request bodies are never capped`);
        } else if (postData && typeof postData.text === 'string'
            && INLINE_TRUNCATION_MARKER.test(postData.text)) {
            // The same spelling the response rule below already claims, on the
            // request side, where the consumer-side exporter also writes it.
            // Without this the entry falls through to gate 7, which reports it
            // as a wholesale REPLACEMENT and tells the reader there is no
            // truncation marker to go looking for -- while the marker is
            // sitting in the body. An ambiguous finding is survivable; a
            // finding that is affirmatively false sends an operator away
            // confident in the wrong direction.
            report(
                `entry ${i}: request body carries an INLINE truncation marker. Request bodies ` +
                'are never capped, and a cut written into the payload is invisible to a ' +
                'structured audit -- re-extract from the preserved raw capture. If the client ' +
                'genuinely SENT this text (posting a log, say), this is a false positive; to ' +
                'tell them apart, a cut body no longer parses and sent text still does');
        }

        // Responses, on exactly the reasoning the request rule already used. A
        // reference exists to be replayed and diffed; a shortened body looks
        // authoritative and proves nothing. Extending the same rule here would
        // have caught all 27 at commit time.
        const content = entry.response && entry.response.content;
        if (!content) continue;
        if (content.truncated) {
            const { originalBytes, keptBytes } = content.truncated;
            report(
                `entry ${i}: response body is truncated ` +
                `(${keptBytes} of ${originalBytes} bytes kept) -- re-extract without ` +
                '--max-response-bytes, from the preserved raw capture');
        } else if (typeof content.text === 'string' && INLINE_TRUNCATION_MARKER.test(content.text)) {
            // Two readings, and the gate cannot tell them apart: an exporter
            // wrote this marker, or the PROVIDER sent it as genuine content --
            // logging and webhook APIs really do emit `[response body
            // truncated]` in a payload. Telling the operator to re-extract is
            // wrong advice for the second reading, since the pipeline did not
            // write it and re-extracting changes nothing.
            //
            // So give the discriminator rather than guess. A cut this pipeline
            // (or the consumer exporter) made leaves the payload unterminated;
            // provider-authored text does not.
            report(
                `entry ${i}: response body carries an INLINE truncation marker. If an exporter ` +
                'wrote it, the payload is cut mid-string and the cut is invisible to a ' +
                'structured audit -- re-extract from the preserved raw capture. If the PROVIDER ' +
                'sent it as genuine content, this is a false positive. To tell them apart: a cut ' +
                'body no longer parses, provider text still parses');
        }
    }
}

// Gate 7 -- a request body that is present but belongs to no wire grammar.
//
// SAY THE CONCEPT OUT LOUD, because everything below is an approximation of it
// and the two must be checked against each other: "this body is not a body --
// it stands in for one."
//
// The predicate is NOT a match against a known sentinel string. The one that
// prompted this gate was written by a hand this repo has never seen, and the
// next one will be written by a different hand again. So RECOGNISE THE
// GRAMMARS a body can belong to, and report a body that belongs to none.
//
// TWO EARLIER VERSIONS COUNTED PUNCTUATION, AND BOTH FELL TO A FRESH PROBE.
// The first asked whether ANY separator sat in the body's interior: one colon
// cleared `[REDACTED: form body]`. The second asked for TWO, on the reasoning
// that "one is the count a hand-written note reaches on its own" -- and a note
// is precisely where a second mark shows up, so `[REDACTED: form body,
// unused]`, `it's, redacted` and `body: (removed)` all walked through.
//
// The response is NOT a third threshold. Design doc beat 4: fixing a third
// member of the same set means the set is the wrong unit of work -- stop
// narrowing and restrict the language so the dangerous input cannot be
// expressed. A three-mark rule has a three-mark placeholder waiting for it.
// So punctuation counting is GONE, replaced by positive recognition of the
// grammars an operator's captures actually contain.
//
// MEASURED, NOT GUESSED. Classified over 755 request bodies from 14 real
// captures across three providers (counts only; no body content was printed or
// retained): 80.3% form-urlencoded, 10.9% multipart, 7.0% composite JSON, 1.9%
// NDJSON -- and ZERO belonging to none of the four. The punctuation net was
// carrying nothing at the low end that a grammar does not carry better, and
// deleting it without these two extra recognisers would have reported 39 of
// 208 real bodies in an earlier sample. Noise on that scale destroys a gate's
// authority, which is how real leaks survive.
//
// RESIDUAL FALSE POSITIVES, stated rather than papered over: a body in a
// grammar not listed here -- raw GraphQL SOURCE (`application/graphql`),
// protobuf, a raw base64 blob, plain prose -- is reported. GraphQL is the one
// worth naming, because it looks like a bigger gap than it is: GraphQL over
// HTTP is conventionally POSTed as `{"query": "..."}`, which is composite JSON
// and already recognised. A raw `query { me { id } }` body needs
// `application/graphql`, which is genuinely uncommon. This is the correct
// direction for this path:
// beat 2 says fail toward a MISS on a replace path and toward a REPORT on a
// gate path. This gate only reports, and it names a file and an entry index,
// so a false positive costs an operator one look at the file. A grammar that
// starts showing up in real captures should be ADDED AS A RECOGNISER here,
// with a measurement behind it -- never by relaxing one of these back into a
// punctuation count.

// A composite (object or array) JSON root.
//
// The leading-character test is load-bearing twice over. It keeps JSON.parse
// off several-hundred-KB bodies that cannot be composites anyway -- and it is
// what excludes a `null` root, since `typeof null === 'object'` would
// otherwise sneak one through the check below. That is why there is no
// separate null clause: it would be unreachable code asserting nothing.
function hasCompositeJsonRoot(text) {
    if (!/^[[{]/.test(text)) return false;
    try {
        return typeof JSON.parse(text) === 'object';
    } catch {
        return false;
    }
}

// One `name=value` pair.
//
// The name must be non-empty and free of whitespace -- real form names never
// carry a raw space, they percent-encode it -- which is what stops a
// hand-written `body = redacted` from passing itself off as a field.
//
// It must also not OPEN with a bracket, and its brackets must balance. Real
// form names do carry brackets (`user[name]=x`, `items[0][id]=y`), so a flat
// ban would reject real traffic; but a name that opens with `[` and never
// closes it before the `=` is not that shape, it is a bracket-WRAPPED body.
// That distinction is what separates `user[name]=x` from `[redacted=x]` and
// `<redacted=x>` structurally, rather than by special-casing brackets.
const FORM_PAIR = /^[^&=\s]+=[^&]*$/;
const NAME_OPENS_WITH_DELIMITER = /^[[\]{}()<>"']/;

function isFormPair(part) {
    if (!FORM_PAIR.test(part)) return false;
    const name = part.slice(0, part.indexOf('='));
    if (NAME_OPENS_WITH_DELIMITER.test(name)) return false;
    let depth = 0;
    for (const ch of name) {
        if (ch === '[') depth++;
        else if (ch === ']' && --depth < 0) return false;
    }
    return depth === 0;
}

// A form-urlencoded body: every `&`-part is a pair, OR at least two of them
// are.
//
// The second clause is not a ratio and not a tuning knob -- it is measured. 7
// of 755 real bodies carry a single valueless flag-style segment (a bare token
// with no `=`) among 26 well-formed pairs; requiring EVERY part would report
// them. Two real pairs is the point at which a body carries named fields
// whatever else is in it, and it still rejects `REDACTED&token=`, where one
// lone pair sits beside a placeholder.
function isFormUrlEncodedBody(text) {
    const parts = text.split('&');
    const pairs = parts.filter(isFormPair).length;
    return pairs === parts.length || pairs >= 2;
}

const escapeForRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The boundary a `multipart/*` mimeType declares, if it declares one.
function declaredBoundary(mimeType) {
    const m = /boundary=("?)([^";,\s]+)\1/i.exec(mimeType || '');
    return m ? m[2] : null;
}

// Does `text` carry a multipart body delimited by `boundary`?
//
// FIND THE DELIMITER ANYWHERE IN THE BODY, NOT ON LINE ONE. A leading CRLF or
// a MIME preamble before the first delimiter is legal and common, and keying
// off the first line blinds the check for the WHOLE body -- SKILL.md already
// carries this warning for the scrubber's multipart split and it applies
// identically here.
//
// Two delimiter occurrences are required, not one, and the closing `--B--`
// must be present. That is what stops a lone `--redacted--` placeholder from
// nominating itself as a multipart body: it produces one occurrence, not two.
function isMultipartWithBoundary(text, boundary) {
    if (!boundary) return false;
    const escaped = escapeForRegExp(boundary);
    const delimiters = new RegExp('(?:^|\\r?\\n)--' + escaped, 'g');
    let seen = 0;
    while (delimiters.exec(text) !== null) seen++;
    // Found ANYWHERE, not anchored to the end: an epilogue after the closing
    // delimiter is legal MIME, and anchoring here would reject a real body for
    // the same reason anchoring the opener to line one would -- looking in one
    // place because that is where it usually is.
    const closing = new RegExp('(?:^|\\r?\\n)--' + escaped + '--');
    return seen >= 2 && closing.test(text);
}

// Prefer the declared boundary, but never REQUIRE the mimeType: a hand-edited
// reference may have lost it, and the body still declares its own delimiter.
function isMultipartBody(text, mimeType) {
    const declared = declaredBoundary(mimeType);
    if (declared && isMultipartWithBoundary(text, declared)) return true;
    const trailing = /(?:^|\r?\n)--(.+?)--[ \t]*(?:\r?\n)?$/.exec(text);
    return trailing ? isMultipartWithBoundary(text, trailing[1]) : false;
}

// NDJSON: two or more non-empty lines, every one a JSON composite.
//
// TWO or more, because one line that parses as JSON is just a JSON body -- and
// a body of `"REDACTED"` is one line that parses. Composites rather than any
// JSON value, because a stream of bare scalars is not a document either.
//
// `.every` IS LOAD-BEARING, and is not to be confused with the inert line
// count documented below. Weakened to `.some`, a single valid JSON line would
// vouch for every other line beside it, so a placeholder line sitting next to
// a real JSON line would clear -- a plausible hand edit, and exactly what this
// gate exists to catch. It is pinned by fixtures.
//
// HONEST NOTE ON THE LINE COUNT: mutation testing showed `>= 2` cannot change
// any verdict, because the text is trimmed before it gets here, so a body with
// one non-empty line IS that line and the composite-JSON rule ahead of this one
// has already cleared it. The clause is kept because it is the correct
// DEFINITION of NDJSON and this function is judged on its own terms, not on its
// position in the chain -- but it is inert, no test pins it, and it is
// documented here rather than left looking load-bearing. The composite
// requirement on each line is NOT inert and is pinned.
// 13 of the 14 NDJSON bodies in the sample declared `text/plain`, so this
// never consults the mimeType.
function isNdjsonBody(text) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    return lines.length >= 2 && lines.every((line) => hasCompositeJsonRoot(line.trim()));
}

// XML, and NOTHING MORE THAN THAT. This answers "does this belong to the
// markup grammar", not "is this valid XML": no parser, no well-formedness
// check, no entity or namespace resolution. A gate that tried to validate
// would reject real documents for reasons that have nothing to do with whether
// a body was replaced by a placeholder.
//
// WHY IT IS HERE despite not occurring once in 755 sampled bodies. The sample
// is three modern social providers, JSON and form-urlencoded by house style;
// that is evidence about which providers were sampled, not evidence about XML.
// This is an UPSTREAM TEMPLATE that ships to arbitrary consuming projects, and
// a consumer wrapping a SOAP or XML-RPC API would meet a gate firing on 100%
// of their traffic -- #297 failure mode 4 in its purest form, where noise
// destroys a gate's authority and the operator's rational response is to
// disable it, losing the sentinel detection this whole gate exists to provide.
// Omitting a wire grammar from a predicate whose rule is "belongs to a wire
// grammar" is an incomplete list, not a narrowing justified by measurement.
//
// The test is that the ROOT ELEMENT IS CLOSED. That is what separates a
// document from a lone angle-bracketed token: `<redacted>`, `<redacted:body>`
// and `<redacted=x>` all open something that never closes, and the last does
// not even parse as a tag. Anchoring at both ends also keeps this linear --
// a lazy scan for a closing tag that is not there is quadratic on a body that
// may run to hundreds of KB.
//
// KNOWN LIMITS, both accepted and both pinned in the suite.
//
// FALSE POSITIVE: a document whose root is self-closing (`<a/>`), which
// carries a comment or processing instruction after the root, or which opens
// with a DOCTYPE rather than an XML declaration, is not recognised -- only
// `<?xml ... ?>` is skipped before the root is looked for. All are rare as a
// REQUEST body, and the cost is a report an operator dismisses in a glance.
// Each is pinned as a fixture asserting current behaviour.
//
// FALSE NEGATIVE, and this is the one that costs something: a placeholder
// written AS a well-formed element -- `<REDACTED>body was removed</REDACTED>`
// -- belongs to the markup grammar and is cleared. That is the price of
// recognising XML at all, and it is not payable by tightening the recogniser:
// no structural test separates that document from a real one-element body,
// because there is no structural difference. It is the same trade every
// recogniser here makes (`body=redacted` is a valid form pair too), and the
// alternative -- firing on 100% of a SOAP consumer's traffic -- is worse by
// the margin that decided this gate's design.
const XML_OPENING_TAG = /^<([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[^>]*)?>/;

function isXmlBody(text) {
    let rest = text;
    if (rest.startsWith('<?xml')) {
        const close = rest.indexOf('?>');
        if (close < 0) return false;
        rest = rest.slice(close + 2).trim();
    }
    const opening = XML_OPENING_TAG.exec(rest);
    return opening ? rest.endsWith(`</${opening[1]}>`) : false;
}

function bodyCarriesPayloadStructure(text, mimeType) {
    return hasCompositeJsonRoot(text)
        || isFormUrlEncodedBody(text)
        || isMultipartBody(text, mimeType)
        || isNdjsonBody(text)
        || isXmlBody(text);
}

// THREE STATES, DECIDED SEPARATELY rather than left to a truthiness check --
// `undefined` falling through an `if (text)` would have collapsed all three:
//
//   * `postData` absent entirely -- a GET. Legal, and the majority of entries.
//   * `postData` present with no `text` string (a decoded `params[]` only, or
//     a body the exporter recorded structurally) -- nothing to judge, so this
//     gate says nothing. `params[]` is itself decomposed structure.
//   * `text` present but empty or whitespace-only -- LEGAL, deliberately. A
//     zero-length body is a real wire state (`Content-Length: 0`) and, more to
//     the point, it is VISIBLY empty. This gate exists for the body that looks
//     like content and is not; an empty string misleads nobody.
function checkHollowRequestBody(entries, report) {
    for (const [i, entry] of entries.entries()) {
        const postData = entry.request && entry.request.postData;
        if (!postData || typeof postData.text !== 'string') continue;

        // Already reported by gate 1 as truncated -- in either spelling, the
        // structural flag or the marker written into the payload. Reporting
        // the same entry a second time as "replaced" would contradict the
        // first finding and send the reader hunting for the wrong repair.
        if (postData.truncated || INLINE_TRUNCATION_MARKER.test(postData.text)) continue;

        const text = postData.text.trim();
        if (text === '') continue;
        if (bodyCarriesPayloadStructure(text, postData.mimeType)) continue;

        // Names the file (the caller prefixes it) and the entry index, and
        // quotes NOTHING of the body: a finding that echoed the placeholder
        // would be one habit away from echoing a real payload.
        report(
            `entry ${i}: request body is present but carries NO payload structure -- ` +
            'nothing in it separates one component from another, so it stands in for a ' +
            'body rather than being one. This is a wholesale REPLACEMENT, not a ' +
            'truncation: there is no truncation marker to go looking for. Re-extract ' +
            'this entry from the preserved raw capture, or drop the reference -- as ' +
            'committed it documents the response and nothing about what a client sends');
    }
}

// Does a finding fail the run? One definition, in har-shapes.js, so the gate
// on the committed reference cannot drift away from the gate on the
// intermediate it came from. See `blocksLeak` there for what each setting
// means and why an identifier-shaped finding is reported rather than dropped.
const blocks = harShapes.blocksLeak;

function main() {
    const args = parseArgs(process.argv.slice(2));
    const dir = path.resolve(typeof args.dir === 'string' ? args.dir : DEFAULT_DIR);

    if (!fs.existsSync(dir)) {
        console.error(
            `verify-har-reference: ${dir} does not exist. A capture worth keeping belongs in ` +
            `<provider>/ beside the capture output, indexed by ${path.join(dir, 'README.md')}; ` +
            'pass --dir if this project keeps its references elsewhere.');
        process.exit(1);
    }

    let literalStatus = 'skipped (no profile)';
    let literals = [];
    try {
        const profile = harProfile.loadProfile({ profilePath: args.profile, startDir: dir });
        literals = profile.literals;
        literalStatus = `${literals.length} literal(s)`;
    } catch (e) {
        if (args.profile) {
            console.error(`verify-har-reference: ${e.message}`);
            process.exit(1);
        }
    }

    // The merged policy is discovered from the reference directory, so the
    // consuming project's own posture governs its committed references.
    let policy;
    try {
        policy = harPolicy.loadPolicy({ startDir: dir });
    } catch (e) {
        console.error(`verify-har-reference: ${e.message}`);
        process.exit(1);
    }

    const violations = [];
    const advisories = [];

    // Checked before the "is there anything to verify" question: a directory
    // holding a substitution table and no reference at all is the worst case,
    // not an exempt one. Only the path is reported -- naming a key would
    // relocate the leak into the log that reports it.
    for (const found of listForbiddenFiles(dir)) {
        violations.push(
            `${path.relative(dir, found)}: substitution table in the reference directory -- ` +
            'its keys are the values the scrub replaced; it belongs in the gitignored capture tree');
    }

    const files = listHarFiles(dir);
    if (files.length === 0 && violations.length === 0) {
        console.error(`verify-har-reference: no .har reference found under ${dir}.`);
        process.exit(1);
    }

    for (const file of files) {
        const rel = path.relative(dir, file);
        const report = (message) => violations.push(`${rel}: ${message}`);

        let raw;
        let har;
        try {
            raw = fs.readFileSync(file, 'utf8');
            har = JSON.parse(raw);
        } catch (e) {
            console.error(`verify-har-reference: cannot parse ${rel}: ${e.message}`);
            process.exit(1);
        }

        const entries = (har.log && har.log.entries) || [];
        checkTruncation(entries, report);
        checkHollowRequestBody(entries, report);
        harSecrets.walkForUnredactedSecrets(har, (name, where) => {
            report(`${where}: credential '${name}' is readable in the clear`);
        }, { policy });

        // Structural walk, not a sweep of the serialized document: a finding
        // needs a location to be triageable, and our own envelope annotations
        // are not wire data. A finding the policy does not gate is reported as
        // advisory and does not fail the reference -- shape carries no
        // provenance for an identity, and failing on it is what deleted 1413
        // trip ids.
        for (const leak of harShapes.findLeaksInHar(har, policy)) {
            if (blocks(leak)) report(harShapes.describeLeak(leak));
            else advisories.push(`${rel}: not blocking ${harShapes.describeLeak(leak)}`);
        }

        for (const hit of harLiterals.findLiteralHits(raw, literals)) {
            report(`forbidden literal ${hit.sentinel} appears ${hit.count} time(s) unscrubbed`);
        }
    }

    // Printed whether or not the run passes: a loosening the project chose
    // stays visible on every run, and an advisory finding is still a finding
    // somebody should look at.
    if (policy.loosenedSecretNames.length) {
        console.error(
            `verify-har-reference: NOTE -- ${policy.path} removes ` +
            `${policy.loosenedSecretNames.length} upstream secret name(s) from detection: ` +
            `${policy.loosenedSecretNames.join(', ')}`);
    }
    for (const a of advisories) console.error(`  ~ ${a}`);

    if (violations.length === 0) {
        console.log(
            `verify-har-reference: ${files.length} reference(s) under ${dir} -- clean` +
            `${advisories.length ? `, ${advisories.length} advisory` : ''} ` +
            `(literal check: ${literalStatus})`);
        process.exit(0);
    }

    console.error(`verify-har-reference: ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(3);
}

main();
