# 0061: Permission modes with auto-review by default

Date: 2026-10-03. Status: accepted for implementation.

## Number allocation

Checked origin/main and open PRs #82 and #83 before writing this record. Main ends at 0057 and has two records numbered 0056. PR #82 reserves 0058 and 0059; PR #83 now reserves 0060. This record moves from 0060 to the next free number, 0061. The separate renumbering change moved in-app devices to [ADR 0064](0064-in-app-devices.md).

## Decision

PermissionMode is an ace policy, separate from provider plan modes and workspace local/worktree modes. Its values are read-only, ask, auto-review and full-access. Auto-review is the shipped default. Full access requires an explicit setting or thread/deck selection. On-failure does not survive as an ace mode: failure-triggered sandbox escape is neither a risk review nor a portable permission contract.

The schema lives in @ace/protocol. Pure resolution and deterministic review belong to @ace/core; the engine owns settings reads, physical path containment, durable decisions and provider resolution intents. Settings use permissions.defaultMode, resolved thread settings over workspace over global over defaults. A thread permissionMode override takes precedence. A host-owned spawn API accepts a permission mode and optional parent thread. Deck supplies its override through that API to every card and lane thread, including replacements and retries. This branch does not change the conductor executor in PR #83.

Delegated children inherit their parent's effective mode. An explicit child selection can only lower it, in the order read-only < ask < auto-review < full-access. Durable parent links constrain every later turn and mode change, including settings changes, provider switches and resumed work. Spawn, fork inheritance, setters and turn admission compute the minimum across the complete ancestry, bounded to 64 parent edges. Idle intermediate records may retain their previous turn policy; they cannot hide a tightened ancestor. Provider-specific options cannot grant permissions. Agent-control tools do not expose the permission command or human approval resolution.

Mode changes are requested immediately. For Codex app-server, the next engine-owned turn/start carries the resolved requested policy even while older children or background shells survive. The composer publishes that mode as effective only after a valid native turn acknowledgement. Approval review uses the policy submitted for the request's own native turn or background action, including requests preceding the acknowledgement; child turns inherit the spawning turn's policy. Steering retains its current turn policy. Missing or evicted native attribution cannot earn a Full-access grant. Codex does not retire its process to apply these per-turn settings.

Providers with session-fixed policy still wait until their own tree has no live turns, background work or interactions, then retire and resume with explicit policy. No active child or background shell is closed merely to apply a setting. Autonomous provider continuation retains its originating turn or session policy until the next engine-owned boundary.

## Settings compatibility

Keep approvals.policy as a deprecated wire key. Explicit stored ask maps to ask, never to full-access, and on-failure to auto-review. Missing approvals.policy never opts into full access. Existing permissions.defaultMode takes precedence within its layer. Decode legacy documents without discarding comments or unknown fields. Writes through the legacy key update the new key too, so old clients still change the effective policy. New callers use permissions.defaultMode.

## Provider enforcement

Owner decision on PR #84: every provider launches in auto-review using its best available native guard. Incomplete coverage is explicit; it does not cause an ace launch refusal or a full-access fallback. Installed/version compatibility checks still apply.

Capabilities expose supported modes, nativeAutoReview, toolGate and an additive auto-review guarantee. A guarantee has a level, gates for writes/network/protectedReads/shell, and limitations. A true gate means the provider constrains that action class through sandboxing, tool exclusion or a pre-execution approval gate. It does not mean every action receives an ace review. False means ace cannot promise coverage. toolGate means surfaced approval requests can be answered, not that the provider surfaces every action. Missing guarantee metadata is unknown to clients, never full protection.

Ask requires an explicitly advertised mode and a pre-execution tool gate. An auto-review guarantee cannot substitute for this contract. Cursor has no public decision callback, and generic ACP can perform unsurfaced actions. These providers do not advertise Ask; the daemon rejects explicit Ask selections before launch and retains inputs whose inherited Ask policy cannot be enforced. Codex advertises Ask with its read-only sandbox and human approval for mutation escalation, as described in the QA correction below. Claude, OpenCode and Pi advertise Ask through their comprehensive tool gates. There is no weaker-policy fallback for Ask.

