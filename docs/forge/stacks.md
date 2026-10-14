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
that UUID too. Only a validated native result qualifies for the HTTP 409
exception; an ordinary conflict response is a definite refusal and permits a
reviewed retry after restart. `enqueued` is an acknowledgement, not a merged result. Later reads
inspect layer states for completion or queue ejection. After a lost acknowledgement
or expired result, ace reconciles host facts and blocks a repeated write while
the outcome remains uncertain. Records remain visible when native membership
changes or disappears. Saved scope PRs are queried independently of native
membership to distinguish continued queuing, completion, ejection and unresolved
access. Receipt versions are captured before host I/O and reconciled once through
a compare-and-swap. The shared forge transport owns per-write certainty. A
command that cannot spawn or a definite host refusal settles as failed, while
a dispatched write with a lost acknowledgement stays uncertain. A direct merge of independent PRs is never used to emulate
a native stack operation. Native stacks have no auto-merge control.

## Rebase and recovery

Local actions require the installed `gh stack` extension, a matching stack in the
selected task checkout and an `origin` pointing at the selected repository.
`gh stack view --json` supplies local branch revisions and PR identities. Before
execution, ace re-reads both host and local revisions, verifies their relationship,
and summarizes all active layers. No extension is installed automatically.

ace invokes `gh stack rebase --remote origin` for local changes only. The
extension owns worktree locks, clean-checkout checks and conflict state. Because
it may coordinate branches in other local worktrees, the confirmation covers the
whole active stack. Commands are bounded and cancellable through the forge runner.

A successful local rebase is a visible `push_partial` outcome: the branches are
rebased and nothing is pushed. ace never invokes `gh stack push`. That command
fetches its own leases, so it can accept and overwrite collaborator commits
absent from the rebased history.

Resolve and stage conflicts, then explicitly confirm Continue local rebase or
Abort rebase. Abort invokes `gh stack rebase --abort` without a push. Recovery
stays with the task checkout that started the operation. If membership or topology
no longer matches, recover local changes in the installed CLI. Nothing marks an
agent tree done or changes its lifecycle.

## Publishing a rebased stack

Publish stack lists every active layer whose local head moved, with the revision
GitHub had when the rebase was confirmed and the rebased revision. Confirming it
runs one Git push through the daemon's Git owner (`GitService.pushLeased`):

    git push --atomic --porcelain \
      --force-with-lease=refs/heads/<layer>:<reviewed sha> ... \
      -- origin <rebased sha>:refs/heads/<layer> ...

The decision rules are pure (`@ace/forge/stack-publish`):

- **Leases.** Each lease is the host revision recorded when the rebase was
  confirmed, never a freshly fetched value. Continue and Publish requests must
  carry the same reviewed revisions as the recorded rebase. A refreshed request
  carrying a newer GitHub head is refused without a push.
- **Preflight.** GitHub must still report those revisions. The local stack must
  match the host layers and be restacked: no layer needs a rebase, and each layer's
  base is the head of the layer below it. Unmoved layers are left out.
- **Destination.** Every push URL of `origin` must name the selected repository.
  The pushed source is a commit ID, not a branch name, so a branch moving after
  review cannot change what is published.
- **Outcome.** Git's porcelain report decides the result. All layers accepted
  becomes `rebased`. Any rejected layer, such as a stale lease or a protected
  branch, becomes `failed`: the push is atomic, so nothing moved. A missing report,
  lost connection or restart becomes `uncertain`.
- **Reconciliation.** An uncertain publication settles from GitHub's layer heads.
  All at the rebased revisions becomes `rebased`; all still at the reviewed
  revisions becomes `push_partial`. Publishing again is safe, because the leases
  refuse any layer that already moved.

- **Moved layers.** While a rebased stack waits to be published, or after a
  publication was refused or never confirmed, every stack read compares GitHub's
  layer heads with the reviewed revisions (`stackLayersMovedSinceReview`). A layer
  at any other revision than the reviewed or the rebased one carries commits the
  local rebase lacks. The workspace lists it with both heads and disables Publish
  until those commits are brought in. Merged layers and a different native stack
  are not compared.

## Bringing collaborator commits into the stack

While moved layers are listed, **Bring in GitHub commits** lists each moved layer
with its commit range (`reviewed..current`). Confirming it runs a sync in the task
checkout that holds the rebase. Nothing is pushed.

1. **Preflight** (`planStackSync`, pure). GitHub must still report the heads the
   person confirmed, and the checkout must still hold the restacked layers they
   saw. Merged layers, queued layers and a different native stack are refused.
2. **Fetch.** Through the daemon's Git owner, each moved layer's branch is fetched
   from `origin` into its remote-tracking ref. If GitHub's head has moved again,
   the sync is refused, and the person reviews the newer head first.
3. **Replay** (`GitService.replayStackLayers`). Each new head must contain the
   reviewed revision. A force-pushed layer is refused, and so is one that gained
   merge commits. Recovering either stays with `gh stack`. Every collaborator commit
   is cherry-picked onto the local rebased layer, top layer first. Commits whose
   changes are already present are kept as empty commits, never dropped. Repository
   hooks don't run.
4. **Restack.** From the lowest moved layer, `gh stack rebase --upstack --remote
origin` replays the layers above it. gh stack owns their saved bases, so its view
   of the stack stays consistent.
5. **New review point** (`reviewAfterSync`). The confirmed GitHub heads become the
   reviewed revisions. The next Publish needs a fresh confirmation and leases each
   layer to those heads.

A conflict in either step stops as `conflict`. Resolve and stage the files, then
**Continue sync**. Continue finishes the cherry-pick (or runs `gh stack rebase
--continue`) and runs the remaining steps. **Abort sync** clears any cherry-pick
or gh stack restack and resets every layer to its recorded rebased head. The moved
layers are then listed again. The record stores the sync's progress and the
recorded heads. A restart, or a step that ends without a result, settles as
`uncertain`, and Abort is then the only recovery offered.

## Sources and verification

These contracts follow GitHub's [stack GraphQL types](https://docs.github.com/en/graphql/reference/pulls),
[required check contexts](https://docs.github.com/en/graphql/reference/commits),
[asynchronous merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously)
and [stack CLI commands](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands).
The JSON interface and exit codes are documented in the official extension's
[CLI skill reference](https://github.com/github/gh-stack/blob/main/skills/gh-stack/SKILL.md).
Publication follows [`git push`](https://git-scm.com/docs/git-push)'s
`--atomic`, `--force-with-lease=<refname>:<expect>` and `--porcelain` contracts.
Syncing follows [`git cherry-pick`](https://git-scm.com/docs/git-cherry-pick)'s
`--allow-empty`, `--keep-redundant-commits` and `--continue`/`--abort` contracts.
The implementation is written fresh from those interfaces.

Behavior tests use real child processes with a fake `gh` at the process boundary,
temporary Git repositories, SQLite restarts and routed UI interactions. Publication
tests push to a real bare repository that stands in for GitHub. Tests and
the full repository typecheck must run in CI. Local verification is restricted to
formatting, lint and sequential typechecks of the changed packages because this
machine is shared.
