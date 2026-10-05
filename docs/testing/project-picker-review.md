# Project picker review follow-up

Read the `## Review: changes requested` comment on PR #130 on 2026-10-05.
The paginated issue-comments endpoint contained two comments and no comment titled
`Integration rehearsal: findings for this PR`. The earlier unavailable-review report
is superseded by this report.

Merged current `origin/main` without rebasing. Generated protocol documentation was
resolved from the merged schemas, preserving the dedicated-channel project-push guard.
All changes authored here are backend, protocol, client runtime, fake host, tests or docs.

The owner prohibits tests, mutations, benchmarks, probes and CI execution before merge.
Each blocker has a public socket regression with deterministic inputs or an injected
filesystem boundary. These reproduce the code paths statically; failing-before and
passing-after confirmation needs run at merge. No execution or measured mutation-kill
claims are made for the review fixes.

## Blocking review items

1. Stale top hits. Search examines at most limit + 128 candidates, continues past missing
   hits, evicts stale entries and checks one additional live result. Truncation reflects
   remaining live results, incomplete indexing or a validation cap. Regressions assert
   alpha-two survives alpha-one deletion and that removing an exact needle-folder hit
   leaves needle-folder-old with no stale truncation on repeated requests.
2. Disappearing children. Metadata ENOENT/ENOTDIR is handled per entry. Search and completion
   continue to healthy siblings. Retryable directory errors retain the queued scan and
   stop the current slice. Deterministic real-filesystem regressions remove a listed child
   at the injected metadata boundary and inject a transient enumeration failure.
3. Valid POSIX names. Existing-directory schemas preserve literal backslashes; traversal
   checks use the host separator. Root, recent and child result names use the same schema.
   Response parsing failures get a `project_failed` reply, and tracked task cleanup observes
   rejections. A socket regression covers an a\b root, c\d child, literal\Library child,
   search, completion and browse. Creation/clone destination-name restrictions stay intact.

## Other review items

- Substring scores have a floor above fuzzy-name scores and their recency bonuses. A
  223-character substring name ranks above a-c-e through the socket API.
- Completion validates the entire expanded path before splitting it. Final `..` and NUL
  segments return `invalid_path` in the daemon and fake client regressions.
- Scan continuation retains at most one 10,000-name enumeration per root view. Device/inode
  changes discard that enumeration. A boundary regression makes subsequent enumeration
  unavailable but still requires a healthy sibling after 600 regular files to be found.
- Directory admission counts distinct scheduled paths. A frozen-clock socket regression
  verifies the last admitted sibling and absent siblings past the 1,024-directory cap.
- A separate five-level tree verifies the depth cap without the directory cap masking it.
- Two sockets block concurrently in filesystem validation. A completion supersedes the
  first socket's search, while the other socket's search returns its folder.
- The load-sensitive timing assertion and clock-call-count assertions were removed from
  behavior tests. Latency, throughput and RSS measurement belong to the merge-time benchmark.

## Review mutation matrix

Every row is **not executed (tests run at merge)**. These are designed guards, not observed kills.
Names below identify public behavior tests, so refactoring helpers does not change the evidence.

