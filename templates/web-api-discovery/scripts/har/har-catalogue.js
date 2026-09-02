#!/usr/bin/env node
/**
 * har-catalogue.js -- the committed catalogue: measure it, render it.
 *
 * A HAR reference catalogue was prose in a markdown table:
 *
 *   | File | Operation | Captured | Related |
 *   | `facebook-composer-story-create.har` | Feed post with people tags | ... |
 *
 * A prose row makes a claim nothing can check. That is not hypothetical. Four
 * references shipped carrying a 29-character placeholder where the request
 * payload belonged, under rows describing request-side behaviour -- "one
 * Only-Me post with two people tagged", "email + password, then a two-factor
 * code", "Backdated one existing post" -- and passed a dedicated guard, an
 * independent review and a merge. A downstream design document then cited one
 * of them as the evidence for four request-side facts that cannot be read from
 * it.
 *
 * The guard the references passed asserted that every reference HAS a row. It
 * could not assert that the row is TRUE, because "published a post with two
 * people tagged" is a sentence, not a field.
 *
 * So the committed catalogue becomes `catalogue.json`, and this module is the
 * half that makes a row checkable:
 *
 *   measureReference()  computes a row's factual half FROM the .har it names,
 *                       so a claim and the artifact can be compared.
 *   renderTable()       renders the human-facing table, which is a rendering
 *                       of the catalogue rather than a second source of truth.
 *
 * Nothing here decides pass or fail. `verify-har-catalogue.js` is the gate;
 * keeping the measurement separate from the judgement is what lets the
 * measurement be tested without a process boundary.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ONE definition of "is this a body", shared with the gate that wrote it.
//
// verify-har-reference.js gate 7 recognises a request body by WIRE GRAMMAR --
// composite JSON, form-urlencoded, multipart, NDJSON, XML -- rather than by a
// list of known placeholders, because the sentinel that prompted it was
// emitted by no tool in this pipeline and the next one will be spelled
// differently. That reasoning is documented at length beside the gate, and it
// stays there: this module imports the predicate rather than forming a second
// opinion about what a body is. Two implementations that agree today are the
// standard way a guard and the thing it guards drift apart.
const { bodyCarriesPayloadStructure } = require(path.join(__dirname, 'verify-har-reference.js'));

const CATALOGUE_FILE = 'catalogue.json';
const README_FILE = 'README.md';

// The generated region. Everything outside it is hand-written and never
// touched -- the naming convention, the provenance notes, the re-capture
// recipe. The marker names the file to edit instead, because the first
// instinct on seeing a wrong table is to fix the table.
const BEGIN_MARKER = '<!-- BEGIN GENERATED CATALOGUE -- edit catalogue.json, not this table -->';
const END_MARKER = '<!-- END GENERATED CATALOGUE -->';

// Methods that carry a request body in ordinary use. The falsifier reads this:
// a row whose recomputed methods include one of these, on a reference with
// zero request bodies, is claiming request-side behaviour its file cannot
// support.
//
// DELETE is deliberately absent. A body on DELETE is legal and occurs, but it
// is uncommon enough that requiring one would report real captures -- and a
// gate that fires on real traffic gets disabled, costing every other check it
// carries.
const BODY_BEARING_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// Directories that are never part of a committed reference set. `.har-captures`
// holds raw captures with live credentials and is gitignored; the other two are
// never interesting and are expensive to walk.
const SKIP_DIRS = new Set(['.har-captures', 'node_modules', '.git']);

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Collapse identifier-shaped path segments to a template.
 *
 * THIS IS THE SHARED DEFINITION, and capture-har.js requires it rather than
 * keeping its own. `buildCatalogueScaffold` writes a row's `Endpoints` from
 * the capture digest's path template; the guard recomputes them from the
 * reference. If the two templated a path differently, every scaffolded row
 * would fail the guard the moment it was committed -- the failure would be in
 * the gate, and the fix people would reach for is to weaken the gate.
 */
function pathTemplate(pathname) {
    return pathname.split('/').map((segment) => {
        if (!segment) return segment;
        if (/^\d+$/.test(segment)) return '{id}';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return '{uuid}';
        if (/^[0-9a-f]{16,}$/i.test(segment)) return '{hash}';
        // Mixed alphanumeric with enough digits to be an id rather than a word.
        if (segment.length >= 8 && /\d/.test(segment) && /^[A-Za-z0-9_-]+$/.test(segment)
            && (segment.replace(/\D/g, '').length / segment.length) > 0.3) return '{id}';
        return segment;
    }).join('/');
}

