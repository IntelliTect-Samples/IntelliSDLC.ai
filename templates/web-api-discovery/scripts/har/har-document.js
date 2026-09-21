'use strict';

/**
 * har-document.js -- the one place a capture is read, and the one place a
 * capture that cannot be read is REFUSED (issue #423).
 *
 * THE DEFECT THIS EXISTS TO END. Every stage used to open a capture like this:
 *
 *     const entries = (har && har.log && har.log.entries) || [];
 *
 * which answers "zero entries" to three completely different questions: a
 * capture that really is empty, a file that is not a HAR at all, and a
 * document whose entries are some other shape. Downstream, all three become
 * the same sentence -- `buildDigest` makes no groups, the catalogue scaffold
 * makes no rows, `verify-har-catalogue.js` blames the catalogue for a file the
 * READER could not understand, and a generated api.json describes a provider
 * as though those sessions never happened. Every gate stays green while
 * measuring nothing, which is the failure class this pipeline has spent weeks
 * closing on the verification side. This is the same thing on the INPUT side,
 * where it is worse: the gates downstream are honest about a corpus that is
 * silently short.
 *
 * So: an unreadable or unrecognised capture FAILS, loudly, naming the file and
 * what was found in it. A capture that is genuinely empty still reads as zero
 * entries, because "I read it and it held nothing" and "I could not read it"
 * are different facts and the operator acts on them differently.
 *
 * WHAT #423 TURNED OUT NOT TO BE. The issue was filed believing mitmproxy
 * `hardump` exports were a second, unreadable format needing detection or
 * conversion. They are not. mitmproxy writes standard HAR 1.2 -- the same
 * `log.entries` envelope Playwright writes, differing only in
 * `log.creator.name` and in whitespace, and pretty-printed captures are the
 * norm across a real store rather than an anomaly. Measured against the
 * dogfood corpus, the "unreadable" captures parse cleanly and yield their full
 * entry counts. There is no second shape to teach anything, and
 * `har-unreadable-capture.test.js` pins that with a mitmproxy fixture so the
 * assumption cannot be reintroduced on the strength of the original report.
 * (Those sessions are missing downstream for an unrelated and deliberate
 * reason: `capture-store.js` classifies them FOREIGN and declines them by
 * name, because they carry no `session.json` and so have no provenance.)
 *
 * WHY A MODULE AND NOT A HELPER IN EACH SCRIPT. Nine scripts shared the fold.
 * Nine repairs that agree today are how a guard and the thing it guards drift
 * into disagreeing about what a HAR is. It is also the precondition for #450:
 * captures past Node's ~512 MB maximum string length cannot be read by
 * `JSON.parse(fs.readFileSync(...))` at all, and that work replaces the
 * INTERNALS of this module with a streaming engine. That swap is only
 * internals-only if there is exactly one place to swap and every stage already
 * goes through it -- which is what this file and the migration alongside it
 * establish.
 *
 * THE CONTRACT #450 BUILDS AGAINST, stated so neither side has to guess:
 *
 *   - `HarFormatError` is canonical and lives HERE. It is the only error type
 *     a caller ever catches for a capture it could not read. The streaming
 *     engine must NOT import this module to throw it -- this module will
 *     require the engine, and an import cycle is the cost of both directions.
 *     The engine raises its own error carrying a stable `code` and this
 *     boundary translates it, which is what `fromEngineError` below is for.
 *   - `code` is the machine-readable half and is exhaustive by construction:
 *     every condition the engine can raise has a code here, and an
 *     untranslated one becomes `unreadable` rather than escaping as a foreign
 *     type.
 *   - `iterateHarEntries` exists from day one even though its first
 *     implementation walks an array that is already in memory. The name has to
 *     be at the call sites BEFORE the streaming swap, or the swap re-touches
 *     every stage it was supposed to leave alone.
 *
 * SIZE IS NOT THIS MODULE'S PROBLEM, YET. A capture past the string limit
 * still fails here, as `unreadable`, carrying Node's own message. That is
 * #450's to remove; this file only guarantees it is never reported as zero
 * entries in the meantime.
 */

const fs = require('fs');
const path = require('path');

/**
 * The one error a caller catches when a capture cannot be read as a HAR.
 *
 * `code` is the stable, machine-readable half:
 *
 *   unreadable      the bytes could not be obtained -- missing, permissions,
 *                   or (until #450) larger than a JavaScript string
 *   not-json        the bytes are not JSON
 *   not-a-har       it is JSON, but there is no `log.entries` array in it.
 *                   THE condition this issue is about: the one that used to
 *                   be an empty list
 *   truncated       the document ends inside `log.entries` -- the shape was
 *                   right and the recording was cut off, which is a different
 *                   repair from "this is not a HAR" (raised by #450's
 *                   streaming engine; a whole-document parse reports the same
 *                   file as not-json)
 *   entry-not-json  one entry does not parse (streaming engine)
 *   entry-too-large one entry alone exceeds a JavaScript string (streaming
 *                   engine) -- the one size condition streaming does not
 *                   remove
 */
class HarFormatError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'HarFormatError';
        this.code = code || 'unreadable';
    }
}

