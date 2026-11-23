# `@ace/forge`: observable behaviour and invariants

The contract any implementation of `packages/forge` must keep, as of `ace/rust-git-forge`
e344219b2b (2026-11-23): the package's 15 entry points (`packages/forge/package.json:6`), the
daemon and client code that call them, and the rules they hold. Each rule cites the code that
holds it. The last section classes every test file.
[ADR 0224](../adr/0224-git-and-forge-move-to-rust-behind-the-same-interfaces.md) moves it to Rust (the
owner's decision, 2026-11-23), driving the same CLIs; this document is the contract both
implementations keep. [porting-guide.md](porting-guide.md) is for the builders.

Terms:

- **Host**: a git hosting service: GitHub (`gh`), GitLab (`glab`), Gitea and Forgejo (`tea`),
  Bitbucket (`bkt`), Cursor Origin (`origin`). ace reaches each only through the person's own
  installed, signed-in CLI (ADR 0002).
- **Runner**: a `CommandRunner` (`command.ts:33`), the one function every request goes through.
- **Write**: a request that may change state on the host (`isForgeMutation`, `mutation.ts:8`).

## 1. Public surface and its callers

The daemon (57 modules) uses the `.` entry; the web app (14 modules), `ui-core` (11) and
`fake-daemon` (6) use only the pure subpath entries, in the browser and the iOS bridge.

| Group                    | Exports (file:line)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Main callers                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Transport                | `createCommandRunner` (`command.ts:37`), `CommandRunner`, `CommandRequest`, `CommandResult` (`:7`–`:33`), `GhApi` (`http.ts:97`), `GitLabApi` (`gitlab-api.ts:26`), `pinnedRunner` (`pinned-runner.ts:36`), `identityRunner` (`readiness.ts:37`), `identityVerificationMs` (`pinned-runner.ts:4`)                                                                                                                                                                                                                                                                                                                                                                        | `forge-backends.ts`, `source-control.ts`, `host-cli-identity.ts`                                               |
| GitHub                   | `GitHubForge` (`github.ts:76`, implements `Forge` and `ForgeBrowser`, `api.ts:16`, `:65`), `GitHubInbox` (`github-inbox.ts:43`), `GitHubRepositories` (`repositories.ts:38`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `forge-backends.ts`, `forge-stack-sync.ts`, `hosted-inbox.ts`, `services/repositories.ts` (12 modules)         |
| GitLab                   | `GitLabReader` (`gitlab-reader.ts:51`), `GitLabReviews` (`:38` of `gitlab-reviews.ts`), `GitLabChecks` (`gitlab-checks.ts:35`), `GitLabCreation` (`gitlab-creation.ts:72`), `GitLabHostedMerge` (`gitlab-hosted-merge.ts:9`), `GitLabInbox` (`gitlab-inbox.ts:101`), `GitLabIssues` (`gitlab-issues.ts:60`), `GitLabLifecycle` (`gitlab-lifecycle.ts:33`), their `gitLab*Writes`/`gitlab*Writes` admission lists                                                                                                                                                                                                                                                         | `hosted-browse.ts`, `hosted-checks.ts`, `hosted-inbox.ts`, `hosted-issues.ts`, `gitlab-hosted-merge.ts`        |
| Gitea, Forgejo           | `TeaReader` (`tea-reader.ts:46`), `TeaReviews` (`tea-reviews.ts:64`), `TeaWriter` (`tea-writes.ts:24`), `TeaIssueWriter` (`tea-issue-writes.ts:46`), `teaWrites`, `teaReviewWrites`, `teaIssueWrites`, `isTeaHost` (`tea-hosts.ts:4`)                                                                                                                                                                                                                                                                                                                                                                                                                                    | `forge-backends.ts`, `tea-source-control.ts`, `host-routes.ts`                                                 |
| Bitbucket, Origin        | `BitbucketReader` (`bitbucket-reader.ts:53`), `BitbucketReviews` (`bitbucket-reviews.ts:69`), `bitbucketReviewWrites`; `OriginReader` (`origin-reader.ts:67`, read-only), `OriginListSnapshots` (`origin-list-snapshots.ts:17`)                                                                                                                                                                                                                                                                                                                                                                                                                                          | `forge-backends.ts`, `hosted-review-conversation.ts`                                                           |
| Readiness and identity   | `githubReadiness`/`githubIdentity` (`readiness.ts:56`, `:20`), `gitlabReadiness`/`gitlabIdentity` (`gitlab-readiness.ts:71`, `:18`), `teaReadiness`/`teaIdentity`/`teaLogin` (`tea-readiness.ts:70`, `:57`), `bktReadiness`/`bktIdentity`/`bktContext` (`bkt-readiness.ts:84`, `:72`), `originReadiness`/`originIdentity` (`origin-readiness.ts:37`, `:17`)                                                                                                                                                                                                                                                                                                              | `source-control.ts`, `host-cli-identity.ts`                                                                    |
| Write certainty          | `MutationDispatch` (`mutation.ts:58`), `ForgeMutationOutcome` (`:49`), `uncertainWriteExpired`/`uncertainWriteWindowMs` (`:36`, `:33`), `WriteDispatch`, `ReplyReceipts` (`reply-receipts.ts:12`), `isReadOnlyApiRequest` (`read-only-api.ts:49`), `isAdmittedApiRequest` (`:148`), `HostApiWrite` (`:10`), `HostApiCli` (`:4`), `lifecycleWriteMarker`, `reviewWriteMarker`                                                                                                                                                                                                                                                                                             | `inbox-actions.ts`, `issue-actions.ts`, `workspace-forge-actions.ts`, `repository-publications.ts` (7 modules) |
| State the daemon keeps   | `ForgeStore` (`store.ts:51`), `ForgeIntents` (`intents.ts:3`), `ForgeListCaches` (`list-cache.ts:85`), `ReviewIndex`, `StatusRevisions`, `LogTail`, `mapCheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `workspace-pr-links.ts`, `workspace-forge-checks.ts`, `forge-backends.ts`                                      |
| Errors                   | `ForgeError` (`errors.ts:44`, `kind`, `retryAt`, `dispatched`), `ForgeErrorKind` (`:20`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 27 daemon modules (`action-errors.ts` maps them to `forge_<kind>`)                                             |
| Pure helpers (`.` entry) | `repositoryKey` (`repository-key.ts:4`, 19 callers), `repositoryFromRemote` (`remote.ts:17`), `resolveProjectRepositories` (`project-repositories.ts:67`), `normalizeRepositoryConfig`, `sameRepositoryConfig`, `prFromUrl`/`prUrl`/`prRepository` (`pr-reference.ts:33`, `:108`), `planStackSync` (`stack-publish.ts:150`), `reconcileStackPublication`, `stackPublishUpdates`, `canPublishAfter`, `reviewAfterSync`, `sameReviewedRevisions`, `stackLayersMovedSinceReview`, `mergeStateChangeObserved` (`merge-state.ts:5`), `withForgeCapabilities`, `forgeCapabilities`, `SshHostAliases` (`ssh-aliases.ts:34`), `mediaKey`, `RenderedMedia` (`github-media.ts:16`) | daemon                                                                                                         |
| Browser entries          | `./pr-reference`, `./project-repositories`, `./review-comment-body`, `./stack-publish`, `./stack-plan`, `./review-draft-move`, `./review-anchor`, `./remote`, `./capabilities`, `./suggestions`, `./review-hunk`, `./issue-write-plan`, `./detect`                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/web`, `packages/ui-core`, `packages/fake-daemon`: must stay JavaScript that runs in a browser            |
| Test kit                 | `./testing` (`testing/fixtures.ts`): `fakeGh` (`:122`), a real fake `gh` executable (`testing/fake-gh.mjs`) behind the real `createCommandRunner`, and fixture builders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 34 test files across forge and the daemon                                                                      |

## 2. Every request is one run of the person's CLI

- **The runner** (`command.ts:37`) spawns the host CLI with the request's argv, writes `input` to
  stdin, and returns `{ code, stdout, truncated }`, plus, for `tea` and `bkt`, the parsed HTTP
  status and pagination or quota headers, and `unreachable` when the CLI reported a network
  failure (matched privately against a fixed pattern, `:30`–`:32`). **No stderr, argv,
  environment or raw error leaves the runner** (`:35`–`:36`).
- **Environment**: inherited plus `GH_PROMPT_DISABLED=1`, `GH_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`,
  `GCM_INTERACTIVE=never`; `GH_DEBUG` and `DEBUG` removed (`:56`–`:66`).
- **Limits**: 4 MiB of output (`maxBytes`, `:43`), 30 s per request (`:44`), both validated;
  `mode: "tail"` keeps only the newest 16 KiB (log tails). An aborted signal fails `cancelled`
  before spawning (`:54`).
- **Windows**: a gate process starts in the CLI's place and joins a job object before starting
  the CLI, so the tree ends with the job (`:67`–`:79`).
- **GitHub requests** (`GhApi`, `http.ts:97`) are `gh api <path> --hostname <host> --include
--method <m> --header "Accept: application/vnd.github+json"`, bodies on stdin. The reply's
  status line and headers are parsed from `--include` output; GETs send `If-None-Match` for a
  cached ETag and `If-Modified-Since` for notifications, and a 304 returns the cached page
  (`:172`–`:200`). GraphQL replies are cached by the SHA-256 of the document. Any write clears the
  cache. `x-poll-interval` is honoured.
- **Other hosts** go through `glab api`, `tea api`, `bkt api` and `origin api` with one exact
  request shape each (`read-only-api.ts:4`, `gitlab-api.ts:41`, `tea-api.ts:40`, `bkt-api.ts:42`,
  `origin-reader.ts:122`).

## 3. Credentials and identity (ADR 0002)

- ace never reads, stores or proxies a host token; the CLI authenticates itself. `redact.ts`
  scrubs recognised token shapes (`gh*_`, `github_pat_`, `Bearer`, `…token=`) from untrusted
  bodies before they are kept (`redact.ts:1`–`:8`, applied in `http.ts:243`, `:304`); unknown
  fields are kept only after redaction, and a key that redaction collides is suffixed, never
  dropped (`redactData`, `:9`).
- **Pinned accounts.** `pinnedRunner` (`pinned-runner.ts:36`) pins pinned requests to the
  admitted account, never switching shared CLI configuration. Reads reuse a verification for
  60 s (`identityVerificationMs`); outside it they run beside one shared identity probe whose
  answer gates the result. Writes are verified immediately before dispatch. A probe naming
  another account fails closed. Results carry `identityChanged` when the account moved.

## 4. Writes: certain or uncertain, never guessed (ADR 0117)

- A request is a write unless it is a GET/HEAD, `api markdown`, or a GraphQL `query`
  (`mutation.ts:8`–`:26`); `pr merge` is always a write. An unrecognised request is a write.
- Non-GitHub hosts admit only the writes each adapter lists (`HostApiWrite`,
  `read-only-api.ts:10`), pinned to one repository's exact API root; anything else is refused
  before spawning (`isAdmittedApiRequest`, `:148`; `write-admission-scope.test.ts`).
- Certainty comes from process admission, never from a probe's error (`MutationDispatch`,
  `mutation.ts:57`–`:58`): a failure before the CLI started is "not sent" (`dispatched: false`);
  after dispatch, only HTTP 400, 401, 403, 404, 405, 409, 412, 422, 429 under an unchanged identity
  prove the host did not apply it (`refusedWriteStatuses`, `:44`). Any other failure is
  `outcome_uncertain` and fences a retry of the same write for 10 minutes
  (`uncertainWriteWindowMs`, `:33`); after that a complete read without the write's trace releases
  the fence. A write the host accepted whose result can't be published under the current identity
  is `ForgeMutationOutcome` (`:49`).

## 5. Reading host data

- Host replies are parsed with Zod schemas; protocol outputs never leak a raw `ZodError`
  (`origin-reader.ts:1`). An unreadable reply is `invalid_data`; a GraphQL document the host
  refuses (a field it doesn't have) is `ForgeQueryRefused` (`errors.ts:62`), so a reader may ask
  a smaller one; `ForgeAccessRefused` is `:74`.
- Unknown fields are kept, redacted, in `raw` where the protocol carries one (`status.ts`).
- Paging follows the `Link` header; a snapshot reads at most 8 MiB of source bytes, cached pages
  included, and fails `limit` past it (`ReadBudget`, `read-budget.ts:2`–`:14`).
- Retained state is proportional to the change: `ReviewIndex` and `StatusRevisions` reuse
  unchanged rows and pages (bench: warm status 36–141 µs, an edited 100-comment page 0.65 ms),
  `LogTail` keeps a bounded ring, `ForgeListCaches` and `OriginListSnapshots` keep list pages.
- **Errors** are fixed categories (`errors.ts:1`–`:43`): `offline` means no HTTP response at all
  and is never an auth answer; `forbidden` is 401/403 or a sign-in required; `rate_limit` carries
  `retryAt`; the rest name host refusals. The daemon publishes each as `forge_<kind>`.

## 6. Storage

`ForgeStore` (`store.ts:51`) takes the caller's `DatabaseSync` and owns three tables
(`forge_links`, `forge_intents`, `forge_link_epochs`) isolated from daemon migrations; an older
layout fails `IncompatibleDataError` naming the fix (`:34`–`:48`). The feedback queue is capped at
2,000 pending entries (`:64`). With `ACE_STORE=native` the caller passes the store's connection
wrapper, so one SQLite library per process holds (ADR 0222).

## 7. Measured costs (2026-11-23)

No real host was called and no credential was read.

- **The CLI's own start**, `gh --version` with an empty `GH_CONFIG_DIR` and `HOME`: 35 ms wall,
  31 ms CPU, 41 MB peak RSS per process (20 runs, load 35–100). Every `gh api` request pays this,
  plus a new TCP and TLS connection to the host (a process can't reuse one), plus the network.
- **The daemon's side**, `packages/forge/bench/transport.ts` (the real runner with `/bin/cat`
  echoing a canned reply): 3.1–3.7 ms wall and 1.1–1.9 ms CPU per request for spawn, pipes and
  capture; `JSON.parse` 0.013 ms (one record, 426 B), 0.17 ms (100, 37 KB), 0.75 ms (1,000,
  371 KB).
- **Decoding, Zod and revisions**, `packages/forge/bench/status.ts` (injected runner): warm status
  36 µs (2 comments) to 141 µs (2,000 comments over 20 conditional pages); one edited page
  0.17 ms (2 comments), 0.65 ms (100), 0.87 ms (2,000).

So per request the daemon spends about 1–3 ms of CPU, the CLI about 31 ms, and the wall time is
the CLI start plus connection set-up plus the host's answer. No part of the daemon's share is large
enough for Rust to matter; the CLI's share can only be removed by not starting a CLI per request,
which is a credentials question, not a language one; ADR 0224 keeps one CLI process per request
(ADR 0002 unchanged). The owner decided the port knowing this: the aim is the same behaviour at no
extra cost.

## 8. The tests that guard this

Classes as in [the engine's §19](../engine/behaviour.md). Counts: 83 files, 588 tests:
**(a) 79 files (569 tests)**, **(b) 4 files (19 tests)**, **(c) none**. The (a) files prove both
implementations unchanged, switch off and on; the (b) cases move with their modules; the last
column names the porting guide's item each proves. The 51 daemon test files that use `@ace/forge` (most through `fakeGh`)
carry over the same way. All 44 process tests drive a fake `gh` executable through the real
runner, so they prove the `gh api` argv and reply contract; none exercises an HTTP connection, and a Rust caller drives the same fake through the same runner.
All paths in `packages/forge/src/`.

| Test files                                                                                                                                                                                                                                                                                                                                                                                              | Class | What they guard                                                                                                                                                                                        | Proof for                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `command-search.process`, `identity-probes.process`, `readiness.process`, `graphql-refusals.process`, `retry-regressions.process`, `cache-regressions.process`, `cache-overlap`, `change-regressions.process`, `ssh-aliases.process`                                                                                                                                                                    | a     | Sections 2 and 3: the runner's limits, environment and silence; CLI search; identity probes and pinning; readiness; GraphQL refusals; retries; ETag and GraphQL caches; SSH host aliases.              | F1                                                                               |
| `write-dispatch.process`, `reply-expiry.process`, `pr-create.process`, `new-pr.process`, `pr-management.process`, `lifecycle.process`, `merge-state.process` (22), `stacks.process` (19), `stack-checks.process`, `repositories.process`                                                                                                                                                                | a     | Section 4: dispatch certainty, uncertain-write fences and their expiry, PR creation and management, lifecycle writes, merge state, stack publication, repository creation.                             | F1, F2                                                                           |
| `github.process`, `status`, `review.process`, `review-regressions.process`, `review-relink.process`, `review-index`, `review-thread-anchors.process`, `hosted-reviews.process`, `hosted-review-actions.process`, `hosted-review-line-comment.process`, `hosted-review-reactions.process`, `hosted-review-suggestions.process`, `hosted-review-visibility.process`, `people.process`, `activity.process` | a     | Section 5 for GitHub reviews: status and checks, review threads and anchors, reactions, suggestions, visibility, people, activity.                                                                     | F2                                                                               |
| `browser.process` (19), `pr-read-depth.process`, `file-content.process`, `file-overflow.process`, `range-files.process`, `open-work.process`, `states.process`, `group-counts.process`, `list-cache.process`, `inbox.process`, `issues.process`, `links`                                                                                                                                                | a     | Browsing: PR lists and details, read depth and budgets, file contents and overflow, ranges, open work, states, counts, list caches, the inbox, issues, links.                                          | F2                                                                               |
| `gitlab-reader`, `gitlab-reviews`, `gitlab-checks`, `gitlab-creation`, `gitlab-conversation`, `gitlab-inbox`, `gitlab-issues`, `gitlab-lifecycle`, `gitlab-merge-state`, `gitlab-readiness`                                                                                                                                                                                                             | a     | GitLab through its exported classes with an injected runner: reads, reviews, checks, creation, inbox, issues, lifecycle, merge state, readiness.                                                       | F3                                                                               |
| `tea-reader`, `tea-reviews`, `tea-writes`, `tea-issue-writes`, `tea-write-certainty`, `tea-readiness`, `tea-admission`, `bitbucket-reader`, `bkt-readiness`, `bkt-admission`, `origin-reader` (24), `origin-readiness`, `read-only-api`, `write-admission-scope`                                                                                                                                        | a     | Gitea/Forgejo, Bitbucket and Origin with an injected runner; read-only admission and write scopes.                                                                                                     | F1 (admission), F4, F5                                                           |
| `detect`, `pr-reference`, `project-repositories`, `review-draft-move`, `review-hunk`, `review-comment-body`, `stack-publish`, `suggestions`, `issue-write-plan`                                                                                                                                                                                                                                         | a     | The pure browser entries: remote detection, PR and issue URLs, repository config, draft moves, hunks, comment bodies, stack plans, suggestions, issue write plans. Shared with the web app and iPhone. | F6 (the browser keeps the TypeScript copy)                                       |
| `bitbucket-reviews`, `tea-checks`, `media.process`, `command.process` (one case: `bktWrite`)                                                                                                                                                                                                                                                                                                            | b     | Internal helpers: Bitbucket write markers and review ids, Gitea check mapping, rendered media parsing (`github-media-parse.ts`), `bkt` write requests. They move with their modules.                   | moves with F2 (`media`), F4 (`tea-checks`), F5 (`bitbucket-reviews`, `bktWrite`) |

`command.process` is counted (b) because one of its four cases imports `bktWrite` from
`bkt-api.ts`; its other three go through `createCommandRunner` and `fakeGh` and prove F1 like the
(a) rows; the `bktWrite` case moves with F5.
