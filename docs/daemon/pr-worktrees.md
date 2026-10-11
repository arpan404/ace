# Working on a pull request

The repository PR list, PR workspace and linked-PR menu offer **Work on PR**. A new task opens the normal project and provider composer with a PR description. Its environment shows the selected PR head and requires an isolated worktree. The PR workspace also lets the person select an existing task in that project. Agents, background tasks and terminals must stop before the task switches checkouts.

The daemon reads GitHub metadata through the person's installed, authenticated `gh`. It matches a configured Git remote to the PR's base repository, checks the source branch, and fetches `refs/pull/<number>/head` through `@ace/git` into a private ref. This supports fork PRs without checking out the person's root or changing its index, branches or dirty files. Fetches have a deadline, accept cancellation and never fall back to a cached PR head.

Preparation pins the selected SHA, creates an owned worktree and runs the project's existing setup scripts. It rechecks the hosted head/base and local HEAD before admission. Deleted or inaccessible source branches and changed heads fail visibly. PR preparation offers cancellation and retry, with no fallback to a local checkout. An existing task retains its previous checkout, including its edits.

The thread's `details.pullRequestWorkspace` records the verified repository, head/base SHAs, source branches and bounded review context. PR links use the existing forge link owner. The link and context commit with admission before the first provider prompt. Later workspace switches clear verified PR checkout metadata.

Existing-task preparation uses the engine's durable workspace reservation. Preparation and uncertain recovery keep the thread waiting on its queue. A failed operation leaves the previous binding and a visible progress record; a fresh Work on PR intent can recover it. Command receipts prevent reconnects from replaying a completed or uncertain operation. Repeating the same verified selection reuses the bound checkout. The creation journal owns unadmitted worktrees across restarts and never removes an admitted task's checkout.

This flow reads GitHub and prepares local Git resources. It does not push or perform a remote PR mutation. Merge, review, comment and CI action workflows can extend the PR workspace separately.
