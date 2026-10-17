# Minimum provider CLI versions

Every provider CLI and ACP agent ace launches has one minimum version, declared in
[`packages/provider-kit/src/cli-requirements.ts`](../../../packages/provider-kit/src/cli-requirements.ts).
That file is the only place a floor is set; adapters, discovery, the installer, the model catalog
and the UI read it from there.

A floor is the oldest version that provides every feature ace depends on. Where no source shows
an older version failing, the floor is the oldest version ace has evidence for (a recorded
fixture, an inspected release, a generated schema or a reviewed profile), and the table says so.

| CLI                                   | Minimum | Evidence                                                                                                                                                                                                                                                         | Confidence                                        |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Claude Code (`claude`)                | 2.1.286 | `fixtures/claude/2.1.286` (9 recorded scenarios, `claude_code_version: 2.1.286`); `user_message_uuids` on reply frames appears in `native-ace-mcp.jsonl`; native steering (`priority: "now"`) from the SDK 0.3.286 changelog ([claude-code.md](claude-code.md)). | Works at 2.1.286: high. Oldest possible: unknown. |
| Codex (`codex`)                       | 0.159.1 | `packages/adapter-codex/src/generated/VERSION` is `codex-cli 0.159.1`; `clientUserMessageId` in `TurnStartParams`, `TurnSteerParams`, `ThreadQueueAddParams`; `fixtures/codex/0.159.1` includes `turn/steer`.                                                    | Works: high. No older schema was generated.       |
| OpenCode (`opencode`)                 | 2.0.22  | `@opencode/client` 2.0.22 pin; `session.inbox.delivered` in its typings and in `fixtures/opencode/2.0.22`. Newer 2.0.x patches are checked against the served OpenAPI document; a newer line is "unsupported", never "too old".                                  | High.                                             |
| Pi (`pi`)                             | 0.85.1  | ADR 0050 gates support to the inspected 0.85.1 release ([pi.md](pi.md)).                                                                                                                                                                                         | Medium: inspected, no recorded turns.             |
| Cursor SDK (`@cursor/sdk`)            | 1.0.35  | Ships with ace and is pinned exactly (ADR 0043, `fixtures/cursor-sdk/1.0.35`). Older is "too old"; newer is "unsupported".                                                                                                                                       | High.                                             |
| Antigravity (`agy_acp_server`)        | 1.2.1   | The inspected release: `loadSession`, `sessionCapabilities.resume`, image prompts ([antigravity.md](antigravity.md)). 1.1.1 was never inspected.                                                                                                                 | Medium.                                           |
| Gemini CLI (`gemini`)                 | 0.43.0  | Reviewed profile `gemini-043`; its `initialize` reply was inspected ([acp-registry.md](acp-registry.md)).                                                                                                                                                        | Medium.                                           |
| Qwen Code (`qwen`)                    | 0.0.14  | Reviewed profile `qwen-old` (`--experimental-acp`), inspected in [sdk-audit.md](sdk-audit.md).                                                                                                                                                                   | Medium.                                           |
| Claude Agent ACP (`claude-agent-acp`) | 0.85.1  | Reviewed profile `claude-bridge`, from the registry snapshot only.                                                                                                                                                                                               | Low: never run.                                   |
| Codex ACP (`codex-acp`)               | 2.1.1   | Reviewed profile `codex-bridge`, from the registry snapshot only.                                                                                                                                                                                                | Low: never run.                                   |
| Goose (`goose`)                       | 1.53.0  | Reviewed profile `goose-153`, from the registry snapshot only.                                                                                                                                                                                                   | Low: never run.                                   |
| Auggie (`auggie`)                     | 0.36.0  | Reviewed profile `auggie-036`, from the registry snapshot only.                                                                                                                                                                                                  | Low: never run.                                   |
| Any other ACP agent                   | ACP 1   | No reviewed profile, so no version ace has checked. `initialize` must answer `protocolVersion: 1` (`adapter-acp/src/negotiation.ts`).                                                                                                                            | Protocol floor, not a CLI version.                |

## What happens below the minimum

- Discovery reports `versionCheck: { status: "too_old", installed, required }` on the provider's
  status row, and readiness becomes `needs_update`. The row is never ready, whatever its sign-in.
- Settings shows "Update needed" with Update as the one action, and the provider page says, for
  example, "Claude Code 2.1.200 is older than 2.1.286, the oldest version ace supports. Update
  Claude Code, then refresh."
- The model catalog doesn't probe the CLI; its error names both versions.
- Starting a session throws `CliTooOldError` (`code: "cli_too_old"`) before the CLI launches.
- The installer reports an install or update that lands below the minimum as a refusal, not success.
- Check again (provider status refresh) picks up an updated CLI without restarting ace.

An unreadable version is not reported as too old. Claude, Codex and Pi still refuse to start a
session on one, because their capabilities are gated on the version.