| Provider          | Auto-review native guard                                                                  | Level               | Writes / network / protected reads / shell | Audit limits                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex app-server  | workspace-write, network disabled, on-request, approvalsReviewer user                     | sandbox             | true / true / false / true                 | Workspace writes and sandbox-allowed commands can execute without approval; secret-file reads inside the workspace aren't gated. Native auto_review stays off.                                                     |
| Cursor SDK 1.0.35 | sandbox enabled, autoReview true, isolated settings, child tool-header inheritance        | sandbox             | true / false / false / true                | SandboxOptions exposes only enabled. Network and protected-read coverage are unverified. No public permission/escalation decision callback; native decisions and classifier availability cannot be audited by ace. |
| Claude Agent SDK  | default native mode, isolated settings, PreToolUse asks for every tool including children | tool-gate           | true / true / true / true                  | Native auto is available but unused because ace owns decisions.                                                                                                                                                    |
| OpenCode v2       | wildcard ask rules reapplied on resume                                                    | tool-gate           | true / true / true / true                  | Exact targets are reviewed; permission patterns alone escalate.                                                                                                                                                    |
| Pi 0.85.1         | no ambient extensions; read,grep,find,ls tools only; no MCP tools                         | tool-selection      | true / true / false / true                 | Writes, shell and network tools are excluded. Native read tools can read secrets. RPC has no tool permission callback; generic extension questions remain human questions.                                         |
| Generic ACP       | request_permission routed to ace; choose advertised read-only/plan selector when present  | permission-requests | false / false / false / false              | No portable tool allowlist or comprehensive gate. Selector names are best available hints, not an enforceable sandbox guarantee. Agents may perform unsurfaced actions.                                            |

Every approval request a provider surfaces enters the same ace reviewer and durable decision path. Cursor 1.0.35 and Pi 0.85.1 expose no native approval decision callback, so ace cannot synthesize decisions for their unsurfaced operations. Generic ACP without selectors still launches with client filesystem/terminal capabilities disabled and explicitly limited guarantees. Never select a native unrestricted/bypass mode as a restricted-mode fallback. Native ACP mode commands may only reselect the strongest advertised restricted selector while ace is restricted. Unknown, build and bypass selectors require an explicitly effective full-access mode; changing a native selector cannot opt into full access. Missing restricted selectors still permit launch with the disclosed partial guarantees.

