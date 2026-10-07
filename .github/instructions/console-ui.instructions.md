---
description: 'Console UI conventions: progress and live status in a terminal'
applyTo: '**/*.cs,**/*.ps1,**/*.psm1,**/*.ts,**/*.js,**/*.py,**/*.go,**/*.rs,**/*.java'
---

# Console UI Conventions

> Applies to any code that writes interactive status to a terminal: progress
> for a batch of items, spinners, pickers, live counters. Language-neutral.

## Progress and live status

1. **One line per item.** While an item is in progress, update its own line
   in place. Never append a new line per update, and never print the same
   item twice. When the item finishes it leaves exactly one final line --
   done, or failed with a one-line reason.
2. **Move relative to the cursor, never to absolute rows.** Update with
   carriage return (`\r`), cursor-up (`ESC[nA`) and clear-to-end-of-line
   (`ESC[K`). Do not position the cursor at absolute buffer rows: in many
   terminals the buffer is only the visible window and the cursor is already
   near its bottom, so absolute rows do not fit -- and code that falls back
   when they do not fit silently reverts to printing a new line per update.
3. **Keep the live region at the bottom and small.** At most the current
   item's line plus one summary row (counts, time left). Finished items
   scroll up above it as ordinary lines.
4. **Never let a line wrap.** Truncate every line to the terminal width
   minus one. A wrapped line occupies two rows and breaks every cursor-up
   that follows.
5. **Close the live region before anything else prints** -- end it with a
   newline so the next output starts on its own line. Close it on every exit
   path, including failure and cancellation (use `finally`), and ignore
   updates that arrive after it was closed.
6. **Redirected output is a different mode.** When the output is not a
   terminal (a file, a pipe, a CI log), emit no cursor movement and no escape
   sequences: print each item's final line once, and at most an occasional
   plain progress line (e.g. every 30 s) for long-running items. Decide the
   mode from whether the stream is redirected, not from whether a layout fits.
7. **Updates may come from other threads** (timers, progress callbacks).
   Serialize every write through one lock, and drop an update for an item
   that has already finished -- a late tick must never overwrite a result.
8. **Narration must never break the work.** A failure while rendering
   progress is caught and ignored; it must not fail or slow the operation it
   reports on.

## Testing

- Inject the writer, the width, and whether the output is interactive, so
  both modes are testable without a real console.
- Test against a **fake screen** that applies `\r`, `\n`, `ESC[nA` and
  `ESC[K` and keeps what each row finally shows. Assert on the rows -- one row
  per item, the summary row below, the next output on its own row -- not on
  the raw text written, which passes even when the terminal would show a mess.
- Cover: many updates for one item, a retry, a failure, a result with no
  prior progress, closing the region, and an update after closing.
