# Background computer use: UI handoff

The daemon owns session safety: the computer use switch, controller ownership, human takeover and secure-input consent. It adds no approval of its own to agent calls; the provider's own permission mode decides those, using the tools' MCP annotations. Clients display state and send authenticated admin requests. See [ADR 0067](../adr/0067-background-computer-use.md). macOS supports eight concurrent sessions, exclusive by bundle id. Simulator is an ordinary target. Windows and Linux expose the existing single-target contract; background agent input is refused until their follow-up is complete.

## Wire requests and replies

Use the existing `screen.request` envelope with a unique `requestId` and an `operation` below. The reply is `screen.result {requestId, ok, data?, error?, errorCode?, holder?}`. Known errors have `errorCode`; retain the text fallback for legacy errors. `target_busy` additionally has `holder:{sessionId,owner}`. The owner is an opaque daemon controller identity (scoped agents use a JSON tuple of thread and agent IDs); use matching session state for labels.

| Operation                   | Additional fields                                                     | Successful data / behavior                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enable`                    | `enabled:boolean`                                                     | Persists enablement. False stops sessions; true also clears the kill-switch latch.                                                                                      |
| `open.app`                  | `bundleId`                                                            | `{bundleId,pid,mode:"background"}`; launches an app in background, without acquiring a session.                                                                         |
| `start`                     | `target, fps?:1..60, threadId?`                                       | `ScreenState`. threadId shares the capture with that thread. Defaults to background mode.                                                                               |
| `sessions`                  | —                                                                     | Current `ScreenState[]`; fetch on reconnect.                                                                                                                            |
| `controller`                | `sessionId, controller:"human"\|"agent"\|"none", threadId?, agentId?` | Human takeover or delegate matching thread/agent. Another agent cannot replace an existing agent holder. Queued input is revalidated in the shared host execution slot. |
| `mode`                      | `sessionId, mode:"background"\|"foreground"`                          | Updated state. Foreground activates the app and uses the real cursor and keyboard focus; a controller change returns it to background.                                  |
| `secure.input`              | `sessionId, allowed:boolean`                                          | Updated state. Human-only ephemeral consent for secure typing.                                                                                                          |
| `stop`                      | `sessionId`                                                           | Stops only that session.                                                                                                                                                |
| `stop.all`                  | —                                                                     | Persists disabled access, cancels starts, releases controllers and stops all sessions. Blocks agent reacquisition until `enable:true`.                                  |
| `subscribe` / `unsubscribe` | `sessionId`                                                           | Independently route binary frames for up to eight subscriptions.                                                                                                        |
| `ui.act` / `input`          | existing action fields / input                                        | Result includes `mode` and a fresh compact `snapshot` after settling.                                                                                                   |

Frame packets retain their existing framing and per-session sequence numbers; route by `sessionId`, never by whichever app is selected in the UI. Native window-local input uses points; divide screenshot pixels by its reported scale. `text.paste` is an additive `input.kind`. `ui.act` adds `performSecondaryAction` with `name` from `secondaryActions`, and `selectText` with `value` or `range:{location,length}`. Consult generated protocol schemas for the complete union.

## Visible states

Every admin connection receives `screen.state {state}` without a pixel subscription. State contains `sessionId`, `target`, `lifecycle`, `controller`, `mode`, `secureInputAllowed`, optional `holder:{threadId,agentId}`, `indicator`, `permissions`, optional capabilities/error. Fetch `sessions` after reconnect and reconcile by ID.

Show every `controller:"agent"` session in the computer-use indicator, including semantic-only sessions with `indicator:false`. The capture indicator represents actual capture demand, not all agent control. Show background/foreground visibly and a per-app Take over action. Show a global Stop all button. Keep capture visibility through `stopping` until acknowledgement/termination turns `indicator` off. A failed session with `indicator:true` has unconfirmed termination; keep it visible and allow stop retry. Remove stopped sessions after their final broadcast. Mode and secure-input consent reset on controller change and restart; reconnect never redelegates automatically.

## No approval UI

Agent calls never open an ace approval. Computer use is the person's switch (`enable`), and the person keeps control through takeover, Stop and Stop all; an agent is refused while a person holds its app. The conservative secure-input rule stays: agents cannot type into secure fields without the person's per-session consent. OS permission prompts remain human initiated.

## Errors and recovery

| Code                                                  | UI behavior                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_busy`                                         | Name the holder from session state; offer per-session takeover. Never steal an agent lease automatically.                                                               |
| `screen_disabled`                                     | Offer human enablement.                                                                                                                                                 |
| `foreground_required`                                 | The agent may switch the session to foreground. No automatic retry.                                                                                                     |
| `focus_changed`                                       | Explain unexpected frontmost app, focused AX window/element or cursor change. Restoration is best effort and suppressed after human HID activity. Refresh before retry. |
| `window_minimized` / `window_offscreen`               | Ask the human to restore/reposition or select a different window.                                                                                                       |
| `secure_input_required`                               | Offer session consent only for a classified secure field. Unknown destinations also refuse input; consent cannot override failed metadata. Never show secure values.    |
| `clipboard_changed`                                   | Another clipboard writer intervened; saved clipboard was not restored. Refresh before retrying paste.                                                                   |
| `denied` / `timeout`                                  | Show the refusal; no automatic retry.                                                                                                                                   |
| `not_supported` / `target_gone` / `permission_denied` | Show the remedy; refresh inventory/OS grants and explicitly restart if needed.                                                                                          |

