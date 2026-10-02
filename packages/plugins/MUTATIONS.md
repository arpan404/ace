# Behavior mutation checks

Run on 2026-10-02. Each fault below was applied to production code, tested through the package's public API, and reverted immediately. Every fault produced a behavior test failure, not a transform or import error.

| Deliberate fault                                   | Test that failed                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Disable relative-path containment                  | hostile component path is rejected before use                                                   |
| Remove the per-file byte cap                       | oversized manifests and files are rejected without component activation                         |
| Ignore commit/hash consent                         | consent pins the prepared commit even after the marketplace branch changes                      |
| Skip staged integrity verification                 | staged tampering and accepted content or mode tampering cannot acquire or retain trust          |
| Skip accepted integrity verification               | staged tampering and accepted content or mode tampering cannot acquire or retain trust          |
| Keep unreferenced version/staging directories      | update requires new consent for changed scripts even when version and command stay the same     |
| Omit Claude command files                          | Claude receives native commands, agents, hook matchers, skill resources and MCP config          |
| Drop native hook matchers                          | Claude receives native commands, agents, hook matchers, skill resources and MCP config          |
| Strip executable permissions during Git extraction | reviews and accepted trust survive reopening and executable bits survive Git extraction         |
| Drop OpenCode MCP environment variables            | OpenCode runtime content adds skills, command templates, subagent prompts, instructions and MCP |
| Skip streamed projection copy verification         | source tampering fails replacement while the previous generated configuration remains usable    |

Use `bun run test -- packages/plugins/src/<file>.test.ts -t '<behavior>'` to run a named behavior while reproducing a fault. The full unmutated suite must pass afterward.

## PR #24 review follow-up

The review's four survivors (22, 23, 25 and 26) and nine additional production faults below were applied individually and reverted. Each named public-API regression failed with a behavioral assertion; none failed from a transform or import error. The unmutated suite passed afterward.

| Fault                       | Behavior that failed          |
| --------------------------- | ----------------------------- |
| 22-delete-recovery          | crash recovery preserves      |
| 23-remove-override-limits   | provider invocation rejects   |
| 25-skip-document-validation | missing .* cannot be reviewed |
| 26-omit-path-hash           | a rename alone                |
| cycle-detection             | cyclic .* file references     |
| hook-output-budget          | flat hook batches             |
| traversal-budget            | empty repeated aliases        |
| depth-budget                | deep acyclic                  |
| acp-session-root            | session resources survive     |
| portable-cwd-default        | portable stdio cwd undefined  |
| cursor-discovery            | Cursor custom paths           |
| cursor-selectors            | conditional Cursor rules      |
| git-descendant-ownership    | Git overflow                  |

The recovery test fails the replacement after restoring distinct previous content. Missing commands, agents and rules each have independent tests. The rename test takes its baseline after setting permissions, isolating path identity. Invocation tests cover both individual and aggregate override sizes. Concurrency now uses two actual managers during a real Git preparation; the injected stream gate provides deterministic synchronization. Git lifecycle tests synchronize descendant readiness and observe real socket closure after the API completes; detached helpers are additionally checked for non-runnable status.

## Independent verifier follow-up

All thirteen faults below were applied individually, caused the named public behavior to fail, and were reverted. Runs excluded transform errors and fixture timeouts. N13 is the verifier's sole surviving mutation.

| ID  | Deliberate fault                             | Failed behavior                                                        |
| --- | -------------------------------------------- | ---------------------------------------------------------------------- |
| V1  | Persist reviews above the byte cap           | oversized execution reviews fail before persistence                    |
| V2  | Return full bodies instead of list summaries | large collections expose bounded review summaries                      |
| V3  | Skip the first paged entry                   | legacy pending reviews remain discoverable with complete details       |
| V4  | Reject single entries above the page target  | a single large accepted execution remains completely readable          |
| V5  | Replace Codex command instructions           | Codex commands remain explicitly invocable                             |
| V6  | Drop Codex agent instructions                | Codex commands remain explicitly invocable and agents retain prompts   |
| V7  | Omit projected process arguments             | claude native launch receives plugin overrides                         |
| V8  | Omit projected process environment           | opencode native launch receives plugin overrides                       |
| V9  | Send ACP parameters without plugin servers   | acp native session receives projected MCP servers                      |
| V10 | Accept a relative ACP cwd                    | ACP sessions reject relative workspace directories                     |
| V11 | Skip daemon launch shutdown                  | daemon shutdown stops an active plugin launch                          |
| V12 | Skip successful private Git cwd release      | successful Git preparation reclaims detached helpers with closed pipes |
| N13 | Activate an incompatible OpenCode cwd server | unsupported transport or cwd are reported instead of misconfigured     |
