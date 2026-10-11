# Auto-merge and merge queue

The PR workspace and linked thread controls read auto-merge and queue state through a separate bounded
`forge.pr.merge-state` resource. This keeps failures in newer GitHub capabilities
visible without preventing the conversation, checks or files from loading.
Reads poll while the workspace is open and refresh after reconnect. Cached state
is never used to decide that a mutation succeeded.

`forge.pr.merge-state.change` is a durable explicit command scoped to an existing
thread association. It checks the selected head and GitHub capabilities before
writing through the installed `gh api` process. Enabling auto-merge supplies
`expectedHeadOid`. Disable and dequeue are separate GraphQL mutations. GitHub does
not expose an expected revision on those cancellation inputs, so ace checks the
head immediately before the mutation; GitHub still enforces its permissions.

A complete mutation acknowledgement is persisted before later state reads. If a
read fails, that accepted receipt remains accepted and the workspace asks for a
refresh. Only the shared forge transport can prove a definite refusal or that
nothing was sent. A later read failure cannot change the mutation's certainty.

After a lost acknowledgement or partial GraphQL result, ace reads authoritative
state without retrying the mutation. An unresolved outcome stays visible through
an uncertain receipt, including after a new command ID or daemon restart. A read
that confirms completion clears that fence. A complete refusal and an unsent
spawn failure settle as failed and permit a reviewed retry. Reads capture the
receipt generation before host I/O. Pending or uncertain writes keep controls
disabled across reloads. The legacy `forge.pr.auto-merge` command and
`enableAutoMerge` API use the same guarded merge-state owner.

GitHub's capability fields decide auto-merge availability. Check rollup, review
decision and merge-state status describe blockers without pretending to enumerate
all repository rules. Queue cancellation requires repository write permission;
GitHub makes the final authorization decision. Unknown states and provider fields
remain available as bounded, redacted raw data.

Primary contracts:

- https://docs.github.com/en/graphql/reference/mutations
- https://cli.github.com/manual/gh_api
- https://cli.github.com/manual/gh_pr_merge

Behavior tests cover state, cancellation, queue ejection, external disablement,
changed heads, CLI/GraphQL failures, lost acknowledgements and durable receipts.
They are not executed during development under the shared-machine policy. CI
must run tests and the full typecheck before merge.
