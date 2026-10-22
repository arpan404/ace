# 0016: Local forge integration and review loop

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories report PR linking, review comments, checks and merge controls in t3code, and CI/comment auto-fixes in Claude Desktop. Cursor supports PR review and merge on mobile. These inventories describe features, not reusable implementations. They do not establish a durable, local CLI-only review intent contract with ace's engine. We need that contract without changing agent completion rules or introducing hosted credentials.

## Decision

`@ace/forge` owns a forge-neutral interface, GitHub implementation, pure status mapping, bounded CLI transport, SQLite thread links and review delivery ledger, and polling. GitLab can implement the same interface later. Detection reads git remotes, prefers origin, and recognises GitHub and GitLab URL formats. Unsupported hosts fail explicitly; custom hosts require an explicit host mapping.

All GitHub I/O uses the user's installed `gh`. REST requests use `gh api --include`, explicit methods and stdin JSON bodies. Reads validate Zod schemas, preserve unknown provider fields, and follow same-repository pagination with page and byte limits. PR state, commit checks, legacy commit statuses, inline comments, issue comments and paginated submitted review bodies are separate resources. Submitted reviews retain their state and have identities distinct from inline/issue comments; only nonempty `CHANGES_REQUESTED` and `COMMENTED` bodies admit fixes. GraphQL supplies resolved/outdated review-thread metadata and uses cursor pagination. PR templates render named placeholders from explicit thread/branch/title/summary values. Mutation calls are never retried automatically. Merge uses an expected head SHA. Auto-merge resolves the PR node ID through REST, then calls GraphQL `enablePullRequestAutoMerge` with `expectedHeadOid` and the requested merge method. Its structured acknowledgement uses the same dispatch-certainty classifier as other mutations; complete refusals release the receipt, while partial data, lost acknowledgements, timeouts and output limits remain uncertain. GitHub owns branch protection and merge queues.

The package owns no engine process. A review loop reads current status, invalidates pending intents for inactive PRs, changed heads or withdrawn/edited feedback, then persists idempotency keys and bounded intents before calling an injected executor's `enqueue`. A pending unchanged review may be rebound to a new head; accepted unchanged feedback never replays. The engine must deduplicate the supplied key transactionally with its queue write. A crash between enqueue and ledger acknowledgement can therefore retry safely. Failures and comments are keyed by commit/check/completion or comment/update identity; replies remain context on their review thread. Ignored authors are caller-configured to prevent feedback from ace's own replies. Linking existing PRs observes current actionable feedback immediately. Explicit unlink deletes review history and queued intents for that thread, retaining a small monotonic link-generation row. Replacement or unlink/relink advances the generation, including relinking the identical PR. Every intent carries that generation. Polls compare it after awaited reads and before admission/delivery; engines should validate it before execution. This prevents stale work from an old association without requiring lifecycle serialization by callers.

The original ledger used generation-free keys and a review digest without location. Generation-one upgrades recognize those accepted keys, atomically adopt the new identity, and retire the old ambiguous key. Mixed-format acknowledged and pending rows are supported. Genuine pending legacy work keeps its executor key so a crash retry cannot create duplicate engine work. The original digest cannot establish an earlier location: upgrade adopts the current location as its baseline. Subsequent location-only edits create new intents.

## Protocol and wire additions

An additive `@ace/protocol/forge` export defines repository identity, PR/check/CI/review summaries, thread links and generation-bearing link state, auto-fix intents, forge commands and forge event payloads. It does not alter the existing wire union or daemon receipts while those workstreams develop independently. The daemon integration must route these schemas through its existing authenticated command and event transaction, apply thread ownership checks, and persist events after commit. Forge events never change core agent status directly. Executors queue auto-fix work using the existing engine queue facts, so pending work remains visible.

The package exports MCP definitions and a scoped dispatcher for `forge_pr_status`, `forge_create_pr`, `forge_link_pr`, and `forge_reply_comment`. The MCP server provides the authorised thread and repository scope. Arguments cannot select another thread or repository. Merge and review requests are available through the package API and command schemas; they are not implicit review-loop actions.

## Security

