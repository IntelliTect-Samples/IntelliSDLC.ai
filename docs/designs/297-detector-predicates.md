# When a detector stands in for a concept

- **Issue:** [#297](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/297)
- **Status:** a record of a moment, **closed on the day #297's stages landed**.
  Do not append to it. The rules are summarised as imperatives in
  `.github/skills/web-api-discovery/SKILL.md` (Phase 3); this file carries the
  argument and the measurements behind them.
- **It describes the subsystem as of this commit, not necessarily as of the day
  you are reading it.** #297 closed with follow-on work still open — the scrub's
  `classes` consumption — as of this commit `pii.js` does not reference
  `policy.classes` at all, so gate/advise/off govern the gate and not the scrub
  — the `identifierFields` alignment, query-string coverage, and unquoted JSON
  numbers. Some of what is described below as a defect
  is fixed by now, and the descriptions are kept as they were because the point
  is the *shape* of each failure, not its current status. Check the code before
  concluding anything here is still true of it.
- **Where a later finding goes.** If it changes what an agent should DO, the
  imperative goes in `SKILL.md` and the evidence goes in *that* issue's design
  doc. If it is another instance of an imperative already here, nothing changes
  — record the measurement on the issue where it was found and move on. Linking
  to this file is correct; appending to it is not. An append-only defect log has
  no reader: nobody opens five hundred lines of past bugs to learn how to write
  a detector.
- **Why it is here and not in SKILL.md:** SKILL.md is operational and read as
  current instruction. The measurements below are what make these rules
  survive disagreement, and they are also what will date them -- a stale
  worked example in an instruction file invites somebody to go hunting a
  defect that no longer exists. A design doc is allowed to be a record of a
  moment.

Every defect cited here shipped. None is hypothetical.

Every control in this pipeline is a **predicate approximating a concept**:
"Luhn-valid 13-19 digit run" for *credit card*, "six hex pairs" for *MAC
address*, "key ends in `city`" for *this field holds a person's city*. The
approximations are unavoidable. What follows is what to do about them, and it is
written from defects that shipped rather than from principle.

**1. A predicate is not the concept it approximates.**

Roughly one digit run in ten is Luhn-valid by chance, so 1413 trip ids were
reported as leaked cards. `sort_city: "asc"` was rewritten to
`sort_city: "Ashendell"` because the key ends in `city`. A twenty-byte TLS
certificate thumbprint was carved into three "MAC addresses" because it is made
of hex pairs. `aws_region`, `locale_country`, `backup_zip`, `account_birthday`,
`ecliptic_latitude`, `isMobile` — each is a real field name that a tail-matching
rule claimed.

Say the concept out loud, then check whether the predicate is it. "Six hex
pairs" is not "a MAC address" when more pairs follow.

**2. The danger scales with what the predicate DRIVES.**

The same loose predicate behind a **report** produces noise — visible, and
self-correcting because somebody eventually reads it. Behind a **replace** it
produces plausible-looking corruption — invisible, permanent, and indetectable
after the fact.

This is the asymmetry that decides how much rigour a detector deserves. Every
serious defect found in this subsystem was on a replace path. A scrubber
rewriting a provider object id into a fake card number is worse than a gate
crying wolf about it, even though the gate is noisier.

Corollary: when a predicate is uncertain, **fail toward a miss on a replace path
and toward a report on a gate path**. An allowlist of qualifiers fails toward
missing a field; a denylist fails toward corrupting one.

**3. The check that clears a predicate is itself a predicate.**

This is the one that is easiest to miss, because it feels like verification
rather than another guess.

- **The fix is a predicate.** Anchoring a MAC pattern with a hex-character
  lookbehind fixed the carving and silently broke `device:AA:BB:...`, because
  `a`–`f` are ordinary letters and two characters of context cannot tell the end
  of an English word from the second digit of a hex pair. A corruption was
  traded for a silent miss and called a fix.
- **The test is a predicate.** A curated list of field names is a claim about
  which names matter. Three review rounds each found a name the list had not
  imagined.
- **The generator behind the test is a predicate.** A randomised differential
  reported zero divergences because its generator produced *nested* overlaps and
  never *staggered* ones. "Zero in that direction" meant "zero of the shapes I
  thought to generate."
- **A signature is not reachability.** A test asserting
  `typeof fieldTypeFor === 'function'` — with the message *"so a project cannot
  extend it"* — passed while nothing in the codebase ever passed it a policy.
  The capability existed; the feature was inert.

Prefer a **property** over a list where one exists: *detected as a MAC iff the
run is exactly six pairs*, checked over generated inputs, catches what a case
list cannot. And **verify the check bites** — ablate the fix and watch the test
fail — because a test that cannot fail certifies nothing.

**4. Fixing a third member of the same set means the set is the wrong unit of
work.**

Three rounds each found the same defect in a different member of the
`qualifiers: "any"` set — first `region`/`country`/`zip`, then
`city`/`town`/`locality`, then `dob`/`geo`/`phone`/`device-id`. Every round
fixed the members it had been shown.

The signal that a category is the wrong unit of work is having narrowed it
twice. The fourth round did not fix two more members; it removed the setting
from the shipped default and added a test asserting its absence. The same
happened independently with `identifierFields` — three rounds probing arbitrary
regex, then restricting the language so the dangerous input could not be
expressed. **Detection replaced by restriction**, both times only after the
third round.

**5. A predicate has two halves, and unifying one moves the divergence.**

A detector is a **pattern** that finds candidates and a **check** that validates
them. When two engines share a definition, they must share both.

The gate and the scrubber were aligned on the card *check* — issuer identifier
plus Luhn — while the scrubber kept its own *pattern*, missing the decimal
lookarounds. So `{"price":"4000000000006.45"}` was rewritten to
`{"price":"4242510090045384.45"}`, and the gate passed it clean because the gate
never saw a card there.

Measured two ways, and the second is the one that matters. **488 of 3,812 card
detections (12.8%) were embedded in decimal numbers**, almost all
Unix-millisecond timestamps — but that counts *distinct values*, and a distinct
count understates the damage because each of those values also appeared bare
elsewhere. Counting what a capture actually loses, the fix removed **560 of 850
rewrite sites**.

Prefer the site count when reporting a scrub defect. Distinct values measure how
many things were wrong; sites measure how much of the artifact was rewritten.

The same shape appeared in the redaction sentinels: the "already redacted"
*check* was unified between the verifiers while the fake *markers* stayed
divergent. Consume the whole slot, not the half you were looking at.

**6. A widening change lands after the narrowing change that constrains it.**

Some changes make a detector **see more**; others narrow **what it does with
what it sees**. Order them, and the order is not the order the issues were
filed in.

`#344` widens the scrubber to unquoted JSON numbers, which are currently
invisible to it. The `identifierFields` alignment narrows it, so a card-shaped
value at a declared identifier field stops being replaced. Landing `#344` first
would put a newly-visible population on the replace path with nothing
suppressing the false positives among them — which is the 20-of-22 object-id
corruption, applied to a fresh node class. `#330` (query-string values, dense
with `sort_`, `filter_` and `order_by_` parameters) has the same shape.

This composes with beat 2. Widening a **report** path is cheap: more noise,
visible, reversible. Widening a **replace** path before its constraint exists is
how silent corruption arrives, and it arrives at the scale of whatever
population you just made visible.

The rule in practice: before landing a change that makes a detector see more,
ask what limits what it does with what it sees, and land that first.

**7. A fix's effect is what remains after it, not what it removed.**

`#295` tightened the card predicate and the finding count fell from 2,841 to
176 — a 12-capture cross-provider run. (That is a different measurement from
the 1134-findings-3-real figure in beat 1, which is the original consumer-tree
count from the root-cause analysis. The two are not reconcilable and should not
be read as a before-and-after of the same population.)

The 2,841 → 176 result was reported as the fix working. It was measured on the
**gate**; the scrubber's own predicate was never in the measurement, and it kept
rewriting provider ids at the original rate. The false positives did not stop — they
stopped being *visible*, which is worse, because a blocked capture announces
itself and a silently corrupted reference does not.

Later, aligning the scrubber left **859 values still passing the tightened
predicate**, so the fix delivered roughly 83% rather than elimination.

Measure the residue, not the delta. And when you tighten a predicate, **check
every engine holding a copy of it**.
