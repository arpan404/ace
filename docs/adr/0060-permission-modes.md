# 0060: Permission modes with auto-review by default

Date: 2026-10-03. Status: accepted for implementation.

## Number allocation

Checked origin/main and open PRs #82 and #83 before writing this record. Main ends at 0057, has two records numbered 0056, and the open PRs reserve 0058 and 0059. This record uses 0060. Renumbering existing records belongs to a separate change.

## Decision

PermissionMode is an ace policy, separate from provider plan modes and workspace local/worktree modes. Its values are read-only, ask, auto-review and full-access. Auto-review is the shipped default. Full access requires an explicit setting or thread/deck selection. On-failure does not survive as an ace mode: failure-triggered sandbox escape is neither a risk review nor a portable permission contract.

The schema lives in @ace/protocol. Pure resolution and deterministic review belong to @ace/core; the engine owns settings reads, physical path containment, durable decisions and provider resolution intents. Settings use permissions.defaultMode, resolved thread settings over workspace over global over defaults. A thread permissionMode override takes precedence. A host-owned spawn API accepts a permission mode and optional parent thread. Deck supplies its override through that API to every card and lane thread, including replacements and retries. This branch does not change the conductor executor in PR #83.

Delegated children inherit their parent's effective mode. An explicit child selection can only lower it, in the order read-only < ask < auto-review < full-access. Durable parent links constrain every later turn and mode change, including settings changes, provider switches and resumed work. Provider-specific options cannot grant permissions. Agent-control tools do not expose the permission command or human approval resolution.

Mode changes are requested immediately but become effective only before the next turn, once the provider's own tree has no live turns, background work or interactions. Steering retains the active turn's mode. A provider session is retired and resumed with explicit policy when the effective mode changes. No active child or background shell is closed merely to apply a setting. Autonomous provider continuation retains the session policy until the next engine-owned boundary.

## Settings compatibility

Keep approvals.policy as a deprecated wire key. Explicit stored ask maps to ask, never to full-access, and on-failure to auto-review. Missing approvals.policy never opts into full access. Existing permissions.defaultMode takes precedence within its layer. Decode legacy documents without discarding comments or unknown fields. Writes through the legacy key update the new key too, so old clients still change the effective policy. New callers use permissions.defaultMode.

## Provider enforcement

Capabilities advertise supported ace modes, nativeAutoReview and whether native approval requests can be routed to ace. Missing declarations fail closed for real adapters. Test providers must explicitly declare their gate.

- Codex app-server exposes on-request approval routing plus read-only/workspace-write sandbox and native approvalsReviewer auto_review. Current [official security guidance](https://learn.chatgpt.com/docs/agent-approvals-security) retires untrusted despite its continued presence in the generated 0.159.1 wire enum. Native auto-review evaluates only approval-triggering actions; sandbox-permitted reads have no comprehensive protected-file gate or canonical audit. Do not claim restricted ace modes until a verified permissions profile and complete tool gate exist. Capability metadata exposes nativeAutoReview and the approval callback, but ace read-only/ask/auto-review fail closed before launching. Explicit full access uses danger-full-access, never and user reviewer routing. Legacy non-engine callers without an ace mode get read-only/on-request rather than implicit full access. Exact native approval commands/cwd remain translated for the future gate.
- Claude Agent SDK exposes default, plan, auto and bypassPermissions. Native auto can precede canUseTool and cannot supply ace's audit contract. Restricted ace modes use default, empty ambient setting sources, and a PreToolUse hook that routes every tool through the existing permission callback, including native children. Read-only denies mutation requests. Full access explicitly selects bypassPermissions. Provider option permissionMode is rejected as an independent grant.
- OpenCode v2 uses session permission rules: ask for all tools under ask/auto-review, ask for all tools under read-only with ace denying mutations, and allow for full access. Rules are supplied on create and reapplied on resume. No native auto-review is claimed. Its permission requests carry exact tool metadata; incomplete pattern-only requests escalate.
- Cursor SDK provides autoReview with enabled sandbox under restricted policy, requires verified classifier availability and disables ambient setting sources and hidden retries. The pinned SDK has no host approval callback or complete native-decision audit stream. Capability metadata reports nativeAutoReview but does not claim ace ask, read-only or auto-review until the protected-action escalation and durable-review contract can be enforced. Default auto-review fails closed with an unsupported-mode result; explicit full access maps to disabled sandbox and autoReview false. Never downgrade automatically. The existing restricted mapping remains documented for a future complete gate.
- Pi 0.85.1 has a native read_only option that disables extensions and selects read,grep,find,ls, but it cannot gate protected reads or workspace escapes. It therefore cannot claim ace read-only/ask/auto-review. Reject those modes before discovery or spawning. Explicit full access maps to unrestricted tools. Preserve the separate native PiProfile read_only declaration for existing direct callers; no ace restricted mode or native auto-review is claimed.
- ACP request_permission permits reviewing requests that the agent chooses to send, but ACP does not guarantee coverage of all tools or a standard sandbox/mode selector. Generic ACP cannot claim restricted ace modes from a provider name or a selector named plan. Explicit full access retains provider execution. A future reviewed compatibility profile may declare comprehensive gating; until then auto-review is unsupported, never silently unrestricted.

These limitations are intentional: a native label is insufficient proof that an ace mode is enforceable. Sources: [Cursor SDK](https://cursor.com/docs/sdk/typescript), [Claude SDK permissions](https://platform.claude.com/docs/en/agent-sdk/permissions), the pinned SDK declarations, Codex generated app-server 0.159.1 schemas, OpenCode v2 SDK declarations, ADR 0050 and ADR 0044.

## Reviewer and audit

The deterministic reviewer consumes a schema-validated exact command, paths or tool input and the thread's physical workspace. It does not execute commands. Path checks resolve existing ancestors, including symlinks, before granting access. Unknown tools, shell composition, broad permission grants and incomplete targets escalate. A small allowlist permits low-risk reads and commands. Clearly destructive workspace commands are denied. Secret/credential access and destructive actions outside the workspace always escalate, even when another rule would deny them. Read-only never approves writes.

Each ace review creates a durable permission.reviewed event containing interaction identity, target, effective mode, decision and reason. The same transaction creates a transcript notice and, for allow/deny, a single-use resolution intent. No session-wide or permanent grants are synthesized. Restricted ace modes also refuse permanent native grants submitted by a human; full access requires the explicit mode command. Read-only refuses human mutation approvals. Escalation leaves the interaction pending, so ADR 0004 derives needs_you for the whole tree. Retries cannot duplicate decisions or race a human resolution; uncertain delivery after restart is never replayed automatically.

An optional provider-session reviewer may be injected at the host boundary in a later change. It must use the user's installed, logged-in CLI or official local SDK, with no tools, no ace control lease and no credentials entering ace storage or clients. Its structured result may only classify cases the deterministic policy explicitly delegates. Protected secret/outside-workspace cases always escalate and cannot be overruled. This initial implementation uses the deterministic reviewer alone and never sends reviewer prompts.

## Safety invariants and follow-up

Auto-review never grants full access. Restricted provider options and ambient permission grants cannot override the resolved mode. Children cannot exceed their parent. Mode changes occur at turn boundaries. Uncertain approvals remain human work. Full access is an explicit opt-in and intentionally disables tool risk review.

The Claude web agent will add mode pickers, scoped defaults and audit rendering through @ace/client. Deck's executor will persist its run override and pass it into the generic engine spawn API for each lane/card thread. Behavior tests are written but not executed locally, per the owner's merge-only test rule. Runtime claims need run at merge.
