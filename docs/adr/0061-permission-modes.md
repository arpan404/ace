# 0061: Permission modes with auto-review by default

Date: 2026-10-03. Status: accepted for implementation.

## Number allocation

Checked origin/main and open PRs #82 and #83 before writing this record. Main ends at 0057 and has two records numbered 0056. PR #82 reserves 0058 and 0059; PR #83 now reserves 0060. This record moves from 0060 to the next free number, 0061. Renumbering existing records belongs to a separate change.

## Decision

PermissionMode is an ace policy, separate from provider plan modes and workspace local/worktree modes. Its values are read-only, ask, auto-review and full-access. Auto-review is the shipped default. Full access requires an explicit setting or thread/deck selection. On-failure does not survive as an ace mode: failure-triggered sandbox escape is neither a risk review nor a portable permission contract.

The schema lives in @ace/protocol. Pure resolution and deterministic review belong to @ace/core; the engine owns settings reads, physical path containment, durable decisions and provider resolution intents. Settings use permissions.defaultMode, resolved thread settings over workspace over global over defaults. A thread permissionMode override takes precedence. A host-owned spawn API accepts a permission mode and optional parent thread. Deck supplies its override through that API to every card and lane thread, including replacements and retries. This branch does not change the conductor executor in PR #83.

Delegated children inherit their parent's effective mode. An explicit child selection can only lower it, in the order read-only < ask < auto-review < full-access. Durable parent links constrain every later turn and mode change, including settings changes, provider switches and resumed work. Provider-specific options cannot grant permissions. Agent-control tools do not expose the permission command or human approval resolution.

Mode changes are requested immediately but become effective only before the next turn, once the provider's own tree has no live turns, background work or interactions. Steering retains the active turn's mode. A provider session is retired and resumed with explicit policy when the effective mode changes. No active child or background shell is closed merely to apply a setting. Autonomous provider continuation retains the session policy until the next engine-owned boundary.

## Settings compatibility

Keep approvals.policy as a deprecated wire key. Explicit stored ask maps to ask, never to full-access, and on-failure to auto-review. Missing approvals.policy never opts into full access. Existing permissions.defaultMode takes precedence within its layer. Decode legacy documents without discarding comments or unknown fields. Writes through the legacy key update the new key too, so old clients still change the effective policy. New callers use permissions.defaultMode.

## Provider enforcement

Owner decision on PR #84: every provider launches in auto-review using its best available native guard. Incomplete coverage is explicit; it does not cause an ace launch refusal or a full-access fallback. Installed/version compatibility checks still apply.

Capabilities expose supported modes, nativeAutoReview, toolGate and an additive auto-review guarantee. A guarantee has a level, gates for writes/network/protectedReads/shell, and limitations. A true gate means the provider constrains that action class through sandboxing, tool exclusion or a pre-execution approval gate. It does not mean every action receives an ace review. False means ace cannot promise coverage. toolGate means surfaced approval requests can be answered, not that the provider surfaces every action. Missing guarantee metadata is unknown to clients, never full protection.

| Provider | Auto-review native guard | Level | Writes / network / protected reads / shell | Audit limits |
| --- | --- | --- | --- | --- |
| Codex app-server | workspace-write, network disabled, on-request, approvalsReviewer user | sandbox | true / true / false / true | Workspace writes and sandbox-allowed commands can execute without approval; secret-file reads inside the workspace aren't gated. Native auto_review stays off. |
| Cursor SDK 1.0.35 | sandbox enabled, autoReview true, isolated settings | sandbox | true / false / false / true | SandboxOptions exposes only enabled. Network and protected-read coverage are unverified. No public permission/escalation decision callback; native decisions and classifier availability cannot be audited by ace. |
| Claude Agent SDK | default native mode, isolated settings, PreToolUse asks for every tool including children | tool-gate | true / true / true / true | Native auto is available but unused because ace owns decisions. |
| OpenCode v2 | wildcard ask rules reapplied on resume | tool-gate | true / true / true / true | Exact targets are reviewed; permission patterns alone escalate. |
| Pi 0.85.1 | no ambient extensions; read,grep,find,ls tools only; no MCP tools | tool-selection | true / true / false / true | Writes, shell and network tools are excluded. Native read tools can read secrets. RPC has no tool permission callback; generic extension questions remain human questions. |
| Generic ACP | request_permission routed to ace; choose advertised read-only/plan selector when present | permission-requests | false / false / false / false | No portable tool allowlist or comprehensive gate. Selector names are best available hints, not an enforceable sandbox guarantee. Agents may perform unsurfaced actions. |

