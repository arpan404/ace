# 0194: The daemon owns a browser engine move

Status: accepted. Date: 2026-11-19. Proposed in issue #2013. Builds on
[ADR 0055](0055-browser-backends.md) and [ADR 0069](0069-shared-native-browser.md); the engine
choice itself is unchanged.

## Context

"Engine for this thread" moves a thread's browser between the desktop app (`embedded`) and ace's
Chrome (`headless`). Until now each client made the move itself, in `@ace/client`'s
`browser-engine.ts` (web since #2008, then the iPhone): write the thread's `browser.backend`,
snapshot the open tabs, close the browser, open it again and load every page. Each step was a
separate request, so two devices switching the same thread at once could close a browser the
other was restoring, or load its pages twice (#2013, found in the Codex review of #2008).

## Options considered

- **Keep the move in clients and add a lock request.** A lock held by a client needs a lease
  and expiry for clients that drop mid-move, and every step still crosses the network.
- **Refuse a second move while one runs.** Simple, but the person on the second device sees a
  failure for a move that the first one completes.
- **One daemon request that runs the whole move, queued per thread (chosen).** The daemon
  already owns the sessions and the setting; a queued second move finds the browser already on
  its engine and leaves it alone, so both devices see success and the pages load once.

## Decision

1. **`browser.engine.move` moves a thread's browser.** A person's client sends `threadId`,
   `workspaceId` and `engine`; the reply's result is `BrowserEngineMoved`: the browser's state on
   the new engine (absent when the thread had no browser open, which only keeps the choice) and
   the pages that didn't load there. Clients no longer write the setting or close and reopen the
   browser to move it.
2. **Moves of one thread run one at a time.** `BrowserService.moveEngine` queues per thread; a
   move that finds the browser already on its engine only keeps the setting.
3. **The move commits only once the browser opened on the new engine.** The daemon first
   records the tabs it carries in a move journal of its own (`browser_engine_moves`), then
   closes the browser as a shutdown does and opens it on the new engine with those tabs (same
   ids, private tabs still private, the shown tab shown). Only then does it write the thread's
   `browser.backend`, and only after that write does the journal entry go. The new engine's
   session may already have saved a shorter list to the tab store (an engine that restored
   fewer tabs), so a daemon that stops anywhere before the write reopens the journal's tabs on
   the engine the setting still names, then drops the entry.
4. **A failed open leaves the browser where it was.** When the new engine won't open, the tabs
   open again on the engine the browser was on and the request fails with the reason; the
   setting was never changed. If writing the setting fails after the move, the browser goes
   back too.
5. **The setting is written as a person's write would be.** The daemon writes the thread layer's
   `browser.backend` and asks the same refusal as a settings write (ADR 0190), so an agent's
   device can't move engines.
6. **A client keeps working with an older daemon.** Phones and desktops update at different
   times. When the daemon answers `browser.engine.move` with `unsupported`, `@ace/client` makes
   the move itself as before (`browser-engine-here.ts`): keep the setting, snapshot, close,
   reopen and load the pages, or only keep the setting when the client sees no browser open.

## Consequences

- Web and the iPhone make one request against a current daemon.
- The client-side steps stay, for older daemons only. With such a daemon two devices switching
  at once can still step on each other; the fallback goes once older daemons no longer connect.
- A move rides the restart restore path, so every tab comes back, not only web pages; a tab that
  doesn't is named in the reply's `failed`.
- Only moves are serialized: an agent opening or closing the thread's browser mid-move is not
  held off, as before.

## Tests

- `packages/browser/src/engine-move.process.test.ts`: two devices moving at once end with one
  browser on the engine and its page loaded once; a failed open brings every tab back with the
  shown and private ones as they were; a daemon that stops mid-move, or after the new engine
  saved fewer tabs but before the setting, reopens every tab on the old engine; a move queued
  behind a failed one still moves.
- `apps/daemon/src/browser-engine-moves.test.ts`: the journal's tabs outlive the daemon until
  the move settles.
- `apps/daemon/src/browser-engine-move.server.process.test.ts`: the same through the daemon's
  socket with real settings.
- `packages/client/src/browser-engine-here.test.ts`: against a daemon that answers
  `unsupported`, the client makes the move itself.
