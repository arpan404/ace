# ACP registry recordings to request after approval

Nothing in the registry implementation or recorder definitions authorizes these recordings. They start provider sessions/turns and spend quota. No recording was run. The owner must choose exact installed versions and explicitly request execution first. Use Cursor `composer-2.5` and OpenCode `opencode-go/muse-spark-1.3-contributor` where those providers participate.

Preserve the existing Cursor version directory `fixtures/cursor/2026.09.26-dd393fe/` and its public status expectations. Re-record only after approval: `tool-read.jsonl`, `approval-edit.jsonl`, `question.jsonl`, `plan-review.jsonl`, `subagent.jsonl`, `subagent-background.jsonl`, `background-shell.jsonl`, `interrupt.jsonl`, each with its corresponding `.expect.json`. An upgraded CLI gets a new version directory. Registry identity, MCP injection, restart and selector scenarios add evidence rather than rewriting those original cases.

| Agent/version choice                      | To record after approval                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Cursor installed and selected upgrade     | Existing eight cases; registry identity, MCP injection, restart and selectors                                                  |
| Antigravity reviewed server               | Tool/approval, hidden-child and surviving-shell limitations, interrupt; installation/auth terms need separate resolution       |
| Gemini 0.43.0 or selected newer           | Tool, permission, model/mode selection, HTTP MCP, load/replay, supported children/background work, surviving shell, interrupt  |
| Qwen 0.0.14 if retained                   | Minimal tool/permission, stdio MCP bridge, cancellation, unsupported resume/selectors                                          |
| Qwen modern selected version              | Tools/permissions, selectors, MCP, load/list/resume, actual lifecycle/heartbeat and child/background evidence                  |
| Claude-agent-acp/native pair              | Tool, approval/question, MCP, selectors, supported resume/fork, negotiated child/background work, cancellation and restart     |
| Codex-acp/native pair                     | Tool, approval/question, MCP, selectors, supported resume/fork, negotiated child/background work, cancellation and restart     |
| Goose/Auggie selected versions            | Tool/approval, MCP injection and configuration preservation, selectors/load, background work/cancel; login stays owner-managed |
| Kiro/OpenHands optional selected versions | Minimal tool/approval/MCP, supported selectors/load/cancel; documented no-op and visibility limits                             |

Definitions live in `tools/recorder/src/acp-plan.ts`. Proposed scenarios do not claim provider support. New fixtures use `fixtures/<agent-id>/<bridge-and-native-version-or-cli-version>/<scenario>.jsonl`, record source-qualified identity and relevant versions, redact homes/identities/secrets, and include behavior expectations. The research's initialize-only transcripts may be used as deterministic synthetic input without new provider calls.