| #   | Production mutation                                       | Designed behavior guard                                                                      |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Remove exact-name bonus                                   | Folder search ranks names and recents: ace precedes ace-old                                  |
| 2   | Disable fuzzy matching                                    | Folder search includes a-c-e for ace                                                         |
| 3   | Remove recency bonus                                      | Empty folder search puts registered ace-old first                                            |
| 4   | Always report non-Git                                     | Folder search reports ace-work as a Git root                                                 |
| 5   | Always report non-project                                 | Registered folder returns isProject true in socket/client tests                              |
| 6   | Include ignored descendants                               | Folder search excludes node_modules, Library, cache, .git and hidden children                |
| 7   | Ignore showHidden                                         | Explicit hidden search returns .hidden; concurrent views stay distinct                       |
| 8   | Limit the common prefix to displayed candidates           | Limit-one completion retains ~/Co across three matches                                       |
| 9   | Trim completion spaces                                    | ~/Cool completes to ~/Cool folder/                                                           |
| 10  | Stop preserving tilde                                     | Completion candidates and prefix retain ~/                                                   |
| 11  | Admit escaping completion links                           | Escaping link produces no candidates and traversal returns outside_project_roots             |
| 12  | Omit cached-hit revalidation                              | Replacing a cached folder with an escaping link removes the match                            |
| 13  | Retain results after roots change                         | A root change removes old-root matches from search                                           |
| 14  | Remove supersession abort                                 | Original socket cancellation and overlapping-validation cancellation regressions             |
| 15  | Remove depth cap                                          | A small five-level tree excludes fifth-level independently of the directory cap              |
| 16  | Never expire the index                                    | A new directory appears after advancing the injected clock by 30,001 ms                      |
| 17  | Leave shorthand unnormalized                              | Clone validation and fake clone return https://github.com/arpan404/ace.git                   |
| 18  | Accept credentials/query tokens                           | Clone helper rejects credential-bearing URLs, tokens and invalid destinations                |
| 19  | Let admin imply projects scope                            | Paired-device scope regression refuses admin without projects                                |
| 20  | Omit client/fake picker forwarding                        | Public client/fake tests exercise search, completion and clone validation                    |
| 21  | Remove directory-count cap                                | Frozen-clock wide tree excludes folder-1023 and folder-1099 after indexing drains            |
| 22  | Share cancellation across sockets                         | Concurrently pending validations: the other socket returns target-project                    |
| 23  | Let child metadata failure abort siblings                 | Injected real child deletion still returns z-healthy in search/completion                    |
| 24  | Drop retryable directory continuation                     | Healthy folder appears on a request after an injected EAGAIN                                 |
| 25  | Reject POSIX backslashes or skip root-name validation     | Literal backslash root and descendants get valid socket replies                              |
| 26  | Slice before stale-hit validation or skip eviction        | Deleted exact hit reveals the live next hit without stale truncation                         |
| 27  | Allow category score overlap                              | Long substring name ranks before fuzzy a-c-e                                                 |
| 28  | Validate only the completion parent                       | Final traversal and NUL inputs return invalid_path                                           |
| 29  | Re-enumerate each continuation                            | Healthy sibling remains searchable when a second readdir would fail                          |
| 30  | Ignore canonical target visibility                        | Completion aliases to Library/.git remain hidden; hidden mode admits ordinary hidden targets |
| 31  | Count only successful completions toward bounds           | 512 ignored-target links retain input and report truncation                                  |
| 32  | Apply metadata bounds after directory filtering           | 300 matching regular files stop before a later directory                                     |
| 33  | Return a lone UTF-16 high surrogate                       | Emoji completion common prefix remains ~/                                                    |
| 34  | Aggregate unrelated indexing flags or discard other modes | Concurrent normal/hidden sockets retain correct views and indexing flags                     |
| 35  | Keep fake timestamps after unregister                     | Removed fake projects have no lastOpened and recentScore 0                                   |

The original socket tests are in `apps/daemon/src/project-picker.process.test.ts`.
Additional guards are in `project-picker-review.process.test.ts`,
`project-picker-failures.process.test.ts` and `project-picker-bounds.process.test.ts`.
Scope, client and fake coverage remains in their respective public-API test files.

## Performance evidence

| Evidence                              | Numbers                                                                                                                                                      | Status                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Historical original socket test       | Warm median <100 ms, 9 samples, 1,100 folders, limit 2                                                                                                       | Original revision only; exact samples were not retained      |
| Merge-time warm benchmark             | 50 samples each at limits 2, 30 and 100; median, p95, maximum, requests/second, peak RSS and RSS growth                                                      | Not executed; needs run at merge                             |
| Merge-time wide enumeration benchmark | 10,000 entries with a final healthy directory; reports scan slices, latency, enumeration calls, names read and RSS                                           | Not executed; needs run at merge                             |
| Static bounds                         | 32 cache slots, 1,024 admitted directories per slot, depth 4, one retained enumeration of at most 10,000 names per slot, 256 metadata entries per scan slice | Enforced statically; actual timing/memory needs run at merge |

`apps/daemon/bench/project-picker.ts` uses temporary homes and real authenticated sockets.
Warm search still ranks the bounded index, then validates only the requested page, a live
lookahead and bounded stale-hit replacements. The benchmark measures that cost and guards
warm median below 100 ms. No new benchmark numbers or performance certification are claimed.

Three serial runs, four concurrent copies, mutation execution, full `bun run check` and
runtime replacement/cancellation/shutdown checks need run at merge. CI is disabled by the owner.
