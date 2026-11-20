# 0193: The daemon owns a browser engine move

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
3. **A failed open undoes the move.** When the new engine won't open, the thread's previous
   engine is written back (the engine the browser was on when settings can't be read), the
   browser opens there with its pages, and the request fails with the reason.
4. **The setting is written as a person's write would be.** The daemon writes the thread layer's
   `browser.backend` and asks the same refusal as a settings write (ADR 0190), so an agent's
   device can't move engines.

## Consequences

- Web and the iPhone make one request; their move code shrank to reading its result.
- A client newer than its daemon gets the older daemon's refusal of an unknown request and shows
  that the engine couldn't switch; there is no client-side fallback.
- Only moves are serialized: an agent opening or closing the thread's browser mid-move is not
  held off, as before.

## Tests

- `packages/browser/src/engine-move.process.test.ts`: two devices moving at once end with one
  browser on the engine and its page loaded once; a failed open leaves engine, setting and page.
- `apps/daemon/src/browser-engine-move.server.process.test.ts`: the same through the daemon's
  socket with real settings.
