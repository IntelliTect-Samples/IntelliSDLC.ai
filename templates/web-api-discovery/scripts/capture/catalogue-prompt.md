# Catalogue a HAR capture

You are cataloguing a browser session that has already been recorded, scrubbed
and verified. Your job is the half a filename cannot carry: **what a human did
to provoke this traffic**, and which endpoints the API revealed along the way.

This file is the single source of truth for the catalogue phase. The recorder
reads it when it shells out to the `claude` CLI, and an agent that drove the
capture itself follows the same steps. Do not restate it elsewhere.

## Inputs

The recorder supplies these paths; read each one fresh.

| Input | What it is |
|---|---|
| `digest.json` | Entries grouped by host / method / path template / status, with timing gaps, content types and payload shapes. **Segment from this, not from the raw HAR** -- a capture runs to hundreds of megabytes. |
| `catalogue.json` | The scaffold: one `Observed` row per group. You promote rows; you do not start from an empty file. |
| The raw capture | Ground truth. Read it only for the entries you have already narrowed to. |
| Operator intent | An optional hint (`-Describe`). It helps you segment. It is **never** the source of an action name. |

## What to produce

### 1. Segment the session into actions

One browse decomposes into discrete actions -- Create Post, Edit Post, Delete
Post -- each a candidate API operation. Use the timing gaps in `digest.json` as
boundary evidence and the method/path/status groups as the content of each
action. A pause is a hint, not a rule: confirm it against what the requests
actually do.

Name each action for **the operation a human performed**, not for the endpoint.
`composer-story-create`, `login-flow-2fa`, `video-upload` -- never `post-v1-posts`.

### 2. Extract one reference HAR per action

For each action you identified, derive a selector and run:

```
node ../har/extract-har-reference.js --in <raw.har> \
    --provider <provider> --action <action>
```

**No selector is needed.** The extractor keeps the API calls and drops the
static assets by itself, from `_resourceType` where the recorder wrote one and
from the request body and response content type where it did not. It is
deliberately conservative about what it drops: documents, redirects and
anything it cannot positively identify as an asset or a beacon are kept.

Every run prints what it did, by category, and kept + dropped always equals the
number of entries scanned:

```
extract-har-reference: wrote example/example-create-post-2026-09-02.har (24 of 412 entries)
  kept     21   API calls (xhr 14, fetch 7)
  kept     3    documents -- HTML, redirects and auth callbacks, kept because they carry tokens (html 3)
  dropped  371  static assets (scripts 155, images 193, fonts 14, css 9)
  dropped  17   telemetry / beacon (beacons 17)
  total    412  entries scanned = 24 kept + 388 dropped
```

**Read that report.** It is how a wrong drop becomes visible now rather than
months from now, when someone is relying on the reference. If a count looks
wrong, `scrubbed.har` is still in the session directory -- re-extract, nothing
is lost.

`--match <pattern>` is available as **optional further narrowing** when an
API-heavy capture still yields too much. It is a case-insensitive regular
expression tested against the request URL and the request/response bodies, and
it narrows *within* the API set -- it can never re-admit an entry the
classification dropped.

The output lands at
`<OutputPath>/<provider>/<provider>-<action>-<yyyy-MM-dd>.har`.

### 3. Update the catalogue row

Promote the rows the action covers from `Observed` to `Exercised`, and fill in:

- `Action` -- the name from step 1.
- `Description` -- what the capture *proves*. The facts a filename cannot
  carry: that a first finalize call returned `400` and succeeded on a
  byte-identical retry; that the capture holds two upload cycles and five
  transcode polls; that two trailing entries are a *failed* edit that
  established a platform limitation.
- `HarFile` -- the reference written in step 2, as a path **relative to
  `catalogue.json`**.
- `Provider` -- the provider from step 2.
- `Related` -- the issue numbers this reference answers, as an array.
- `Methods`, `Endpoints`, `EntryCount`, `RequestBodies`, `RequestBytes`,
  `ResponseBytes` -- **measured against the reference you just wrote**, not
  estimated and not copied from the scaffold. The scaffold leaves them `null`
  because it describes a digest group, not a file.

