# 0087: A background computer-use engine for agents on macOS

Date: 2026-10-18. Status: accepted. Supersedes the agent tool surface of
[ADR 0011](0011-screen-and-computer-use.md), [ADR 0067](0067-background-computer-use.md) and
[ADR 0069](0069-screen-daemon-dispatch.md) on macOS. Amends
[ADR 0086](0086-agent-facing-mcp-tools.md) (the computer-use entry point).

## Context

Agents drove Mac apps through seven session tools: `screen_open_app`, `screen_windows`,
`screen_ui_tree`, `screen_ui_act`, `screen_input`, `screen_screenshot` and `screen_measure`.
Each call went through a session, a controller lease and a background or foreground mode
inherited from the live-view machinery of ADR 0011 and ADR 0067.

An audit on 2026-10-18 replayed the day's real calls against Calculator, TextEdit and ace's
own window. Permissions, signing and the `screen` group were all in order, and none of the
three tasks succeeded:

- Background keyboard input was refused outside classified text fields (typing digits into
  Calculator returned `secure_input_required`), and synthesized clicks that worked were
  reported as `delivery_unconfirmed` errors.
- Menu presses required foreground consent that ADR 0067's 2026-10-14 note had already
  retired, so the documented semantic path failed by default. Foreground mode then failed
  with `not_supported` when AXRaise did.
- The helper's specific error messages were dropped at the MCP boundary; agents saw generic
  codes with hints that were wrong for the case.
- Tree bounds were global points, `screen_input` took window-local points and screenshots
  were pixels at a fractional scale, then downscaled again by the model's image limit.
- A tree cost about 10k tokens and was repeated after every action. It missed text exposed
  only as AXValue, Electron apps returned no nodes at all, and the "settled" snapshot did
  not wait for anything.
- Multi-window apps failed with `window_ambiguous`, and an app with no window produced a
  session with no way forward.

The design was compared with how Codex's computer use behaves (interfaces and behaviour
only; no code read or reused): one call to look, one batched call to act, stable element
ids, diffs, window screenshots sized for the model, and AX actions before synthesized
events.

## Decision

On macOS the daemon starts `ace-screen-helper --computer` beside the session helper, from
the same signed bundle so the person's Accessibility and Screen Recording grants apply.
`@ace/screen` registers `computerToolkit` instead of `screenToolkit` when that client
exists. Windows and Linux keep the session tools.

**Three tools.** `screen_apps` lists running apps and searches installed ones.
`screen_state {app}` resolves a name or bundle id, launches without activation if needed,
and returns the window. `screen_act {app, actions}` runs 1 to 20 steps in order, stops at
the first failure and reports which step failed, then returns the settled result. There
are no sessions, leases, modes or window ids for the agent to manage. `screen_state` is the
family's entry point (ADR 0086).

**Outline and diff.** An observation is one line per meaningful AX element,
`<id> <role> (<flags>) <name>, Value: …, Actions: …`, tab-indented. Ids are stable for an
element across looks. The toolkit keeps each caller's last outline per app and returns only
what changed (`+` new, `~` changed, ancestors as context, `Removed: 3-5`), or "No change
since your last look." Static text read from AXValue is included; Chromium and Electron
apps are asked for their tree with `AXManualAccessibility`.

**Settling.** Observations wait for AX notifications to go quiet for a short interval,
within a bound, instead of polling or reading immediately.

**Acting in the background.** Clicks by id use AX actions (press, focus, select), which work
on covered and off-screen windows. Clicks by x,y take screenshot pixels, hit-test the
outline and press the element found. Keys and text are posted to the app's process, never
to the HID stream; the person's cursor, keyboard and frontmost app are untouched. Menus are
pressed by path without being opened. Windows on other Spaces are reached through AX remote
tokens. `activate` is an explicit step that brings the app forward; it is the last resort
for apps that ignore background input.

**Key window without activation.** A background app has no key window, so it ignores ⌘
shortcuts and disables first-responder menu commands. Before keyboard and menu steps the
helper posts SkyLight focus records that make the target window the app's key window
without activating the app; the window server keeps routing the person's keyboard to their
frontmost app (verified: the frontmost app did not change). ⌘ shortcuts press the menu item
bound to them. Select all, copy, cut and paste on text go through AX selection attributes,
which work regardless of activation. Rich paste goes through the clipboard and restores it;
if the app ignores it the text is inserted plain and the result says so.

**The person comes first.** An action is refused while the person is using that same app
(real HID input within 1.5 s and the app frontmost); acting in other apps continues. Esc
pressed while the agent is acting stops the next step with `stopped_by_person`. A locked
screen is reported, and a power assertion keeps the display awake during a batch. On a
visible window a small non-interactive marker shows where the agent acts.