/** Every code this boundary promises to produce. Exported so #450's engine can assert against it. */
const HAR_FORMAT_CODES = Object.freeze([
    'unreadable',
    'not-json',
    'not-a-har',
    'truncated',
    'entry-not-json',
    'entry-too-large',
]);

/**
 * Translate an engine error into the canonical type.
 *
 * The streaming engine cannot require this module (cycle), so it throws its
 * own error carrying `code`. An unrecognised code degrades to `unreadable`
 * rather than escaping as a foreign type: a caller catching `HarFormatError`
 * must never be surprised by a second class for the same condition.
 */
function fromEngineError(error, label) {
    if (error instanceof HarFormatError) return error;
    const code = error && HAR_FORMAT_CODES.includes(error.code) ? error.code : 'unreadable';
    const detail = error && error.message ? error.message : String(error);
    return new HarFormatError(`${label} cannot be read as a HAR: ${detail}`, code);
}

/**
 * The top-level key names of a JSON value -- the SHAPE, never the values.
 *
 * An error message is printed to a terminal, pasted into an issue and swept
 * into CI logs. A raw capture holds live credentials, so the message names
 * what the keys are called and nothing about what they contain. Naming them at
 * all is what lets an operator tell "this is a mitmproxy flows dump" from
 * "this file is corrupt" without opening a multi-hundred-megabyte file by
 * hand.
 */
function describeShape(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `an array of ${value.length}`;
    if (typeof value !== 'object') return typeof value;
    const keys = Object.keys(value);
    if (keys.length === 0) return 'an object with no keys';
    const shown = keys.slice(0, 8);
    return `an object with keys: ${shown.join(', ')}${keys.length > shown.length ? ', ...' : ''}`;
}

/**
 * Recognise a parsed value as a HAR and hand back its entries.
 *
 * Note what is NOT checked: the creator, the version, the presence of `pages`.
 * A reader that insisted on those would reject mitmproxy's output, or
 * tomorrow's recorder, for reasons that have nothing to do with whether the
 * traffic can be read -- which is precisely the mistake #423 was filed
 * believing had already been made. `log.entries` being a list is the whole
 * definition, because it is the whole of what every stage downstream uses.
 */
function entriesOf(document, label) {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
        throw new HarFormatError(
            `${label} is not a HAR document: no log.entries -- the file is ${describeShape(document)}`,
            'not-a-har');
    }
    const log = document.log;
    if (log === null || typeof log !== 'object' || Array.isArray(log)) {
        throw new HarFormatError(
            `${label} is not a HAR document: no log.entries -- the file is ${describeShape(document)}`,
            'not-a-har');
    }
    if (!Array.isArray(log.entries)) {
        throw new HarFormatError(
            `${label} is not a HAR document: log.entries is ${describeShape(log.entries)}, not a list ` +
            `-- log is ${describeShape(log)}`,
            'not-a-har');
    }
    return log.entries;
}

/**
 * Parse capture text into `{ document, entries }`, or throw.
 *
 * `label` is what the operator is told: a path when there is one, something
 * like `stdin` when there is not. A message naming a path the caller never
 * gave sends the operator looking for the wrong file.
 */
function parseHarDocument(text, label) {
    let document;
    try {
        document = JSON.parse(text);
    } catch (e) {
        throw new HarFormatError(`${label} is not valid JSON: ${e.message}`, 'not-json');
    }
    return { document, entries: entriesOf(document, label) };
}

/**
 * Read a capture from disk into `{ document, entries }`, or throw.
 *
 * #450 replaces the body of this function with its streaming engine. The
 * return shape stays: the stages that need the whole document (the scrub
 * rewrites it, the trim filters and re-serialises it) keep working, and the
 * stages that only walk entries should move to `iterateHarEntries`.
 */
function readHarDocument(harPath) {
    const label = path.basename(harPath) === harPath ? harPath : `${harPath}`;
    let text;
    try {
        text = fs.readFileSync(harPath, 'utf8');
    } catch (e) {
        // Missing, unreadable, or -- until #450 -- longer than a JavaScript
        // string. All three are "I could not obtain the bytes", which is not
        // the same claim as "this is not a HAR", and the operator's next move
        // differs for each.
        throw new HarFormatError(`cannot read ${label}: ${e.message}`, 'unreadable');
    }
    return parseHarDocument(text, label);
}

/**
 * Walk a capture's entries one at a time.
 *
 * Today this iterates an array that is already in memory, which buys nothing
 * on its own. It exists now so that the call sites say `iterateHarEntries`
 * BEFORE #450 swaps in a generator that never holds the whole document --
 * otherwise that work has to re-touch every stage this migration just moved.
 *
 * It fails the same way the whole-document read does, and it fails BEFORE
 * yielding anything: a walk that yielded three entries and then announced the
 * file was unreadable would leave the caller holding a partial answer it had
 * already acted on.
 *
 * @param {string|{entries: Array}} source a path, or an already-read document
 */
function* iterateHarEntries(source) {
    const entries = typeof source === 'string'
        ? readHarDocument(source).entries
        : entriesOf(source && source.document ? source.document : source, 'the capture');
    for (const entry of entries) yield entry;
}

module.exports = {
    HarFormatError,
    HAR_FORMAT_CODES,
    describeShape,
    entriesOf,
    fromEngineError,
    iterateHarEntries,
    parseHarDocument,
    readHarDocument,
};
