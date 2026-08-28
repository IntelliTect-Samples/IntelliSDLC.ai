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
node ../har/extract-har-reference.js --in <raw.har> --match <pattern> \
    --provider <provider> --action <action>
```

`--match` is a case-insensitive regular expression tested against the request
URL and the request/response bodies. It is required and there is no
"extract everything" default: supplying the judgement is the whole point of
this phase. The output lands at
`<OutputPath>/<provider>/<provider>-<action>-<yyyy-MM-dd>.har`.

### 3. Update the catalogue row

Promote the rows the action covers from `Observed` to `Exercised`, and fill in:

- `Action` -- the name from step 1.
- `Description` -- what the capture *proves*. The facts a filename cannot
  carry: that a first finalize call returned `400` and succeeded on a
  byte-identical retry; that the capture holds two upload cycles and five
  transcode polls; that two trailing entries are a *failed* edit that
  established a platform limitation.
- `HarFile` -- the reference written in step 2.
- `Methods`, `Endpoints`, `EntryCount` -- corrected against what you extracted.

### 4. Record what was observed but not exercised

Endpoints the capture saw that **nobody drove** are capabilities the API has,
worth knowing even without a worked example. Leave those rows at
`Status: "Observed"` with a `Description` saying what they appear to do and
what would exercise them. Do not delete them, and do not promote them to
`Exercised` -- a row claiming a worked example that does not exist is worse
than no row.

Mirror them into the provider's `README.md` under a separate
**"Observed, not exercised"** heading, so a reader can tell the two apart
without opening the JSON.

### 5. Gate the result

```
node ../har/verify-har-reference.js --dir <OutputPath>
```

This is the gate, not a formality. It fails on a truncated request body, an
unredacted credential, a secret nested in a JSON-valued parameter, a forbidden
operator literal, or a shape-detected token. **A non-zero exit means the
catalogue is not done.** Fix the reference and re-run; never hand back a
catalogue whose gate did not pass.

## Rules

- Never commit the raw capture. It carries live session cookies and is
  gitignored. Only the extracted, scrubbed references ship.
- Never invent an action you cannot point at entries for.
- Cataloguing is not clerical work. Doing it properly means re-reading the
  entries rather than the prose about them; that is what surfaces the facts
  nobody wrote down.
