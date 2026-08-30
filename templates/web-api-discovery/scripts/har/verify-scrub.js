#!/usr/bin/env node
/**
 * verify-scrub.js -- CI-grade leak detector for scrubbed HAR files.
 *
 * Scans a HAR file for unredacted JWTs, long hex tokens, bearer tokens,
 * and plausible email addresses. Exits non-zero on any hit so it can be
 * wired into pre-commit and CI workflows.
 *
 * Three checks, matching the three ways a value escapes a scrub:
 *
 *   1. Shape patterns -- JWTs, long hex, bearer tokens, emails, PII.
 *   2. Known secret names, INCLUDING inside percent-encoded parameters. A
 *      form body carrying `variables=<percent-encoded JSON>` hides tokens
 *      where no flat pattern reaches them.
 *   3. Forbidden literals from the operator profile -- the operator's own
 *      identifiers, which escape (1) and (2) whenever they travel under a
 *      name nobody anticipated.
 *
 * Check 3 needs `.har-profile.json`, which is gitignored and therefore
 * absent in CI. When no profile is found the literal check is reported as
 * skipped rather than silently passing; checks 1 and 2 still gate.
 *
 * No failure message ever echoes the offending value -- that would merely
 * relocate the leak into the log that reports it.
 *
 * Alongside the console report, a non-clean run writes `scrub-findings.json`
 * beside the file it verified: kind, class, key path, entry index, occurrence
 * count and fingerprint, and NEVER a value. A location is not a secret; only
 * the value is, and a report that quoted it would merely relocate the leak
 * into the document written to explain it.
 *
 * Usage:
 *   node verify-scrub.js --in <scrubbed.har> [--profile <path>]
 *
 * Exit codes:
 *   0 -- clean
 *   1 -- I/O or parse error
 *   3 -- a GATING finding: a secret, a forbidden literal, or an identity class
 *        the consuming project opted up. The artifact must not be committed.
 *   4 -- ADVISORY findings only: identity evidence that is SHAPE alone. Still
 *        non-zero -- it is the ARTIFACT that survives an advisory finding, not
 *        the exit code, and a zero here would read as clean to every wrapper,
 *        hook and CI step that only asks whether this succeeded.
 *
 * Two distinct non-zero codes rather than one, because capture-har.js switches
 * on the code: 3 quarantines the artifact, 4 keeps it and warns. A flag would
 * have expressed the same thing while letting the caller ASK for the lenient
 * branch, which is the one thing a caller must not be able to do.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const harProfile = require(path.join(__dirname, 'har-profile.js'));
const harLiterals = require(path.join(__dirname, 'har-literals.js'));
const harSecrets = require(path.join(__dirname, 'har-secrets.js'));
// Shape patterns live in har-shapes.js so verify-har-reference.js gates the
// committed reference on exactly the same list. The reference is the file
// that actually ships.
const harShapes = require(path.join(__dirname, 'har-shapes.js'));
const harPolicy = require(path.join(__dirname, 'har-policy.js'));

// Does a finding fail the run? One definition, in har-shapes.js, so the gate
// on the committed reference cannot drift away from the gate on the
// intermediate it came from. See `blocksLeak` there for what each setting
// means and why an identifier-shaped finding is reported rather than dropped.
const blocks = harShapes.blocksLeak;

const EXIT_GATING = 3;
const EXIT_ADVISORY = 4;
const FINDINGS_FILENAME = 'scrub-findings.json';

/**
 * Is this finding shape-only identity evidence -- reported, but not a reason
 * to withhold the artifact?
 *
 * Read off the policy `setting`, not off the class. A project may opt an
 * identity class UP to `gate`, and one that did must get the gating code; the
 * policy loader already refuses to let any secret class reach `advise`, so
 * this cannot quietly downgrade a secret.
 *
 * Findings with no `setting` at all -- a known secret name, a forbidden
 * literal -- are gating by construction, which is the safe default for a field
 * this predicate does not understand.
 */
function isAdvisory(leak) {
    return leak.setting === 'advise';
}

// Keys a finding may contribute to the report, whitelisted rather than
// blacklisted. Every one of these is a NAME, a LOCATION or a non-reversible
// tag. A blacklist would admit whatever key the detectors grow next, and the
// key they grow next is exactly the one that would carry a value.
const REPORT_KEYS = ['kind', 'class', 'setting', 'waived', 'identifierField',
    'keyPath', 'entryIndex', 'enclosing', 'count', 'fingerprint', 'length'];

