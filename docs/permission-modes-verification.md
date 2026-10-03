# Permission modes verification

No tests, provider prompts, probes, benchmarks, mutation runs, recorder sessions or UI changes were executed. Behavior and adapter tests are written for the merge gate. Runtime statements below need run at merge.

## Static review

- PermissionMode is schema-only in @ace/protocol. Resolution and risk decisions have no I/O in @ace/core.
- Settings preserve the deprecated approvals.policy key and add permissions.defaultMode. Missing legacy values use auto-review. Only explicit never migrates to full-access. Workspace and thread resolution reuse the settings owner.
- Engine stores requested and effective modes separately. Native sessions receive an explicit mode. Pending changes retire an idle session at the next boundary; steering and live child/background work keep the current policy.
- Durable parent edges constrain delegated children at spawn, subsequent commands and later session admissions. Raw native permission/sandbox options are rejected across sends, forks and switches.
- Approval facts use exact structured targets. Display titles and wildcard permission resources never earn automatic permission. Physical paths resolve symlinks and existing ancestors in the daemon shell. Unknown commands and tools escalate. Reviewer grants are single-use only.
- Restricted modes refuse human permanent native grants too; read-only refuses one-shot mutation grants.
- The decision event, transcript notice and resolution intent share the existing event/receipt transaction. The unique interaction decision prevents replay duplication; a reserved resolution prevents a second human answer. Native I/O is outside the transaction. Uncertain provider resolution is governed by existing engine restart handling.
- permission.reviewed materializes Interaction.review for snapshots and reconnects. @ace/client copies the changed interaction and publishes its keyed notification. The transcript notice retains the structured review as raw data.
- Every provider advertises auto-review and launches with its strongest available native guard. Codex uses workspace-write, network disabled, on-request and approvalsReviewer user. Cursor enables sandbox plus autoReview without an ace classifier-availability refusal. Pi selects read tools and excludes ambient extensions/MCP. ACP selects an advertised read-only/plan option when present; missing selectors do not prevent launch. ADR 0061 documents incomplete coverage and audit limits. Every surfaced approval goes through ace; unsurfaced operations cannot receive an ace decision.
- Permission capabilities include an auto-review guarantee with its level, gates and limitations. The read-only permissions.capabilities request exposes registry metadata before thread creation, including an optional Cursor backend selection, without starting sessions. PermissionClient.getCapabilities and permissionGuarantee expose it to clients. Missing metadata remains unknown. Fake guarantees explicitly describe simulation.
- The fake daemon shares mode resolution and risk policy. Its filesystem is simulated; it never reads the host filesystem.

## Mutation cases

Every case is **not executed (tests run at merge)**.

| Mutation                                                            | Behavior test designed to kill it                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Change the shipped default to ask or full-access                    | Unset settings and engine default test                     |
| Treat absent legacy never as full access                            | Default and legacy migration tests                         |
| Drop scoped settings precedence                                     | Workspace/thread settings test                             |
| Ignore a new default when legacy policy conflicts                   | Legacy conflict test                                       |
| Approve every shell request                                         | Dangerous and uncertain engine/fake cases                  |
| Deny or escalate every action                                       | Low-risk pwd approval with provider answer                 |
| Drop the review reason                                              | Engine interaction resolution and client reader assertions |
| Resolve an uncertain interaction                                    | Uncertain needs_you and pending-state cases                |
| Approve outside-workspace destruction                               | Outside path and symlink escalation cases                  |
| Approve credential access                                           | .env escalation case                                       |
| Accept a human permanent grant under auto-review                    | Native grant refusal test                                  |
| Accept a protected mutation after read-only escalation              | Protected read-only write test                             |
| Escalate a destructive action when native cancellation is available | Codex native cancellation and fake durable deny cases      |
| Use a permanent native grant                                        | One-shot provider resolution assertion                     |
| Change effective mode during an active turn                         | Next-turn mode test                                        |
| Allow full-access child under auto-review parent                    | Child spawn and later-mode refusal test                    |
| Drop explicit full-access selection                                 | Next-turn full-access and adapter transport assertions     |
| Omit Codex sandbox/approval parameters at turn start                | Codex scripted app-server policy test                      |
| Permit ambient Claude grants                                        | Claude isolated sources and restricted callback behavior   |
| Omit OpenCode wildcard ask rule                                     | OpenCode scripted server request test                      |
| Start Pi unrestricted for auto-review                               | Pi scripted write availability tests for all modes         |
| Refuse ACP without complete permission coverage                     | ACP scripted launch with and without selectors             |
| Downgrade Cursor restricted policy to full access                   | Cursor scripted SDK admission with unknown classifier      |
| Drop review snapshot materialization                                | Engine snapshot and @ace/client reader tests               |
| Refuse default auto-review for any registered provider              | Each provider's engine launch and capability preview case  |
| Claim protected-read coverage for Codex/Cursor/Pi                   | Per-provider guarantee response and thread snapshot cases  |
| Enable Codex network or native auto_review                          | Scripted thread/turn transport policy assertions           |
| Auto-approve a network escalation attached to pwd                   | Codex network escalation needs_you case                    |
| Drop ACP exact raw input or use its display title                   | ACP scripted request target and native engine review cases |
| Skip a provider's surfaced approval                                 | Codex/Claude/OpenCode/ACP translated request engine cases  |
| Open a native session to preview guarantees                         | Capability request before creation, zero open contexts     |
| Report an unknown guarantee as complete coverage                    | Client preview and missing metadata reader case            |