Codex thread start/resume/fork and every turn explicitly set the policy, workspace writable roots and disabled temporary-directory exceptions. Turn workspaceWrite uses only the thread workspace as writableRoots, excludes temporary-directory write exceptions, and disables network. Network escalation requests remain uncertain human work; ace never automatically enables network. The pinned generated AskForApproval enum accepts on-request; the [official config reference](https://learn.chatgpt.com/docs/config-file/config-reference) confirms on-request is current, untrusted unsupported and on-failure deprecated. approvalsReviewer user ensures ace decides each surfaced request.

Sources: pinned official SDK declarations, Codex generated app-server 0.159.1 schemas, [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), [Claude SDK permissions](https://platform.claude.com/docs/en/agent-sdk/permissions), ADR 0050 and ADR 0044. No provider prompts or recorder sessions are used to infer coverage.

## Reviewer and audit

The deterministic reviewer consumes a schema-validated exact command, paths or tool input and the thread's physical workspace. It does not execute commands. Path checks resolve existing ancestors, including symlinks, before granting access. Unknown tools, shell composition, broad permission grants and incomplete targets escalate. A bounded allowlist permits `pwd`, non-recursive `ls`, and `cat`, `head`, `tail`, and `wc` on exact regular workspace files. The host verifies system utility identity through PATH, and verifies absolute shell wrappers separately. Expansion, redirection, composition, recursive search and arbitrary programs remain uncertain. Exact native Read/read operations also require regular-file proof. Exact Edit/Write, OpenCode edit/write and correlated Codex file changes can create or update ordinary workspace files. Existing directories, missing read files, symlink escapes and workspace control metadata in `.git`/`.ace` cannot earn automatic approval. Every destination of a Codex rename is checked; deletes, missing file-change attribution and broad `grantRoot` requests escalate. Generic ACP read categories always escalate. [ACP kinds are categories and locations support follow-along](https://agentclientprotocol.com/protocol/v1/tool-calls); they do not provide an exhaustive file-input contract. The adapter retains the category as acp/read, even when rawInput appears to name one file. Provider-specific exact-read proof requires a separate audited input contract. The fake daemon has no physical-file proof and escalates these reads too. Clearly destructive workspace commands are denied; Git mutation requests remain human work. Secret/credential access and destructive actions outside the workspace always escalate, even when another rule would deny them. Read-only never approves writes.

Each ace review creates a durable permission.reviewed event containing interaction identity, target, effective mode, decision and reason. The same transaction creates a transcript notice and, for allow/deny, a single-use resolution intent. When a provider has no one-shot denial but offers cancellation, deny cancels the current action. No session-wide or permanent grants are synthesized. Restricted ace modes also refuse permanent native grants submitted by a human; full access requires the explicit mode command. Read-only refuses human mutation approvals. Escalation leaves the interaction pending, so ADR 0004 derives needs_you for the whole tree. Retries cannot duplicate decisions or race a human resolution; uncertain delivery after restart is never replayed automatically.

An optional provider-session reviewer may be injected at the host boundary in a later change. It must use the user's installed, logged-in CLI or official local SDK, with no tools, no ace control lease and no credentials entering ace storage or clients. Its structured result may only classify cases the deterministic policy explicitly delegates. Protected secret/outside-workspace cases always escalate and cannot be overruled. This initial implementation uses the deterministic reviewer alone and never sends reviewer prompts.

## Safety invariants and follow-up

Auto-review never grants full access. Restricted provider options and ambient permission grants cannot override the resolved mode. Children cannot exceed their parent. Mode changes occur at turn boundaries. Uncertain approvals remain human work. Full access is an explicit opt-in. Surfaced approvals still pass through the durable one-shot reviewer, which approves ordinary actions while retaining the secret/credential exception.

The Claude web agent will add mode pickers, scoped defaults and audit rendering through @ace/client. Deck's executor will persist its run override and pass it into the generic engine spawn API for each lane/card thread. Behavior tests are written but not executed locally, per the owner's merge-only test rule. Runtime claims need run at merge.

## Browser origin approvals

The thread browser uses the effective permission authority, including its parent
ceiling. Its daemon-owned approval is an engine host interaction, with an exact
origin and action in the review target. Unknown external sites escalate through
the existing deterministic reviewer; no provider prompts are sent. Read-only
refuses agent navigation. Browser origin grants explicitly selected by a human
are scoped to one page or one thread and never become native provider grants.
Human navigation itself is consent under the human browser lease. See
[thread browser origin consent](0054-desktop-shell.md#thread-browser-origin-consent)
for resource, redirect, WebSocket, timeout and persistence rules.

## Runtime corrections from the Pi and Cursor re-test

Cursor SDK 1.0.35 sandbox support depends on the host, beyond package/helper installation.
The isolated SDK host uses the public `createAgentPlatform` and
`prewarmLocalWorkspace` executor admission before a turn. An unsupported-sandbox
`ConfigurationError` selects `read,grep,glob,ls` with sandboxing disabled,
settings isolated and child-header inheritance enabled. Shell, writes, network,
MCP and Task children are excluded. The preview reports tool-selection and
Limited coverage until support is verified; a supported host publishes its
sandbox guarantee at open. Auto-review remains the ace default. An unsupported
host launches with this disclosed read-only fallback, never full access.
Source: [Cursor SDK options and executor prewarming](https://cursor.com/docs/sdk/typescript)
and the pinned 1.0.35 public declarations.

Pi 0.85.1 exposes a blocking `tool_call` extension event before execution.
The ace extension forwards exact tool input through RPC `ui.confirm` as a
canonical approval with Allow once and Deny. Ask and Auto-review enable the
standard read/write/edit/bash/search tools with ambient extensions disabled.
The engine owns deterministic review, physical path checks and durable decisions.
Read-only also gates reads and excludes mutation tools. Missing UI, malformed
input and failed approval delivery block execution. No OS sandbox is claimed.
This supersedes the Pi tool-selection row and the statement that Pi cannot gate
operations. Sources: pinned official [extension contract](https://raw.githubusercontent.com/badlogic/pi-mono/v0.85.1/packages/coding-agent/docs/extensions.md)
and [RPC confirmation contract](https://raw.githubusercontent.com/badlogic/pi-mono/v0.85.1/packages/coding-agent/docs/rpc.md).

## Codex reconstruction and process lifetime

Resume/read history reconstructs transcript and background work. It does not prove a live answer transport: historical questions and plans never open interactions, and their native question identities remain terminal on duplicate notifications. A fresh server request owns a process-scoped key. Stale resolution returns `interaction_unavailable`; it never writes to a replacement process. The engine retains durable interaction outcomes and generation fencing (WP5).

Each Codex exit emits bounded, redacted `codex-session-exit` diagnostic evidence: process-generation token, deliberate flag, retirement reason, native reason, code, signal, and a 4 KiB stderr tail. Planned idle/user/shutdown retirement is distinct from native disconnect and failed-open cleanup. This evidence uses the existing provider diagnostic sink; the daemon currently persists that sink only at debug level. WP5 must wire this specific exit record at ordinary log levels as part of its engine logging ownership.

## QA correction: Ask admission and Codex workspace writes

The October 5 QA shell-edit reproduction established that Ask and Auto-review
must not share Codex's writable sandbox. Ask now explicitly uses read-only at
thread start, resume, fork and each engine-owned turn. Native escalation remains
on-request with the user reviewer. A shell write is held until the user grants
that action, and denial leaves the workspace unchanged. Sandboxed read commands
can run without asking. The picker describes approval for edits and risky actions,
and Codex's Ask guarantee discloses those read exceptions.

Claude, OpenCode and Pi retain their pre-execution tool gates and now publish
Ask guarantees separately from Auto-review. Their surfaced Ask approvals remain
pending for a person. Cursor SDK and generic ACP, including the Cursor CLI and
Antigravity ACP profiles, do not offer Ask because their contracts cannot
promise a human decision before mutations. ACP rejects explicit Ask before
spawning its CLI. An Auto-review guarantee can no longer imply Ask support at
engine admission. Existing Auto-review behavior remains governed by the provider
guarantees above.

The regressions use isolated scripted CLIs and existing recorded Codex, Claude
and OpenCode approval flows. No recorder or subscription prompts were run.

## Corrections from the installed-app reports

The October 5 investigation replayed recorder fixtures and used a real daemon in
isolated temporary homes. OpenCode v2 edit approvals supply `metadata.files`,
while shell/read approvals identify a tool through `source`. The complete tool
input is JSON in `session.tool.input.ended`, before `permission.asked` and before
`session.tool.called`. That completed input, bounded and matched to the tool
identity and action, is authority. Permission `resources` and `save` are patterns
and never substitute for exact input. Raw frames retain unknown fields.

The deterministic policy is deliberately narrower than arbitrary local command
execution. It approves the proven cases above without executing reviewer commands
or calling a model. Network, credential access, outside paths, ambiguous effects,
and browser/screen consent remain human work. `defaultToNo` browser and screen
host approvals and external-effect ace tools retain their existing consent path.
Safe ace inspection, scoped thread changes and inherited delegation already had
specific risk classes; they were not the cause of the reported failures. Pi's
blocking extension confirmations use this same durable reviewer, including
exact read/write/edit inputs and shell commands. Generic ACP shell requests can
earn approval from exact input; follow-along file locations remain insufficient.

This follows the sandbox boundary documented by OpenAI for
[agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
and [auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review).
ace continues to use its own deterministic reviewer rather than the native
Codex reviewer, and does not claim to reproduce every native reviewer decision.
