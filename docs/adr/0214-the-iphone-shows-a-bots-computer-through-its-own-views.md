# 0214: The iPhone shows a bot's computer through its own views

Status: Proposed. Date: 2026-11-22. Decided by: the iPhone parity work (#2547, #2553); for the
owner to accept. Builds on [ADR 0142](0142-a-bots-computer.md) and
[ADR 0143](0143-cowork-computer-use.md); changes neither.

## Context

The web draws a bot's computer (Computer on its profile) with its terminal, file manager, live
browser and screen, and who has the computer from the conversation stream's `computer` frames.
The iPhone reaches Spade only through the daemon (ADR 0121) and already has one live terminal
model (`TerminalScreenModel`), one live browser view (`BrowserLiveModel`, ADR 0088) and a
computer-use screen view (`RemoteScreen`), each with native rendering and bounded memory. The
profile sheet sits over the bot's chat, so the person looks at one page of it at a time.

## Options considered

- **New native renderers for the bot's surfaces:** a second terminal emulator, browser video
  path and screen view. Lost: it duplicates the hardest code on the phone and its memory bounds.
- **Reuse the phone's views, fed from the bridge (chosen):** the bot's terminal goes in as the
  phone's own `terminal.output` patches; its browser and screen are the daemon's live views of
  the bot's hidden thread, which the phone already decodes.
- **Who has the computer from the conversation stream's `computer` frames, as on the web:**
  needs `spade-open.ts` to forward side frames and the pages to hold the conversation open.
  Lost for now: a read of `GET …/computer` every 3 s while a Computer page shows gives the same
  guard (input only on a fresh word from Spade) with no change to the chat's stream.

## Decision

1. **The bot's terminal reuses the phone's one terminal model.** `bridge/spade-computer-live.ts`
   follows `/v1/agents/{id}/terminal/live?after=N` and puts its output as `terminal.output` under
   the page's own stream id, addressed by UTF-8 byte offset, resuming after the last `seq`. Output
   is held between flushes, since the patch pump keeps only a key's latest patch.
2. **The bot's browser opens in the phone's one live browser view, on the bot's hidden thread.**
   `openBrowser` takes that thread's id; leaving the page closes it.
3. **The bot's screen is the computer-use session its hidden thread holds,** watched with
   `RemoteScreen`, to watch only.
4. **Who has the computer is read, not streamed:** every 3 s while a Computer page shows with
   the app in front, and right after Take over or Hand back. The person's input goes in only
   while the latest read went, says they may act, no change of hands is on its way and the phone
   is connected.
5. **Every stream stops when its page goes or the app leaves the front.**

## Consequences

- No new renderer; the terminal, browser and screen keep their existing performance gates.
- Only one terminal and one browser show at a time on the phone: opening the bot's replaces any
  other, which the profile sheet over the chat makes moot.
- A change of hands can take up to 3 s to show on the phone when made elsewhere.
- Input on the bot's screen, and starting a service (Spade has no route for it), are not built.

## Tests

`apps/ios/bridge/spade-computer.test.ts` (who may act, take over and hand back, file writes
refused over a changed revision) and `apps/ios/bridge/spade-computer-live.test.ts` (typed
commands reach the shell, resume without repeats, `streams` drops to 0 when the page stops).
