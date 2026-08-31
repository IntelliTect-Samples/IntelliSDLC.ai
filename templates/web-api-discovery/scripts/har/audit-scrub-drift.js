#!/usr/bin/env node
/**
 * audit-scrub-drift.js -- which committed fields hold a fake that was
 * substituted for something that was never a card? (issue #335)
 *
 * ## The wound
 *
 * `har-shapes.js` requires an assigned issuer identification number before it
 * will call a Luhn-valid digit run a credit card (#295 / #316). `pii.js` kept
 * its own bare-Luhn predicate -- and `pii.js` drives a REPLACE, not a report. So
 * the gate stopped flagging provider object ids while the scrubber went on
 * OVERWRITING them with generated fake card numbers, and every reference
 * committed in that window carries the result. Measured on the operator's own
 * corpus: one 10 MB capture produced 22 card replacements of which 20 were false
 * positives, and across nine captures 3,812 detections, 488 of them the integer
 * part of a decimal timestamp.
 *
 * #334 stopped the bleeding. It did not repair what was already committed. This
 * tool says WHERE the damage is. It does not repair it either -- see READ-ONLY.
 *
 * ## The three-step adjudication, and why no plaintext enters it
 *
 * A substitution table records `{ type, originalHash, replacement }`, where
 * `originalHash` is `sha256(original)[0..8]`. That is what makes the question
 * answerable without an original ever being typed, pasted or printed:
 *
 *   1. the `credit-card` substitutions whose `replacement` occurs in the
 *      reference are the CANDIDATES;
 *   2. the original is recovered from the PRESERVED RAW by matching that hash
 *      against the raw's own digit runs -- so it is a lookup, never a guess;
 *   3. the MERGED POLICY is consulted about the value and the field that held
 *      it. "Never a card" means the field is corrupted, and the raw is its
 *      repair.
 *
 * ## Why step 3 is the policy and not the predicate
 *
 * The tempting test is "the tightened predicate says this is not a card". It is
 * wrong, and measurably so. 859 values across 12 real captures pass the
 * tightened predicate -- a genuinely assigned issuer prefix, a valid Luhn check
 * -- in a corpus the operator has confirmed contains no cards at all. A
 * predicate-only audit calls every one of those CLEAN.
 *
 * What separates them is the field name, which is exactly what #328 gave the
 * gate as `identifierFields`. So this consults the merged policy: a card-shaped
 * run under `media_id` is a card only in the sense that ~10% of digit runs are.
 *
 * Both halves are IMPORTED -- `hasAssignedIin` / `luhnValid` from
 * `har-shapes.js`, `isIdentifierField` from `har-policy.js`. A second copy of a
 * definition is the entire defect this audit exists to measure; writing a third
 * would be self-refuting.
 *
 * ## Three outcomes, never two -- and the third is the headline
 *
 *   CLEAN          every candidate in the reference stood in for something the
 *                  merged policy still calls a card (or there is no candidate).
 *   CORRUPTED      a candidate stood in for something that was never a card.
 *   UNADJUDICABLE  the question could not be ANSWERED.
 *
 * UNADJUDICABLE is not a soft CLEAN. Folding it into CLEAN would reproduce,
 * inside the audit, the same silent false negative the audit was written to
 * find. Expect it to dominate: until #341 lands a per-invocation correlation id,
 * most references cannot be paired with a raw at all. That count is the most
 * informative number this tool currently produces -- it measures how much of the
 * corpus is un-repairable, and therefore what #341 is worth.
 *
 * ## Selection is a correctness problem, not a lookup detail
 *
 * `.har-captures/` is a SHARED store. Several sessions record the same providers
 * in the same hours; directory names key on capture START while `session.json`'s
 * mtime is when POST-PROCESSING finished, so the two orderings interleave.
 * Measured: selecting by `describe` gave one session exactly its 23 of 79
 * captures, but any time window holding all 23 also swept in an unrelated 86 MB
 * capture -- and the same session routinely produces several captures with an
 * IDENTICAL describe (one had three reading "create a Polarsteps step with one
 * video, then delete it").
 *
 * That last case is the dangerous one. Correct session, wrong attempt passes
 * every cheap sanity check -- same provider, same describe, same operator,
 * plausible timestamp -- so it does not look like a mistake from the inside. And
 * this report is meant to drive repair, so a confident verdict about the wrong
 * file edits the wrong thing.
 *
 * THE RULE: an EXPLICIT LINK is the only acceptable basis for pairing a
 * reference with a raw. Time proximity, directory ordering, mtime and `describe`
 * are not links and are not consulted -- not even to break a tie. Today the only
 * explicit link on disk is the `outputPath` a session record wrote down for
 * itself, and because sessions of one provider routinely share an output
 * directory, that link is usually AMBIGUOUS. Two claimants is a refusal, not a
 * nearest-match. Refuse rather than assume.
 *
 * ## READ-ONLY, and structurally so
 *
 * This tool opens files for reading and writes nothing anywhere -- not the
 * reference, not the raw, not the table, and nothing under the captures root.
 * Repair is a separate, later, human-approved step and is deliberately absent:
 * there is no `--fix`, no options at all, and no exported entry point that could
 * grow into one. An option-shaped argument is REFUSED rather than ignored, so a
 * habit picked up from another tool fails loudly instead of quietly auditing the
 * wrong paths.
 *
 * ## Locations, never values
 *
 * Every finding is a PLACE and a COUNT: reference path, entry index, JSON key
 * path, occurrence count, the table's own `originalHash`, and a 12-hex
 * fingerprint of the replacement. No original and no replacement is ever
 * emitted. A tool written to find leaked identifiers that prints them has
 * relocated the leak into its own report.
 *
 * ## Usage
 *
 *   node audit-scrub-drift.js <captures-root> <reference-path> [<reference-path> ...]
 *
 * `<captures-root>` is the directory holding capture sessions -- normally the
 * gitignored `.har-captures/`. Every `session.json` beneath it is a capture, and
 * the walk FOLLOWS LINKS: `find` does not descend a junction, and a capture
 * store is routinely one. The last session to meet this lost three runs to it,
 * because it presented as a dead CDP endpoint.
 *
 * A `<reference-path>` is a committed `.har`, or a directory of them.
 *
 * The machine-readable report goes to STDOUT and the human summary to STDERR, so
 * `> report.json` yields an artifact that can drive a later repair and be diffed
 * over time while the terminal still shows the story.
 *
 * Exit codes:
 *   0  every reference CLEAN
 *   1  at least one CORRUPTED finding
 *   2  nothing CORRUPTED, but something could not be adjudicated
 *   3  usage error
 */

