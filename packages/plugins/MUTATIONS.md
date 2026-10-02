# Behavior mutation cases

**Current revision: not executed (tests run at merge).** The owner changed the execution policy on 2026-10-02: pre-merge work uses static checks only. The tables map each production fault to its public behavior guard. Earlier execution results recorded before that policy are historical evidence, not validation of the final revision.

| Deliberate fault                                   | Guarding behavior                                                                               | Current validation                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------- |
| Disable relative-path containment                  | hostile component path is rejected before use                                                   | not executed (tests run at merge) |
| Remove the per-file byte cap                       | oversized manifests and files are rejected without component activation                         | not executed (tests run at merge) |
| Ignore commit/hash consent                         | consent pins the prepared commit even after the marketplace branch changes                      | not executed (tests run at merge) |
| Skip staged integrity verification                 | staged tampering and accepted content or mode tampering cannot acquire or retain trust          | not executed (tests run at merge) |
| Skip accepted integrity verification               | staged tampering and accepted content or mode tampering cannot acquire or retain trust          | not executed (tests run at merge) |
| Keep unreferenced version/staging directories      | update requires new consent for changed scripts even when version and command stay the same     | not executed (tests run at merge) |
| Omit Claude command files                          | Claude receives native commands, agents, hook matchers, skill resources and MCP config          | not executed (tests run at merge) |
| Drop native hook matchers                          | Claude receives native commands, agents, hook matchers, skill resources and MCP config          | not executed (tests run at merge) |
| Strip executable permissions during Git extraction | reviews and accepted trust survive reopening and executable bits survive Git extraction         | not executed (tests run at merge) |
| Drop OpenCode MCP environment variables            | OpenCode runtime content adds skills, command templates, subagent prompts, instructions and MCP | not executed (tests run at merge) |
| Skip streamed projection copy verification         | source tampering fails replacement while the previous generated configuration remains usable    | not executed (tests run at merge) |

Runtime validation and mutation execution need a merge-time run. Do not execute these cases during pre-merge review.

## PR #24 review follow-up

The review's four survivors (22, 23, 25 and 26) and nine additional faults are covered by the public behavior guards below. Current status for every case: **not executed (tests run at merge)**.

| Fault                       | Guarding behavior             | Current validation                |
| --------------------------- | ----------------------------- | --------------------------------- |
| 22-delete-recovery          | crash recovery preserves      | not executed (tests run at merge) |
| 23-remove-override-limits   | provider invocation rejects   | not executed (tests run at merge) |
| 25-skip-document-validation | missing .* cannot be reviewed | not executed (tests run at merge) |
| 26-omit-path-hash           | a rename alone                | not executed (tests run at merge) |
| cycle-detection             | cyclic .* file references     | not executed (tests run at merge) |
| hook-output-budget          | flat hook batches             | not executed (tests run at merge) |
| traversal-budget            | empty repeated aliases        | not executed (tests run at merge) |
| depth-budget                | deep acyclic                  | not executed (tests run at merge) |
| acp-session-root            | session resources survive     | not executed (tests run at merge) |
| portable-cwd-default        | portable stdio cwd undefined  | not executed (tests run at merge) |
| cursor-discovery            | Cursor custom paths           | not executed (tests run at merge) |
| cursor-selectors            | conditional Cursor rules      | not executed (tests run at merge) |
| git-descendant-ownership    | Git overflow                  | not executed (tests run at merge) |

The recovery test fails the replacement after restoring distinct previous content. Missing commands, agents and rules each have independent tests. The rename test takes its baseline after setting permissions, isolating path identity. Invocation tests cover both individual and aggregate override sizes. Concurrency now uses two actual managers during a real Git preparation; the injected stream gate provides deterministic synchronization. Git lifecycle tests synchronize descendant readiness and observe real socket closure after the API completes; detached helpers are additionally checked for non-runnable status.

## Independent verifier follow-up

The thirteen verifier follow-up cases below have public behavior guards. N13 was the verifier's sole surviving mutation; the new guard checks absence of the executable as well as its diagnostic. Current status for every case: **not executed (tests run at merge)**.

