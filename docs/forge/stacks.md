# Native GitHub stacks

The PR workspace reads native membership independently of task associations.
GitHub supplies the stack ID, trunk and entry positions. List pages and linked
PR controls group only members confirmed by GitHub. Opening another layer never
links it to a task, so manually unlinked layers stay unlinked.

Stack reads use the user's authenticated `gh api graphql`. They include at most
100 layers. A second bounded query reads up to 20 reported check contexts per
layer and evaluates `isRequired` for that layer's PR number. The workspace shows
truncation, review decisions, merge blockers and queue state. Missing reports do
not establish that all rules passed. GitHub enforces the complete trunk rules.
Unknown provider fields remain in redacted raw data. No credentials enter ace's
storage or protocol.

## Merge

The confirmation lists the selected layer and all downstack layers, the trunk
and the merge method. Execution re-reads stack identity, ordered PR numbers and
every head revision. A changed dependency, removed layer or closed layer requires
a refreshed confirmation. The daemon checks the linked task's current operation
authorization immediately before the write.

There is one native `PUT /repos/{owner}/{repo}/pulls/{number}/merge-async`, with the
selected head SHA, `merge_action: default` and `bypass_rules: false`. GitHub applies
branch protection and chooses its merge queue when configured. The API guards the
selected head atomically; the all-layer comparison is a preflight check, not a
claim that the API accepts a revision lock for every layer.

The daemon records an operation before submission, persists its UUID, and polls
the documented result endpoint. An existing pending request's HTTP 409 returns
that UUID too. `enqueued` is an acknowledgement, not a merged result. Later reads
inspect layer states for completion or queue ejection. After a lost acknowledgement
or expired result, ace reconciles host facts and blocks a repeated write while
the outcome remains uncertain. Records remain visible when native membership
changes or disappears. A direct merge of independent PRs is never used to emulate
a native stack operation. Native stacks have no auto-merge control.

## Rebase and recovery

Local actions require the installed `gh stack` extension, a matching stack in the
selected task checkout and an `origin` pointing at the selected repository.
`gh stack view --json` supplies local branch revisions and PR identities. Before
execution, ace re-reads both host and local revisions, verifies their relationship,
and summarizes all active layers. No extension is installed automatically.

ace invokes `gh stack rebase --remote origin`, followed by
`gh stack push --remote origin` only after a successful rebase. The extension owns
worktree locks, clean-checkout checks, conflict state and per-branch
force-with-lease protection. Because it may coordinate branches in other local
worktrees, the confirmation covers the whole active stack. These commands are
bounded and cancellable through the existing forge process runner.

A conflict stops before push. Resolve and stage files in the checkout, then
explicitly confirm Continue rebase and push, or Abort rebase. Abort invokes
`gh stack rebase --abort` without a push. A failed or interrupted push can publish
some branches. It exposes a separate Retry stack push action after refreshing
both host and local revisions. Recovery stays with the task checkout that started
the operation. If stack membership or checkout topology no longer matches, the
workspace explains that recovery must finish in the installed CLI. Nothing marks
an agent tree done or changes its lifecycle.

## Sources and verification

These contracts follow GitHub's [stack GraphQL types](https://docs.github.com/en/graphql/reference/pulls),
[required check contexts](https://docs.github.com/en/graphql/reference/commits),
[asynchronous merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously)
and [stack CLI commands](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands).
The JSON interface and exit codes are documented in the official extension's
[CLI skill reference](https://github.com/github/gh-stack/blob/main/skills/gh-stack/SKILL.md).
The implementation is written fresh from those interfaces.

Behavior tests use real child processes with a fake `gh` at the process boundary,
temporary Git repositories, SQLite restarts and routed UI interactions. Tests and
the full repository typecheck must run in CI. Local verification is restricted to
formatting, lint and sequential typechecks of the changed packages because this
machine is shared.
