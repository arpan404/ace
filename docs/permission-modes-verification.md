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

check:deps exits successfully but dependency-cruiser warns that its TypeScript compiler integration does not yet support TypeScript 7; dependency scan coverage has that tooling limitation.
