---
description: 'Console UI conventions: progress and live status in a terminal'
applyTo: '**/*.cs,**/*.fs,**/*.ps1,**/*.psm1,**/*.sh,**/*.ts,**/*.js,**/*.py,**/*.go,**/*.rs,**/*.java,**/*.kt'
---

# Console UI Conventions

> Applies to any code that writes interactive status to a terminal: progress
> for a batch of items, spinners, pickers, live counters. Language-neutral.

## Choosing the mode

- **Interactive** means all of: the stream you write the status to is a
  terminal (not redirected), `TERM` is set and is not `dumb` (on Unix), and
  the console interprets VT sequences (on Windows, `ENABLE_VIRTUAL_TERMINAL_PROCESSING`
  is on -- most modern runtimes and Windows Terminal enable it; if you cannot
  confirm it, use the plain mode).
- **Check the stream you actually write to.** Status and progress belong on
  stderr so stdout stays clean for data; then decide the mode from stderr.
  `cmd > out.txt` still has an interactive stderr; `cmd 2> log` does not.
- **Never decide the mode from whether a layout fits** (see rule 2).
- `NO_COLOR` governs colour only: emit no SGR colour codes when it is set or
  the stream is not interactive. It does not select the plain mode.

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
   Cursor-up cannot move above the top of the window, so the live region must
   always be shorter than the terminal is tall.
3. **Keep the live region at the bottom and small.** For a sequential batch:
   the current item's line plus at most one summary row (counts, time left).
   For concurrent work: one row per active worker plus the summary row,
   capped below the terminal height. Finished items scroll up above it as
   ordinary lines.
4. **Never let a line wrap.** Truncate every line to the terminal width minus
   one, measured in display cells (wide East-Asian characters and most emoji
   take two cells), not string length. Re-read the width on every render --
   the window can be resized. If the width is unknown or tiny (under about
   20 columns), use the plain mode. A wrapped line occupies two rows and
   breaks every cursor-up that follows.
5. **Close the live region before anything else prints** -- end it with a
   newline so the next output starts on its own line. Close it on every exit
   path: success, failure, and cancellation (a `finally`, and a Ctrl+C /
   signal handler that runs the same close). Ignore updates that arrive after
   it was closed. If you hide the cursor (`ESC[?25l`), show it again
   (`ESC[?25h`) on that same close path -- a cursor left hidden after Ctrl+C
   is the classic bug.
6. **Plain mode for everything that is not interactive** (a file, a pipe, a
   CI log, `TERM=dumb`): emit no escape sequences at all. Print each item's
   final line once, and at most an occasional plain progress line (for
   example every 30 s) for a long-running item.
7. **One writer at a time.** Updates may come from other threads (timers,
   progress callbacks): serialize every write to the stream through one lock,
   and drop an update for an item that has already finished -- a late tick
   must never overwrite a result. Anything else that writes to the same
   stream while the region is open (logging, warnings) must go through the
   same lock or close the region first, or it lands in the middle of it.
8. **Narration must never break the work.** A failure while rendering
   progress is caught and ignored; it must not fail or slow the operation it
   reports on.

## Testing

- Inject the writer, the width, and whether the output is interactive, so
  both modes are testable without a real console.
- Test against a **fake screen** that applies `\r`, `\n`, `ESC[nA` and
  `ESC[K`, wraps at the injected width, clamps cursor-up at the top row, and
  keeps what each row finally shows. Assert on the rows -- one row per item,
  the summary row below, the next output on its own row -- not on the raw
  text written, which passes even when the terminal would show a mess.
- Cover: many updates for one item, a retry, a failure, a result with no
  prior progress, a line longer than the width, closing the region, an
  update after closing, and plain mode writing zero escape bytes.
