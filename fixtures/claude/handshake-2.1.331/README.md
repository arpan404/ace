# A prompt-less handshake with `claude` 2.1.331

Recorded on 2026-11-25, with the owner's OK, to settle E3-claude's open questions 2 to 4
([docs/engine/claude-session.md](../../../docs/engine/claude-session.md)). No turn ran and no
quota was spent: the SDK's public `query()` (`@anthropic-ai/claude-agent-sdk` 0.3.288) was given a
prompt stream that never yields, so only `initialize` crossed the wire. The run was then aborted.
`pathToClaudeCodeExecutable` pointed at a tap that logged the argv, the environment the SDK added
and every line in each direction, then ran the installed CLI unchanged. Settings sources were
empty, so no user hooks or MCP servers ran.

- `coding`: ace's coding configuration (the `claude_code` preset, `settingSources: []` for the
  recording) with `canUseTool`, `onElicitation`, `onUserDialog`, two hooks, partial messages,
  hook events, `forwardSubagentText` and `perTaskStopAffordance`, as `adapter-claude/src/session.ts`
  sets them.
- `isolated`: the same without a system prompt, with `strictMcpConfig`.

What it settles:

- `canUseTool` becomes `--permission-prompt-tool stdio` (question 2).
- The SDK adds `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` to the child's environment and nothing else
  (question 3).
- No system prompt becomes `"systemPrompt": [""]` in the `initialize` request, not a flag; empty
  `settingSources` becomes `--setting-sources=` (question 4).

Redacted: the account's email, organization and subscription type, the home directory in
`user_output_styles_dir`, and the CLI's pid.