| ID  | Deliberate fault                             | Guarding behavior                                                                                  | Current validation                |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------- |
| V1  | Persist reviews above the byte cap           | oversized execution reviews fail before persistence                                                | not executed (tests run at merge) |
| V2  | Return full bodies instead of list summaries | large collections expose bounded review summaries                                                  | not executed (tests run at merge) |
| V3  | Skip the first paged entry                   | legacy oversized persisted reviews can be discovered, paged completely and cancelled after restart | not executed (tests run at merge) |
| V4  | Reject single entries above the page target  | a single large accepted execution remains completely readable                                      | not executed (tests run at merge) |
| V5  | Replace Codex command instructions           | Codex commands remain explicitly invocable                                                         | not executed (tests run at merge) |
| V6  | Drop Codex agent instructions                | Codex commands remain explicitly invocable and agents retain prompts                               | not executed (tests run at merge) |
| V7  | Omit projected process arguments             | claude native launch receives plugin overrides                                                     | not executed (tests run at merge) |
| V8  | Omit projected process environment           | opencode native launch receives plugin overrides                                                   | not executed (tests run at merge) |
| V9  | Send ACP parameters without plugin servers   | acp native session receives projected MCP servers                                                  | not executed (tests run at merge) |
| V10 | Accept a relative ACP cwd                    | ACP sessions reject relative workspace directories                                                 | not executed (tests run at merge) |
| V11 | Skip daemon launch shutdown                  | daemon shutdown stops an active plugin launch                                                      | not executed (tests run at merge) |
| V12 | Skip successful private Git cwd release      | successful Git preparation reclaims detached helpers with closed pipes                             | not executed (tests run at merge) |
| N13 | Activate an incompatible OpenCode cwd server | unsupported transport or cwd are reported instead of misconfigured                                 | not executed (tests run at merge) |

## Static verifier follow-up at 94f99dc

Every case below is **not executed (tests run at merge)**. Runtime confirmation needs run at merge.

| ID         | Deliberate fault                                           | Guarding behavior                                                                                                                                                               | Current validation                |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| M4         | Omit legacy summary-column migration                       | legacy oversized persisted reviews can be discovered, paged completely and cancelled after restart                                                                              | not executed (tests run at merge) |
| M9         | Overwrite existing OpenCode config during merge            | OpenCode launch preserves existing runtime MCP servers and instruction paths                                                                                                    | not executed (tests run at merge) |
| R1         | Allow retained provider groups through the plugin launcher | plugin launches reject retained groups before starting a provider or creating resources                                                                                         | not executed (tests run at merge) |
| R1-child   | Remove daemon stopping of ordinary ignored-pipe children   | authenticated daemon installation is reviewed, survives restart and supplies materialized adapter overrides, including child resource use and socket closure                    | not executed (tests run at merge) |
| R2         | Restore the 256 KiB wrapped legacy-entry cap               | legacy consent exposes every argument from a native MCP file at the JSON limit                                                                                                  | not executed (tests run at merge) |
| C1-cwd     | Match only the exact leased cwd                            | a detached Git helper terminates after normal exit while holding stderr in private/nested; successful Git preparation terminates closed-pipe detached helpers in private/nested | not executed (tests run at merge) |
| C1-stdout  | Wait for stdout EOF before starting the drain              | a detached Git helper terminates after normal exit while holding stdout in private/nested                                                                                       | not executed (tests run at merge) |
| C1-sibling | Use a raw string prefix for directory ownership            | private lease cleanup stops nested processes and preserves siblings with the same path prefix                                                                                   | not executed (tests run at merge) |

The integration rehearsal comment provides no specific per-PR diagnostic beyond the canonical status precedence. This branch merges main's conductor, automations and process-test changes and leaves core status unchanged. Plugin real-edge tests join main's process project. No combined runtime rehearsal was executed under the owner's rule.

## Merge with main at 4701bfa

Protocol exports and process-test inventories retain both branches. Daemon shutdown joins plugin tasks and presence cleanup; the outbox retains main's snapshot pressure checks, serialization and injected clock alongside plugin results.

| Deliberate fault                                                  | Guarding behavior                                                                             | Mutation validation               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| Drop either plugin drain or presence failure from shutdown        | finishes pending plugin persistence before reporting a presence shutdown failure              | not executed (tests run at merge) |
| Lose plugin results or their ordering during outbox serialization | delivers plugin control results after queued events and preserves subsequent control messages | not executed (tests run at merge) |

The owner granted a merge-conflict exception for specific affected test files. Ten daemon test files passed with 60 tests, including these two behavior guards. No mutation, full-suite run, benchmark, Docker harness or CI command was executed. All remaining runtime claims need run at merge.