**These are checked.** `verify-har-catalogue.js` recomputes every one of them
from the `.har` and fails on any disagreement. That is deliberate: it is the
difference between a row a guard can confirm *exists* and a row a guard can
confirm is *true*.

**Promotion is atomic.** Flip `Status` to `Exercised` and correct the measured
fields **in the same edit**. A scaffold row's `EntryCount` and `Endpoints`
describe a digest *group*, not the reference you extracted, so a row promoted
without correcting them fails the guard until you do.

That failure is correct, and the annoyance is the point. The property that
makes it safe is that it is **loud and specific**, not that it is rare: a guard
that failed a half-promoted row is a nuisance, while a guard that passed one
would let a row's claims outlive their evidence silently -- which is the defect
this whole convention exists to remove. If the interruption bothers you, make
the promotion atomic. Do not soften the guard.

**Do not describe request-side behaviour on a reference with no request body.**
Four references once shipped carrying a 29-character placeholder where the
payload belonged, under rows reading "one Only-Me post with two people tagged"
and "email + password, then a two-factor code". They passed the guard of the
day, an independent review and a merge, and a design document then cited one of
them as evidence for facts it cannot provide. If `RequestBodies` is `0` on a
`POST`/`PUT`/`PATCH` reference, you have two honest options:

- re-extract the entries from the preserved raw capture so the bodies are
  really there; or
- correct the `Description` to what the file actually documents ("response
  shape only; request body not preserved").

A third option exists and is **not** a way to make the gate quiet: set
`RequestBodiesAbsent` to a written sentence explaining why the traffic
genuinely carries no body (`POST /logout` does not). It is prose, in the file,
in the diff, and a reviewer will read it.

### 4. Record what was observed but not exercised

Endpoints the capture saw that **nobody drove** are capabilities the API has,
worth knowing even without a worked example. Leave those rows at
`Status: "Observed"` with a `Description` saying what they appear to do and
what would exercise them. Do not delete them, and do not promote them to
`Exercised` -- a row claiming a worked example that does not exist is worse
than no row.

Do **not** hand-write them into `README.md`. They are generated from the same
`catalogue.json` in step 5, under an "Observed, not exercised" heading, so a
reader can tell the two apart without opening the JSON. A hand-written half
beside a generated half is how a README ends up describing a previous capture.

### 5. Render the table

```
node ../har/render-har-catalogue.js --dir <OutputPath>
```

`catalogue.json` is the source of truth; the table in `README.md` is generated
from it, between the `BEGIN GENERATED CATALOGUE` markers. Prose outside those
markers is hand-written and is never touched -- the provenance notes, the
naming convention and the re-capture recipe live there.

### 6. Gate the result -- BOTH gates

```
node ../har/verify-har-reference.js --dir <OutputPath>
node ../har/verify-har-catalogue.js --dir <OutputPath>
```

Neither substitutes for the other. `verify-har-reference.js` is about the
artifact's **safety**. `verify-har-catalogue.js` is about whether the catalogue
tells the **truth** about that artifact: every measured field recomputed from
the file, every reference accounted for in both directions, no row describing
request-side behaviour on a reference with no request body, and a `README.md`
that matches what `catalogue.json` renders to.

The safety gate fails on a truncated request body, an unredacted credential, a
secret nested in a JSON-valued parameter, a forbidden operator literal, a
shape-detected token, or a request body that is present but belongs to no wire
grammar.

**A non-zero exit from either gate means the catalogue is not done.** Fix the
reference or the row and re-run; never hand back a catalogue whose gates did
not pass.

## Rules

- Never commit the raw capture. It carries live session cookies and is
  gitignored. Only the extracted, scrubbed references ship.
- Never invent an action you cannot point at entries for.
- Cataloguing is not clerical work. Doing it properly means re-reading the
  entries rather than the prose about them; that is what surfaces the facts
  nobody wrote down.
