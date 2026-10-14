import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, subagent, tool, toolDone, turn } from "./facts.ts";

const cwd = "/Users/dev/acme";
export const childActionsIds = {
  parent: "thread-triage",
  delegate: "thread-triage-codex",
} as const;

/** Claude's own words when a subscription session runs out mid-task. */
export const sessionLimitText = "You've hit your session limit · resets 8:30pm (America/Chicago)";

const spawn = (item: string, child: string, title: string): Fact =>
  tool("root", item, {
    kind: "agent.spawn",
    title,
    detail: { kind: "agent.spawn", description: title, childAgent: child },
  });

/**
 * A Claude thread triaging open issues with three of its own subagents and one thread ace
 * delegated to Codex. `layout-fixer` hits the session limit, `issue-sweeper` keeps working,
 * `dep-auditor` goes silent with its turn still open and the Codex delegate stops at its usage
 * limit. The parent is still working, so a message to it queues.
 * Labels: `spawned`, `child-failed`.
 */
export function childActions(): Scenario[] {
  const delegate: Scenario = {
    thread: {
      id: childActionsIds.delegate,
      workspaceId: "ace",
      title: "Reproduce the sidebar flicker",
      provider: "codex",
      parentThreadId: childActionsIds.parent,
      execution: { provider: "codex", model: "gpt-5.5-codex", options: { effort: "medium" } },
    },
    steps: [
      {
        kind: "facts",
        agoMs: 4 * 60_000,
        facts: [
          rootAgent("codex", cwd),
          turn("root"),
          {
            type: "item.upsert",
            agent: "root",
            item: "ask",
            draft: {
              type: "message",
              role: "user",
              complete: true,
              parts: [{ type: "text", text: "Reproduce the sidebar flicker from issue #412." }],
              origin: {
                kind: "spawn",
                parentThreadId: ThreadId.parse(childActionsIds.parent),
                role: "repro",
              },
            },
          },
          tool("root", "read", {
            kind: "file.read",
            title: "Read apps/web/src/features/shell/sidebar.tsx",
            detail: { kind: "file.read", path: "apps/web/src/features/shell/sidebar.tsx" },
          }),
          toolDone("root", "read"),
        ],
      },
      {
        kind: "facts",
        agoMs: 3 * 60_000,
        facts: [
          endTurn("root", "failed", {
            kind: "quota",
            message: "You've hit your usage limit. Try again at 8:30 PM.",
          }),
        ],
      },
    ],
  };
  const parent: Scenario = {
    thread: {
      id: childActionsIds.parent,
      workspaceId: "ace",
      title: "Triage and fix open issues",
      provider: "claude",
      // `dep-auditor` says nothing after it starts: past this, core reads it as not responding.
      silenceMs: 90_000,
    },
    steps: [
      {
        kind: "facts",
        agoMs: 5 * 60_000,
        label: "spawned",
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message("root", "ask", "user", "Triage the open issues and fix what you can."),
          spawn("spawn-layout", "layout", "Apply the layout fixes"),
          subagent("claude", "layout", "layout-fixer", "spawn-layout"),
          turn("layout", "spawn"),
          tool("layout", "edit", {
            kind: "file.read",
            title: "Read apps/web/src/features/shell/screen.tsx",
            detail: { kind: "file.read", path: "apps/web/src/features/shell/screen.tsx" },
          }),
          toolDone("layout", "edit"),
          message("layout", "progress", "assistant", "Fixed the header overlap; moving on."),
          spawn("spawn-sweep", "sweep", "Sweep stale issues"),
          subagent("claude", "sweep", "issue-sweeper", "spawn-sweep"),
          turn("sweep", "spawn"),
          tool("sweep", "list", {
            kind: "shell",
            title: "gh issue list --state open --limit 200",
            detail: { kind: "shell", command: "gh issue list --state open --limit 200" },
          }),
          spawn("spawn-deps", "deps", "Audit outdated dependencies"),
          subagent("claude", "deps", "dep-auditor", "spawn-deps"),
          turn("deps", "spawn"),
          {
            type: "item.upsert",
            agent: "root",
            item: "delegation-repro",
            draft: {
              type: "delegation.started",
              origin: "ace",
              childThreadId: ThreadId.parse(childActionsIds.delegate),
              provider: "codex",
              model: "gpt-5.5-codex",
              title: "Reproduce the sidebar flicker",
              role: "repro",
              phase: "running",
              status: { state: "limited" },
              updatedAt: 1000,
              generation: 0,
              complete: false,
              outcome: null,
            },
          },
          spawn("delegate-repro", "repro", "Reproduce the sidebar flicker"),
          {
            type: "agent.seen",
            agent: "repro",
            parent: "root",
            spawnedBy: "delegate-repro",
            origin: "ace",
            fidelity: "full",
            native: { provider: "codex", nativeId: "repro" },
            cwd,
            name: "repro",
            model: "gpt-5.5-codex",
          },
          {
            type: "agent.external",
            agent: "repro",
            threadId: ThreadId.parse(childActionsIds.delegate),
            status: { state: "limited" },
          },
        ],
      },
      {
        kind: "facts",
        agoMs: 2 * 60_000,
        label: "child-failed",
        facts: [
          endTurn("layout", "failed", { kind: "provider", message: sessionLimitText }),
          toolDone("root", "spawn-layout", "failed"),
        ],
      },
    ],
  };
  return [parent, delegate];
}
