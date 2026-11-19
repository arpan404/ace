# 0143: Cowork: the person and agents share computer use

Status: Accepted. Date: 2026-11-13. Decided by: the owner (2026-11-13: "ai agent and human can
cowork instead of one at a time"; the agent yields to the person; all ace computer use). Amends [ADR 0142](0142-a-bots-computer.md) (a bot's computer)
and the controller rules of [ADR 0067](0067-background-computer-use.md) and
[ADR 0087](0087-background-computer-use-engine.md) where human input takes control, plus
the collaboration rules of [ADR 0067](0067-browser-parity.md). Builds on
[ADR 0011](0011-screen-and-computer-use.md), [ADR 0064](0064-in-app-devices.md),
[ADR 0087](0087-background-computer-use-engine.md) and [ADR 0104](0104-browser-tab-ownership.md).

## Context

ace's browser already let the person and agents share a tab: an agent's page input waited while
the person typed (ADR 0067). The screen and the simulators still worked one at a time. To use an
app or a device an agent held, the person took its controls, and the agent was refused until they
gave them back. A Spade bot's computer (ADR 0142) worked the same way: take over, then hand back.

The owner wants the person and the agent to work at once, with one rule for every surface: when
both act on the same thing, the agent yields to the person.

## Options considered

- Keep one driver at a time. Simple fencing, but helping in one app stops useful work elsewhere.
- Allow simultaneous input without priority. Fast, but the agent can interrupt the person's work.
- Default to cowork with a person lease per surface. The person comes first locally, and explicit take-over remains available.

## Decision

### Two modes

1. **Every computer-use surface is shared (`cowork`) unless the person takes it (`exclusive`).**
   The surfaces are a browser tab, a screen app (its sessions and windows) and a simulator or
   emulator. They apply to every agent thread and to Spade's bots alike. `exclusive` is today's
   explicit Take control (`controller: "human"` on a screen session or a device) and a Spade
   take-over (`driver: "person"`). Everything exclusive did before still holds: agents are
   refused there, as before (`lease_required`, `person_driving`, controller ownership).
2. **In cowork the person's input never needs the controls.** Their input through ace (the
   browser view, the screen live view, a device view) goes in while an agent holds the session or
   device, or nobody does. It never flips the controller and never stops the agent. It only
   extends the person's lease on that surface.

### The person's lease

3. **One lease per surface, 3 s after the person's last input there** (`personQuietMs` in
   `@ace/interaction/presence`, the same constant for every surface). Surfaces are keyed
   `tab` (per tab, in the browser), `app:<bundle id>` (the screen, per app; the process name off
   macOS) and `device:<id>`.
4. **What counts as the person's input.** Everything routed through ace: browser view input, the
   desktop's native browser view (`ace.humanInput`), screen live-view input and `ui.act`, and
   device-view input. On a Mac the person's own keyboard and mouse count too, for the app that is
   frontmost while they type. ace reads the time since the last HID event (`HIDIdleTime` from
   `ioreg -c IOHIDSystem`, the same counter `CGEventSourceSecondsSinceLastEventType` reads). That
   needs no permission. It is read only when an agent is about to act and when a lease would
   lapse, never on a timer, and the frontmost app is asked for only after recent input.
   Windows samples `GetLastInputInfo` through its native helper and attributes recent input to
   the frontmost app. Linux counts only ace-routed input; it has no idle source that works on
   every desktop.

### Agents yield

5. **An agent's action waits while the person's lease on the same surface is active, at most a
   minute** (`personWaitMs`, 60 s). Actions are page input in the browser (click, type, press,
   scroll, drag, hover, select, check, focus, fill_form, upload, navigate, history), every
   `screen_act` batch except one of only `wait`, `wait_for` and `if` steps, and every simulator
   input and `ui.act`. The wait is event-driven: it sleeps until the lease would lapse, looks
   again (on a Mac, at the HID idle time too), and runs or keeps waiting.