'use strict';

const fs = require('fs');
const path = require('path');

const harShapes = require(path.join(__dirname, 'har-shapes.js'));
const harPolicy = require(path.join(__dirname, 'har-policy.js'));
const pii = require(path.join(__dirname, 'pii.js'));

const CLEAN = 'CLEAN';
const CORRUPTED = 'CORRUPTED';
const UNADJUDICABLE = 'UNADJUDICABLE';

const SESSION_FILENAME = 'session.json';
const RAW_FILENAME = 'raw.har';
// Both spellings the scrub has used. A table under the legacy name is still a
// table, and treating it as absent would report ignorance the store does not
// actually have.
const TABLE_FILENAMES = ['.substitutions.json', '.har-substitutions.json'];

// The one type this audit adjudicates. The drift #334 describes is specific to
// the card predicate; widening to every PII type would mean claiming a tightened
// definition exists for each, and none does.
const AUDITED_TYPE = 'credit-card';

// The window of digit-run lengths a card substitution could ever have stood in
// for. The loose predicate matched 13-19; one digit of slack on each side costs
// nothing and means a table written by a slightly different vintage of the
// scrubber still resolves.
const MIN_RUN = 12;
const MAX_RUN = 20;

// A directory walk that would otherwise take this long is a linked cycle. The
// cap is on DIRECTORIES VISITED rather than depth, because a junction pointing
// at an ancestor produces an unbounded path that is never deep at any one step.
const MAX_DIRS = 200000;

