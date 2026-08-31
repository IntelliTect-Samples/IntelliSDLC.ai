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
 *   1. A truncated request body. Only responses may be capped; a reference
 *      whose request bodies were shortened cannot be replayed or diffed, and
 *      it looks authoritative anyway.
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
 *   7. A request body that is PRESENT but carries no payload structure -- a
 *      placeholder standing in for a body. Gate 1 catches a body that was
 *      SHORTENED; nothing caught one that was REPLACED, so a reference could
 *      carry a 29-character sentinel where a form body used to be, pass every
 *      gate, and be catalogued as documenting a protocol it contains none of
 *      (issue #358).
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

// Gate 7 -- a request body that is present but is only a placeholder.
//
// SAY THE CONCEPT OUT LOUD, because the predicate below is an approximation of
// it and the two must be checked against each other: "this body carries no
// payload structure -- nothing in it separates one component from another, so
// it stands in for a body rather than being one."
//
// The predicate is deliberately NOT a match against a known sentinel string.
// The one that prompted this gate, `REDACTED_FORM_URLENCODED_BODY`, was never
// emitted by any tool in this repo -- it was written by a hand this repo has
// never seen, and the next one will be written by a different hand again. A
// gate keyed to the spelling would pass the next one. So judge the shape.
//
// Two components, and both directions matter:
//
//   * A composite JSON root is a payload, full stop. `{}` and `[]` are legal
//     minimal bodies and carry structure even though they hold no characters
//     between their delimiters, so the character scan below cannot see them
//     and the parse is what clears them. A JSON SCALAR root -- `"REDACTED"`,
//     `1`, `null` -- is NOT cleared here: a body that is one bare string
//     literal is exactly the shape a cautious hand leaves behind, and it names
//     no field either.
//   * An INTERIOR separator is a payload. `a=1` is a form body, `a: 1` is a
//     header-ish body, `x,y` is a list. "Interior" is what keeps the wrapped
//     sentinels -- `[REDACTED]`, `<redacted>`, `{SCRUBBED}`, `**removed**` --
//     on the failing side: their brackets sit at the two ends and join
//     nothing. A separator at position 0 or at the last position is a wrapper,
//     not a join.
//
// NO LENGTH THRESHOLD, on purpose. A threshold is a second predicate with its
// own false positives, and the check that clears a predicate is itself a
// predicate (docs/designs/297-detector-predicates.md, beat 3). The structural
// test alone decides; `{}` is two characters and passes, a 29-character
// sentinel is longer and fails, so length was never the signal.
//
// RESIDUAL FALSE POSITIVES, stated rather than papered over: a body that is a
// single opaque run of characters -- raw base64 with no padding or slashes, a
// bare numeric id, a line of plain prose -- has no interior separator and is
// reported. That is the correct direction for this path. Beat 2 of the same
// design doc: fail toward a MISS on a replace path and toward a REPORT on a
// gate path. This gate only reports, and it names a file and an entry index,
// so a false positive costs an operator one look at the file.
const BODY_SEPARATORS = /[=&:,;{}[\]()<>"']/;

// A composite (object or array) JSON root. The leading-character test is not an
// optimisation for its own sake: JSON.parse over a several-hundred-KB body for
// every entry is work this gate does not need, and only `{` or `[` can open a
// composite anyway.
function hasCompositeJsonRoot(text) {
    if (!/^[[{]/.test(text)) return false;
    try {
        const value = JSON.parse(text);
        return value !== null && typeof value === 'object';
    } catch {
        return false;
    }
}

// A separator that actually joins two parts, i.e. one with text on both sides
// of it. See the wrapper reasoning above for why the two end positions do not
// count.
function hasInteriorSeparator(text) {
    for (let i = 1; i < text.length - 1; i++) {
        if (BODY_SEPARATORS.test(text[i])) return true;
    }
    return false;
}

function bodyCarriesPayloadStructure(text) {
    return hasCompositeJsonRoot(text) || hasInteriorSeparator(text);
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

        // Already reported by gate 1 as truncated. Reporting the same entry a
        // second time as "replaced" would contradict the first finding and
        // send the reader hunting for the wrong repair.
        if (postData.truncated) continue;

        const text = postData.text.trim();
        if (text === '') continue;
        if (bodyCarriesPayloadStructure(text)) continue;

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