**Screenshots carry ids.** Actionable elements are outlined and tagged with their outline
ids on the image, so what the model finds by sight it can act on by id.

**One coordinate space.** Screenshots capture the window alone, at most 1568 px on the long
edge and about 1.15 MP, so the model sees them unscaled and its pixel coordinates are the
ones the helper uses.

**Errors.** Helper messages are written for the model and reach it unchanged: what happened
and what to do next.

**Policy.** Password managers, system authentication prompts and terminals are refused
before anything launches. Everything else follows the provider's own permission mode, as
for every ace tool. Some apps get a one-line note on first look (for example, that Return
sends in Slack).

**Wire.** JSON lines on the helper's stdin and stdout: `{id, op, ...}` with `op` one of
`hello`, `apps`, `resolve`, `state` and `act`; replies `{id, ok: true, result}` or
`{id, ok: false, error: {code, message}}`, parsed leniently. The client starts the helper on
first use and replaces it after it exits or a request times out.

## What is superseded

- ADR 0011: the session tools are no longer the agent's interface on macOS. Capture,
  frames, human live view, takeover and the daemon wire are unchanged.
- ADR 0067: for agents on macOS, background versus foreground mode, the focus guard and
  restoration, delivery probes and `foreground_required`, the clipboard paste transaction
  and per-session secure-input consent. The engine never moves focus except through
  `activate`, and posts nothing to the HID stream.
- ADR 0069: session dispatch, window acquisition by `windowId` and `window_ambiguous`, and
  the settled-snapshot fallback no longer apply to agent calls on macOS. They still govern
  the session tools on other platforms and the person's sessions.

## Consequences

- A typical task is one look plus one batched act per step, at a fraction of the earlier
  tokens: diffs replace repeated trees.
- Two helper processes may run on a Mac: one for live view and simulators, one for agents.
  The agent helper holds no capture stream between calls.
- The person can watch an agent only through the app itself; agent work no longer creates a
  screen session in ace's live view.
- Apps that ignore process-posted events while off screen (often Electron) need `activate`,
  which interrupts the person. The tools and skill say so.
- Correctness depends on app accessibility. Apps with poor AX trees fall back to
  screenshots and x,y clicks.
- Tests and fixtures that name the session tools describe the non-macOS surface;
  `apps/daemon/src/testing/provider-mcp-proof.ts` still exercises `screen_ui_act`.

## Amendment 2026-10-18

Follow-up work on the same day, toward parity with other agents' computer use and speed.

**Process pool.** One helper serialised every app: a hung app stalled every agent, and a
timeout killed work in unrelated apps. `ComputerClient` now runs one
`ace-screen-helper --computer` per target app (at most six; the least recently used idle
one is evicted; idle helpers exit after five minutes) plus one shared helper for `hello`,
`apps` and `resolve`. Clocks and timers are injected. Clipboard transactions take a
cross-process lock so two helpers never interleave a paste.

**Cancel.** The wire gains `cancel {target}`, answered at once outside the helper's serial
queue; the target stops at its next check point (between steps, and every 50 ms inside
typing, key repeats, `wait` and `wait_for`) and replies with the steps it finished and
`error.code: "cancelled"`. An aborted call sends `cancel`, waits 3 s for that reply, then
kills only that app's helper (SIGTERM, so the helper restores a borrowed clipboard). An
overrun deadline does the same. A reply over the size cap fails its call at once instead
of waiting for the deadline. Every request has its own bound inside the helper (an AX
messaging timeout of at most 1 s and hard walk and settle deadlines): a hung app yields a
partial outline marked `notResponding`, never a dead helper.

**Actions.** Clicks take `button: middle`, `modifiers` and `hold_ms`, and x,y clicks
hit-test in true z-order; `move` hovers; `type`, `paste` and `key` may focus an `id` first;
`key` takes `hold_ms` and maps keys through the current keyboard layout; `select_text`
takes `suffix`; `scroll` takes `pixels` or `pages`; `scroll_to`, `drag` between ids or
points with modifiers, and `window` (close, minimize, restore, zoom, fullscreen, raise,
move, resize) are new. The zod schema in `@ace/screen` is the source of truth and checks
cross-field rules before anything runs.

**`if` and `wait_for`.** An `if {text|id, gone?, steps?}` step guards the next `steps`
steps (default 1): they run only if such an element exists then, otherwise they are reported
as skipped, not failed. The toolkit moves each `if` onto its steps as a `when` before the
helper sees them, so the model's schema carries one guard type instead of a guard on every
step (about 7 KB less schema per load). `wait_for` re-reads
the window until text or an element appears (or goes). Together they let one batch handle
a dialog that may or may not appear, and replace look-act-look round trips.

