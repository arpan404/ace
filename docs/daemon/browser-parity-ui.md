# Browser parity UI handoff

Use the existing authenticated browser socket and `Client.request`. All requests
below carry `requestId` and `threadId`. Replies are correlated `browser.result`
with `ok`, `result` or `error`. Browser mutations are one-shot requests, never
reconnect intents. Subscribe again after reconnect or session reopen and acknowledge
rendered `browser.frame` sequences using the existing ACK contract.

| UI operation    | Request and result                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| List tabs       | `browser.tabs.list` returns `BrowserTab[]`                                                              |
| Open tab        | `browser.tabs.open` with optional HTTP(S) `url`; shows it; returns active ID, tabs and the new `tabId`  |
| Show tab        | `browser.tabs.select` with `tabId`, returns active ID and tabs                                          |
| Close tab       | `browser.tabs.close` with `tabId`, returns active ID and tabs; closing the last returns `{closed:true}` |
| Keep agents out | `browser.tabs.private` with `tabId` and `private`, returns state                                        |
| List downloads  | `browser.downloads.list` returns `BrowserDownload[]`                                                    |
| Answer dialog   | `browser.dialog.answer` with `tabId`, `dialogId`, `accept`, optional `promptText`; returns `{ok:true}`  |
| Recording       | Existing `browser.recording.start` / `.stop`; stop returns an artifact                                  |

Listing tabs and downloads requires thread read access. Creating/showing/closing
tabs, keeping agents out, answering dialogs, input and recording require operate
access. Nobody holds a lease: the person and agents share every tab (ADR 0067,
Collaboration). Commands name the tab they act in (`tabId`); omitted, the shown tab.
A thread excluded by device policy always refuses. Agents need no site, script or
file grant: ace never asks before an agent browses, evaluates, uploads or downloads.

`browser.state` carries `url` (the shown tab's), `backend`, `status`, `closed`,
`blocked`, recovery fields, `activeTabId`, `tabs`, `downloads` and `pending_dialog`.
Each tab has `tabId`, `url`, `title` and optional `favicon`, `loading`, `label`,
`openedBy`, `inUse` (the agent working there now), `pointer` (where it last pointed,
in the tab's CSS pixels), `private` and `pending_dialog`. A popup changes the list without switching the current tab.
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

A private tab ("Keep agents out of this tab") refuses agent calls with
`human_private`; its frames do not enter recordings and its logs or response bodies
are not collected. Human viewing and input are unaffected. It stays private across a
disconnect and a daemon restart, until the person lets agents back in. There is no
interaction or host gate.

Inline inspection uses `browser.execute` with action `logs`: optional `kind`,
`level`, `url` substring, `status`, and `limit` 1..200, default 100. It returns
`{entries,limit}`. Entries include `kind`, `at`, `type`, `text`, and for responses,
`url`, `status`, `requestId`. Pass that ID to `network_body` to receive
`{requestId,mimeType,body,redacted:true}`. The body must have completed and still
be retained. Text and URLs are scrubbed using the shared redactor. Do not render
body HTML as executable markup.

Agent/MCP failures expose fixed codes including `human_private`, `human_active`,
`stale_ref`, `browser_paused`, `backend_changed`, `denied`,
`queue_full` and `not_supported`. Wire failures use `browser.result.ok:false` and
bounded `error`; an address that is not an HTTP(S) URL without credentials
additionally exposes `blocked:{origin,reason:"invalid_origin"}`. Read current state before offering a retry. Do not replay
input, file operations, approvals or recording actions after an uncertain result.

The fake daemon exposes the same requests and states. Fixture scripts can call
`tabsList`, `tabOpen` (an agent's tab), `personOpen`, `tabSelect`, `tabClose`,
`agentWorks`, `agentIdle`, `setPrivate`, `dialogOpen` and `downloadAdd` to seed these
panels; client behavior still goes through the wire.

## Client API

Use `new BrowserFeaturesClient(client)` from `@ace/client` for `tabs`, `openTab`,
`selectTab`, `closeTab`, `keepPrivate`, `downloads` and `answerDialog`. These are
one-shot requests, not durable intents. Tab mutations return either
`{activeTabId,tabs,tabId?}` or `{pending_dialog}`; closing the last tab returns
`{closed:true}`. Answer a pending dialog by its original `tabId` and `dialogId`
before retrying. Client errors use `ClientError("daemon", error)` or
`ClientError("protocol", ...)`. Continue rendering `browser.state` and acknowledging
`browser.frame` through the existing subscription transport.
