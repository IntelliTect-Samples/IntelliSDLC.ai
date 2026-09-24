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
 * SIZE (#450). A file is never read into one string here: both readers go
 * through the streaming engine in `lib/har-stream.js`, so a capture past Node's
 * string limit reads. What that does NOT remove is memory. `readHarDocument`
 * still holds every entry, because its callers need the whole document; only
 * `iterateHarEntries` over a path holds one entry at a time. A stage that only
 * walks entries should be on the iterator, accumulating its ANSWER rather than
 * the entries -- collecting the walk into an array re-creates the defect as an
 * out-of-memory instead of a string-length error.
 */

const fs = require('fs');
const path = require('path');
const harStream = require(path.join(__dirname, '..', 'lib', 'har-stream.js'));

// Node's longest string, in UTF-16 code units. A file of at least this many
// BYTES cannot be read into one string, whatever it holds.
const STRING_LIMIT = require('buffer').constants.MAX_STRING_LENGTH;

/**
 * The one error a caller catches when a capture cannot be read as a HAR.
 *
 * `code` is the stable, machine-readable half:
 *
 *   unreadable      the bytes could not be obtained -- missing, permissions
 *   not-json        the bytes are not JSON (told apart from `not-a-har` only
 *                   for a file small enough to parse whole; above the string
 *                   limit the scanner can only say it found no entries)
 *   not-a-har       it is JSON, but there is no `log.entries` array in it.
 *                   THE condition this issue is about: the one that used to
 *                   be an empty list. A capture cut off BEFORE `log.entries`
 *                   begins also lands here rather than in `truncated`: a
 *                   single forward scan that never reaches the key cannot
 *                   tell "this document has no entries" from "this document
 *                   stopped before it got to them", and telling those apart
 *                   costs a second pass for a narrow case. Both still fail
 *                   loudly, which is the invariant; only the suggested repair
 *                   is less precise
 *   envelope-not-json  the JSON is broken OUTSIDE the entries array -- the
 *                   entries themselves may be perfectly good. Distinct from
 *                   `not-json` because it tells the operator something
 *                   different: the recording is probably intact and the
 *                   wrapper around it is not (streaming engine; a
 *                   whole-document parse cannot tell the two apart and
 *                   reports `not-json`)
 *   truncated       the document ends inside `log.entries` -- the shape was
 *                   right and the recording was cut off, which is a different
 *                   repair from "this is not a HAR" (raised by #450's
 *                   streaming engine; a whole-document parse reports the same
 *                   file as not-json)
 *   entry-not-json  one entry does not parse (streaming engine)
 *   entry-too-large one entry alone exceeds a JavaScript string (streaming
 *                   engine) -- the one size condition streaming does not
 *                   remove
 *   duplicate-key   `log` appears twice in the root, or `entries` twice in
 *                   `log`. Valid JSON, but which copy is the capture is
 *                   ambiguous: `JSON.parse` keeps the last, a scanner the
 *                   first, and a first `entries: []` would read as zero
 *                   entries. Refused rather than guessed (streaming engine)
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
    'envelope-not-json',
    'truncated',
    'entry-not-json',
    'entry-too-large',
    'duplicate-key',
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
    // The engine names the file in its own message. Prefixing unconditionally
    // printed the path twice in one sentence, which is the sort of thing an
    // operator reads as a bug in the tool reporting their bug. The common
    // phrase is what has to be there -- it is what makes an open-level and an
    // entry-level refusal read as the same kind of event -- so it is added and
    // the second copy of the label is not.
    //
    // The label must be a LEADING TOKEN, not merely a prefix, and not merely
    // contained. Each weaker test loses the filename for a different input,
    // and losing the filename is the one outcome this boundary exists to
    // prevent:
    //
    //   contains    a label of `a` is "contained" in `cannot read data`, so a
    //               real name that existed was dropped
    //   starts with every string starts with the empty string, so a caller
    //               that passed no label suppressed the prefix too; and an
    //               error whose own message is empty stringifies to `Error`,
    //               which a file named `E` is a prefix of
    //
    // Requiring a separator after the label costs nothing -- every READ error
    // that reaches here writes the path as its first token, followed by a
    // space or a colon, engine and fs alike -- and it cannot be satisfied by
    // accident.
    //
    // A position-INDEPENDENT rule was tried and rejected. It would also dedup
    // the engine's write-side messages, which lead with `cannot write` and
    // carry the path second -- but matching a whole token anywhere in the
    // sentence brings the coincidence straight back one size up: a capture
    // named `is` is a token of `this file is broken`, and the name vanishes
    // again. Losing the name is the failure this function exists to prevent;
    // printing it twice is untidy. Those are not the same cost, so the rule
    // that can never lose it wins.
    //
    // FOR READ FAILURES ONLY, and that is what makes the trade safe. The
    // sentence built here says a capture could not be READ, so a write
    // failure routed through it would be wrong about what happened rather
    // than merely repetitive -- and no dedup rule fixes a wrong verb. The
    // trim command's write path deliberately does not come through this
    // function. A future tidy-up that makes the two sides symmetric must give
    // the write side its own sentence rather than borrow this one; making the
    // engine's write messages lead with the path would remove the doubling
    // but not the wrong verb, so it is not on its own a fix.
    const named = label ? String(label) : 'the capture';
    const deduped = detail.startsWith(`${named} `) || detail.startsWith(`${named}:`);
    const message = deduped
        ? `cannot be read as a HAR: ${detail}`
        : `${named} cannot be read as a HAR: ${detail}`;
    return new HarFormatError(message, code);
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
    // Capped on BOTH axes. Eight keys was the obvious limit and it is only half
    // of it: a document keyed by base64 blobs -- which is a shape an operator
    // hands this precisely because they do not know what the file is -- has few
    // enough keys to print them all and still fills a terminal with one of
    // them. Truncating a key changes nothing about the leak rule either way,
    // since these are names and never values.
    const shown = keys.slice(0, 8).map((k) => (k.length > 40 ? `${k.slice(0, 40)}...` : k));
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
 * Open a capture through the streaming engine, translating every refusal into
 * the canonical type.
 *
 * The one open-level refusal that is re-diagnosed is `not-a-har`. The engine
 * finds `log.entries` by scanning, so "no entries array" is all it can say --
 * about a flows dump, about a file that is not JSON at all, about a HAR whose
 * `entries` is an object. Those are different repairs, and the whole-document
 * reader told them apart (`not-json`, and the top-level key names). So when the
 * file is small enough to be read whole, the refusal is re-derived by the
 * whole-document parser, which produces the more useful sentence. Above the
 * string limit that is impossible, and the engine's own refusal stands. This
 * runs only on a path that is already failing, so it costs nothing on a
 * capture that reads.
 */
function openCapture(harPath) {
    try {
        return harStream.openHarDocument(harPath);
    } catch (e) {
        if (e && e.code === 'not-a-har') rediagnose(harPath);
        throw fromEngineError(e, harPath);
    }
}

function rediagnose(harPath) {
    let text;
    try {
        if (fs.statSync(harPath).size >= STRING_LIMIT) return;
        text = fs.readFileSync(harPath, 'utf8');
    } catch (e) {
        return;
    }
    // Throws the richer refusal. If it does NOT throw, the whole-document
    // parser found entries the scanner did not -- the two readers disagree
    // about this file, and returning quietly would let the scanner's answer
    // win. That is a defect in the engine, and it is reported as one.
    parseHarDocument(text, harPath);
    throw new HarFormatError(
        `${harPath}: the streaming reader found no log.entries but a whole-document parse did -- `
        + 'the two readers disagree about this file; please report it', 'unreadable');
}

/** Walk an opened capture, translating an entry-level refusal as it surfaces. */
function* walkOpened(opened, harPath) {
    const it = opened.entries();
    for (;;) {
        let step;
        try {
            step = it.next();
        } catch (e) {
            throw fromEngineError(e, harPath);
        }
        if (step.done) return;
        yield step.value;
    }
}

/**
 * Read a capture from disk into `{ document, entries }`, or throw.
 *
 * The file is never built as one string: the engine scans it, parses the
 * envelope and each entry separately, and the entries are placed back into the
 * envelope's own `log.entries` slot -- the key position the file had, so a
 * stage that re-serialises the document writes the keys in the order it read
 * them. `document.log.entries` IS `entries`, one array, so a stage that edits
 * an entry and then serialises the document sees its own edit.
 *
 * This removes the string limit, not the memory: the whole document is still
 * held. It is for the stages that genuinely need the document. A stage that
 * only walks entries belongs on `iterateHarEntries`, which holds one.
 */
function readHarDocument(harPath) {
    const opened = openCapture(harPath);
    const entries = [];
    for (const entry of walkOpened(opened, harPath)) entries.push(entry);
    const document = opened.envelope;
    document.log.entries = entries;
    return { document, entries };
}

/**
 * Walk a capture's entries one at a time.
 *
 * Given a PATH, this streams: one entry is held at a time, whatever the size
 * of the file. Given an already-read document, it walks the array in memory.
 *
 * WHEN IT FAILS. A capture refused at the OPEN -- not a HAR, cut off inside
 * `log.entries`, a broken envelope -- fails before anything is yielded, because
 * the open locates the whole entries array before the first entry is parsed.
 * An entry that does not parse is only knowable when the walk reaches it, so
 * that refusal arrives AFTER the entries before it were yielded. A stage must
 * therefore accumulate its answer and act on it only once the walk completes;
 * a throw mid-walk then leaves nothing acted on.
 *
 * @param {string|{entries: Array}} source a path, or an already-read document
 */
function* iterateHarEntries(source) {
    if (typeof source === 'string') {
        yield* walkOpened(openCapture(source), source);
        return;
    }
    const entries = entriesOf(source && source.document ? source.document : source, 'the capture');
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