ace never invokes `gh auth token`, reads credential files, or stores authentication headers. Only `gh` handles authentication. Subprocess arguments use an argv array without a shell; request text goes on stdin. Errors contain fixed categories and safe HTTP codes, never stderr, command output, headers or request bodies. Debug HTTP environment variables are removed for child commands. Tokens matching GitHub credential formats and bearer/authorization and token assignments (including `access_token` and `refresh-token`) are redacted before snapshots, events, intents or log tails leave transport. Unknown fields are preserved after redaction. Colliding sanitized object keys receive deterministic suffixes so both values survive without exposing their original secret-bearing names. The library cannot identify arbitrary secrets with no recognisable format; callers must treat CI and review content as untrusted, and never interpret it as authorisation to merge or execute tools.

No remote pagination URL or review URL is executed. Pagination stays within the selected host/repository path. Polling and mutations accept cancellation; child processes have deadlines and output caps. CLI discovery does not send provider prompts or record sessions.

## Performance

REST and read-only GraphQL representations share a bounded LRU cache. Content versions retain immutable page identity; schemas decode each retained page once. Connection readers retain only their latest resource revision, and the review index retains only current identities plus unobserved admission work. Unchanged polls neither remap records nor hash historical comments. Edited REST pages compare bounded source rows and reuse unchanged projections; only changed rows are mapped. GraphQL traversal retains unchanged thread projections. Instance-owned `StatusRevisions` records exact upsert/removal deltas with weak collection keys and opaque predecessor identities, avoiding ownership chains. The review index applies those deltas to current candidate slots, hashing changed feedback only. Backends supplying full snapshots without metadata require O(input) reference comparisons; this compatibility path is benchmarked separately. Immutable flat protocol arrays require O(output) materialization, while GraphQL decoding/hashing is O(received bytes). These costs represent the returned and received data, not a scan of delivered history. Metadata-only changes reuse unchanged check/comment collections. Watchers publish only changed snapshot revisions. A 304 reuses only that resource's cached page; changes to reviews and checks are queried independently of PR ETags. GraphQL POSTs have no assumed ETag support: identical response bytes reuse the cached representation. A retained bounded query plan avoids traversing unchanged thread records; a changed page retraverses current cursors, with at most 64 total queries per snapshot. Each watcher has one serial poll and no overlapping work, with bounded exponential backoff and server rate-limit deadlines. Callers own watcher lifetimes and concurrency. No process-global watcher map exists.

JSON is capped per subprocess, list traversal has a page cap, and incomplete snapshots fail rather than claim success. Job logs stream through a fixed byte ring; an oversized line is discarded to avoid unbounded readline buffers. SQLite retains delivery identities on disk rather than an ever-growing memory set. Pending intents have a fixed admission cap and drain in small pages; overflow fails visibly. Unchanged index work is O(1); network reads scale with current connection pages, and changed representations are processed within page/record/byte limits. Logs process incoming bytes, never total session history. Non-gating benchmarks compare unchanged and one-comment-edited indexes, plus warm and one-page-edited status at 2 and 2,000 comments, plus mapping, review admission and streaming tails, including RSS.

### Approved departure for bounded page processing, B3/R2