6. **Reads never wait.** Snapshots, screenshots, outlines, page text, `screen_state`,
   `sim_screenshot` and `sim_ui` run at once.
7. **Another surface never waits.** A different tab, another app, another device.
8. **An action already running finishes.** Only later actions wait. A browser drag still lets go
   mid-way if the person comes back (ADR 0067), now with `person_busy`.
9. **After a minute the action is not run** and fails with the public error `person_busy`:
   "The person is using this right now; nothing was done", with the hint "try again shortly, or
   work in another tab or app meanwhile". The browser's former `human_active` is now
   `person_busy`, and its wait went from 10 s to 60 s, with a quiet window of 3 s instead of 1.5 s.
10. **A waited action says so.** Its result carries one line, "Waited 4 s while the person used
    this tab." (or the app's or device's name): browser results as `waited`, a `screen_act` log as
    its first line, a `sim_act` result as `waited`. Waits under half a second say nothing.

### What viewers see

11. **Streams carry the agent's pointer and the person's lease** (`packages/protocol/src/cowork.ts`):
    - `AgentPointer {x, y, kind: move|click|drag|scroll|type, at}` in the stream's own
      coordinates: CSS viewport pixels for a tab (`BrowserTab.agentPointer`; the older `pointer`
      stays), the app's screenshot pixels for a screen session (`ScreenState.agentPointer`),
      device points for a device (`DeviceState.agentPointer`, from the agent's activity). A
      screen step aimed at an outline id has no point, so the pointer stays where it was.
    - `personActive: true` while the person's lease on that surface runs (tab, screen session,
      device). Viewers hear it start and lapse.
    - `sharing: "cowork" | "exclusive"` on `ScreenState` and `DeviceState` (exclusive while a
      person holds `controller: "human"`). Tabs have no `sharing`: a tab is always cowork, and
      a Spade bot's exclusive comes from its computer's `mode`.

### Spade's bots (amends ADR 0142)

12. **Cowork is a bot's default; a take-over is exclusive.** `spade.computer.get` reports
    `mode` (`cowork`, or `exclusive` while the person drives), `browser.tabs[].personActive` and
    `screen.personActive`. `spade.computer.drive` takes `mode` (`exclusive` takes over, `cowork`
    hands back) beside `driver`, which is now optional; `mode` wins when both are sent, and the
    result names it. The surface reports the daemon sends Spade (`PUT
/v1/agents/{id}/computer/surfaces/{kind}`) gain `mode` and `person_active`. Per-bot
    attribution (`_meta` `ace/acting-for`) is unchanged.
13. **Spade's side** (PR #1917):
    - Take-over and hand-back stay the only switch. The mode is exclusive exactly while Spade's
      take-over record (`<data>/computer/<bot>.json`) exists, so it survives restarts and cowork
      stores nothing. Spade sends both `driver` and `mode`, so older daemons still work. A bot
      never taken over is never sent a drive.
    - Spade reads `person_active` from reports (it overrides Spade's own 10 s window for the
      browser and screen) and `person_acted`. A browser report with `person_acted` counts its
      address as one the person was on. A report's `mode` is ignored: Spade's record is the truth.
    - The model gets `person_busy` as a not-run result, not an error: the person comes first,
      work on something else, don't retry straight away. `person_driving` is unchanged.
    - The terminal is shared too: the person types into their shell without a take-over. Bot
      commands still run as separate processes with stdin from `/dev/null`. In exclusive mode
      the person's input is refused (`409`) while a bot command is stopping, as before.
    - Files are shared: `GET` of a workspace file gains `revision` (`sha256:<hex>`); writes,
      uploads, moves and deletes take an optional `base`, and a file whose revision differs or
      is gone answers `409 changed` with its current revision. Without `base` the write goes
      ahead. Exclusive mode adds the old stopping check.
    - The person's file routes and the bot's file tools check, change and record under one lock
      per workspace, so when both go for the same file at once exactly one wins and the other
      gets `409 changed` or a not-run result. Terminal commands, the bot's and the person's
      alike, are other processes and can't take that lock: one can change a file between the
      person's revision check and their write, and nothing a command does is yielded.
    - A bot's `workspace_write` or edit of a file the person changed through the app in the last
      30 s is not run (a not-run result). The window keys on the file's identity, not its path
      string: links in folders are followed, names compare without case on volumes that ignore
      case, and device and inode match where the file exists, so a file deleted and made again
      still matches. It is kept in `<data>/computer/recent/<bot>.json` and survives a restart.
      The bot's shell commands aren't checked.
    - In cowork Spade gathers what the person did (the surfaces used, the terminal as "typed"
      but never what was typed, files changed through the app, up to 10 browser addresses) and
      stores a `person_activity {text, data}` event before a model step, never mid-call, at most once a
      minute per bot. It opens no reply. The model reads it as `<person_activity from="spade">`
      with its data separated as `<activity_data untrusted="true">`, like hand-back data. It is kept in memory only, so a restart
      drops a summary not yet offered. Bots on CLI brains get it (and the hand-back note) once,
      in their next turn's message. Nothing is gathered in exclusive mode; the hand-back note
      works as before.

