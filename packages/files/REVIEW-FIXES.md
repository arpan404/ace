# PR #44 review fixes

The review titled "PR #44 review" was read with `gh pr view 44 --comments`. All blocking and non-blocking findings are addressed below. No separate comment titled "Integration rehearsal: findings for this PR" was present. Main is merged through `50c725f`, without rebasing.

The owner's latest rule prohibits running tests, mutation checks, benchmarks, probes and CI. These are code changes and authored regression assertions, reviewed statically. Reproduction failures, passing results, mutation kills, native interoperability, memory bounds and current-head benchmark measurements all **need run at merge**. No current-head execution claim is made.

## Blocking findings

| Finding                                                            | Change                                                                                                                                                                                                       | Public regression, needs run at merge                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Destination creation is overwritten after absent-version checks | Dedicated bounded native worker uses OS no-replace rename. Move, rename, restore, create, new upload commit and trash publication have no overwriting fallback. An existing destination returns CONFLICT.    | `review.test.ts` pauses at the injected filesystem boundary, creates an agent destination, then checks typed conflict, preserved destination/source/trash. Includes an empty directory destination.            |
| 2. Incoming cancellation releases before a queued append settles   | Each binding has cancellation state and owns its pending promise. Its writer guard runs inside the serialized action. Cancel marks first, drains, suppresses post-cancel acknowledgements and releases last. | `cancellation.test.ts` uses real sockets and barriers for queued workspace writes and queued/started destination-owned writes. It checks bytes, durable resume offsets, reply ordering and retained capacity.  |
| 3. A symlink alias exposes private upload bytes                    | Shared `SafeRoot.file` rejects resolved private targets before open, retaining no-follow and identity verification.                                                                                          | `review.test.ts` attempts direct/parent aliases through public file download, WebSocket and workspace read.                                                                                                    |
| 4. Moved-parent expiry refunds orphaned disk bytes                 | Cleanup debt is persisted first. A capped non-link-following walk reconciles relocated temps by stored inode. Missing/outside/replaced originals remain charged until deletion is confirmed.                 | `review.test.ts` restarts after relocation, checks deletion before quota refund, then checks outside and replacement bytes survive while quota remains charged. Returning the original permits reconciliation. |
| 5. A lost delete response makes trash undiscoverable               | Read-authorized `trash.list` pages up to 64 live entries by stable cursor, with path/version/size/expiry.                                                                                                    | `review.test.ts` ignores the delete reply, disconnects, restarts, discovers the ID with a read-only connection and restores exact bytes. A separate pagination case checks duplicates and expiry.              |

## Non-blocking findings

- Cleanup now compares stored device/inode with the temp before unlinking and rechecks after parent verification. The replacement-inode case asserts unrelated content survives.
- Normal daemon startup supplies the durable file-event sink. An indexed query visits affected live threads, batching 64 events per transaction. Canonical `workspace.files_changed` events advance projection sequence without changing agent status. The production daemon integration test checks matching-workspace events and excludes another workspace.
- Normal startup registers `daemon-support`. Read-authorized output/raw export requests produce immutable registry files through bounded byte reads and SQLite incremental blob I/O. The integration test checks exact support/output/raw bytes, read-only credentials and foreign-workspace denial. Recording/screenshot producers use the trusted registration API when those owners land.
- Normal startup with `ACE_RELAY_URL` owns host registration, persisted keys, paired-device authentication, file dispatch and revocation checks. The production relay test exercises this path, read-only denial, revoked devices and rejected local admin credentials. Generic command/browser dispatch remains with its owner.
- Workspace process creation, worker creation and regex deadline scheduling are injected through `WorkspaceOptions.runtime`. Real injected child processes/workers control public search results/errors in `runtime.test.ts`.

## Test quality and surviving mutation

- The 200 MiB reader writes and syncs each frame before granting its next credit. Withheld-credit control replies detect unsolicited frames. Source bytes repeat a random 64 KiB block.
- The 200 MiB archive uses the same incompressible source pattern and checks extraction hashes through real tar, with isolated daemon RSS assertions.
- Mutation symlink-parent tests cover write, create, mkdir, rename, move, delete, restore and upload begin, retaining resume/append/commit path checks.
- PAX coverage now transfers the complete 9 GiB archive, verifies its stream trailer and uses real tar to consume and validate the declared size. Long UTF-8 paths still extract exactly.
- The transfer-cap/release survivor has a stronger cross-device regression: four held downloads fill the default service cap, a fifth device gets BUSY, completion releases a slot and that device then opens a download. **Not executed (tests run at merge).**
- All 21 review mutation cases plus new guards/debt/identity/producer cases are listed in `REVIEW-VERIFICATION.md`, each marked **not executed (tests run at merge)**. No observed kills or flakiness results are claimed.

## Cross-PR integration and performance

Static inspection found that the merge-time CLI bundle must keep `@ace/files` external so native worker URLs resolve beside source. The process-test inventory now includes file, workspace and daemon file suites. The composed bundle needs run at merge.

No-replace and blob workers each admit one request with no waiting queue. Raw export uses a fixed 64 KiB buffer and SHA validation. Output export avoids base64, uses prepared range statements and copies only requested bytes across the SQLite boundary. Artifact exports admit one producer and reserve a default 20 GiB budget. Event fan-out uses indexed cursor pages instead of history scans.

New non-gating `bench:artifacts` measures blob-export throughput, exclusive-rename ops/s and peak RSS; daemon `bench:files` measures workspace-change/thread-event throughput and peak RSS. These measurements need run at merge. Earlier transfer numbers remain clearly labeled historical in `REVIEW-VERIFICATION.md` and the PR description.

Permitted static checks passed: formatting, lint, typecheck and the 1,500-line check. The final delivery repeats these checks after all additions are staged so the size check includes newly authored modules.