Every dispatched agent action appends a compact thread notice with `code:"screen.step"` and raw `ace.screen.step {sessionId,action,mode,outcome}`. Render those as step items. Neither typed text nor key contents are audited, and AX secure-field values remain redacted even with secure-input consent. Screenshots/recordings may contain visible app data; this is independent of action audit redaction.

## Owner live checks

Use disposable TextEdit/Calculator windows with existing Screen Recording/Accessibility grants, then close them. Verify concurrent apps plus Simulator, occluded screenshots, minimized/offscreen errors, cursor/frontmost invariance, posted-event refusal, clipboard restoration, locked-Mac capture, foreground switching and takeover. Simulator keyboard, Electron/canvas apps and secure-field support need per-app verification. No live app compatibility or locked-Mac parity is claimed by process/unit tests.

## UI follow-up for the Claude web agent

Import `ScreenClient` and `ScreenClientError` lazily from `@ace/client/screen`, construct with the existing authenticated `Client`, and use:

- `sessions()` for the initial/reconnected inventory and `watch(listener)` for state pushes without pixel demand. Subscribe to `Client.connectionState()` and reload `sessions()` on `ready`; unregister watchers when controls close. Reconcile updates that arrive during the inventory request before presenting the result.
- `enable`, `start(target, threadId)`, `openApp`, and `delegate(sessionId, {threadId,agentId})` for human controls. `openApp` only launches; agent MCP `screen_open_app` also acquires/delegates a session.
- `takeover(sessionId)`, `stop(sessionId)`, and `stopAll()` for per-session and global stop controls. `mode(sessionId, mode)` switches background and foreground. `secureInput(sessionId, allowed)` is an explicit human choice; agents cannot invoke that grant.
- `ScreenClientError.errorCode` and `.holder` for the recovery states above. Requests are one-shot service calls, never durable intents or replayed after reconnect. Mode and secure-input consent must remain visibly session-scoped.

Build the every-agent-app indicator, per-session background/foreground label, takeover and global stop controls.

## UI backend follow-up (screen channel and fake mode)

- Read `screen.request {requestId,operation:{op:"status"}}` on initial connection and after every reconnect. Success is `screen.result {requestId,ok:true,data:{enabled:boolean,permissions:{screenRecording:boolean,accessibility:boolean},sessions:number}}`. The count is 0–8. Configured screen access can be disabled while OS permissions are granted. A daemon without a helper returns correlated `ok:false,errorCode:"screen_disabled"`; a non-admin device gets correlated `errorCode:"forbidden"`. These replies reject `ScreenClient` requests immediately, without waiting for a timeout.
- Listen for `screen.enabled {enabled:boolean}` independently of `screen.state`. All authenticated admin main and screen sockets receive enablement changes, including disable/stop-all when there are zero sessions. Fetch `status` after reconnect; pushes are changes, not a durable event log. `ScreenClient.status()`, `permissions()`, `requestPermission("screenRecording"|"accessibility")`, and `watchEnabled(listener)` are available from the lazy `@ace/client/screen` subpath.
- Human admins may send `operation:{op:"permissions.request",permission:"screenRecording"|"accessibility"}` on either socket. Success data is `{screenRecording,accessibility}`. It opens the daemon host’s OS permission prompt/settings, so show the returned state and allow a refresh. The existing devices permission operation remains supported.
- For pixels, lazily import `ScreenStreamClient`, `screenTransport`, and `browserScreenSocket` from `@ace/client/screen-stream`. Construct with `{id,schedule(callback,delayMs)}`; connect to `screenTransport({target,deviceId,credential,socket,keys,schedule})`, using the same credential/relay-key factory as devices. The authenticated hello uses `channel:"screen"`. Subscribe through `request({op:"subscribe",sessionId})`, register `watchFrames(sessionId,listener)` for decoded `{header,payload,packet}` frames, and send `unsubscribe` when unmounting. `watch`/`getSnapshot` expose `{connected,enabled?,states,error?}` and reconcile state pushes and session-list replies. Run `request({op:"sessions"})`/`status` and re-subscribe explicitly after reconnect. Requests and inputs are never replayed; disconnect rejects outstanding requests and discards old frames. Slow viewers keep one in-flight and one latest pending frame.
- `DeviceState.holder?:{threadId,agentId}` accompanies `controller:"agent"` in real and fake device state/results; it disappears on takeover, release or lease expiry. Use these IDs to label the device’s holder.
- Fake endpoints expose `endpoint.screen():ScreenTransport`, backed by `daemon.screen` (`FakeScreen`). Main `ScreenClient` controls and dedicated viewers share enablement, permissions, up to eight exclusive app targets, controller IDs, mode, secure-input consent and state pushes. Fake `subscribe` produces the shared JPEG fixture; input refreshes it. OS permissions can be staged through `daemon.screen.permissions`, and `daemon.screen.requested` records human permission requests. Recording/native capability probing return `not_supported`; fake pictures are fixtures, not desktop screenshots.
- A fake foreground `mode` request switches at once; takeover resets mode and secure-input consent.

Validation of native background behavior still requires the owner’s live checks listed above. This follow-up changes the wire/client/fake layers and does not claim new native app compatibility.
