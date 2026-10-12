# Orchestration from an agent

ace injects the same scoped MCP server into each supported local provider CLI.
The session lease identifies the calling thread and agent. Tools cannot choose
another caller, collect provider credentials, or approve permission requests.

Start with `ace_agents_catalog`. It reads the same live catalog as the composer,
including configured models and account-specific discovery. Models expose their
native/execution IDs, reasoning efforts and service tiers. Instances expose
installation, auth, availability, supported launch options and native permission
modes. Stale and unknown states stay explicit. `allowedPermissionModes` and
`allowedDefault` describe the caller's permission ceiling, not authentication or
remaining quota. Admission checks those separately.

Page models with `nextOffset`, instances with `nextInstanceOffset`, and a selected
instance's modes with `nextPermissionOffset` as `permissionOffset`. Use provider
and instance filters to inspect one account. Pages omit raw provider data, account
homes, environment variables and credentials. Discovery reads retained metadata;
it does not start a conversation to inspect capabilities.

## Child work

Use `delegate_task` for work whose completion belongs to the calling thread.
Choose `provider`, optional `accountId`, `model`, `options` and `permissionMode`.
Generic ACP selections also require their source-qualified agent, installation
and instance identity from the catalog. Use a stable `requestId` for retries.

```json
{
  "requestId": "review-auth-1",
  "provider": "claude",
  "model": "<catalog model ID>",
  "role": "reviewer",
  "task": "Review the authentication change and report actionable findings",
  "permissionMode": "plan",
  "workspace": { "kind": "project" }
}
```

Delegation is async by default. The reply contains the child `threadId`.
`waitMs` observes for at most four minutes; expiry returns that identity without
cancelling its work. The older `wait: true` uses the same four-minute bound.
Completion is delivered as durable ace context in a queued `subagent_result`
parent turn, with near-simultaneous results coalesced. Parents need not poll.

- `ace_agent_status` reports working, waiting on human, waiting on children,
  result available, failed or cancelled. It uses whole-tree canonical status.
- `ace_agent_result` reads the settled result without consuming its parent wake.
- `ace_agent_message` sends another task to the same child and preserves its
  generation accounting, model and permission ancestry.
- `ace_agent_cancel` requests cascading cancellation. Read status for confirmation
  that the complete tree has stopped.

Large outcomes contain a preview and a transcript cursor. `ace_thread_read`
returns a bounded timeline page; continue with `itemsBefore` as `before`.
Retained text sources can be paged with `ace_thread_read_output` in byte ranges.
The legacy spawn, agent list, wait and thread-info tools remain available.

## Ordinary conversations

`ace_threads_list` lists or searches the calling thread's project, with an opaque
cursor. A cursor belongs to its exact query and project. `ace_thread_read` reads
the state and timeline of an authorized thread.

Use `ace_thread_start` for an ordinary top-level conversation. It requires a
title, initial text, provider selection, stable request ID and workspace strategy.
It records durable caller ownership and permission ancestry, but does not attach
a child agent to the caller or deliver a result wake. The caller can finish while
the conversation continues. Use `delegate_task` when that work must hold the
parent open.

Ordinary conversations share the caller's admission budget. Their own usage and
child usage count through the same provider counter accounting as delegations.
Durable activity leases keep token/cost limits and the original elapsed deadline
in force after reservation release, across completed turns and daemon restart.
Queue, steer, restart, resume and model switches must pass admission again.
A budget breach cancels the participating conversations and child trees. Stopping
the caller alone does not stop ordinary conversations or disable their deadlines.
Budget membership grants no write authority and creates no completion wake.
Accounting counters and replay positions commit together. Startup replays missed
local run/usage events before admission, including usage committed just before a crash.

Workspace strategies are explicit for conversation launch, optional for children:

- `{ "kind": "project" }` selects the project's registered root.
- `{ "kind": "new_worktree", "base": { "ref": "main", "remote": "origin" } }`
  prepares a daemon-owned worktree through the existing Git creation owner.
  Omit `remote` for a local branch. Agent preparation never fetches. A remote base
  must already exist at `refs/remotes/<remote>/<ref>`; fetch it in ace first if
  preparation reports that the branch is missing. Creation and failed-acceptance cleanup survive
  restart. Capacity is reserved before Git effects.
  Agent requests skip automatic setup scripts. Preparation and compensating
  cleanup use the shared Git policy that disables hooks, fsmonitor and configured
  filters, including LFS. It also disables lazy object fetching and denies Git
  transports, including child promisor fetches. Missing objects fail locally; fetch
  them in ace before retrying. Retained checkouts keep this policy across owner restart.
  User-requested push and fetch use separate transfer entry points that keep hooks,
  fsmonitor and filters disabled while allowing only HTTP, HTTPS and SSH.
- `{ "kind": "existing_worktree", "path": "/absolute/registered/path" }` reuses
  a worktree registered to that Git project. Arbitrary directories are rejected.

`ace_thread_message` accepts `queue`, `steer` and `restart`. Steering follows the
provider's existing fallback to queue. Restart atomically accepts a cascade
interrupt and replacement input, clears obsolete recovery holds and puts the
new input before retained queued messages. Retrying its request ID cannot issue
another interrupt or duplicate its input. Descendant child work is cancelled;
pending preparation signals are cancelled and their durable reservations revoked,
so an obsolete child cannot launch after restart acceptance;
the target thread remains available for the replacement turn.

`ace_thread_interrupt` stops an owned thread tree. `ace_thread_configure` changes
an owned thread's catalog model and launch options through the existing engine
switch lifecycle, preserving its provider and account. Acceptance is not proof
that the switch has applied; inspect the thread's `switch` and `execution` state.
Reads may inspect other conversations in the same project. Writes require the
calling thread, its children or its durably owned launched conversations.

## Permission ceilings

Native sandbox and approval selections are ace's runtime modes. Children and
launched conversations capture the caller's ceiling; later caller settings cannot
raise that captured ceiling. The engine checks creation, permission changes and
session resolution, including provider/model transitions. Catalog risk labels
are display metadata and are never used as a containment ordering.

Opaque modes require the same agent, approved installation, account instance and
backend. The captured identity survives restart. Older ceiling records without
that identity fail closed rather than inferring it from later caller settings.

Known unrestricted native CLI modes can launch any native policy. Pi has no native sandbox
or permission mode, as recorded in ADR 0050; its process has the user's OS rights.
Conservative same-provider reductions are supported. Other cross-provider policies
or unknown CLI defaults fail closed when containment cannot be established.
Select a known caller mode in ace before using those launch paths. ace MCP tools
keep their own consent checks regardless of the provider's native mode.
