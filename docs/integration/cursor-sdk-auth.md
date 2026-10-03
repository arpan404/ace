# Cursor SDK browser auth protocol

The daemon service registry exposes SDK browser sign-in without a provider key
field or daemon-local browser launch. Web and desktop UI implementation is owned
separately. These request/event schemas are exported from `@ace/protocol` and
included in `ClientMessage`/`ServerMessage`.

Every request carries a bounded `requestId`. Start, poll, cancel, select and
logout require `operate` scope; status requires `read`. Login jobs belong to the
paired device that started them. Another device cannot poll or cancel the job,
even if it knows its ID. Reconnecting the same paired device can continue polling.

| Request              | Fields beyond requestId        | Response                                                                  |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| `cursor.auth.start`  | `instanceId`, optional `label` | `cursor.auth.login` with loginId and expiry                               |
| `cursor.auth.poll`   | `loginId`                      | Current `cursor.auth.login` state                                         |
| `cursor.auth.cancel` | `loginId`                      | Cancelled state after worker exit                                         |
| `cursor.auth.status` | `instanceId`                   | `cursor.auth.changed` with effective auth source and selected account     |
| `cursor.auth.select` | `instanceId`                   | Changed default account after checking authentication                     |
| `cursor.auth.logout` | `instanceId`                   | Changed effective status after selected hosts exit and SDK store deletion |

Start registers a missing account in a daemon-owned isolated home; the client
cannot provide a filesystem path, environment value or key. Repeating the same
start request returns its existing job while retained. An active login for the
same account is reused by its owner; another device receives `busy`.

The client polls until state `browser` includes the SDK-provided HTTPS `url`,
then opens that URL on the **client's device**. The browser exchange is performed
by `Cursor.auth.login` in the selected account's worker. Completion produces
state `complete` with safe auth metadata. Failures use fixed error codes, never
raw SDK errors or auth results. Terminal states clear the URL. Jobs expire after
five minutes; expiry cancels the worker, clears the challenge and removes the
job. Clients receiving `not_found` can start a new sign-in.

Login URLs are one-time challenges. Keep them only in the login view; do not
persist, log, include in telemetry, or copy them into thread history. The daemon
holds at most eight jobs, sixteen service requests and eight requests per socket.
It never stores the URL in accounts SQLite, events, frames or recorder output.

Auth metadata is `{ status: "logged-in" | "logged-out", source: "environment" |
"sdk-store" | "none" }`. The SDK's launch `CURSOR_API_KEY` override wins over its
store; its value is never sent to clients. SDK sign-in is separate from editor or
ACP CLI sign-in. Login drains cached selected-instance hosts before changing the
store. Sign-out fences new sends, cancels any browser exchange, drains selected
hosts and calls SDK logout. Only the SDK credential file is deleted; checkpoints
and ace history remain. Sign-out does not revoke a key in Cursor's dashboard,
and environment authentication remains active until the launch value is removed.

Selection persists only the default account ID. New `thread.create` requests pin
that account at command acceptance; an optional `instanceId` selects another
account explicitly. Changing the default leaves existing threads pinned to
their original instance/backend. Resume cannot move checkpoints across accounts.
A signed-out thread requires reauthentication of that account or an explicit new
thread with bounded context handoff. Model cache entries are invalidated after
authentication changes, and catalog workers use the selected account's narrow
environment policy and shared host capacity.

Offline socket/process behavior tests are written but **need run at merge**.
Actual browser sign-in is a separate owner action and is never a model fixture.
