import type { Fact } from "@ace/core";
import { ThreadId, type ProviderKind, type ThreadStatus } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { endTurn, message, rootAgent, subagent, tool, turn } from "./facts.ts";

const cwd = "/Users/dev/acme";
export const nestedDelegationIds = {
  parent: "thread-rail-redesign",
  build: "thread-rail-build",
  review: "thread-rail-review",
  shell: "thread-rail-shell",
} as const;

/** A delegate in its parent's tree whose work is the thread `child`. */
function delegate(
  agent: string,
  child: string,
  provider: ProviderKind,
  name: string,
  status: ThreadStatus,
): Fact[] {
  return [
    tool("root", `delegate-${agent}`, {
      kind: "agent.spawn",
      title: `Delegate ${name}`,
      detail: { kind: "agent.spawn", prompt: name, agentType: provider, childAgent: agent },
    }),
    {
      type: "agent.seen",
      agent,
      parent: "root",
      spawnedBy: `delegate-${agent}`,
      origin: "ace",
      fidelity: "full",
      native: { provider, nativeId: agent },
      cwd,
      name,
    },
    { type: "agent.external", agent, threadId: ThreadId.parse(child), status },
  ];
}

/** A subagent that runs a command and is still running it. */
function busy(provider: ProviderKind, agent: string, name: string, command: string): Fact[] {
  return [
    tool("root", `spawn-${agent}`, {
      kind: "agent.spawn",
      title: "Task",
      detail: { kind: "agent.spawn", prompt: name, childAgent: agent },
    }),
    subagent(provider, agent, name, `spawn-${agent}`),
    turn(agent, "spawn"),
    tool(agent, `${agent}-run`, {
      kind: "shell",
      title: command,
      detail: { kind: "shell", command },
    }),
  ];
}

/** A subagent that already finished, reporting `result`. */
function finished(provider: ProviderKind, agent: string, name: string, result: string): Fact[] {
  return [
    tool("root", `spawn-${agent}`, {
      kind: "agent.spawn",
      title: "Task",
      detail: { kind: "agent.spawn", prompt: name, childAgent: agent },
    }),
    subagent(provider, agent, name, `spawn-${agent}`),
    turn(agent, "spawn"),
    endTurn(agent),
    {
      type: "item.upsert",
      agent: "root",
      item: `spawn-${agent}`,
      draft: {
        type: "tool_call",
        complete: true,
        call: {
          status: "succeeded",
          result: { isError: false, durationMs: 5, content: [{ type: "text", text: result }] },
        },
      },
    },
  ];
}

const child = (id: string, parent: string, title: string, provider: ProviderKind) => ({
  id,
  workspaceId: "acme",
  title,
  provider,
  parentThreadId: parent,
});

/**
 * Delegation three threads deep, for the Summary's agent tree: a Claude thread delegated the
 * build to another Claude thread, which runs a subagent, a dev server and its own delegated Codex
 * review, whose subagent is still running tests. A second delegate finished earlier. Play
 * `nestedDelegation()` whole, parents first.
 */
export function nestedDelegation(): Scenario[] {
  const parent: Scenario = {
    thread: {
      id: nestedDelegationIds.parent,
      workspaceId: "acme",
      title: "Rail sidebar redesign",
      provider: "claude",
    },
    steps: [
      {
        kind: "facts",
        agoMs: 35 * 60_000,
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message("root", "ask", "user", "Build the rail sidebar with the Threads panel."),
          ...finished("claude", "explore", "Explore the Threads panel code", "Read 41 files."),
          ...delegate("shell", nestedDelegationIds.shell, "claude", "Rail-shell-web-sidebar", {
            state: "done",
          }),
          ...delegate(
            "build",
            nestedDelegationIds.build,
            "claude",
            "Projects-inbox-overlay-panel",
            {
              state: "working",
              agents: 2,
            },
          ),
        ],
      },
    ],
  };
  const build: Scenario = {
    thread: child(
      nestedDelegationIds.build,
      nestedDelegationIds.parent,
      "Projects-inbox-overlay-panel",
      "claude",
    ),
    steps: [
      {
        kind: "facts",
        agoMs: 34 * 60_000,
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message("root", "ask", "user", "Build the Projects inbox overlay."),
          ...busy("claude", "settings", "Settings › General row", "bun run test settings"),
          ...delegate("review", nestedDelegationIds.review, "codex", "GPT review of the paging", {
            state: "working",
            agents: 1,
          }),
          tool("root", "dev", {
            kind: "shell",
            title: "bun run dev:fake --port 5394",
            detail: { kind: "shell", command: "bun run dev:fake --port 5394" },
          }),
          {
            type: "background.started",
            agent: "root",
            task: "dev",
            kind: "shell",
            title: "bun run dev:fake --port 5394",
            item: "dev",
            stoppable: true,
          },
          tool("root", "history", {
            kind: "file.edit",
            title: "Edit history-page.tsx",
            detail: { kind: "file.edit", changes: [] },
          }),
        ],
      },
    ],
  };
  const review: Scenario = {
    thread: child(
      nestedDelegationIds.review,
      nestedDelegationIds.build,
      "GPT review of the paging",
      "codex",
    ),
    steps: [
      {
        kind: "facts",
        agoMs: 4 * 60_000,
        facts: [
          rootAgent("codex", cwd),
          turn("root"),
          message("root", "ask", "user", "Review the settled paging."),
          ...busy("codex", "limits", "Check daemon search limits", "bun run test settled"),
        ],
      },
    ],
  };
  const shell: Scenario = {
    thread: child(
      nestedDelegationIds.shell,
      nestedDelegationIds.parent,
      "Rail-shell-web-sidebar",
      "claude",
    ),
    steps: [
      {
        kind: "facts",
        agoMs: 2 * 60 * 60_000,
        facts: [
          rootAgent("claude", cwd),
          turn("root"),
          message("root", "ask", "user", "Build the rail shell."),
          ...finished("claude", "frame", "Find the sidebar frame", "Read 12 files."),
          message("root", "done", "assistant", "Opened #1542 with the rail shell."),
          endTurn("root"),
        ],
      },
    ],
  };
  return [parent, build, review, shell];
}

/** The review's subagent stops to ask the person, four threads down from where they look. */
export function nestedQuestion(): Fact {
  return {
    type: "interaction.opened",
    agent: "limits",
    interaction: "keep-days",
    blocking: true,
    request: {
      kind: "question",
      questions: [
        {
          id: "days",
          text: "Keep 3 days as the default?",
          multiSelect: false,
          allowOther: false,
          secret: false,
          options: [
            { id: "yes", label: "Keep 3 days" },
            { id: "no", label: "Use 7 days" },
          ],
        },
      ],
    },
  };
}