### Where it lives

14. **Pure core, thin shells.** `@ace/interaction/presence` holds the lease and the wait
    (`presenceStep`, `PersonPresence`) with an injected clock and timers. The browser's lane
    (`collaboration.ts`, `agent-input-lane.ts`) uses its step and constants. `@ace/screen`'s
    `ScreenCowork` keys it by app for both the agent tools (`screen_act`) and the
    `ScreenManager`'s live view; `macPhysicalInput` reads the Mac's idle time.
    `@ace/devices`' `DeviceCowork` keys it by device, behind `DevicesOptions.cowork`. The
    daemon builds one `ScreenCowork` for the machine and turns cowork on for devices.

## Consequences

- The person never has to take anything over to help an agent: they type, click or tap, and
  the agent waits its turn. An agent that keeps meeting the person gets `person_busy` after a
  minute, having done nothing, and can work elsewhere.
- An agent's next action can now be up to a minute late in a busy tab, app or device, where the
  browser used to give up after 10 s.
- A Mac's own keyboard and mouse hold back an agent only in the frontmost app. Input into a
  window behind it counts only through ace. Windows also samples native session idle time;
  Linux counts physical input only when ace routes it.
- The screen's pointer has a point only for steps aimed at screenshot pixels. Steps aimed at an
  outline id leave it where it was, because the helper doesn't report where they landed.
- The legacy session tools (`screen_input` and friends, used where the background engine isn't)
  wait for the person too and attach wait notes to object results.
- Rejected: stopping the agent's in-flight action on the person's input. Input already sent
  can't be recalled, and the agent's next action waits anyway (as in ADR 0067).
- Rejected: a per-surface lock the agent takes and the person must ask for. That is the
  take-over the owner asked to replace; it stays only as the explicit exclusive mode.

## Tests

- `packages/interaction/src/presence.test.ts`: renewed leases, independent surfaces, expiry, physical samples, cancellation and the 60-second budget.
- Browser process tests: action priority, reads bypass waiting actions, not-run timeout, waited results, and pointer/person state.
- Screen physical-input, toolkit and manager tests: native idle decoding, foreground attribution, reads, waits, controller fencing and dispatch-time lease checks.
- Device cowork tests: human input without controller transfer, queue rechecks, retained controller tickets, exclusive takeover, read bypass and not-run timeout.
- Daemon Spade computer tests: modes, take-over compatibility and native-app person activity in reads and reports.
- Spade PR #1917 covers terminal cowork, stale base revisions changing nothing, the shared workspace lock, persisted file-identity yielding, trusted summaries with untrusted data, rate limits and `person_busy` as not-run. Those Rust tests belong to that PR.
