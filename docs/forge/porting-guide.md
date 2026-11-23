# Porting `@ace/forge` to Rust

For the builders of [ADR 0224](../adr/0224-git-and-forge-move-to-rust-behind-the-same-interfaces.md),
one work item each. Read the ADR (§8 for the forge) and [behaviour.md](behaviour.md) first: the
contract there is what you keep, and behaviour.md §8 lists every test file by class. The owner
decided the port (2026-11-23) knowing the measurements: the CLI and the network are a request's
cost and the daemon's share is 1–3 ms (behaviour.md §7), so the aim is the same behaviour in Rust
at no extra cost, not a speed-up. Where this guide is silent, follow
[the engine's porting guide](../engine/porting-guide.md); its rules 6, 7, 9, 12 and 13 apply word
for word.

Branch from `ace/rust-git-forge` once F0 has landed on it, one branch per work item
(`ace/rust-forge-<item>`). Every item needs ADR 0223's E2 (`ace-supervisor`).

## Rules for every work item

1. **The person's CLI, one process per request** (ADR 0002, unchanged). The Rust forge runs
   `gh`, `glab`, `tea`, `bkt` and `origin` with the same arguments, stdin and environment as the
   TypeScript, through `ace-supervisor`, and parses what they print. Never read a CLI's
   configuration, keychain or token, never store or log one, never open a connection to a host.
2. **Nothing kept carries a credential** (ADR 0224 §8a). The supervisor's inventory and journals
   get metadata only (pid, start identity, uid, group, owner, the executable's basename, the
   working directory: `packages/provider-kit/src/process-inventory.ts:15`–`:24`), never argv,
   environment values or stdin. Every reply, stderr tail and diagnostic is redacted through
   `ace-redaction` before it is cached (`GhApi`'s ETag and GraphQL caches, list caches), kept as
   `raw`, logged, put in an error, or serialized; the matcher's values are the child's
   environment values for that request only, never written anywhere.
3. **Same TypeScript interface.** Every export of the 15 entry points keeps its signature, result
   shape, error kind and timing (behaviour.md §1). Classes are the native ones when `ACE_FORGE`
   names their host (`new GitHubForge(...)` gets the native class), chosen per instance through
   `packages/provider-kit/src/native-switches.ts`; you edit only your files. With the switch on
   and the addon missing, fail at startup.
4. **Runners are ports.** A class given a runner made by `createCommandRunner` (native when the
   switch is on, so `fakeGh` gets it too) runs it in Rust; a class given a JS function (26 test
   files inject one) calls it back on the JS thread and awaits it. Never bypass an injected
   runner.
5. **Output through `ace-json`; strings stay `JsString`.** Host replies are parsed with
   `ace_json::parse` (`JSON.parse`'s numbers, duplicate keys, lone surrogates); every value a
   caller sees is serialized with `ace_json::ser::to_string` and parsed once by the shell. A value
   TypeScript ran through a Zod `parse` comes out in the schema's key order, unknown keys stripped
   where Zod strips and kept where the schema keeps them (`raw`); `redactData`'s key suffixing
   (`redact.ts:9`) is kept; objects TypeScript freezes (`immutable.ts`, 23 sites) are frozen by
   the shell after parsing. Every string from a host or a caller is `JsString` until it is written
   out. No `serde_json`.
6. **Schemas mirror Zod field for field.** Each Zod schema a module uses becomes a decoder in
   `ace-forge/src/schema/` with the same optional, nullable, default and refinement rules; a
   failed decode is the error the TypeScript raises (`invalid_data`, never a raw `ZodError`,
   `origin-reader.ts:1`). Protocol output types come from `ace-protocol`.
7. **Write certainty is contract** (behaviour.md §4). "Dispatched" is the supervisor reporting the
   CLI started; the refused-status set, the 10-minute fence, `ForgeMutationOutcome` and the
   identity checks before a write are kept exactly.
8. **Same numbers.** 4 MiB per reply, 30 s per request, 16 KiB tails, 8 MiB per snapshot read
   budget, 60 s identity verification, 2,000 pending feedback entries, the GraphQL cache key
   (SHA-256 of the document).
9. **Tests.** The class (a) files of your item are the proof; you don't edit them. Run each
   alone, switch on and off; `test -f` first.

   ```sh
   f=packages/forge/src/github.process.test.ts
   test -f "$f" && ACE_SUPERVISOR=native ACE_FORGE=github bun --bun x vitest run "$f" --maxWorkers=4
   test -f "$f" && bun --bun x vitest run "$f" --maxWorkers=4
   ```

   Never run the full suite or the tier scripts. Never a real host: process tests use `fakeGh`
   (`testing/fixtures.ts:122`), unit tests an injected runner.

10. **(b) cases move with their module** into `#[cfg(test)]` beside the Rust; the TypeScript test
    goes with its module after default-on. New Rust tests only for behaviour nothing covers.
11. **The browser's copies stay.** The 13 pure entries stay TypeScript for `apps/web`, `ui-core`
    and `fake-daemon` (ADR 0224 question 6); F6 ports them for the forge's own use, and the
    daemon's imports of them get the native ones with the switch on.
12. **Measure before you finish**, switch off and on: `node packages/forge/bench/transport.ts`
    and `node packages/forge/bench/status.ts` (F1, F2); report both. A result slower than the
    TypeScript beyond noise doesn't ship.
13. **Cross-mode** for F7 only (the tables): `bun scripts/native-cross.ts ACE_FORGE_STORE <file>`,
    per boot of the event database (ADR 0223 §8). In-memory caches have no cross concern.

## Files per work item

F0 creates every file below as a stub. Rust in `native/daemon/crates/ace-forge/src/`, bindings
in `native/daemon/crates/ace-daemon-node/src/forge/`, shells in `packages/forge/src/`. `index.ts`
and the 15 `package.json` entries stay the TypeScript surface.

| Item | TypeScript replaced (`packages/forge/src/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Rust (yours)                                                    | Binding                     | Shell                                     | Switch                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------- | ----------------------------------------- | ---------------------------- |
| F1   | `command`, `http`, `http-errors`, `errors`, `api`, `mutation`, `write-dispatch`, `read-only-api`, `pinned-runner`, `readiness`, `redact`, `immutable`, `tail`, `poll`, `host-text`, `resource`, `incremental`, `revisions`, `read-budget`, `repository-key`, `ssh-aliases`, `reported-capabilities`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `transport/*.rs`, `schema/common.rs`                            | `transport.rs`              | `native-transport.ts`                     | `ACE_FORGE=<host>`           |
| F2   | `github`, `github-activity`, `github-browser`, `github-browser-enrichment`, `github-browser-schemas`, `github-checks`, `github-comment-visibility`, `github-commits`, `github-draft-moves`, `github-file-content`, `github-file-overflow`, `github-group-counts`, `github-inbox`, `github-issues`, `github-lifecycle`, `github-lifecycle-extras`, `github-lifecycle-schemas`, `github-lifecycle-writes`, `github-line-comment`, `github-media`, `github-media-marker`, `github-media-parse`, `github-merge-state`, `github-new-pr`, `github-open-work`, `github-pending-writes`, `github-people`, `github-range-files`, `github-reactions`, `github-repository`, `github-reviewer-writes`, `github-reviews`, `github-row-facts`, `github-schemas`, `github-stack-checks`, `github-stack-operation`, `github-stack-scope`, `github-stacks`, `github-states`, `github-status`, `github-suggestions`, `github-tree-changes`, `review`, `review-index`, `review-io`, `review-threads`, `status`, `merge-state`, `list-cache`, `projections`, `inbox-rows`, `rest-records`, `repositories`, `local-stacks`, `lifecycle-plan`, `pr-create-text`, `job-log` | `github/*.rs`, `schema/github.rs`                               | `github.rs`                 | `native-github.ts`                        | `ACE_FORGE=github`           |
| F3   | `gitlab-api`, `gitlab-check-records`, `gitlab-checks`, `gitlab-conversation`, `gitlab-conversation-records`, `gitlab-creation`, `gitlab-hosted-merge`, `gitlab-inbox`, `gitlab-issue-records`, `gitlab-issue-writes`, `gitlab-issues`, `gitlab-lifecycle`, `gitlab-lifecycle-records`, `gitlab-merge-state`, `gitlab-reader`, `gitlab-readiness`, `gitlab-records`, `gitlab-reviews`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `gitlab/*.rs`, `schema/gitlab.rs`                               | `gitlab.rs`                 | `native-gitlab.ts`                        | `ACE_FORGE=gitlab`           |
| F4   | `tea-api`, `tea-checks`, `tea-hosts`, `tea-issue-writes`, `tea-issues`, `tea-reader`, `tea-readiness`, `tea-records`, `tea-reviews`, `tea-writes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `tea/*.rs`, `schema/tea.rs`                                     | `tea.rs`                    | `native-tea.ts`                           | `ACE_FORGE=tea`              |
| F5   | `bitbucket-checks`, `bitbucket-pulls`, `bitbucket-reader`, `bitbucket-records`, `bitbucket-reviews`, `bkt-api`, `bkt-readiness`, `origin-list-snapshots`, `origin-reader`, `origin-readiness`, `origin-records`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `bitbucket/*.rs`, `origin/*.rs`, `schema/{bitbucket,origin}.rs` | `bitbucket.rs`, `origin.rs` | `native-bitbucket.ts`, `native-origin.ts` | `ACE_FORGE=bitbucket,origin` |
| F6   | `detect`, `pr-reference`, `project-repositories`, `review-comment-body`, `stack-publish`, `stack-plan`, `review-draft-move`, `review-anchor`, `remote`, `forge-capabilities`, `suggestions`, `review-hunk`, `issue-write-plan` (Rust copies; the TypeScript stays for the browser)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `pure/*.rs`                                                     | `pure.rs`                   | `native-pure.ts`                          | with any `ACE_FORGE` host    |
| F7   | `store`, `intents`, `reply-receipts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `store/*.rs`                                                    | `store.rs`                  | `native-store.ts`                         | `ACE_FORGE_STORE=native`     |

## F0: foundations (one builder, first)

- **`ace-redaction`** (`native/daemon/crates/ace-redaction/`): the Rust port of
  `@ace/redaction` (environment values with their JSON-escaped spellings, credential patterns,
  secret keys; `packages/redaction/src/`), its 11 test files' cases moved into it; shared by
  `ace-forge` and `ace-git`.
- `ace-forge` (`ace-json`, `ace-supervisor`, `ace-redaction`, `ace-protocol`, `ace-store` for F7,
  `sha2`, `regex`, `thiserror`), every module above as a stub; the binding modules with panics caught and thrown
  as `ForgeError("cli")`; the shell helper that parses a result once and deep-freezes it where the
  TypeScript froze it.
- `ACE_FORGE` (comma list of `github`, `gitlab`, `tea`, `bitbucket`, `origin`) and
  `ACE_FORGE_STORE` in `native-switches.ts`; any host without `ACE_SUPERVISOR=native`, or the
  store without `ACE_STORE=native`, refuses to start.
- The runner port bridge (rule 4): a native runner handle that `createCommandRunner` returns when
  the switch is on (a callable with the `CommandRunner` signature), and the callback path for a
  JS function.
- Proof: `check:daemon-native`, `cargo deny check`; every (a) file still passes with every host
  named (stubs defer to TypeScript).

## F0r: redaction in TypeScript first (before F1)

New behaviour, so it lands in TypeScript with its own test before any Rust copies it: forge's
`redact` and `redactData` (`redact.ts:2`–`:6`, `:20`–`:22`) call `@ace/redaction` with the child's
environment as the matcher's values (`createEnvironmentMatcher`,
`packages/redaction/src/environment.ts:19`), so a credential the CLI echoes as a bare value is
masked; forge's patterns (`gh*_`, `github_pat_`, `Bearer`, `token`/`authorization` keys) move into
`@ace/redaction`, which gains GitLab's `glpat-`, `gloas-`, `glrt-` and URL user-info. One owner,
no second pattern list. Proof: the redaction file `json-credentials` and `index` tests, forge's
`github.process` (unknown fields kept only after redaction), plus the new test for an echoed
environment value; then the forge files that read `raw`.

## F1: the transport (one builder)

The runner (`command.ts:37`): arguments, stdin, the environment (`:56`–`:66`), 4 MiB, 30 s, tail
mode, the network-failure pattern (`:30`–`:32`), `tea`'s and `bkt`'s HTTP status and headers,
`identityChanged`, nothing of stderr, argv or environment escaping; the supervisor's job object
replaces Windows' gate (`:67`–`:79`). `GhApi` (`http.ts:97`): the `gh api` arguments, `--include`
parsing, ETag and `If-Modified-Since` reuse, the GraphQL cache, cache clearing on writes,
`x-poll-interval`. Write classification and `MutationDispatch` (`mutation.ts:8`, `:58`),
admission (`read-only-api.ts:49`, `:148`), pinned identities and the 60 s window
(`pinned-runner.ts:36`), readiness and identity probes, redaction through `ace-redaction` before
every cache and output (rule 2), error kinds
(`errors.ts:20`–`:74`), read budgets.

- Proof: `command-search.process`, `identity-probes.process`, `readiness.process`,
  `graphql-refusals.process`, `retry-regressions.process`, `cache-regressions.process`,
  `cache-overlap`, `change-regressions.process`, `ssh-aliases.process`, `command.process` (its
  three runner cases; the `bktWrite` case moves with F5), `read-only-api`,
  `write-admission-scope`, `write-dispatch.process`, `reply-expiry.process`; then the daemon's
  `source-control` and `host-cli-identity` tests one at a time.
- Measure: `bench/transport.ts` (the runner with `/bin/cat`; crossing included).

## F2: GitHub

`GitHubForge` (`github.ts:76`, `Forge` and `ForgeBrowser`), `GitHubInbox`, `GitHubRepositories`,
reviews and threads, status and revisions (`ReviewIndex`, `StatusRevisions`), list caches,
lifecycle and merge state, stacks, media, file contents and overflow, people, reactions,
suggestions, open work.

- (b): `media.process`'s `renderedMedia` case. Proof: `github.process`, `status`,
  `review.process`, `review-regressions.process`, `review-relink.process`, `review-index`,
  `review-thread-anchors.process`, `hosted-reviews.process`, `hosted-review-actions.process`,
  `hosted-review-line-comment.process`, `hosted-review-reactions.process`,
  `hosted-review-suggestions.process`, `hosted-review-visibility.process`, `people.process`,
  `activity.process`, `browser.process`, `pr-read-depth.process`, `file-content.process`,
  `file-overflow.process`, `range-files.process`, `open-work.process`, `states.process`,
  `group-counts.process`, `list-cache.process`, `inbox.process`, `issues.process`, `links`,
  `pr-create.process`, `new-pr.process`, `pr-management.process`, `lifecycle.process`,
  `merge-state.process`, `stacks.process`, `stack-checks.process`, `repositories.process`,
  `media.process`; then the 51 daemon files that use `@ace/forge`, one at a time.
- Measure: `bench/status.ts`.

## F3: GitLab

All `GitLab*` classes and their write lists. Proof: `gitlab-reader`, `gitlab-reviews`,
`gitlab-checks`, `gitlab-creation`, `gitlab-conversation`, `gitlab-inbox`, `gitlab-issues`,
`gitlab-lifecycle`, `gitlab-merge-state`, `gitlab-readiness`; the daemon's `hosted-*` tests.

## F4: Gitea and Forgejo

`TeaReader`, `TeaReviews`, `TeaWriter`, `TeaIssueWriter`, their write lists, `isTeaHost`.
(b): `tea-checks`. Proof: `tea-reader`, `tea-reviews`, `tea-writes`, `tea-issue-writes`,
`tea-write-certainty`, `tea-readiness`, `tea-admission`.

## F5: Bitbucket and Origin

`BitbucketReader`, `BitbucketReviews`, `bitbucketReviewWrites`, `bkt` readiness and identity;
`OriginReader` (read-only), `OriginListSnapshots`, `origin` readiness. (b): `bitbucket-reviews`
(write markers, review ids) and `command.process`'s `bktWrite` case. Proof: `bitbucket-reader`,
`bkt-readiness`, `bkt-admission`, `origin-reader`, `origin-readiness`.

## F6: the pure helpers, for the forge's own use

Rust copies of the 13 modules, called by F1–F5's Rust. With any host switched on, the daemon's
imports of `.`'s pure exports (`repositoryKey`, `prFromUrl`, `planStackSync`, … behaviour.md §1)
are the native ones; the subpath entries the browser imports stay TypeScript. Proof: `detect`,
`pr-reference`, `project-repositories`, `review-draft-move`, `review-hunk`,
`review-comment-body`, `stack-publish`, `suggestions`, `issue-write-plan`, run once against each
copy (the switch selects which one the test's import gets).

## F7: the forge's tables on `ace-store`

`ForgeStore` (`store.ts:51`), `ForgeIntents` (`intents.ts:3`) and reply receipts: the same tables
(`forge_links`, `forge_intents`, `forge_link_epochs`), columns, rows and `IncompatibleDataError`
check (`store.ts:34`–`:48`), on the store's native connection, in the caller's transactions.
Proof: `review.process`, `review-relink.process`, `reply-expiry.process`,
`write-dispatch.process`, the daemon's `workspace-pr-links` and `workspace-forge-checks` tests;
the per-boot cross gate on each (rule 13).