/** `host/templated/path` for one entry, or null when the URL will not parse. */
function endpointOf(request) {
    try {
        const url = new URL(request.url);
        return `${url.host}${pathTemplate(url.pathname)}`;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Does this entry carry a request body that IS a body?
 *
 * The three states are decided separately rather than by truthiness, matching
 * gate 7: no `postData` at all (a GET), `postData` with no `text` string
 * (structural `params[]` only), and a `text` that is empty or whitespace. None
 * of those is a body, and none of them is a defect either.
 */
function hasRequestBody(entry) {
    const postData = entry.request && entry.request.postData;
    if (!postData || typeof postData.text !== 'string') return false;
    const text = postData.text.trim();
    if (text === '') return false;
    return bodyCarriesPayloadStructure(text, postData.mimeType);
}

/** Bytes of a response body, preferring what is actually stored over what is declared. */
function responseBytes(entry) {
    const content = entry.response && entry.response.content;
    if (!content) return 0;
    if (typeof content.text === 'string') return Buffer.byteLength(content.text);
    return typeof content.size === 'number' && content.size > 0 ? content.size : 0;
}

/**
 * The factual half of a catalogue row, computed from the reference itself.
 *
 * Every field here is one a row declares and the guard recomputes. The point
 * is not the numbers -- it is that a sentence in a table had no numbers, so
 * there was nothing to disagree with.
 *
 * Methods and endpoints are deduplicated and SORTED. A capture is a recording:
 * if the facts moved with the order the traffic happened to arrive in, a
 * re-capture of the same flow would dirty the catalogue and the guard would
 * report a real reference as wrong.
 */
function measureReference(harPath) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    } catch (e) {
        // Name the file. A measurement that returned zeroes for an unreadable
        // reference would let a deleted or corrupt file pass as "a reference
        // with no entries", which is the failure mode this whole issue is about.
        throw new Error(`cannot read reference ${harPath}: ${e.message}`);
    }

    const entries = (parsed && parsed.log && Array.isArray(parsed.log.entries))
        ? parsed.log.entries
        : [];

    const methods = new Set();
    const endpoints = new Set();
    let requestBodies = 0;
    let requestBytes = 0;
    let responseByteTotal = 0;

    for (const entry of entries) {
        const request = entry.request || {};
        if (request.method) methods.add(String(request.method).toUpperCase());
        const endpoint = endpointOf(request);
        if (endpoint) endpoints.add(endpoint);

        if (hasRequestBody(entry)) {
            requestBodies++;
            // Only bodies that ARE bodies contribute, so `RequestBodies: 0,
            // RequestBytes: 0` cannot be misread as "a small payload".
            requestBytes += Buffer.byteLength(entry.request.postData.text);
        }
        responseByteTotal += responseBytes(entry);
    }

    return {
        EntryCount: entries.length,
        Methods: [...methods].sort(),
        Endpoints: [...endpoints].sort(),
        RequestBodies: requestBodies,
        RequestBytes: requestBytes,
        ResponseBytes: responseByteTotal,
    };
}

/** The fields `measureReference` computes, in the order a row declares them. */
const MEASURED_FIELDS = [
    'Methods', 'Endpoints', 'EntryCount', 'RequestBodies', 'RequestBytes', 'ResponseBytes',
];

// ---------------------------------------------------------------------------
// The reference set on disk
// ---------------------------------------------------------------------------

/**
 * Every `.har` under `dir`, as paths relative to `dir` with forward slashes.
 *
 * Both layouts are live and neither is guessed at: provider subdirectories
 * (today's upstream shape) and references flat beside the catalogue (the shape
 * #379 draws). Forward slashes because the result is compared against
 * `HarFile` values written into JSON, which are not Windows paths.
 */
function listReferences(dir) {
    const found = [];
    const walk = (current, prefix) => {
        for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
            if (dirent.isDirectory()) {
                if (SKIP_DIRS.has(dirent.name)) continue;
                walk(path.join(current, dirent.name), `${prefix}${dirent.name}/`);
            } else if (dirent.name.toLowerCase().endsWith('.har')) {
                found.push(`${prefix}${dirent.name}`);
            }
        }
    };
    walk(dir, '');
    return found.sort();
}

