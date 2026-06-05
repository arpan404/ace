import { describe, expect, it } from "vitest";
import {
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@ace/contracts";

import { normalizeProviderRuntimeEvent } from "./providerRuntimeEventNormalizer.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asItemId = (value: string): RuntimeItemId => RuntimeItemId.makeUnsafe(value);

function lifecycleEvent(
  payload: Extract<ProviderRuntimeEvent, { type: "item.completed" }>["payload"],
): Extract<ProviderRuntimeEvent, { type: "item.completed" }> {
  return {
    type: "item.completed",
    eventId: asEventId("event-1"),
    provider: "opencode",
    createdAt: "2026-05-13T10:00:00.000Z",
    threadId: asThreadId("thread-1"),
    turnId: asTurnId("turn-1"),
    itemId: asItemId("item-1"),
    payload,
  };
}

describe("normalizeProviderRuntimeEvent", () => {
  it("does not rewrite assistant text that happens to mention tools", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "assistant_message",
        title: "Assistant message",
        detail: "I will run a command next.",
        status: "completed",
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "assistant_message",
      title: "Assistant message",
      detail: "I will run a command next.",
    });
  });

  it("normalizes rough provider shell tools into Ace command executions", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "Bash",
        detail: "bun run check",
        status: "completed",
        data: {
          toolName: "Bash",
          input: {
            command: "bun run check",
            cwd: "/repo",
          },
          result: {
            stdout: "src/agent/codex-responses-transport.ts (0ms)\n",
            stderr: 'error: script "check" exited with code 1\n',
            exit_code: 1,
            duration_ms: 191,
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "command_execution",
      title: "Run command",
      detail: "bun run check",
      data: {
        command: "bun run check",
        cwd: "/repo",
        output:
          'src/agent/codex-responses-transport.ts (0ms)\nerror: script "check" exited with code 1',
        aggregatedOutput:
          'src/agent/codex-responses-transport.ts (0ms)\nerror: script "check" exited with code 1',
        exitCode: 1,
        durationMs: 191,
        ace: {
          normalized: true,
          action: "command",
          itemType: "command_execution",
          command: "bun run check",
          cwd: "/repo",
          exitCode: 1,
          durationMs: 191,
        },
      },
    });
  });

  it("normalizes XML-ish read tools into Ace file-read metadata", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "Read",
        detail:
          "<path>/Users/arpanbhandari/.ace/worktrees/t3code/ace/AGENTS.md</path>\n<type>file</type>\n<content>\n# AGENTS.md\n</content>",
        status: "completed",
        data: {
          name: "Read",
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "file_change",
      title: "Read file",
      detail: "/Users/arpanbhandari/.ace/worktrees/t3code/ace/AGENTS.md",
      data: {
        path: "/Users/arpanbhandari/.ace/worktrees/t3code/ace/AGENTS.md",
        paths: ["/Users/arpanbhandari/.ace/worktrees/t3code/ace/AGENTS.md"],
        ace: {
          normalized: true,
          action: "file-read",
          itemType: "file_change",
          paths: ["/Users/arpanbhandari/.ace/worktrees/t3code/ace/AGENTS.md"],
        },
      },
    });
  });

  it("normalizes generic search/find provider tools without leaking raw provider labels", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "Find",
        detail: ".",
        status: "completed",
        data: {
          tool_name: "Find",
          arguments: {
            pattern: "ProviderRuntimeEvent",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "Search",
      detail: "ProviderRuntimeEvent",
      data: {
        query: "ProviderRuntimeEvent",
        ace: {
          normalized: true,
          action: "search",
          itemType: "dynamic_tool_call",
          query: "ProviderRuntimeEvent",
        },
      },
    });
  });

  it("normalizes provider subagent tools into managed subagent metadata", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "collab_agent_tool_call",
        title: "Task",
        detail: "Task: review API boundaries",
        status: "completed",
        data: {
          toolName: "Task",
          toolUseId: "tool-task-1",
          input: {
            description: "Review API boundaries",
            prompt: "Inspect provider normalization and report risks.",
            subagent_type: "code-reviewer",
            model: "claude-sonnet",
          },
          result: {
            agent_id: "agent-1",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      detail: "Review API boundaries",
      data: {
        subagent: {
          id: "agent-1",
          type: "code-reviewer",
          description: "Review API boundaries",
          prompt: "Inspect provider normalization and report risks.",
          model: "claude-sonnet",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "agent-1",
            type: "code-reviewer",
          },
        },
      },
    });
  });

  it("preserves Copilot-style custom agent identity fields on subagent tools", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "collab_agent_tool_call",
        title: "Sub-agent started",
        detail: "Analyze provider runtime events.",
        status: "completed",
        data: {
          toolName: "Task",
          agentName: "runtime-reviewer",
          agent_display_name: "Runtime Reviewer",
          agentRole: "code-reviewer",
          input: {
            prompt: "Analyze provider runtime events.",
          },
          result: {
            subagent_id: "copilot-subagent-1",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      detail: "Analyze provider runtime events.",
      data: {
        subagent: {
          id: "copilot-subagent-1",
          type: "code-reviewer",
          name: "Runtime Reviewer",
          prompt: "Analyze provider runtime events.",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "copilot-subagent-1",
            type: "code-reviewer",
            name: "Runtime Reviewer",
          },
        },
      },
    });
  });

  it("normalizes nested provider agent objects as subagent metadata", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "collab_agent_tool_call",
        title: "Agent task",
        detail: "Inspect provider side-chat routing.",
        status: "completed",
        data: {
          agent: {
            id: "provider-agent-1",
            name: "Routing Reviewer",
            role: "code-reviewer",
            model: "provider-model",
          },
          input: {
            prompt: "Inspect provider side-chat routing.",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      detail: "Inspect provider side-chat routing.",
      data: {
        subagent: {
          id: "provider-agent-1",
          type: "code-reviewer",
          name: "Routing Reviewer",
          model: "provider-model",
          prompt: "Inspect provider side-chat routing.",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "provider-agent-1",
            type: "code-reviewer",
            name: "Routing Reviewer",
            model: "provider-model",
          },
        },
      },
    });
  });

  it("normalizes root provider agent objects as subagent metadata", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "collab_agent_tool_call",
        title: "Agent task",
        detail: "Inspect provider command discovery.",
        status: "completed",
        agent: {
          id: "root-agent-1",
          name: "Command Reviewer",
          role: "researcher",
          model: "provider-root-model",
        },
        data: {
          input: {
            prompt: "Inspect provider command discovery.",
          },
        },
      } as Extract<ProviderRuntimeEvent, { type: "item.completed" }>["payload"]),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      data: {
        subagent: {
          id: "root-agent-1",
          type: "researcher",
          name: "Command Reviewer",
          model: "provider-root-model",
        },
      },
    });
  });

  it("normalizes provider delegated-agent aliases as subagent metadata", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "collab_agent_tool_call",
        title: "Delegate task",
        detail: "Ask the platform specialist to inspect deploy hooks.",
        status: "completed",
        data: {
          delegatedAgent: {
            id: "delegate-agent-1",
            displayName: "Platform Specialist",
            role: "platform",
            model: "provider-delegate-model",
            prompt: "Inspect deploy hooks and summarize risks.",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      data: {
        subagent: {
          id: "delegate-agent-1",
          type: "platform",
          name: "Platform Specialist",
          model: "provider-delegate-model",
          prompt: "Inspect deploy hooks and summarize risks.",
        },
      },
    });
  });
});