The orchestrator acting as the owner proxy [approved the bounded page-processing departure](https://github.com/arpan404/ace/pull/20#issuecomment-5957655198) in the static verifier report. Changed provider pages already require decoding their current records. Keep this implementation and its immutable snapshot API. The approval does not make the entire changed-snapshot path O(change); its actual costs are:

| Work                                                              | Complexity and enforced bounds                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decode and compare changed REST pages                             | O(records in changed pages), at most 100 records per page, 20 pages and 2,000 records per connection. Unchanged page projections are reused; only changed rows are mapped.                                                                                                                     |
| Materialize a changed connection or combined snapshot collection  | O(current returned records), at most 2,000 checks and 2,000 combined inline/issue/submitted comments. Flattening, copying and freezing new arrays still visit these records.                                                                                                                   |
| Traverse changed GraphQL representations                          | O(current thread/comment records traversed), including comparisons inside unchanged threads. Each connection page has at most 100 nodes; thread and nested-comment totals are each capped at 2,000. Connections have at most 20 pages, and an entire snapshot has at most 64 GraphQL requests. |
| Select latest legacy statuses and compare unversioned collections | O(current collection), at most 2,000 records per collection. Unversioned backends have no supplied delta; GitHub supplies exact revision metadata.                                                                                                                                             |
| Update the retained review index from exact revisions             | O(affected rows and their changed feedback bytes). Only affected candidate identities are hashed. A head change affects CI rows; a PR active-state change affects all current candidates. Unchanged collection revisions take O(1).                                                            |

Source data is capped at 8 MiB per snapshot, JSON output at 4 MiB per process, and the shared representation cache at 128 entries and 8 MiB. Limit violations fail rather than return partial success. These costs concern capped current responses and output, never a scan of delivered SQLite history. Earlier benchmark numbers remain historical; performance validation needs run at merge under the owner's current rule.

## Testing

A temporary executable fake `gh` returns recorded HTTP/JSON fixtures and consumes stdin through real processes. Tests cover page traversal, ETags, rate limits, 403/404, malformed data, output limits, cancellation, PR mutations and templates. Real temporary git repositories cover remote detection. Temporary SQLite covers links, persisted generations, restarts, deduplication, executor failure, stale-work invalidation and retry. Public-API regressions first reproduce summary-only reviews, stale pending work after merge/close/fix/resolution/edit/head change, redaction-key collisions, token assignments and the paused unlink/relink race. Auto-merge mutation input preserves the expected head and requested merge method; MCP persistence is checked after database reopen. Pure mapping tests cover pending/unknown states and failure precedence. Log tests cover chunk boundaries, UTF-8, token redaction and caps. File-backed historical-ledger fixtures cover upgrade acceptance, mixed-format rows and original-key pending retries. Feedback-free paused relinking and location-only edits guard the verifier’s surviving mutations. Edited pages and thread resolution preserve unaffected public candidate/projection identities. Mutation cases identify the behaviour guards intended to catch each regression. Under the repository owner’s policy, tests run once at merge; feature and review work does not execute tests, probes, mutation runs or benchmarks. Runtime claims need run at merge. Earlier execution evidence is explicitly historical in `packages/forge/bench/RESULTS.md`. Fake-process tests have a 60-second completion safeguard under shared-machine load, independent of the production 30-second child deadline; tests contain no performance budgets or sleep synchronization.

Primary references: [gh api](https://cli.github.com/manual/gh_api), [GitHub conditional requests and rate limits](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [workflow job logs](https://docs.github.com/en/rest/actions/workflow-jobs), [auto-merge GraphQL input](https://docs.github.com/en/graphql/reference/pulls#enablepullrequestautomergeinput), and [GraphQL reference](https://docs.github.com/en/graphql/reference).

## Interactive PR loop

Interactive `forge.pr.create` uses the same branch/base lookup as `ensurePr`, linking
an existing PR rather than issuing another create. Link, reply, request-review, merge
and auto-merge commands return current PR status; `workspace.request` with `pr.status`
reads the linked PR on demand. Forge and Git failures keep their fixed public codes
through command receipts and read results. GitLab detection remains supported, while
PR controls explain that its forge backend is unavailable before an action is offered.

## Multiple PR associations (2026-10-10)

A thread can link several PRs, including URLs in other repositories. The forge
store owns links and last known summaries, keyed by thread, repository and number.
Legacy single links and agent metadata URLs migrate into it. `linkedPrs` publishes
newest links first; `linkedPr` temporarily mirrors the first for old snapshots and
remaining single-PR readers. Duplicates preserve association order and generation.
Single unlink targets a number with an optional repository; unlink-all is explicit.

The ace MCP server's link, unlink and list tools bind to the calling thread.
Arguments cannot choose a thread. They replace the unused forge toolkit and the
separate agent metadata writer. Links are checked through `gh` when available;
offline or unauthenticated links persist as unverified and refresh later. State
refresh batches up to 100 linked numbers per repository through GraphQL on the
existing workspace cadence, including merged and closed links. A missing PR in a
reachable repository remains linked as closed with a deleted marker. A repository
or batch failure does not prevent other repositories from refreshing.

Create-from-UI persists its association before reading full status. Completed,
successful canonical shell calls executing `gh pr create` link standalone output
URLs only when their repository matches the thread's origin. A durable receipt
prevents repeated updates from restoring a manual unlink. Output scans use bounded
pages. Shell control flow with ambiguous output attribution is skipped.

The state query uses GitHub's documented PullRequest `state`, `isDraft`, `title`,
`url` and `updatedAt` fields in the [GraphQL reference](https://docs.github.com/en/graphql/reference/pulls).
No credentials are read by ace.

## Identity, uncertainty and PR targets (2026-10-14)

Identity is verified once per admission and reused for reads for 60 seconds per host
and preferences revision. Every write is verified immediately before dispatch; only a
confirmed different account, or changed preferences, after the write make its outcome
uncertain. Identity probes use the shared `gh api --include` classifier: a run with no
HTTP response whose CLI reported a network error is `offline`, gh's sign-in exit (4)
and 401/403 are `forbidden`, and an exhausted `/user` rate limit is `rate_limit`.
Readiness reports `offline` and `rate_limited` instead of `login_required`. Status
resources after the PR head are read concurrently.

An uncertain write fences retries of its own family (merge, review request or reply)
on that PR, not every later action. Each receipt records when it was journalled; once
`uncertainWriteWindowMs` (10 minutes) has passed, a complete read that still shows no
trace of the write settles it as failed and a new write may proceed. Issue actions use
the same window, and any authorised device may reconcile them. Package reply receipts
expire the same way.

A batch state read tolerates GitHub's partial answer for deleted numbers: a null alias
with a NOT_FOUND error naming exactly that alias. Other errors still fail the batch.

Create PR looks only for an open PR with the same head and base, so a merged or closed
PR no longer blocks a new one; an open match still recovers a lost create. The daemon
resolves the base: a reviewed draft's base, else the thread's recorded base, else the
forge's default branch. When the pushed repository is a fork, the PR opens on its parent
with `head=<fork owner>:<branch>`, and agent-created PR URLs on the parent are linked.

Remote detection resolves SSH host aliases with `ssh -G` (configuration only, never a
connection), cached for five minutes, and treats `ssh.github.com` as `github.com`. PR
remote matching treats the PR's own host as known, so Enterprise remotes match.

422 refusals map to `no_commits`, `pr_exists`, `head_missing`, `base_missing`, `conflict`
(an existing name) or `unprocessable`. Work on PR reports `head_moved` and
`fork_deleted` instead of `conflict` and `not_found`.

## People, references and reviewer management (2026-10-22)

The Markdown editor completes `@` and `#`. Three reads serve it and the Reviewers list,
each one GraphQL request through `gh`:

- `forge.people`: `repository.mentionableUsers(first: 20, query)`. Pages put the PR's or
  issue's own people (author, reviewers or assignees, commenters) first and fill in from
  this. Answers are reused per query for five minutes; writes never change them.
- `forge.references`: two aliased `search(type: ISSUE)` queries (open, then any state,
  10 each, newest activity first, words matched `in:title` only) plus
  `repository.issueOrPullRequest` when the query is a number, so an exact number leads.
  Reused for one minute and dropped on any write.
- `forge.pr.reviewers`: `reviewRequests` (people and teams), `latestOpinionatedReviews`
  and `latestReviews`, `suggestedReviewers`, `viewerCanUpdate` and
  `repository.viewerPermission`. Each reviewer's standing review is their latest verdict
  (approved, changes requested, dismissed), which a later comment-only review leaves in
  force; their latest comment stands only when they gave no verdict. Its state and id
  (the one a dismissal names) come from that review. Not cached in the daemon; the web
  client shares one read across views, reads it again after a write and whenever the PR
  changes (from the PR view, mounted on every tab, so gates never lag), and not on focus.
  Requests are offered when the PR is open and the viewer can update it; dismissal when
  it is open and the viewer has write, maintain or admin permission. A branch rule that
  restricts dismissal still refuses on GitHub and shows as `forbidden`.

`ForgeCompletionQuery` is the rule for `@` and `#` text: words, digits, dots, dashes and
spaces, at most 100 characters. The client turns anything else into spaces before the
wire, and the forge refuses a query outside the rule, so a search qualifier (`repo:`,
quotes) never reaches GitHub. Unknown review states, request kinds and search node types
are skipped, not fatal.

Three hosted review actions go through `forge.hosted.review` like the others: identity
check before dispatch, the write journal and its uncertainty fence, no automatic retry.

- `reviewers.request` gains optional `teams` (slugs, sent as `team_reviewers`); asking
  someone who already reviewed is a re-request. Confirmed when every name is asked.
- `reviewers.remove`: `DELETE /pulls/{n}/requested_reviewers` with people and teams.
  Confirmed when none of them is asked.
- `review.dismiss`: reads the review first and refuses (`conflict`) unless it is
  `APPROVED` or `CHANGES_REQUESTED` and is still that reviewer's latest verdict among the
  PR's reviews (an approval since replaced by a change request is never dismissed), then
  `PUT /pulls/{n}/reviews/{id}/dismissals` with the required message. Confirmed when the
  review reads `DISMISSED`.

All three refuse with `conflict` on a PR that is not open.