/** Read `catalogue.json` from a reference directory. */
function readCatalogue(dir) {
    const file = path.join(dir, CATALOGUE_FILE);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        throw new Error(`cannot read ${file}: ${e.message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`cannot parse ${file}: ${e.message}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`${file} must contain an array of catalogue entries`);
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * A cell that cannot break the table it sits in.
 *
 * A description carrying a pipe would silently add a column, and one carrying
 * a newline would end the row mid-sentence -- both of which look like the
 * GENERATOR is broken, sending the reader to fix the table rather than the
 * catalogue.
 */
function cell(value) {
    if (value === null || value === undefined || value === '') return '--';
    return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Issue numbers as `#412 #518`, which is what the prose table carried. */
function relatedCell(related) {
    if (!Array.isArray(related) || related.length === 0) return '--';
    return related.map((n) => (String(n).startsWith('#') ? String(n) : `#${n}`)).join(' ');
}

/**
 * Deterministic order, so regenerating an unchanged catalogue is byte-identical.
 *
 * Sorted by provider, then action, then capture date -- never by the order the
 * rows happen to sit in the JSON, which would make an appended row reshuffle
 * the table and turn every catalogue edit into an unreviewable diff.
 */
function sortEntries(entries) {
    return [...entries].sort((a, b) =>
        String(a.Provider || '').localeCompare(String(b.Provider || ''))
        || String(a.Action || '').localeCompare(String(b.Action || ''))
        || String(a.CapturedUtc || '').localeCompare(String(b.CapturedUtc || '')));
}

const EXERCISED_HEADER = [
    '| File | Operation | Entries | Request bodies | Captured | Related |',
    '|---|---|---|---|---|---|',
];

const OBSERVED_HEADER = [
    '| Endpoint | Method | What it appears to do | Related |',
    '|---|---|---|---|',
];

/**
 * The generated region: the exercised references, then the endpoints that were
 * seen but never driven.
 *
 * Both tables are generated, and the "Observed, not exercised" half is NOT
 * left hand-written. SKILL.md requires those rows mirrored into the README so
 * a reader can tell a worked example from a sighting without opening the JSON
 * -- and a half-generated section is precisely the drift this issue closes:
 * the generated half would stay current while the hand-written half quietly
 * described a previous capture.
 */
function renderTable(entries) {
    const sorted = sortEntries(entries);
    const exercised = sorted.filter((e) => e.Status !== 'Observed');
    const observed = sorted.filter((e) => e.Status === 'Observed');

    const lines = [];

    lines.push(...EXERCISED_HEADER);
    if (exercised.length === 0) {
        lines.push('| _no references catalogued yet_ |  |  |  |  |  |');
    }
    for (const e of exercised) {
        lines.push('| ' + [
            e.HarFile ? `\`${cell(e.HarFile)}\`` : '--',
            cell(e.Description || e.Action),
            cell(e.EntryCount),
            // Surfaced in the table on purpose. This is the column that would
            // have made four hollow references visible to a human reading the
            // README, without opening a single .har.
            cell(e.RequestBodies),
            cell(e.CapturedUtc ? String(e.CapturedUtc).slice(0, 10) : null),
            relatedCell(e.Related),
        ].join(' | ') + ' |');
    }

    if (observed.length > 0) {
        lines.push('');
        lines.push('### Observed, not exercised');
        lines.push('');
        lines.push('Endpoints the capture saw that nobody drove. No worked example exists;');
        lines.push('these are capabilities the API has, recorded so a later request starts');
        lines.push('from a sighting rather than from nothing.');
        lines.push('');
        lines.push(...OBSERVED_HEADER);
        for (const e of observed) {
            lines.push('| ' + [
                cell((e.Endpoints || []).join(', ')),
                cell((e.Methods || []).join(', ')),
                cell(e.Description || e.Action),
                relatedCell(e.Related),
            ].join(' | ') + ' |');
        }
    }

    return lines.join('\n');
}

/** Thrown when a README exists but carries no generated region. */
class MissingMarkersError extends Error {}

/**
 * The README text this catalogue implies, given whatever is there now.
 *
 * Three cases, and the third is the one that matters:
 *
 *   * No README -- write one carrying the markers and the table.
 *   * Markers present -- replace ONLY what is between them. Everything else is
 *     hand-written and survives verbatim.
 *   * README present, markers absent -- THROW. Do not guess where the table
 *     goes. Guessing is how a generator eats a paragraph somebody wrote, and
 *     the paragraphs here are the provenance notes and the re-capture recipe
 *     -- the part of the file a person cannot regenerate.
 */
function renderReadme(existing, entries, dirLabel) {
    const region = `${BEGIN_MARKER}\n\n${renderTable(entries)}\n\n${END_MARKER}`;

    if (existing === null || existing === undefined) {
        return [
            `# HAR reference catalogue${dirLabel ? ` -- ${dirLabel}` : ''}`,
            '',
            'Scrubbed reference captures: ground truth about someone else\'s API, kept so',
            'that when a provider changes a payload the fix is re-capture and diff rather',
            'than guesswork.',
            '',
            'The table below is GENERATED from `catalogue.json`. Edit that file, then',
            're-run `render-har-catalogue.js`. Prose outside the markers is hand-written',
            'and is never touched by the generator -- put provenance notes, the naming',
            'convention and the re-capture recipe here.',
            '',
            region,
            '',
        ].join('\n');
    }

    const begin = existing.indexOf(BEGIN_MARKER);
    const end = existing.indexOf(END_MARKER);
    if (begin < 0 || end < 0 || end < begin) {
        throw new MissingMarkersError(
            'README.md carries no generated region, so there is nowhere to put the table ' +
            'and no safe way to guess. Paste these two lines where the table belongs and ' +
            're-run:\n' +
            `  ${BEGIN_MARKER}\n  ${END_MARKER}`);
    }

    return existing.slice(0, begin) + region + existing.slice(end + END_MARKER.length);
}

module.exports = {
    BEGIN_MARKER,
    END_MARKER,
    BODY_BEARING_METHODS,
    CATALOGUE_FILE,
    README_FILE,
    MEASURED_FIELDS,
    MissingMarkersError,
    endpointOf,
    hasRequestBody,
    listReferences,
    measureReference,
    pathTemplate,
    readCatalogue,
    renderReadme,
    renderTable,
    sortEntries,
};
