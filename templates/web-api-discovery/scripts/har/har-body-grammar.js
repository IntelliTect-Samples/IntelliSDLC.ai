#!/usr/bin/env node
/**
 * har-body-grammar.js -- is this text a request body, or something standing in
 * for one?
 *
 * ONE answer, imported by everything that needs it. It was written for
 * verify-har-reference.js gate 7 (#358), where a reference could carry a
 * 29-character sentinel where a form body used to be, pass every gate, and be
 * catalogued as documenting request-side behaviour it contains none of.
 *
 * It lives here rather than in that CLI because har-catalogue.js needs the same
 * answer to count `RequestBodies`, and a library importing a predicate from a
 * command-line tool is a dependency pointing the wrong way (#429). The gate and
 * the catalogue must not drift into two opinions about what a body is.
 *
 * RECOGNISE THE GRAMMARS, NEVER A KNOWN SENTINEL. The placeholder that prompted
 * this was emitted by no tool in this pipeline, and the next one will be spelled
 * differently. A body is a body when it belongs to a recognised wire grammar --
 * composite JSON, form-urlencoded, multipart, NDJSON, or XML.
 *
 * The measurements behind each recogniser, the two earlier versions that counted
 * punctuation and both fell to a hand-written note, and the accepted limits are
 * documented against each function. That commentary is not decoration: it is why
 * a third punctuation-counting rewrite would be a regression.
 */

'use strict';

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

module.exports = {
    hasCompositeJsonRoot,
    isFormUrlEncodedBody,
    isMultipartBody,
    isNdjsonBody,
    isXmlBody,
    bodyCarriesPayloadStructure,
};
