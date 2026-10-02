# 0016: Local forge integration and review loop

Date: 2026-10-02. Status: accepted.

## Context

The supplied competitor inventories report PR linking, review comments, checks and merge controls in t3code, and CI/comment auto-fixes in Claude Desktop. Cursor supports PR review and merge on mobile. These inventories describe features, not reusable implementations. They do not establish a durable, local CLI-only review intent contract with ace's engine. We need that contract without changing agent completion rules or introducing hosted credentials.

## Decision

`@ace/forge` owns a forge-neutral interface, GitHub implementation, pure status mapping, bounded CLI transport, SQLite thread links and review delivery ledger, and polling. GitLab can implement the same interface later. Detection reads git remotes, prefers origin, and recognises GitHub and GitLab URL formats. Unsupported hosts fail explicitly; custom hosts require an explicit host mapping.

All GitHub I/O uses the user's installed `gh`. REST requests use `gh api --include`, explicit methods and stdin JSON bodies. Reads validate Zod schemas, preserve unknown provider fields, and follow same-repository pagination with page and byte limits. PR state, commit checks and legacy commit statuses are separate resources. GraphQL supplies resolved/outdated review-thread metadata and uses cursor pagination. PR templates render named placeholders from explicit thread/branch/title/summary values. Mutation calls are never retried automatically. Merge uses an expected head SHA; auto-merge delegates branch protection and merge queues to GitHub.

The package owns no engine process. A review loop persists idempotency keys and bounded intents, then calls an injected executor's `enqueue`. The engine must deduplicate the supplied key transactionally with its queue write. A crash between enqueue and ledger acknowledgement can therefore retry safely. Failures and comments are keyed by commit/check/completion or comment/update identity; replies remain context on their review thread. Ignored authors are caller-configured to prevent feedback from ace's own replies. Linking existing PRs observes current actionable feedback immediately. Explicit unlink deletes review history and queued intents for that thread.

## Protocol and wire additions

An additive `@ace/protocol/forge` export defines repository identity, PR/check/CI/review summaries, thread links, auto-fix intents, forge commands and forge event payloads. It does not alter the existing wire union or daemon receipts while those workstreams develop independently. The daemon integration must route these schemas through its existing authenticated command and event transaction, apply thread ownership checks, and persist events after commit. Forge events never change core agent status directly. Executors queue auto-fix work using the existing engine queue facts, so pending work remains visible.

The package exports MCP definitions and a scoped dispatcher for `forge_pr_status`, `forge_create_pr`, `forge_link_pr`, and `forge_reply_comment`. The MCP server provides the authorised thread and repository scope. Arguments cannot select another thread or repository. Merge and review requests are available through the package API and command schemas; they are not implicit review-loop actions.

## Security

ace never invokes `gh auth token`, reads credential files, or stores authentication headers. Only `gh` handles authentication. Subprocess arguments use an argv array without a shell; request text goes on stdin. Errors contain fixed categories and safe HTTP codes, never stderr, command output, headers or request bodies. Debug HTTP environment variables are removed for child commands. Tokens matching GitHub credential formats and bearer/authorization assignments are redacted before snapshots, events, intents or log tails leave transport. Unknown fields are preserved after redaction. The library cannot identify arbitrary secrets with no recognisable format; callers must treat CI and review content as untrusted, and never interpret it as authorisation to merge or execute tools.

No remote pagination URL or review URL is executed. Pagination stays within the selected host/repository path. Polling and mutations accept cancellation; child processes have deadlines and output caps. CLI discovery does not send provider prompts or record sessions.

## Performance

REST page representations and ETags use a bounded LRU cache. A 304 reuses only that resource's cached page; changes to reviews and checks are queried independently of PR ETags. GraphQL POSTs have no assumed ETag support. Each watcher has one serial poll and no overlapping work, with bounded exponential backoff and server rate-limit deadlines. Callers own watcher lifetimes and concurrency. No process-global watcher map exists.

JSON is capped per subprocess, list traversal has a page cap, and incomplete snapshots fail rather than claim success. Job logs stream through a fixed byte ring; an oversized line is discarded to avoid unbounded readline buffers. SQLite retains delivery identities on disk rather than an ever-growing memory set. Pending intents have a fixed admission cap and drain in small pages; overflow fails visibly. Work is proportional to the bounded fetched snapshot or incoming log bytes, never total session history. Non-gating benchmarks measure mapping, review admission and streaming tails, including RSS.

## Testing

A temporary executable fake `gh` returns recorded HTTP/JSON fixtures and consumes stdin through real processes. Tests cover page traversal, ETags, rate limits, 403/404, malformed data, output limits, cancellation, PR mutations and templates. Real temporary git repositories cover remote detection. Temporary SQLite covers links, restarts, deduplication, executor failure and retry. Pure mapping tests cover pending/unknown states and failure precedence. Log tests cover chunk boundaries, UTF-8, token redaction and caps. Eight deliberate production mutations must each fail a behavioural test before delivery.

Primary references: [gh api](https://cli.github.com/manual/gh_api), [GitHub conditional requests and rate limits](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [workflow job logs](https://docs.github.com/en/rest/actions/workflow-jobs), [gh pr merge](https://cli.github.com/manual/gh_pr_merge), and [GraphQL reference](https://docs.github.com/en/graphql/reference).