## Integration follow-up

PR #83 owns Deck execution. It must persist the per-deck override and pass it to Engine.spawn for every card, planner, worker, reviewer and integrator lane, including retries and replacements. A Deck requesting full access from a restricted existing coordinator needs its own explicitly opted-in root thread; a child cannot expand its current parent's authority.

The Claude web agent owns all UI changes. Use PermissionClient.getCapabilities(provider, backend), permissionGuarantee, PermissionClient, permissionModes, threadPermission and permissionReview from @ace/client, plus ClientApi.command/request and keyed thread readers. Composer and New thread must show the chosen provider's guarantee level, gates and limitations. See the PR description for exact requests.

Static verification: typecheck, lint, formatting of changed backend/docs files, check:size, check:deps and docs:protocol --check. All tests and provider runtime validation remain **needs run at merge**. No probes or tests are executed locally.

check:deps exits successfully with no violations. Dependency-cruiser 18.5.0 emits its missing-typescript-transpiler warning for TypeScript 7. The existing repository configuration uses the supported SWC parser, including type-only imports; it does not depend on the missing TypeScript JS compiler API. Upstream's current release is already installed, so there is no supported upgrade that supplies that API. See [the upstream parser documentation](https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md#parser).

## Verifier fix round (2026-10-03)

Merged origin/main at a6230291 (#82) before these fixes. No integration-rehearsal finding was present in PR #84 issue comments, reviews or inline comments. The original review file mentioned by the verifier remains unavailable; the current verifier's B1–B3 and follow-ups were reviewed directly.

- B1: the public engine mode command reaches a scripted ACP process. Restricted modes reject bypassPermissions before native I/O; explicit full-access still permits the advertised selector. Selector availability errors retain their existing behavior. No selector-less launch refusal was added.
- B2: native Claude Grep and Read directory requests reach the engine with a real temporary secrets.json fixture. Both remain needs_you; a regular ordinary file is still approved once with its reason. Unknown/broad tools cannot obtain approval just by supplying a contained file path. The fake broad-read path escalates.
- B3: a three-level full-access tree tightens its ancestor at the next boundary while the intermediate stays idle. Descendant setters/spawns reject widening; subsequent descendant turns, inherited threads and portable forks receive read-only. The engine and fake use the same bounded pure ancestry walk; historical turns and transcripts are not scanned.
- Added exact Codex roots and network/tmp/reviewer assertions on open, resume, fork and turns. Added Claude resume/fork, OpenCode resume, Pi resume/cold-fork and ACP load-session restrictions. Cursor scripted SDK recovery resumes both previously restricted and previously full-access checkpoints with sandbox plus autoReview. Providers without native fork support use the portable engine path.
- Added cold SQLite close/reopen assertions for approval/escalation events, notices, reasons and resolutions; duplicate pending approval replay; and a human answer racing the reviewer's reserved resolution. Expired native requests after shutdown remain expired; restoring audit data does not resubmit them.
- Aligned existing scripted transition/history providers with the explicit permission capability contract; their public default launch/fork behavior remains auto-review. The legacy ACP selector-negotiation fixture explicitly opts into full access when asserting unrestricted selector ordering.
- Renamed the provider metadata/engine test to state its scripted boundary. Actual native policy coverage remains in the separate adapter process/SDK tests.

All behavior assertions below **need run at merge**. Reproductions were written before the corresponding blocker logic changes and assessed statically; no failing or passing test execution is claimed.

| Mutation                                                                               | Guarding behavior                                                                                                | Result                            |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Allow ACP bypassPermissions via thread.mode.set under auto-review/ask                  | acp-permission-selectors.process.test.ts: public mode changes keep ACP's permission contract                     | not executed (tests run at merge) |
| Reject advertised native selectors even after explicit full-access                     | Same public-command full-access case                                                                             | not executed (tests run at merge) |
| Approve broad Grep/Glob from contained paths                                           | provider-permissions.process.test.ts: Claude directory searches; core unknown/broad-tool cases; fake broad reads | not executed (tests run at merge) |
| Treat directories/missing files as verified regular files                              | Claude Read directory regression and exact ordinary regular-file engine approval                                 | not executed (tests run at merge) |
| Remove exact-read allowlist or escalate all file reads                                 | Exact ordinary regular-file approval and one-shot reason                                                         | not executed (tests run at merge) |
| Resolve ceilings only from the immediate parent's cached mode                          | permission-ancestry.process.test.ts: three-level turns, setters, spawns and forks; fake ancestry case            | not executed (tests run at merge) |
| Apply a pending ancestor override before its turn boundary                             | Existing active-turn boundary test                                                                               | not executed (tests run at merge) |
| Widen Codex writable roots or lose resume/fork/turn guards                             | adapter-codex permissions.process.test.ts exact roots and network/tmp/reviewer policy                            | not executed (tests run at merge) |
| Drop restricted native policy on resume/fork                                           | Claude, OpenCode, Pi, ACP and Cursor scripted recovery assertions                                                | not executed (tests run at merge) |
| Lose permission review events, reasons, notices or resolutions after reopening storage | permission-audit-recovery.process.test.ts cold Store/Engine reopen                                               | not executed (tests run at merge) |
| Produce multiple decisions on duplicate pending approvals                              | Same file, duplicate pending provider approvals case                                                             | not executed (tests run at merge) |
| Permit a human answer to replace a reserved automatic resolution                       | Same file, human answer racing automatic decision case                                                           | not executed (tests run at merge) |

Fast static checks only: typecheck, lint, formatting of edited backend/tests/docs files, check:size, check:deps and docs:protocol --check. CI remains disabled and was not run or watched. No UI files were edited.

## Second verifier fix round (2026-10-03)

Reviewed the round-2 report at head 72fb6412 and the newest PR comment. origin/main remains a6230291 and is already merged. There are still no separate integration-rehearsal findings in issue comments, reviews or inline comments. The pre-round-1 report remains unavailable; no historical executed mutation outcomes are claimed.

B4 is fixed by preserving generic ACP read categories as acp/read. Kinds and follow-along locations cannot establish the exact operation or exhaustive accessed paths. Wildcard, absent, mismatched and apparently exact inputs all reach the public translator and engine with an ordinary file location and a secrets.json fixture. Each case requires one durable escalation, needs_you, a pending request and no native grant. Known provider-specific exact Read operations retain their existing approval path. ACP's reported guarantee limitations now disclose the generic-read escalation.

The cold reopen case now parses the persisted decision rows through Store.atomic and requires the exact audited reason, target, identity and mode. Retrying the old canonical interaction's public resolution after reopening must fail, retain one row/event/notice and send no additional grant. This closes R1-19's drop-review-insertion mutation gap. Recovery expires the old process's requests; they must not be silently submitted to a replacement process. This is distinct from a fresh canonical request, which needs its own review.

Additional coverage exercises both native session/set_config_option and legacy session/set_mode through public engine commands and the public adapter session. Read-only, ask and auto-review reject build/bypass selectors; explicit full-access accepts them. Unknown selections retain their availability error. The read-only session case asserts only the selector restriction; generic ACP still does not advertise a comprehensive read-only guarantee. A symlink with an ordinary filename pointing to a workspace .env fixture escalates. The complete ancestor scenario now also closes/reopens SQLite and Engine before descendant setters, turns, spawns and forks.

The TypeScript 7 dependency-cruiser warning remains disclosed above; the supported SWC parser remains configured. Composer/New thread guarantee rendering, controls and audit APIs remain documented in the PR's UI follow-up. No UI files changed.

All runtime assertions **need run at merge**. The B4 regression was written before changing its translator mapping; no failing or passing test execution is claimed. These tests were statically traced through their public boundaries.

| Mutation                                                                    | Guarding behavior                                                                                            | Result                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Map generic ACP read categories back to trusted read                        | provider-permissions.process.test.ts wildcard, absent, mismatched and apparently exact native inputs         | not executed (tests run at merge) |
| Drop review-table insertion while retaining events (R1-19)                  | permission-audit-recovery.process.test.ts parses exact durable review rows after cold reopen                 | not executed (tests run at merge) |
| Regrant or rereview an expired/resolved canonical interaction after restart | Same cold reopen case retries interaction.resolve and requires no extra row, event, notice or provider grant | not executed (tests run at merge) |
| Permit build/bypass via legacy session/set_mode or read-only selectors      | permission-selectors.process.test.ts and acp-permission-selectors.process.test.ts public commands/native RPC | not executed (tests run at merge) |
| Lose physical secret classification through a symlink                       | permissions.process.test.ts ordinary filename pointing to workspace .env                                     | not executed (tests run at merge) |
| Lose ancestor links on restart or trust only the intermediate cached mode   | permission-ancestry.process.test.ts cold SQLite/Engine reopen before descendant admission                    | not executed (tests run at merge) |

Only the permitted static checks run locally. Tests, bun run check, CI, probes, benchmarks, provider prompts and recorder sessions remain unexecuted.