**Speed.** `screen_state {outline: false}` returns a screenshot without walking the tree.
`screen_act {observe: false}` skips the settled look. The toolkit resolves an app name once
per caller and caches the bundle id (dropped on `app_not_found`), so a look or action is
one helper round trip. Requests to different apps run in parallel.

**Policy.** Lookups are case-insensitive. ace's own desktop app (`dev.ace.app`) is refused
so agents cannot answer its approvals; Script Editor, Automator and Shortcuts are refused
because they run shell commands, like terminals; more terminals are listed. The person can
add apps (bundle ids or names) in Settings › Computer use › Apps agents can't use
(`computer.blockedApps`, global and admin-only, so an agent cannot loosen it).

**Visibility.** The task list shows a quiet cursor mark on a thread whose agent is using
Mac apps, naming them, from the calls in flight with a short linger
(`computer.using.watch`, shaped like `browser.browsing.watch`).

**Deferred.** Background engines for Windows and Linux (they keep the session tools);
operating while the Mac is locked; per-app approval prompts, which are intentionally not
done: ace never gates its own tools, and the provider's permission mode decides each call
(ADR 0086). ace's web UI open in a browser is not covered by the block list; agents are
told to use browser tools for web pages.

## Amendment 2026-10-19: speed and a sharp live view (#1130)

Settling ends 60 ms (40 ms between steps) after the app's last notification once it has
reacted to the action, instead of a fixed 150 ms; an app that has not reacted keeps the full
interval. Walks read a known element in one round trip (its remembered role predicts the
attributes and is confirmed in the same read) and reuse action names until the app reports a
change on that element. `screen_act` advertises one flat step object with a grammar on `type`
and validates calls against the strict per-step union. The live view encodes H.264 High,
re-sends a still picture once as a refined keyframe, captures at no more than native pixel
density and crops windows without their shadow. Numbers: [computer-use-performance.md](../computer-use-performance.md).

## Amendment 2026-10-23: locked sessions and idle sleep

A real lock test on macOS 26.2 returned an empty TextEdit `AXWindows` array and
`invalidUIElement` for a text control that worked before locking. Neither a cached
reference nor a fresh helper could reach that document. Removing a blanket lock guard
therefore does not establish general support for GUI work behind the macOS lock screen.

Computer-use calls now hold a system idle-sleep assertion through the gaps between
successful calls, for at most five minutes without another call. Failure, cancellation,
helper shutdown and expiry release it. An additional OS assertion timeout bounds a stuck
helper. Display idle-sleep protection remains limited to an unlocked action batch; a
locked display may dim while background work continues. Explicit sleep, a closed lid and
low-battery sleep retain the OS's behavior. These use the documented IOKit
[power assertions](https://developer.apple.com/documentation/iokit/1557078-iopmassertioncreatewithdescripti).
The desktop app also has its existing user-controlled prevent-sleep setting for active
agent turns; the helper protection covers computer use when that app is absent.

Controls still exposed through accessibility may be used while locked. Posted keyboard
and pointer fallback is refused because delivery cannot be confirmed. Missing locked
windows report `screen_locked`, not a closed document or a stale-id retry instruction.
An unavailable GUI session reports `session_unavailable`. Observations distinguish an
active, locked and unavailable session, and lock transitions discard screenshot geometry
and remembered agent focus. After unlocking, callers must observe fresh controls.

Lock detection retains the existing best-effort `CGSSessionScreenIsLocked` dictionary
flag, which Apple does not document as a public `CGSession` key. A missing session or
missing public console/login facts is treated as unavailable. This is not a guarantee of
Apple-supported lock detection across macOS versions. No lock bypass, automatic unlock,
security-setting change or replacement authentication screen is introduced. The existing
off-Space engine also retains its previously documented private window/focus dependencies.

Ace's browser already moves locked-screen pages to its own Chromium backend. That and
non-GUI tools can continue when native app controls are unavailable. Universal native GUI
operation behind the real lock and a persistent status surface on the secure lock screen
remain unimplemented; this change must not be described as providing either.

### Follow-up investigation: authorization-assisted Locked Use

[The clean-room investigation](../research/macos-codex-locked-use.md) found that OpenAI
documents a separately enabled authorization plug-in that temporarily unlocks the desktop
under display covers for approved work. Local bundle and authorization-policy metadata
confirm that integration is installed on this Mac. The AX-only test above does not rule out
such a consented architecture. Ace currently has no corresponding installation, scoped
authorization or protected-desktop lifecycle. Those require a separate design review; this
investigation changed no authorization policy. [Apple API boundaries](../research/macos-authorization-plugin-locked-use.md)
and the unresolved unlock/relock controls are recorded separately.
