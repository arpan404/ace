# Cloud CLI evaluation

Reviewed 2026-10-11 for issue #552. These are public interface observations;
implementations are written fresh. No vendor sessions or subscription quota were used.

Codex is the first wrapper. The [official CLI reference](https://developers.openai.com/codex/cli/reference/)
documents cloud execution through the installed CLI's login, environment selection,
attempt count and paged JSON listing. ace keeps native task output inside a bounded
JSON envelope. A successful exec is admission, never canonical ace-tree completion.
The user's installed binary owns status/diff/apply support and local patch application.
Uncertain submission receipts prevent blind resubmission. Other cloud operations
need their own durable correlation and acceptance contracts before sharing ace tasks.

[Claude Code cloud](https://code.claude.com/docs/en/claude-code-on-the-web) exposes
`claude --cloud`, messages to existing sessions and teleport. It is a viable future
CLI-only wrapper. The current Phase 3 wrapper does not add it because cloud session
creation, interactive provisioning, queued messages and local handoff need a distinct
result/uncertainty contract. ace would keep authentication in Claude's CLI.

[Jules Tools](https://jules.google/docs/cli/reference/) owns browser login and exposes
remote new/list/pull. It is a candidate for a later CLI adapter. The documented list
interface does not establish the bounded machine-readable status contract ace needs;
verify the installed version before implementing parsing. No Jules REST token path
is proposed.

[GitHub agent tasks](https://cli.github.com/manual/gh_agent-task) expose create/list/view
and remain a preview interface. A future wrapper can reuse the user's own gh login.
Task ids, PR association, JSON availability and cancellation need a versioned contract
before mapping them into canonical ace thread status. No GitHub credential is collected.

[Devin's official CLI guide](https://docs.devin.ai/work-with-devin/devin-cli) confirms a
local binary with cloud handoff, but the reviewed guide does not specify a stable
noninteractive `devin --cloud` result contract. Defer the wrapper until its installed
CLI help and official CLI reference establish submission and observation behavior.
A bearer-only cloud API is outside ADR 0002 and issue #552.
