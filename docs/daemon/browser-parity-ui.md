# Browser parity UI handoff

Use the existing authenticated browser socket and `Client.request`. All requests
below carry `requestId` and `threadId`. Replies are correlated `browser.result`
with `ok`, `result` or `error`. Browser mutations are one-shot requests, never
reconnect intents. Subscribe again after reconnect or session reopen and acknowledge
rendered `browser.frame` sequences using the existing ACK contract.

| UI operation      | Request and result                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| List tabs         | `browser.tabs.list` returns `BrowserTab[]`                                                                                                           |
| Open tab          | `browser.tabs.open` with optional HTTP(S) `url`, returns active ID and tabs                                                                          |
| Switch tab        | `browser.tabs.switch` with `tabId`, returns active ID and tabs                                                                                       |
| Close tab         | `browser.tabs.close` with `tabId`, returns active ID and tabs; closing the last requires `browser.close`                                             |
| List downloads    | `browser.downloads.list` returns `BrowserDownload[]`                                                                                                 |
| Answer dialog     | `browser.dialog.answer` with `tabId`, `dialogId`, `accept`, optional `promptText`; returns `{ok:true}`                                               |
| Evaluate grants   | `browser.evaluate.grants.list` returns `BrowserEvaluateGrant[]`                                                                                      |
| Revoke evaluation | `browser.evaluate.grants.revoke` with exact `origin`, returns the remaining grants                                                                   |
| Origin grants     | `browser.origins.list`, `.grant`, `.revoke`; mutation requests carry exact `origin`; lists return effective page/thread grants with optional `scope` |
| Take over         | `browser.takeover` with `mode:"shared"` or `"private"`, returns state; omitted mode means shared                                                     |
| Hand back         | `browser.handback` returns state; controlling connection required                                                                                    |
| Recording         | Existing `browser.recording.start` / `.stop`; stop returns an artifact                                                                               |

Listing tabs, downloads, origins and evaluate grants requires thread read access.
Creating/switching/closing tabs, answering dialogs, changing grants, taking control
and recording require operate access. Tab mutations and dialog answers additionally
require the human controller lease. Grant management does not require a live
browser or a human controller. A thread excluded by device policy always refuses.

`browser.state` retains `controller`, `owner`, `url`, `backend`, `status`, `closed`,
`blocked` and recovery fields. Added fields are `activeTabId`, `tabs`, `downloads`,
`pending_dialog` and `takeoverMode`. They are optional for compatibility with
explicit legacy embedded backends. Each tab has `tabId`, `url`, `title` and optional
`pending_dialog`. A popup changes the list without switching the current tab.
State updates arrive when tabs, dialogs or transfers change, including in background.
Do not infer tab identity from URLs. Preserve the selected stable ID in UI state.

Downloads have `downloadId`, `tabId`, `filename`, `bytes`, `mimeType`, `flags`,
`state` and optional completed host `path`. States are `pending`, `complete`,
`denied`, `failed` and `too_large`. Flags are `executable` and/or `archive`.
Show the flags next to the download; do not automatically open a completed file.
Completion also creates an `artifact` thread item with filename, size, MIME and
flags. Paths refer to the daemon host, not the client filesystem. This backend
change does not introduce a new remote artifact-byte endpoint.

Pending dialogs have `dialogId`, `tabId`, `type`, `message`, optional
`defaultPrompt`. Types are alert, confirm, prompt and beforeunload. Clear the UI
from updated state after answering. Stale IDs fail rather than answering a different
dialog. A command that opens a synchronous dialog returns `{pending_dialog}`
without waiting for the renderer reply. Until it is answered, other page commands
return that pending state without applying input; tab listing remains available.
Dialogs on inactive tabs remain on that tab's entry. Both agent dialog tools and
`browser.dialog.answer` answer the original dialog without switching tabs; send
its original `tabId` and `dialogId`.