Every approval request a provider surfaces enters the same ace reviewer and durable decision path. Cursor 1.0.35 and Pi 0.85.1 expose no native approval decision callback, so ace cannot synthesize decisions for their unsurfaced operations. Generic ACP without selectors still launches with client filesystem/terminal capabilities disabled and explicitly limited guarantees. Never select a native unrestricted/bypass mode as a restricted-mode fallback.

Codex thread start/resume/fork and every turn explicitly set the policy. Turn workspaceWrite uses only the thread workspace as writableRoots, excludes temporary-directory write exceptions, and disables network. Network escalation requests remain uncertain human work; ace never automatically enables network. The pinned generated AskForApproval enum accepts on-request; the [official config reference](https://learn.chatgpt.com/docs/config-file/config-reference) confirms on-request is current, untrusted unsupported and on-failure deprecated. approvalsReviewer user ensures ace decides each surfaced request.

Sources: pinned official SDK declarations, Codex generated app-server 0.159.1 schemas, [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), [Claude SDK permissions](https://platform.claude.com/docs/en/agent-sdk/permissions), ADR 0050 and ADR 0044. No provider prompts or recorder sessions are used to infer coverage.

## Reviewer and audit

The deterministic reviewer consumes a schema-validated exact command, paths or tool input and the thread's physical workspace. It does not execute commands. Path checks resolve existing ancestors, including symlinks, before granting access. Unknown tools, shell composition, broad permission grants and incomplete targets escalate. A small allowlist permits low-risk reads and commands. Clearly destructive workspace commands are denied. Secret/credential access and destructive actions outside the workspace always escalate, even when another rule would deny them. Read-only never approves writes.

Each ace review creates a durable permission.reviewed event containing interaction identity, target, effective mode, decision and reason. The same transaction creates a transcript notice and, for allow/deny, a single-use resolution intent. No session-wide or permanent grants are synthesized. Restricted ace modes also refuse permanent native grants submitted by a human; full access requires the explicit mode command. Read-only refuses human mutation approvals. Escalation leaves the interaction pending, so ADR 0004 derives needs_you for the whole tree. Retries cannot duplicate decisions or race a human resolution; uncertain delivery after restart is never replayed automatically.

An optional provider-session reviewer may be injected at the host boundary in a later change. It must use the user's installed, logged-in CLI or official local SDK, with no tools, no ace control lease and no credentials entering ace storage or clients. Its structured result may only classify cases the deterministic policy explicitly delegates. Protected secret/outside-workspace cases always escalate and cannot be overruled. This initial implementation uses the deterministic reviewer alone and never sends reviewer prompts.

## Safety invariants and follow-up

Auto-review never grants full access. Restricted provider options and ambient permission grants cannot override the resolved mode. Children cannot exceed their parent. Mode changes occur at turn boundaries. Uncertain approvals remain human work. Full access is an explicit opt-in and intentionally disables tool risk review.

The Claude web agent will add mode pickers, scoped defaults and audit rendering through @ace/client. Deck's executor will persist its run override and pass it into the generic engine spawn API for each lane/card thread. Behavior tests are written but not executed locally, per the owner's merge-only test rule. Runtime claims need run at merge.
