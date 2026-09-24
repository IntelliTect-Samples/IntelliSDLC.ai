# 511 -- Zero refused captures: blunt what the scrub cannot clean

- **Issue:** [#511](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/511)
- **Completes:** the blunting fallback [#454](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/454) deferred
- **Unblocked by:** [#456](https://github.com/IntelliTect-Samples/IntelliSDLC.ai/issues/456) (an importable gate)

## Measured first

The issue's count (9 of 30 Instagram captures refused, 2026-09-14) was re-measured
on 2026-09-23 against `main` before any code was written. After #475, #487, #528
and #529, Instagram stood at **19 clean, 8 kept with advisories, 3 refused**. All
three refusals were the same shape: a 32-hex run inside a script-loader array
(`jsmods.require[n][0]`), visible **only once a JSON escape (`/`) is
decoded**. On the wire, the escape and the hex run form one longer hex run that no
pattern matches, so the scrub never saw the value. The gate's structural pass
parses the string and does see it.

## Design

1. **The gate's question, importable.** `har-gate.js` holds `collectFindings` and
   `classifyFindings`. `verify-scrub.js` re-exports both, and its CLI behaviour is
   unchanged. The scrubber asks this same question rather than keeping a copy of
   it.
2. **`har-blunt.js`, per entry and stateless.** `bluntEntry(entry, index,
   {policy, salt})` blunts **gating findings only**. It escalates in three
   steps:
   - a raw-text replacement at every occurrence of the value;
   - a JSON-string-token rewrite, for a value hidden behind an escape;
   - a whole-containing-value blunt, only when neither of the first two can
     reach the value (for example, it is visible only once percent-decoded).

   It re-asks the gate after each step. `bluntHar` is only the loop plus the
   record. Because no state crosses entries, a streamed scrub (#539) can drive it.
3. **Sentinel** `<BLUNTED:kind:tag>`. The tag is an HMAC over the value, spelled
   in the letters a-p, so it can never complete a hex run, a card, a phone number,
   an SSN or an IBAN. `<...>` is what the named-credential check already reads as
   redacted. The same value always gets the same sentinel, so two requests
   carrying one token still read that way.
4. **Record** `log._blunted` in the artifact. For each blunted value it holds the
   kind, entry, key path, mode, occurrence count, bytes, a **salted** fingerprint
   and a debt issue; plus the policy version. It never holds a value or the gate's
   unsalted fingerprint. A re-scrub replaces the record rather than appending to
   it.
5. **Reporting.** The scrub prints one stable stdout line, `sanitize-har: blunted:
   N value(s), M byte(s)`, following the `subs-table:` contract. Stderr lists each
   kind with its debt issue, plus the gate's own description of what it would
   have blocked, including the unsalted fingerprint so a false positive can still
   be **waived**.
   - The store batch reports `BLUNTED ...` per capture, then a `Scrub verdicts: a
     clean, b blunted, c kept with advisories, d refused` line.
   - The recorder's summary says `verified; BLUNTED ...`.
6. **Refusal remains only for the unattributable.** A gating finding with no entry
   cannot be blunted. The file is still written, the unchanged gate refuses it,
   and the scrub says that is a defect to file.

### Not done here

- **Forbidden literals** (the operator profile's own identifiers) are outside
  blunting. The scrub's literal pass replaces them after blunting, over the
  serialized text. A literal that survives that pass is still refused by the
  gate, as it was before.

- **The hex32 rule itself.** These hashes are probably not secrets, but deciding
  that belongs to #297's policy model (a waiver or a `notSecret` rule), not to one
  more shape exception. Blunting is the floor. The debt column names #408.
- **#459's general provenance record.** `log._blunted` is the scrub stage's first
  entry in it. #459 should absorb the shape rather than add a second one.
- **The Facebook store** was not re-measured end to end. The machine ran out of
  memory at 6 of 52 captures (see the PR).

## Acceptance evidence

| Capture | Before (gate) | After (gate) | Blunted |
|---|---|---|---|
| instagram 2026-08-28-024231 | exit 3, hex32 x3 | exit 0 | 3 values, 96 bytes |
| instagram 2026-08-28-024604 | exit 3, hex32 x3 | exit 0 | 3 values, 96 bytes |
| instagram 2026-08-28-102640 | exit 3, hex32 x4 | exit 0 | 4 values, 160 bytes |
| instagram 2026-08-28-103611 (clean) | exit 0 | exit 0, byte-identical | -- |
| instagram 2026-08-28-103209 (advisory) | exit 4 | exit 4, byte-identical | -- |

## Checklist

- [x] Re-measure the store before building (the issue's own falsifier)
- [x] `har-gate.js`: gate classification importable; `verify-scrub.js` re-exports it
- [x] `har-blunt.js` + 14 unit tests, with 5 ablations each confirmed to fail a test
- [x] Scrubber wiring + end-to-end test through the real `sanitize-har` and `verify-scrub` commands
- [x] Store batch: `BLUNTED` reason and `Scrub verdicts` line (Pester, real gate)
- [x] Recorder summary says blunted (capture-quarantine tests)
- [x] Real refused captures re-scrubbed: 3 of 3 now pass the gate
