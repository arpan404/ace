# Fixture analysis: what the recordings showed

These recordings were made on 2026-10-02 with `tools/recorder` against claude 2.1.286, codex 0.159.1, opencode 1.18.33 (model `opencode-go/glm-5.3`) and cursor 2026.09.26. Fixtures are in [`fixtures/`](../../../fixtures). Each provider file below gives evidence by fixture and timestamp, plus a status algorithm for the adapter:

- [claude.md](claude.md)
- [codex.md](codex.md)
- [opencode.md](opencode.md)
- [cursor.md](cursor.md)

Each scenario was recorded once, so the orderings below are observations, not guarantees.

## Confirmed across providers

1. **A turn ending never means the agent is done.**
   - Background shells outlived the turn on Claude, Codex and Cursor.
   - Background subagents outlived it on Claude, Codex and OpenCode.
   - **Interrupting Codex does not stop the running command**: it kept streaming for 52 s after `turn/completed{interrupted}`.
2. **Providers start turns on their own.**
   - Claude starts a new turn 12–82 ms after a background task finishes, and reveals why only on the final `result.origin`.
   - OpenCode injects a synthetic `<task …>` user message into the parent.
   - Codex reports the late completions under the old, finished turn id and never starts a follow-up.
3. **Children can appear before the call that spawned them.** OpenCode's child `session.created` arrives before the parent's task-part metadata. Codex child frames can arrive before the `subAgentActivity` item. Agents must be created on first sight and linked to their spawning call later (`agent.updated.spawnedBy`).
4. **Some background work is invisible.** Over ACP, Cursor reports a background shell as completed with empty output while it keeps running for 13 s and sends nothing further. This is why `Capabilities.backgroundVisibility` exists. For `none` and `partial`, ace needs a side channel or must show "may still be running".
5. **Interrupts leave open tool calls.** Codex and Cursor never close the running call. Adapters close or convert them themselves, otherwise a thread can never reach "done".
6. **Questions come in more than one shape.**
   - Codex has a blocking `requestUserInput` and a non-blocking async `agentMessage` question that is answered with `turn/steer`.
   - Cursor's model said it had no question tool in the default mode.
   - In OpenCode, rejecting a question dismisses the tool without an error turn.
7. **No reliable built-in idle event.** Claude's `session_state_changed` is only emitted when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is set. OpenCode's idle can come before the last tool update. Every adapter derives idle from turn end, open interactions, live background tasks and running children.

## Protocol changes made from these findings

- `RunTrigger` gains `spawn` and `parent_agent`.
- `run.ended` can correct the trigger, and `Run.nativeId` holds the provider's turn id.
- `BlockedReason` gains `upstream` (provider overloaded, retrying). Blocked status gains `attempt` and `message`.
- `working` gains `detail`, and `interrupted` is documented as settled.
- `BackgroundTask` gains `ambient` and `outputPath`. `unknown` is documented as not running for "done", and shown to the user as possibly running.
- `Capabilities.backgroundVisibility: full | partial | none`.
- `NativeRef` gains `path` (Codex agent path) and `aliases`.
- `agent.updated` can set `spawnedBy` and `background` late.
- `plan_review` requests gain `title`, `summary` and `todos`; the plan tool detail gains `todos`.
- Question resolutions can be `dismissed`; plan reviews can be `cancel`led.
- Documented: items may arrive after their run ended; non-blocking interactions still make a thread `needs_you`; adapters create a tool-call item for interactions that have none.

## Not yet covered

- **Approvals on Cursor:** your Cursor allowlist covered every command, so no permission prompt appeared.
- **Questions on Cursor:** the model didn't use one in the default mode.
- **Recording isolation:** Codex recordings include your personal skills and MCP servers. Isolating them needs a recorder-owned `CODEX_HOME`, which means pointing it at your auth file; that's a decision for you.
- **Antigravity:** not installed.