Evaluate approvals arrive through the existing canonical `interaction.opened`
path and thread approval UI, not a separate browser popup. The target tool is
`browser.evaluate`, with `origin`, `url`, `mode` and the proposed `expression` in `target.input`.
Show the expression in the approval review. Options are
`allow_once`, `deny`, and for read-only mode, `allow_site`. Resolve using the existing
`interaction.resolve` command. Download approvals use `browser.downloads` and
Allow once / Deny. Outside-file uploads use `browser.upload`, include exact resolved
paths, and always require a human. Auto-review records `permission.reviewed` and
leaves these external effects pending. Grants never apply across threads or to
unrestricted JS. Revoke calls expire matching pending evaluations.

Private takeover persists its blocking ownership gate immediately, including while the controller is connected. Private takeover shows `controller:"human"`, `takeoverMode:"private"`. Agent calls
return `human_private`; private frames do not enter recordings and private logs or
response bodies are not collected. Human viewing remains authorized independently.
On private disconnect the state becomes `controller:"none"`, `status:"paused"`,
no owner and still private. Reconnect must subscribe, take over in private mode,
then explicitly hand back. Taking over makes human input available again; handback
restores `controller:"agent"`, ready/shared, and closes the engine's blocking
"Private browser ownership" interaction. Resolving that interaction directly fails
with `private_handback_required`; only authorized handback or explicit browser closure clears it. Shared takeover cannot downgrade a private lease. Daemon shutdown and backend loss preserve it. After an unclean daemon stop, reopen the browser before takeover/handback; its
durable private gate restores private/paused state even though tabs were lost.
Backend-loss pause is separate and cannot
be cleared by handback. Shared disconnect retains automatic handback.

Inline inspection uses `browser.execute` with action `logs`: optional `kind`,
`level`, `url` substring, `status`, and `limit` 1..200, default 100. It returns
`{entries,limit}`. Entries include `kind`, `at`, `type`, `text`, and for responses,
`url`, `status`, `requestId`. Pass that ID to `network_body` to receive
`{requestId,mimeType,body,redacted:true}`. The body must have completed and still
be retained. Text and URLs are scrubbed using the shared redactor. Do not render
body HTML as executable markup.

Agent/MCP failures expose fixed codes including `human_private`, `human_controlled`,
`controller_changed`, `stale_ref`, `browser_paused`, `backend_changed`, `denied`,
`evaluate_approval_required`, `queue_full` and `not_supported`. Wire failures use
`browser.result.ok:false` and bounded `error`; origin failures additionally expose
`blocked:{origin,reason}`. Read current state before offering a retry. Do not replay
input, file operations, approvals or recording actions after an uncertain result.

The fake daemon exposes the same requests and states. Fixture scripts can call
`tabsList`, `tabOpen`, `tabSwitch`, `tabClose`, `dialogOpen`, `downloadAdd`, and
`evaluateGrant` to seed these panels; client behavior still goes through the wire.

## UI follow-up for the Claude web agent

Use `new BrowserFeaturesClient(client)` from `@ace/client` for `tabs`, `openTab`,
`switchTab`, `closeTab`, `downloads`, `answerDialog`, `evaluateGrants`,
`revokeEvaluateGrant`, `takeover(threadId, "private")` and `handback`. Use the existing
`BrowserOriginsClient.list/grant/revoke` for origin consent. These are one-shot
requests, not durable intents. Tab mutations return either `{activeTabId,tabs}` or
`{pending_dialog}`; preserve dialog ownership and answer by its original `tabId`
and `dialogId` before retrying. The pending dialog may belong to an inactive tab.
Read lists require thread read scope; mutations, answers, takeover and handback
require operate scope and the human controller lease where applicable. Client
errors use `ClientError("daemon", error)` or `ClientError("protocol", ...)`.
Continue rendering `browser.state` and acknowledging `browser.frame` through the
existing subscription transport. Approvals use `interaction.resolve` and the
existing interaction projection. Do not mark private control complete while its
host gate is pending. The fake daemon exposes the same ownership timing.

UI changes are delegated to the Claude web agent. This backend PR does not edit
web, desktop, mobile or UI packages.
