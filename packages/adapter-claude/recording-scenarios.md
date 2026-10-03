# Claude SDK scenarios to record after approval

These are recorder specifications, not authorization to execute them. Run only
in synthetic workspaces after explicit owner approval. Retain the old
`fixtures/claude/2.1.286` directory and use the installed CLI's actual version for
new captures. Record both wire controls and SDK events with SDK 0.3.288. The
current recorder's older wrapper must be upgraded/reviewed before these runs.
Nothing in this branch invokes the recorder or an installed provider.

| Scenario                     | Concrete steps after approval                                                                                                                                                                | Evidence to retain                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Normal settings              | Create synthetic project/local settings and a harmless hook; ask Claude to read `src/math.ts` with coding configuration, then repeat with isolation.                                         | Preset/settings controls, hook lifecycle, tool availability, no settings mutation.                                                         |
| Permission updates           | Ask for a synthetic edit and outside-directory read. Exercise allow-once, decline and the complete native update set; include a default-to-no and suppressed ask when the CLI produces them. | Native title/description, MCP provenance, all destinations, no suppressed grant, request/tool/child correlation.                           |
| Long approval                | Start a foreground child and leave its permission pending past 60 seconds while another child reports progress. Answer once from each of two devices, then cancel a separate ask.            | Uninterrupted progress, first answer receipt, correct cancellation/expiry.                                                                 |
| MCP ownership                | Start synthetic project/plugin servers plus an SDK-supplied server. Replace the dynamic set, remove it, reconnect/toggle a server and include a deliberately missing synthetic executable.   | Tools/errors/status, raw results, project/plugin servers retained, source config hashes unchanged.                                         |
| Form and URL elicitation     | Synthetic MCP server requests one form, then one URL consent; answer, cancel, and kill the provider while another form waits.                                                                | Typed answer exactly once, completion id/URL correlation, cancellation versus process expiry. Never extract login credentials.             |
| Partials and nested children | Ask for a read through two nested agents; capture partial text/reasoning/tool JSON, complete blocks and late child output.                                                                   | One transcript per block, no incomplete tool input, ancestry and terminal identity.                                                        |
| Surviving interrupt          | Queue two UUID-stamped synthetic prompts while an approved shell is live, then interrupt the root; separately request an explicit cascade.                                                   | Capability advertisement, `still_queued`, consumed UUIDs, task survivors, every stop failure, old-CLI no-receipt behavior.                 |
| Multi-turn accounting        | Run two short synthetic turns with a child and model change; resume, idle-fork and clear the conversation before another short turn.                                                         | Main-loop per-turn counts, inclusive model/cost estimates, inherited baseline, clear epoch, duplicate replay and startup failure handling. |
| Idle history fork            | Close a synthetic session, clone it through the home-bound filesystem helper, then explicitly send input only after inspecting the cloned native id. Repeat using two private homes.         | Source transcript unchanged, new id/UUID chains, persisted lineage, no automatic turn, homes isolated, no undo/worktree claim.             |
| Background completion        | Start an approved background shell/monitor, finish the root and await its completion notification.                                                                                           | Thread remains unfinished until descendant/task/queue facts settle.                                                                        |
| Steering gate, later change  | After a separate steering implementation is reviewable, record human priority-now input during a tool and a queued follow-up.                                                                | Truthful shared input provenance, backgrounded work, queue/turn correlation. This PR does not enable steering.                             |

Re-record existing tool-read, approval-edit, question, plan-review, subagent,
subagent-background, background-shell and interrupt scenarios only where changed
behavior warrants it. Never deliberately exhaust plan quota. Use naturally
observed quota/startup failures or separately approved scenarios.

The Codex pagination-only change needs a synthetic repeated-cursor test at merge;
no paid Codex capture is required for that safeguard. Native fork, detached
review, tier selection and quota service changes remain separate work.

Qwen daemon SDK is out of scope. Gemini remains ACP. Other owners choose their
recordings. If future cross-provider scenarios need the owner-selected models,
use OpenCode `opencode-go/muse-spark-1.3-contributor` and Cursor `composer-2.5`.
