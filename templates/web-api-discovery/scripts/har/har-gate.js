'use strict';

/**
 * har-gate.js -- the leak gate's QUESTION, without its command line.
 *
 * `verify-scrub.js` is the gate a pipeline runs; this is what it asks. Split
 * out so the scrubber's blunting pass (issue #511) can ask exactly the same
 * question in-process -- which findings exist, and which of them would block
 * -- without loading a CLI and without a second copy of the classification.
 * Two engines that each decide what counts as a leak is the drift #454 spent
 * a PR removing.
 *
 * `verify-scrub.js` re-exports all of this, so nothing that already imports
 * the gate changes.
 */

const path = require('path');
const harSecrets = require(path.join(__dirname, 'har-secrets.js'));
const harShapes = require(path.join(__dirname, 'har-shapes.js'));

// Does a finding fail the run? One definition, in har-shapes.js, so the gate
// on the committed reference cannot drift away from the gate on the
// intermediate it came from. See `blocksLeak` there for what each setting
// means and why an identifier-shaped finding is reported rather than dropped.
const blocks = harShapes.blocksLeak;

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

/**
 * Every structural finding in a PARSED capture: shape evidence from the entry
 * walk, plus known secret names still readable in the clear.
 *
 * The forbidden-literal check is not here: it reads the RAW text and needs the
 * operator profile, and `verify-scrub.js` still runs it itself.
 */
function collectFindings(parsed, policy) {
    const leaks = harShapes.findLeaksInHar(parsed, policy);
    // The location travels with the finding (issue #529). Dropping it made
    // this the one finding kind an operator could not act on: the report
    // named a field and left the entry to be found by hand, which on a
    // real capture meant walking tens of megabytes of JSON.
    harSecrets.walkForUnredactedSecrets(parsed, (name, where, at) => {
        leaks.push(Object.assign({ kind: 'known-secret', sample: name, gating: true },
            at && at.entryIndex !== undefined ? { entryIndex: at.entryIndex } : null,
            at && at.keyPath ? { keyPath: at.keyPath } : null,
            at && at.enclosing ? { enclosing: at.enclosing } : null));
    }, { policy });
    return leaks;
}

/**
 * The gate's three buckets -- see `verify-scrub.js` `main` for what each
 * means. One definition, so the scrubber blunts exactly what the gate would
 * block and nothing it merely advises on.
 */
function classifyFindings(leaks) {
    return {
        gating: leaks.filter((l) => blocks(l) && !isAdvisory(l)),
        advising: leaks.filter((l) => blocks(l) && isAdvisory(l)),
        reported: leaks.filter((l) => !blocks(l)),
    };
}

module.exports = { collectFindings, classifyFindings, isAdvisory };
