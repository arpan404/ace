# 0078: Unified access modes

Date: 2026-10-13. Status: accepted. Supersedes the picker, defaults and delegation-ceiling parts
of ADR 0069 and its 2026-10-13 amendment; keeps 0069's rule that providers enforce, ace configures.

Superseded 2026-10-14: ace's MCP tools are always allowed; permissions are provider-native (owner decision). The line that keeps ace's own browser-origin, app and device consent no longer holds; a provider's approval for an ace tool waits for the person like any other.

## Context

ADR 0069 showed each provider's native permission list in the composer: 17 fixed choices across
four adapters, plus Codex profiles and open-ended ACP sets. The same behaviour had different
names ("Auto" meant three different things), defaults were set once per provider, and the
delegation ceiling needed a per-native-id capability table.

## Decision

ace offers four access modes, least capable first:

| Rank | Mode        | Meaning                                                                 |
| ---- | ----------- | ----------------------------------------------------------------------- |
| 0    | Read-only   | Reads and plans. No changes.                                            |
| 1    | Ask         | Asks before edits and commands.                                         |
| 2    | Auto review | Edits freely; risky actions are checked by the provider's own reviewer. |
| 3    | Full access | No prompts, no sandbox.                                                 |

**Only genuine support is offered** (owner, 2026-10-13). A provider lists a mode only when it has
a native setting that means it; ace never emulates a mode with gates, rules or a reviewer of its
own. The composer hides a mode the provider lacks. When a _default_ or an _inherited_ mode isn't
supported, the thread runs the nearest stricter supported mode (Auto review → Ask → Read-only),
never a looser one, and the chip shows the mode in effect. If nothing that strict exists, the
thread doesn't start until the person picks.

| Mode        | Claude              | Codex                                              | OpenCode                                                              | Cursor SDK                  | Pi                          | Gemini / Qwen (ACP)             | Claude bridge       | Codex bridge        |
| ----------- | ------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------- | --------------------------- | ------------------------------- | ------------------- | ------------------- |
| Read-only   | `plan`              | `:read-only`, approval `never`                     | Plan agent, no ace rules                                              | —                           | `--tools read,grep,find,ls` | `plan`                          | `plan`              | `read-only`         |
| Ask         | `default`           | `:read-only`, `on-request`, reviewer `user`        | Build agent + session rules: `*` ask, reads allowed, `.env` reads ask | —                           | —                           | `default`                       | `default`           | —                   |
| Auto review | `auto`              | `:workspace`, `on-request`, reviewer `auto_review` | — (no reviewer)                                                       | sandbox on, autoReview on   | —                           | — (`auto_edit` has no reviewer) | `auto`              | `agent`             |
| Full access | `bypassPermissions` | `:danger-full-access`, approval `never`            | Build agent + session rule `*` allow                                  | sandbox off, autoReview off | default tools               | `yolo`                          | `bypassPermissions` | `agent-full-access` |

Unprofiled ACP agents offer no ace mode; they run their own default. Codex offers a mode only
when `permissionProfile/list` allows the built-in profile it runs on.

**Plan stays a workflow.** `/plan` and the plan card remain; on Claude, `/plan` selects Read-only,
whose native setting is Claude's plan mode.

**OpenCode rules (reverses 0069's audit correction).** For Ask and Full access ace writes the
session's permission rules through OpenCode's session API (`session.create` / `session.update`
`permissions`), never into the project's `opencode.json`. Read-only selects the Plan agent and
clears ace's session rules. A Custom native Build or Plan leaves the session's rules alone.

**Defaults.** A thread's own choice, else its project's default (Edit project), else this daemon's
`access.defaultMode`, which is the person's last pick in any access chip or their Settings value,
else Auto review on a first run. Each daemon stores its own. `permissions.providerModes`,
`permissions.defaultMode` and `approvals.policy` are removed.

**Advanced.** Settings → Providers → (provider) → Advanced can set a native mode
(`access.nativeModes`). That provider's threads then run it and the chip reads "Custom". A Custom
policy is unranked: only the identical policy contains a child.

**Delegation.** `delegate_task` (single and batch) takes `access` (`inherit` or a mode) and
`effort`. The ceiling is the mode rank: a child can't exceed its parent (`access_escalation_denied`
with the allowed list); an explicit mode the target lacks is refused (`access_unavailable` with
the target's supported list); `inherit` steps down to the broadest supported mode at or below the
parent's. A Full access parent contains any child. Effort has no ceiling; an effort the model
doesn't list is refused (`effort_unavailable` with the model's levels), never silently dropped.

**Efforts.** Catalog models list `efforts: {id, level, label}[]` plus `defaultEffort` (a native
id). Spellings map to canonical levels (`extra-high` → `xhigh`, `none` → `off`); Cursor's
`true`/`false` thinking values become `thinkingToggle`, not efforts; Cursor SDK efforts folded
into variants are listed as efforts; OpenCode variants and Pi's `--thinking` levels are efforts;
Claude's default is `high`, the effort parameter's documented default.

**Full access and ace's own tools.** Full access never prompts for ace's MCP tools (0069 §"ace
tools" as amended by #668); ace's own browser-origin, app and device consent are unchanged.

## Migration

One load-time mapping, no shims: stored thread selections, delegation ceilings, automations and
settings map to the mode no looser than the table in the 2026-10-13 proposal (Claude
`plan`→Read-only, `default`/`dontAsk`→Ask, `acceptEdits`/`auto`→Auto review,
`bypassPermissions`→Full access; Codex `:read-only`→Read-only, `:workspace` and reviewer
objects→Auto review, `:danger-full-access`→Full access, custom profiles→Ask; OpenCode
`plan`→Read-only, `build`→Auto review; Cursor sandbox off with review off→Full access, other
combinations→Auto review). The daemon default is the most common mapped provider default, the
stricter on a tie. Cached catalog rows map `reasoningEfforts` to `efforts` once.