function reportableFinding(leak, disposition) {
    const out = { disposition };
    for (const key of REPORT_KEYS) {
        if (leak[key] !== undefined) out[key] = leak[key];
    }
    // `sample` carries a FIELD NAME for a known-secret finding and a SENTINEL
    // for a literal hit -- never the value in either case -- but it is copied
    // under a name that says which, so a reader of the report is never left
    // guessing whether a value slipped in.
    if (leak.kind === 'known-secret' && typeof leak.sample === 'string') out.field = leak.sample;
    if (leak.kind === 'forbidden-literal' && typeof leak.sample === 'string') out.sentinel = leak.sample;
    return out;
}

/**
 * The `.har-policy.project.json` fragment that would accept the identity
 * findings, ready to paste.
 *
 * Identity only. A secret waiver is a deliberate act with a reason and an
 * expiry behind it; offering one as boilerplate would make the sanctioned
 * escape from a secret finding a copy-paste, which is how a gate stops meaning
 * anything.
 *
 * `reason` is left EMPTY on purpose, and the policy loader rejects a waiver
 * without one. So the fragment cannot be pasted and forgotten: the operator
 * has to write down why, in the file a reviewer reads.
 */
function waiverFragment(findings) {
    const seen = new Set();
    const waivers = [];
    for (const l of findings) {
        if (l.class !== 'identity' || typeof l.fingerprint !== 'string') continue;
        const key = `${l.kind}:${l.fingerprint}`;
        if (seen.has(key)) continue;
        seen.add(key);
        waivers.push({ kind: l.kind, fingerprint: l.fingerprint, reason: '' });
    }
    return waivers.length ? { waivers } : null;
}

/**
 * Write the findings report beside the file that was verified.
 *
 * Beside it, and derived -- not pointed at by an option. capture-har.js then
 * moves the report wherever it moves the artifact, so the two never separate,
 * and no caller can aim the report somewhere the artifact is not.
 *
 * Best effort: a report that could not be written is announced, but it never
 * changes the verdict. The exit code is the gate; this is the triage aid.
 */
