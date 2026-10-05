# Background computer use: UI handoff

The daemon owns safety and approval decisions. Clients display them and send authenticated admin requests. See [ADR 0067](../adr/0067-background-computer-use.md). macOS supports eight concurrent sessions, exclusive by bundle id. Simulator is an ordinary target. Windows and Linux expose the existing single-target contract; background agent input is refused until their follow-up is complete.

## Wire requests and replies

Use the existing `screen.request` envelope with a unique `requestId` and an `operation` below. The reply is `screen.result {requestId, ok, data?, error?, errorCode?, holder?}`. Known errors have `errorCode`; retain the text fallback for legacy errors. `target_busy` additionally has `holder:{sessionId,owner}`. The owner is an opaque daemon controller identity (scoped agents use a JSON tuple of thread and agent IDs); use matching session state for labels.

| Operation                   | Additional fields                                                     | Successful data / behavior                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enable`                    | `enabled:boolean`                                                     | Persists enablement. False stops sessions; true also clears the kill-switch latch.                                                                              |
| `approve`                   | `bundleId, allowed, scope?:"turn"\|"thread"\|"always", threadId?`     | Human grant/revoke. Default scope is always; turn/thread require threadId. Revocation removes the exact scope/thread grant and stops sessions that lose access. |
| `approvals`                 | `threadId?`                                                           | Array of `{bundleId,scope,threadId?,turnId?,grantedAt}`. Omit threadId to list all grants; include it for that thread's applicable grants.                      |
| `open.app`                  | `bundleId`                                                            | `{bundleId,pid}`; launches an approved app in background, without acquiring a session.                                                                          |
| `start`                     | `target, fps?:1..30, threadId?`                                       | `ScreenState`. Include threadId when using scoped grants. Defaults to background mode.                                                                          |
| `sessions`                  | —                                                                     | Current `ScreenState[]`; fetch on reconnect.                                                                                                                    |
| `controller`                | `sessionId, controller:"human"\|"agent"\|"none", threadId?, agentId?` | Human takeover or delegate matching thread/agent. Another agent cannot replace an existing agent holder.                                                        |
| `mode`                      | `sessionId, mode:"background"\|"foreground", reason?`                 | Updated state. Foreground opens an engine host approval for an agent-controlled session; background needs no escalation.                                        |
| `secure.input`              | `sessionId, allowed:boolean`                                          | Updated state. Human-only ephemeral consent for secure typing.                                                                                                  |
| `stop`                      | `sessionId`                                                           | Stops only that session.                                                                                                                                        |
| `stop.all`                  | —                                                                     | Persists disabled access, cancels starts, releases controllers and stops all sessions. Blocks agent reacquisition until `enable:true`.                          |
| `subscribe` / `unsubscribe` | `sessionId`                                                           | Independently route binary frames for up to eight subscriptions.                                                                                                |
| `ui.act` / `input`          | existing action fields / input                                        | Result includes `mode` and a fresh compact `snapshot` after settling.                                                                                           |

Frame packets retain their existing framing and per-session sequence numbers; route by `sessionId`, never by whichever app is selected in the UI. Native window-local input uses points; divide screenshot pixels by its reported scale. `text.paste` is an additive `input.kind`. `ui.act` adds `performSecondaryAction` with `name` from `secondaryActions`, and `selectText` with `value` or `range:{location,length}`. Consult generated protocol schemas for the complete union.

## Visible states

Every admin connection receives `screen.state {state}` without a pixel subscription. State contains `sessionId`, `target`, `lifecycle`, `controller`, `mode`, `secureInputAllowed`, optional `holder:{threadId,agentId}`, `indicator`, `permissions`, optional capabilities/error. Fetch `sessions` after reconnect and reconcile by ID.

Show every `controller:"agent"` session in the computer-use indicator, including semantic-only sessions with `indicator:false`. The capture indicator represents actual capture demand, not all agent control. Show background/foreground visibly and a per-app Take over action. Show a global Stop all button. Keep capture visibility through `stopping` until acknowledgement/termination turns `indicator` off. A failed session with `indicator:true` has unconfirmed termination; keep it visible and allow stop retry. Remove stopped sessions after their final broadcast. Mode and secure-input consent reset on controller change and restart; reconnect never redelegates automatically.

## Approval UI

No new approval transport is required. `screen_request_app` and `screen_request_foreground` open ordinary blocking `interaction.opened` approval requests in the agent's thread. They keep the agent tree waiting for the human. Render request title/description/target; `target.tool` distinguishes the requests, `target.input` contains `{bundleId,kind}`, and raw metadata is `ace.screen.approval`.

App option IDs: `allow_once` (“Allow once”, current turn), `allow_thread` (“Allow for this thread”), `allow_always` (“Always”), `deny`. Foreground offers only `allow_once` and `deny`, applies only to that session/controller, and allows activation, real cursor and keyboard focus. Resolve with the existing authenticated `interaction.resolve` command and `resolution:{kind:"approval",optionId}`. Do not resolve locally or infer approval from button selection. Use `interaction.closed` to reconcile. Requests expire after 60 seconds, cancellation or restart; stale turn choices fail `turn_changed`. Reviewers/agents cannot resolve these host approvals.

Saved sensitive-app grants still require a fresh approval in each turn. The conservative list includes password managers, System Settings, Keychain Access, Terminal/iTerm and ace. Screen enablement remains a separate human setting. Expose listing/revocation of turn/thread/always grants; revoked grants stop affected capture before acknowledgment. Turn grants expire on restart/new turn; thread/always persist. OS permission prompts remain human initiated.

## Errors and recovery

| Code                                                  | UI behavior                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `target_busy`                                         | Name the holder from session state; offer per-session takeover. Never steal an agent lease automatically.                         |
| `screen_disabled` / `approval_required`               | Offer human enablement / app approval.                                                                                            |
| `foreground_required`                                 | Offer the engine escalation flow, with the agent's reason. No automatic retry.                                                    |
| `focus_changed`                                       | Explain unexpected focus/cursor change. Restoration is best effort and suppressed after human HID activity. Refresh before retry. |
| `window_minimized` / `window_offscreen`               | Ask the human to restore/reposition or select a different window.                                                                 |
| `secure_input_required`                               | Offer explicit secure-input consent for this session; never show secure values.                                                   |
| `clipboard_changed`                                   | Another clipboard writer intervened; saved clipboard was not restored. Refresh before retrying paste.                             |
| `denied` / `timeout` / `read_only`                    | Preserve the denied/expired/read-only state; no automatic escalation.                                                             |
| `not_supported` / `target_gone` / `permission_denied` | Show the remedy; refresh inventory/OS grants and explicitly restart if needed.                                                    |

Every dispatched agent action appends a compact thread notice with `code:"screen.step"` and raw `ace.screen.step {sessionId,action,mode,outcome}`. Render those as step items. Neither typed text nor key contents are audited, and AX secure-field values remain redacted even with secure-input consent. Screenshots/recordings may contain visible app data; this is independent of action audit redaction.

## Owner live checks

Use disposable TextEdit/Calculator windows with existing Screen Recording/Accessibility grants, then close them. Verify concurrent apps plus Simulator, occluded screenshots, minimized/offscreen errors, cursor/frontmost invariance, posted-event refusal, clipboard restoration, locked-Mac capture, foreground consent and takeover. Simulator keyboard, Electron/canvas apps and secure-field support need per-app verification. No live app compatibility or locked-Mac parity is claimed by process/unit tests.