// ---------------------------------------------------------------------------
// reading, defensively -- every input here is somebody else's committed file
// ---------------------------------------------------------------------------

function readJson(p) {
    try {
        return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch (e) {
        return { ok: false, error: (e && e.message) || 'unreadable' };
    }
}

function realOrSelf(p) {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Every file beneath `dir`, FOLLOWING links.
 *
 * `readdirSync` reports a junction as a link rather than a directory, so the
 * type is taken from `statSync` -- which resolves it -- and not from the dirent.
 * That is this walk's `find -L`. Cycles are bounded by remembering resolved
 * directories, since a link back to an ancestor otherwise recurses forever.
 */
function walkFollowingLinks(dir, onFile) {
    const seen = new Set();
    let visited = 0;
    (function descend(current) {
        const real = realOrSelf(current);
        if (seen.has(real)) return;
        seen.add(real);
        if (++visited > MAX_DIRS) return;

        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const child = path.join(current, entry.name);
            let st;
            try { st = fs.statSync(child); } catch { continue; }
            if (st.isDirectory()) descend(child);
            else if (st.isFile()) onFile(child);
        }
    })(dir);
}

// ---------------------------------------------------------------------------
// capture discovery
// ---------------------------------------------------------------------------

/**
 * Every capture session beneath `capturesRoot`.
 *
 * A session with no substitutions is KEPT, and so is one with no raw. Ten of one
 * real session's twenty-three captures were preserved FAILURES, several with no
 * mutations at all -- one 10 MB capture whose entire value is that the driver
 * refused to act. A capture's worth is not proportional to what it changed, and
 * an audit that prunes on "nothing was mutated" discards exactly the captures
 * carrying findings.
 */
function discoverCaptures(capturesRoot) {
    const found = [];
    walkFollowingLinks(capturesRoot, (p) => {
        if (path.basename(p) !== SESSION_FILENAME) return;
        const sessionDir = path.dirname(p);
        const record = readJson(p);
        const session = record.ok && record.value && typeof record.value === 'object'
            ? record.value
            : {};

        const tablePath = TABLE_FILENAMES
            .map(name => path.join(sessionDir, name))
            .find(candidate => fs.existsSync(candidate)) || null;
        const table = tablePath ? readJson(tablePath) : null;
        const rows = table && table.ok && Array.isArray(table.value && table.value.substitutions)
            ? table.value.substitutions
            : [];

        const rawPath = typeof session.harPath === 'string' && session.harPath !== ''
            ? session.harPath
            : path.join(sessionDir, RAW_FILENAME);

        found.push({
            sessionDir,
            sessionPath: p,
            sessionReadable: record.ok,
            // The one link on disk. Recorded BY the session, ABOUT itself.
            outputPath: typeof session.outputPath === 'string' && session.outputPath !== ''
                ? path.resolve(session.outputPath)
                : null,
            rawPath,
            rawPresent: fs.existsSync(rawPath),
            tablePath,
            tableReadable: table ? table.ok : null,
            substitutions: rows.filter(s => s
                && s.type === AUDITED_TYPE
                && typeof s.replacement === 'string' && s.replacement !== ''
                && typeof s.originalHash === 'string' && s.originalHash !== ''),
        });
    });
    found.sort((a, b) => (a.sessionDir < b.sessionDir ? -1 : a.sessionDir > b.sessionDir ? 1 : 0));
    return found;
}

/** Is `child` inside `parent` (or the same path)? */
function contains(parent, child) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Every capture that EXPLICITLY claims `referencePath`, by having recorded an
 * output path the reference sits under.
 *
 * No tie-break lives here, and that is the design. `describe`, mtime, directory
 * order and capture time are all available a few lines away and none of them is
 * a link -- each is a proxy standing in for a property, on a path that would go
 * on to drive a repair.
 */
function claimingCaptures(referencePath, captures) {
    const real = realOrSelf(referencePath);
    return captures.filter((c) => {
        if (!c.outputPath) return false;
        return contains(c.outputPath, path.resolve(referencePath))
            || contains(realOrSelf(c.outputPath), real);
    });
}

// ---------------------------------------------------------------------------
// walking a HAR's addressable strings
// ---------------------------------------------------------------------------

/**
 * Feed every place a scrubbed value can sit in a HAR entry to `emit(keyPath,
 * text)`.
 *
 * Bodies go through `har-shapes.walkJsonBody` so a finding carries a real JSON
 * key path -- which is both what makes a finding actionable and what lets the
 * merged policy see the field NAME. A body that is not JSON still gets emitted
 * whole, because a non-JSON body is still a place a fake can be; it simply
 * carries no field name, and the adjudication says so rather than inventing one.
 */
function emitEntryStrings(entry, emit) {
    for (const ctx of ['request', 'response']) {
        const side = entry && entry[ctx];
        if (!side) continue;
        for (const h of (Array.isArray(side.headers) ? side.headers : [])) {
            if (h && typeof h.value === 'string') emit(`${ctx}.headers.${h.name}`, h.value);
        }
        for (const c of (Array.isArray(side.cookies) ? side.cookies : [])) {
            if (c && typeof c.value === 'string') emit(`${ctx}.cookies.${c.name}`, c.value);
        }
    }
    const req = entry && entry.request;
    if (req) {
        if (typeof req.url === 'string') emit('request.url', req.url);
        for (const q of (Array.isArray(req.queryString) ? req.queryString : [])) {
            if (q && typeof q.value === 'string') emit(`request.queryString.${q.name}`, q.value);
        }
        const text = req.postData && req.postData.text;
        if (typeof text === 'string') emitBody(text, 'request.postData', emit);
    }
    const res = entry && entry.response;
    const body = res && res.content && res.content.text;
    if (typeof body === 'string') emitBody(body, 'response.content', emit);
}

function emitBody(text, base, emit) {
    const buffered = [];
    const walked = harShapes.walkJsonBody(text, base, (keyPath, scalar) => {
        buffered.push([keyPath, scalar]);
    });
    if (walked && buffered.length) {
        for (const [k, v] of buffered) emit(k, v);
        return;
    }
    emit(`${base}.text`, text);
}

function forEachHarString(har, emit) {
    const entries = (har && har.log && har.log.entries) || [];
    entries.forEach((entry, entryIndex) => {
        emitEntryStrings(entry, (keyPath, text) => emit(entryIndex, keyPath, text));
    });
}

// ---------------------------------------------------------------------------
// locating a replacement inside a reference
// ---------------------------------------------------------------------------

/**
 * Occurrences of `needle` in `hay` that are WHOLE digit runs.
 *
 * The boundary check is not pedantry. A fake card is 16 digits; a longer
 * identifier that happens to contain those 16 in the middle is a DIFFERENT value
 * that was never substituted, and counting it would put a reviewer in front of a
 * field with nothing wrong with it. False positives are what produced this
 * issue, so an audit that adds its own has no standing.
 */
function countWholeRuns(hay, needle) {
    if (typeof hay !== 'string' || !needle) return 0;
    let n = 0;
    let from = 0;
    for (;;) {
        const i = hay.indexOf(needle, from);
        if (i < 0) return n;
        const before = i > 0 ? hay[i - 1] : '';
        const after = hay[i + needle.length] || '';
        if (!/\d/.test(before) && !/\d/.test(after)) n++;
        from = i + 1;
    }
}

/**
 * Where, and how often, each wanted replacement occurs in a reference.
 *
 * The all-digit replacements -- which every card fake is, `4242` plus eleven
 * derived digits plus a Luhn check -- are found by extracting each maximal digit
 * run ONCE per string and looking it up. That is the same whole-run rule
 * `countWholeRuns` states, since a maximal run has non-digits on both sides by
 * construction, and it costs one pass over the text instead of one pass PER
 * SUBSTITUTION. The difference is not academic: a real capture carried 2,954
 * card substitutions against a 10 MB document, and the per-substitution form is
 * that product.
 *
 * A replacement that is not all digits cannot be a maximal digit run, so it
 * falls back to the scan. Nothing in the scrubber emits one today; it is here so
 * a table row of another shape is searched for rather than silently dropped.
 */
function locateReplacements(referenceHar, replacements) {
    const hits = new Map();
    for (const r of replacements) hits.set(r, { occurrences: 0, locations: [] });

    const digitRuns = new Set(replacements.filter(r => /^\d+$/.test(r)));
    const other = replacements.filter(r => !digitRuns.has(r));

    forEachHarString(referenceHar, (entryIndex, keyPath, text) => {
        if (digitRuns.size > 0) {
            const perRun = new Map();
            for (const run of (text.match(/\d+/g) || [])) {
                if (digitRuns.has(run)) perRun.set(run, (perRun.get(run) || 0) + 1);
            }
            for (const [run, n] of perRun) {
                const hit = hits.get(run);
                hit.occurrences += n;
                hit.locations.push({ entryIndex, keyPath, count: n });
            }
        }
        for (const r of other) {
            const n = countWholeRuns(text, r);
            if (n === 0) continue;
            const hit = hits.get(r);
            hit.occurrences += n;
            hit.locations.push({ entryIndex, keyPath, count: n });
        }
    });
    return hits;
}

// ---------------------------------------------------------------------------
// recovering originals from ONE linked raw
// ---------------------------------------------------------------------------

/**
 * For each wanted `originalHash`, what the linked raw holds under it: the value
 * and the field names that held it.
 *
 * Maximal digit runs, not a card pattern. The point is to RECOVER a value the
 * table already committed to by hash, not to re-decide what a card looks like --
 * and a maximal run is also what makes the decimal case resolvable, since the
 * integer part of `168.01500000000001` is a run of its own, which is precisely
 * the shape that produced 488 of the measured rewrites.
 *
 * The recovered values live only in this process and are never serialized.
 * Callers get verdicts out of this, not plaintext.
 */
function recoverFromRaw(rawHar, wantedHashes) {
    const found = new Map();
    if (wantedHashes.size === 0) return found;
    forEachHarString(rawHar, (entryIndex, keyPath, text) => {
        const runs = text.match(/\d+/g);
        if (!runs) return;
        for (const run of runs) {
            if (run.length < MIN_RUN || run.length > MAX_RUN) continue;
            const h = pii.hashPrefix(run);
            if (!wantedHashes.has(h)) continue;
            if (!found.has(h)) found.set(h, { value: run, sites: [] });
            found.get(h).sites.push({ entryIndex, keyPath, field: harShapes.enclosingFieldName(keyPath) });
        }
    });
    return found;
}

// ---------------------------------------------------------------------------
// adjudication
// ---------------------------------------------------------------------------

/**
 * The verdict on one recovered original.
 *
 * The field name is asked FIRST, and deliberately. A value with a real issuer
 * prefix that passes Luhn is still an object id when it sits under `media_id` --
 * 859 such values were measured across 12 captures in a corpus with no cards in
 * it, and a predicate-only test calls every one of them CLEAN.
 */
function verdictFor(recovered, policy) {
    const fields = [...new Set(recovered.sites.map(s => s.field).filter(Boolean))];
    const identifying = fields.filter(f => harPolicy.isIdentifierField(policy, f));

    if (identifying.length > 0 && identifying.length === fields.length) {
        return { outcome: CORRUPTED, reason: 'identifier-field-rewritten' };
    }
    if (identifying.length > 0) {
        // The same value sat under an identifier field in one place and a
        // non-identifier field in another. Picking one would be a guess with a
        // repair behind it.
        return { outcome: UNADJUDICABLE, reason: 'conflicting-field-context' };
    }
    const stillACard = harShapes.hasAssignedIin(recovered.value, policy)
        && harShapes.luhnValid(recovered.value);
    return stillACard
        ? { outcome: CLEAN, reason: 'raw-value-is-a-card' }
        : { outcome: CORRUPTED, reason: 'raw-value-was-never-a-card' };
}

// ---------------------------------------------------------------------------
// one reference
// ---------------------------------------------------------------------------

function unresolved(referencePath, reason, extra) {
    return Object.assign({
        path: referencePath,
        outcome: UNADJUDICABLE,
        reason,
        linkedCapture: null,
        candidateCaptures: [],
        findings: [],
    }, extra || {});
}

function auditReference(referencePath, captures, policy) {
    const claimants = claimingCaptures(referencePath, captures);
    const named = claimants.map(c => ({ sessionDir: c.sessionDir, outputPath: c.outputPath }));

    if (claimants.length === 0) {
        return unresolved(referencePath, 'no-linked-capture');
    }
    if (claimants.length > 1) {
        // Correct session, wrong attempt looks exactly like this from the
        // inside. Every candidate is listed so a human -- the only place the
        // disambiguating knowledge exists -- can settle it.
        return unresolved(referencePath, 'ambiguous-capture-link', { candidateCaptures: named });
    }

    const capture = claimants[0];
    const link = { sessionDir: capture.sessionDir, outputPath: capture.outputPath };
    const asUnadjudicable = (reason) =>
        unresolved(referencePath, reason, { candidateCaptures: named, linkedCapture: link });

    if (!capture.tablePath) return asUnadjudicable('substitution-table-missing');
    if (capture.tableReadable === false) return asUnadjudicable('substitution-table-unreadable');
    if (!capture.rawPresent) return asUnadjudicable('raw-missing');

    const reference = readJson(referencePath);
    if (!reference.ok) return asUnadjudicable('reference-unreadable');
    const raw = readJson(capture.rawPath);
    if (!raw.ok) return asUnadjudicable('raw-unreadable');

    // One candidate per distinct substitution. The same original scrubbed twice
    // produces the same deterministic fake, and a reviewer should see one field
    // once.
    const byHash = new Map();
    for (const sub of capture.substitutions) {
        if (!byHash.has(sub.originalHash)) byHash.set(sub.originalHash, sub);
    }
    const hits = locateReplacements(reference.value, [...byHash.values()].map(s => s.replacement));
    const present = [...byHash.values()].filter(s => hits.get(s.replacement).occurrences > 0);

    const recovered = recoverFromRaw(raw.value, new Set(present.map(s => s.originalHash)));

    const findings = present.map((sub) => {
        const hit = hits.get(sub.replacement);
        const match = recovered.get(sub.originalHash);
        const verdict = match
            ? verdictFor(match, policy)
            // A raw exists and does not hold the value the table says was
            // replaced. Stronger and more surprising than "the raw is gone", and
            // worth telling apart when a repair decides what to do with each.
            : { outcome: UNADJUDICABLE, reason: 'original-not-in-linked-raw' };
        return {
            outcome: verdict.outcome,
            reason: verdict.reason,
            type: AUDITED_TYPE,
            originalHash: sub.originalHash,
            replacementFingerprint: harShapes.fingerprint(sub.replacement),
            digits: match ? match.value.length : sub.replacement.length,
            occurrences: hit.occurrences,
            locations: hit.locations,
            rawSites: match ? match.sites.map(s => ({ entryIndex: s.entryIndex, keyPath: s.keyPath })) : [],
        };
    });
    findings.sort((a, b) => (a.originalHash < b.originalHash ? -1 : a.originalHash > b.originalHash ? 1 : 0));

    const outcome = findings.some(f => f.outcome === CORRUPTED) ? CORRUPTED
        : findings.some(f => f.outcome === UNADJUDICABLE) ? UNADJUDICABLE
            : CLEAN;

    return {
        path: referencePath,
        outcome,
        reason: null,
        linkedCapture: link,
        candidateCaptures: named,
        findings,
    };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

function expandReferencePaths(paths) {
    const out = [];
    for (const p of paths) {
        let st;
        try { st = fs.statSync(p); } catch { out.push(path.resolve(p)); continue; }
        if (st.isDirectory()) {
            walkFollowingLinks(p, (f) => { if (f.toLowerCase().endsWith('.har')) out.push(f); });
        } else {
            out.push(path.resolve(p));
        }
    }
    return [...new Set(out)].sort();
}

function runAudit({ capturesRoot, referencePaths, policy }) {
    const captures = discoverCaptures(capturesRoot);
    const references = expandReferencePaths(referencePaths)
        .map(p => auditReference(p, captures, policy));

    const refCounts = { total: references.length, [CLEAN]: 0, [CORRUPTED]: 0, [UNADJUDICABLE]: 0 };
    const findCounts = { total: 0, [CLEAN]: 0, [CORRUPTED]: 0, [UNADJUDICABLE]: 0 };
    for (const r of references) {
        refCounts[r.outcome]++;
        for (const f of r.findings) { findCounts.total++; findCounts[f.outcome]++; }
    }

    return {
        version: 1,
        tool: 'audit-scrub-drift',
        issue: 335,
        readOnly: true,
        auditedType: AUDITED_TYPE,
        // The CLEAN and CORRUPTED columns depend on `pii.js` and the gate
        // agreeing about field names, which is another session's work and has
        // not landed. The UNADJUDICABLE count depends only on what the STORE can
        // link, so it is trustworthy today -- and it is the number worth running
        // this early for.
        provisional: { [CLEAN]: true, [CORRUPTED]: true, [UNADJUDICABLE]: false },
        provisionalBecause:
            'CLEAN and CORRUPTED are provisional until the identifierFields alignment lands '
            + 'in pii.js; the UNADJUDICABLE count is not.',
        capturesRoot: path.resolve(capturesRoot),
        policyPath: (policy && policy.path) || (policy && policy.defaultPath) || null,
        captures: captures.map(c => ({
            sessionDir: c.sessionDir,
            outputPath: c.outputPath,
            rawPath: c.rawPath,
            rawPresent: c.rawPresent,
            tablePath: c.tablePath,
            tableReadable: c.tableReadable,
            candidateSubstitutions: c.substitutions.length,
        })),
        summary: { references: refCounts, findings: findCounts },
        references,
    };
}

// ---------------------------------------------------------------------------
// human summary -- locations and counts only
// ---------------------------------------------------------------------------

function renderSummary(report) {
    const L = [];
    const s = report.summary;
    L.push(`audit-scrub-drift (issue #${report.issue}) -- read-only, no file was modified`);
    L.push(`  captures root : ${report.capturesRoot}`);
    const noRaw = report.captures.filter(c => !c.rawPresent).length;
    const noTable = report.captures.filter(c => !c.tablePath).length;
    L.push(`  captures      : ${report.captures.length}`
        + ` (${noRaw} with no preserved raw, ${noTable} with no substitution table)`);
    L.push('');
    L.push(`  references : ${s.references.total} total`
        + `   ${CLEAN} ${s.references[CLEAN]}`
        + `   ${CORRUPTED} ${s.references[CORRUPTED]}`
        + `   ${UNADJUDICABLE} ${s.references[UNADJUDICABLE]}`);
    L.push(`  findings   : ${s.findings.total} total`
        + `   ${CLEAN} ${s.findings[CLEAN]}`
        + `   ${CORRUPTED} ${s.findings[CORRUPTED]}`
        + `   ${UNADJUDICABLE} ${s.findings[UNADJUDICABLE]}`);

    for (const outcome of [CORRUPTED, UNADJUDICABLE]) {
        const hits = report.references.filter(r => r.outcome === outcome);
        if (hits.length === 0) continue;
        L.push('');
        L.push(`${outcome}:`);
        for (const r of hits) {
            L.push(`  ${r.path}${r.reason ? `  [${r.reason}]` : ''}`);
            for (const c of (r.linkedCapture ? [] : r.candidateCaptures)) {
                L.push(`      candidate capture  ${c.sessionDir}`);
            }
            for (const f of r.findings.filter(x => x.outcome === outcome)) {
                L.push(`    hash ${f.originalHash} / fake ${f.replacementFingerprint}`
                    + ` (${f.digits} digits) x${f.occurrences}  [${f.reason}]`);
                for (const loc of f.locations) {
                    L.push(`      entry ${loc.entryIndex}  ${loc.keyPath}  x${loc.count}`);
                }
            }
        }
    }

    L.push('');
    L.push('CORRUPTED means the preserved raw holds a value the merged policy never calls a');
    L.push('card, so the field carries a fake where an identifier belongs and the raw is its');
    L.push('repair. UNADJUDICABLE means the question could not be ANSWERED -- most often that');
    L.push('no single capture explicitly claims the reference -- and it is NOT a clean bill of');
    L.push('health. A high UNADJUDICABLE count is the expected result until #341 lands a');
    L.push('per-invocation correlation id; it measures how much of the corpus is un-repairable.');
    L.push('');
    L.push('The CLEAN and CORRUPTED columns are PROVISIONAL until the identifierFields');
    L.push('alignment lands in pii.js (#335); the UNADJUDICABLE count is not provisional.');
    L.push('Repair is a separate, human-approved step -- this tool only reports.');
    return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
    'usage: node audit-scrub-drift.js <captures-root> <reference-path> [<reference-path> ...]',
    '',
    '  <captures-root>   directory holding capture sessions (normally .har-captures/).',
    "                    Every 'session.json' beneath it is a capture; the walk follows",
    '                    links, because a capture store is routinely a junction.',
    '  <reference-path>  a committed reference .har, or a directory of them.',
    '',
    'This tool takes no options. There is no --fix: repair is a separate,',
    'human-approved step. The JSON report goes to stdout and the human summary to',
    'stderr. Read-only -- no reference, raw or substitution table is ever modified.',
].join('\n');

function main(argv) {
    // An option-shaped argument is REFUSED, not ignored. Silently treating
    // `--fix` as a path would audit nothing and report a clean corpus.
    const optionLike = argv.filter(a => a.startsWith('-'));
    if (optionLike.length > 0) {
        process.stderr.write(`audit-scrub-drift: this tool takes no options, got '${optionLike[0]}'\n\n`);
        process.stderr.write(USAGE + '\n');
        return 3;
    }
    if (argv.length < 2) {
        process.stderr.write(USAGE + '\n');
        return 3;
    }
    const [capturesRoot, ...referencePaths] = argv;
    if (!fs.existsSync(capturesRoot)) {
        process.stderr.write(`audit-scrub-drift: captures root not found: ${capturesRoot}\n`);
        return 3;
    }

    let policy;
    try {
        policy = harPolicy.loadPolicy({ startDir: path.resolve(capturesRoot) });
    } catch (e) {
        process.stderr.write(`audit-scrub-drift: could not load the scrub policy: ${e && e.message}\n`);
        return 3;
    }

    const report = runAudit({ capturesRoot, referencePaths, policy });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(renderSummary(report) + '\n');

    if (report.summary.findings[CORRUPTED] > 0) return 1;
    if (report.summary.references[UNADJUDICABLE] > 0) return 2;
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = {
    CLEAN,
    CORRUPTED,
    UNADJUDICABLE,
    walkFollowingLinks,
    discoverCaptures,
    claimingCaptures,
    countWholeRuns,
    recoverFromRaw,
    verdictFor,
    runAudit,
    renderSummary,
};