function writeFindingsReport(inPath, doc) {
    const target = path.join(path.dirname(path.resolve(inPath)), FINDINGS_FILENAME);
    try {
        fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
        return target;
    } catch (e) {
        console.error(`verify-scrub: could not write ${target}: ${e.message}`);
        return null;
    }
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
    }
    return out;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.in) {
        console.error('usage: node verify-scrub.js --in <har> [--profile <path>]');
        process.exit(1);
    }
    let raw;
    try {
        raw = fs.readFileSync(args.in, 'utf8');
    } catch (e) {
        console.error(`verify-scrub: cannot read ${args.in}: ${e.message}`);
        process.exit(1);
    }

    // Walk the parsed HAR so every finding carries a location, and so the
    // fields WE wrote -- log.comment, log.creator, our own annotations -- are
    // not scanned as if they were wire data. A HAR that will not parse still
    // gets the flat text sweep: a gate that skips a malformed file entirely
    // would be a gate anyone could bypass by malforming the file.
    let leaks;
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = null;
    }
    // The merged policy is discovered from the file being verified, so a
    // consuming project's `.har-policy.project.json` governs its own captures.
    let policy;
    try {
        policy = harPolicy.loadPolicy({ startDir: path.dirname(path.resolve(args.in)) });
    } catch (e) {
        console.error(`verify-scrub: ${e.message}`);
        process.exit(1);
    }

    if (parsed) {
        leaks = harShapes.findLeaksInHar(parsed, policy);
        harSecrets.walkForUnredactedSecrets(parsed, (name) => {
            leaks.push({ kind: 'known-secret', sample: name, gating: true });
        }, { policy });
    } else {
        leaks = harShapes.findLeaksDeep(raw, policy);
    }

    // Forbidden literals. The profile is gitignored, so it is absent in CI;
    // say so rather than reporting a check that never ran as a pass.
    let literalStatus = 'skipped (no profile)';
    try {
        const profile = harProfile.loadProfile({ profilePath: args.profile });
        for (const hit of harLiterals.findLiteralHits(raw, profile.literals)) {
            leaks.push({ kind: 'forbidden-literal', sample: `${hit.sentinel} (x${hit.count})` });
        }
        literalStatus = `${profile.literals.length} literal(s)`;
    } catch (e) {
        if (args.profile) {
            console.error(`verify-scrub: ${e.message}`);
            process.exit(1);
        }
    }

    // Three buckets, not two.
    //
    //   gating    a secret, a forbidden literal, or an identity class the
    //             project opted up. Exit 3; capture-har.js quarantines.
    //   advisory  identity evidence that is SHAPE alone. Exit 4: non-zero, so
    //             nothing reads it as clean, but its own code, so capture-har
    //             keeps the artifact and warns rather than withholding it.
    //             Shape carries no provenance -- a Luhn-valid 16-digit run is
    //             a card, a trip id, or ~10% of digit runs by chance -- and
    //             withholding the capture over that is what cost 1413 trip ids
    //             their reference.
    //   reported  waived, disabled, or matched at a declared identifier field.
    //             It has left the gate, not the report: a finding that vanished
    //             outright would be an invisible loosening.
    const describe = (l) =>
        l.sample !== undefined ? `${l.kind}: ${l.sample}` : harShapes.describeLeak(l);
    const gating = leaks.filter((l) => blocks(l) && !isAdvisory(l));
    const advising = leaks.filter((l) => blocks(l) && isAdvisory(l));
    const reported = leaks.filter((l) => !blocks(l));

    // A loosening the project chose is printed on EVERY run, clean or not.
    // `named-credential` is caught by name or not at all, so removing a name
    // silently hollows the class out; saying so is what keeps the cost visible.
    if (policy && policy.loosenedSecretNames && policy.loosenedSecretNames.length) {
        console.error(
            `verify-scrub: NOTE -- ${policy.path} removes ${policy.loosenedSecretNames.length} ` +
            `upstream secret name(s) from detection: ${policy.loosenedSecretNames.join(', ')}`);
    }
    for (const l of reported) console.error(`  ~ reported, not blocking: ${describe(l)}`);

    if (gating.length === 0 && advising.length === 0) {
        console.log(
            `verify-scrub: ${args.in} -- 0 blocking leaks` +
            `${reported.length ? `, ${reported.length} reported but not blocking` : ''} ` +
            `(literal check: ${literalStatus})`);
        process.exit(0);
    }

    // The report, and the paste-ready fragment that clears the identity half
    // of it. Written before either verdict is printed, so a caller that reads
    // stderr and the file together never sees one without the other.
    const fragment = waiverFragment(advising);
    const reportPath = writeFindingsReport(args.in, {
        schemaVersion: 1,
        generatedUtc: new Date().toISOString(),
        target: path.basename(args.in),
        policy: policy && policy.path ? { path: policy.path, version: policy.version } : null,
        verdict: gating.length ? 'gating' : 'advisory',
        counts: { gating: gating.length, advisory: advising.length, reported: reported.length },
        findings: [
            ...gating.map((l) => reportableFinding(l, 'gating')),
            ...advising.map((l) => reportableFinding(l, 'advisory')),
            ...reported.map((l) => reportableFinding(l, 'reported')),
        ],
        suggestedPolicyFragment: fragment,
    });

    // Named findings print the field or the sentinel; shape findings print a
    // fingerprint and a location. Nothing here prints the value itself.
    if (advising.length) {
        // "The artifact is kept" is true only when nothing gated. Saying it
        // beside a blocking leak would tell the operator the opposite of what
        // is about to happen to the file.
        console.error(
            `verify-scrub: ${advising.length} advisory finding(s) in ${args.in} -- ` +
            'identity evidence by SHAPE, which carries no provenance. ' +
            (gating.length
                ? 'These are not what blocked this run; review them alongside the leak below:'
                : 'The artifact is kept; review these and either waive or correct them:'));
        for (const l of advising) console.error(`  ! ${describe(l)}`);
    }
    if (fragment) {
        console.error(
            `\nverify-scrub: to accept the identity findings above, paste into ` +
            `${harPolicy.POLICY_FILENAME} and FILL IN each "reason" -- a waiver ` +
            `without one is refused:\n${JSON.stringify(fragment, null, 2)}\n`);
    }
    if (reportPath) console.error(`verify-scrub: findings written to ${reportPath}`);

    if (gating.length === 0) process.exit(EXIT_ADVISORY);

    console.error(`verify-scrub: ${gating.length} blocking leak(s) detected in ${args.in}:`);
    for (const l of gating) console.error(`  - ${describe(l)}`);
    process.exit(EXIT_GATING);
}

main();
