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

function authStatusEvent(
  payload: Extract<ProviderRuntimeEvent, { type: "auth.status" }>["payload"] &
    Record<string, unknown>,
): Extract<ProviderRuntimeEvent, { type: "auth.status" }> {
  return {
    type: "auth.status",
    eventId: asEventId("event-auth-1"),
    provider: "githubCopilot",
    createdAt: "2026-05-13T10:00:00.000Z",
    threadId: asThreadId("thread-1"),
    payload,
  };
}

function accountUpdatedEvent(
  payload: Record<string, unknown>,
): Extract<ProviderRuntimeEvent, { type: "account.updated" }> {
  return {
    type: "account.updated",
    eventId: asEventId("event-account-1"),
    provider: "claudeAgent",
    createdAt: "2026-05-13T10:00:00.000Z",
    threadId: asThreadId("thread-1"),
    payload: payload as Extract<ProviderRuntimeEvent, { type: "account.updated" }>["payload"],
  };
}

function rateLimitsEvent(
  payload: Record<string, unknown>,
): Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }> {
  return {
    type: "account.rate-limits.updated",
    eventId: asEventId("event-rate-limits-1"),
    provider: "gemini",
    createdAt: "2026-05-13T10:00:00.000Z",
    threadId: asThreadId("thread-1"),
    payload: payload as Extract<
      ProviderRuntimeEvent,
      { type: "account.rate-limits.updated" }
    >["payload"],
  };
}

describe("normalizeProviderRuntimeEvent", () => {
  it("normalizes provider-native auth status fields", () => {
    const event = normalizeProviderRuntimeEvent(
      authStatusEvent({
        isAuthenticated: true,
        login: "dev@example.test",
        authType: "user",
        statusMessage: "Logged in as dev@example.test",
      }),
    );

    expect(event.type).toBe("auth.status");
    if (event.type !== "auth.status") {
      return;
    }
    expect(event.payload).toEqual({
      isAuthenticated: true,
      login: "dev@example.test",
      authType: "user",
      statusMessage: "Logged in as dev@example.test",
      status: "authenticated",
      label: "dev@example.test",
      account: {
        label: "dev@example.test",
      },
      output: ["Logged in as dev@example.test"],
    });
  });

  it("normalizes provider rate-limit aliases into rateLimits", () => {
    const event = normalizeProviderRuntimeEvent(
      rateLimitsEvent({
        rate_limit: {
          limit: 100,
          remaining: 4,
          resetAt: "2026-05-13T11:00:00.000Z",
        },
      }),
    );

    expect(event.type).toBe("account.rate-limits.updated");
    if (event.type !== "account.rate-limits.updated") {
      return;
    }
    expect(event.payload.rateLimits).toEqual({
      limit: 100,
      remaining: 4,
      resetAt: "2026-05-13T11:00:00.000Z",
    });
  });

  it("normalizes provider quota metadata into rateLimits", () => {
    const event = normalizeProviderRuntimeEvent(
      rateLimitsEvent({
        quota: {
          token_count: 1200,
          token_limit: 2000,
        },
      }),
    );

    expect(event.type).toBe("account.rate-limits.updated");
    if (event.type !== "account.rate-limits.updated") {
      return;
    }
    expect(event.payload.rateLimits).toEqual({
      token_count: 1200,
      token_limit: 2000,
    });
  });

  it("normalizes provider-native account fields into account metadata", () => {
    const event = normalizeProviderRuntimeEvent(
      accountUpdatedEvent({
        user: {
          login: "dev@example.test",
          id: "user-1",
        },
        subscription: {
          planType: "pro",
        },
      }),
    );

    expect(event.type).toBe("account.updated");
    if (event.type !== "account.updated") {
      return;
    }
    expect(event.payload.account).toEqual({
      login: "dev@example.test",
      id: "user-1",
      label: "dev@example.test",
      subscription: {
        planType: "pro",
      },
    });
  });

  it("adds a label to existing provider account payloads", () => {
    const event = normalizeProviderRuntimeEvent(
      accountUpdatedEvent({
        account: {
          email: "team@example.test",
          accountId: "acct-1",
        },
      }),
    );

    expect(event.type).toBe("account.updated");
    if (event.type !== "account.updated") {
      return;
    }
    expect(event.payload.account).toEqual({
      email: "team@example.test",
      accountId: "acct-1",
      label: "team@example.test",
    });
  });

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

  it("classifies generic provider task tools with agent metadata as subagent calls", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "Task",
        detail: "Review provider event flow.",
        status: "completed",
        data: {
          toolName: "Task",
          input: {
            subagent_type: "code-reviewer",
            instructions: "Review provider event flow.",
          },
          result: {
            agent_id: "agent-dynamic-1",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      detail: "Review provider event flow.",
      data: {
        subagent: {
          id: "agent-dynamic-1",
          type: "code-reviewer",
          prompt: "Review provider event flow.",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "agent-dynamic-1",
            type: "code-reviewer",
          },
        },
      },
    });
  });

  it("preserves provider subagent transcript lifecycle fields", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "SubagentStop",
        detail: "Subagent completed.",
        status: "completed",
        data: {
          hook_event_name: "SubagentStop",
          agent_id: "agent-hook-1",
          agent_type: "Explore",
          agent_transcript_path: "/repo/.claude/projects/session/subagents/agent-hook-1.jsonl",
          last_assistant_message: "Found two relevant files.",
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      data: {
        subagent: {
          id: "agent-hook-1",
          type: "Explore",
          transcriptPath: "/repo/.claude/projects/session/subagents/agent-hook-1.jsonl",
          lastAssistantMessage: "Found two relevant files.",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "agent-hook-1",
            type: "Explore",
            transcriptPath: "/repo/.claude/projects/session/subagents/agent-hook-1.jsonl",
            lastAssistantMessage: "Found two relevant files.",
          },
        },
      },
    });
  });

  it("normalizes provider subagent final content parts", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "SubagentStop",
        status: "completed",
        data: {
          hook_event_name: "SubagentStop",
          agent_id: "agent-content-1",
          agent_type: "Explore",
          finalAssistantMessage: {
            content: [
              { type: "text", text: "Found the adapter." },
              { type: "text", text: "The event path is covered." },
            ],
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      data: {
        subagent: {
          id: "agent-content-1",
          type: "Explore",
          lastAssistantMessage: "Found the adapter.\nThe event path is covered.",
        },
      },
    });
  });

  it("normalizes provider subagent transcript arrays", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "SubagentStop",
        status: "completed",
        data: {
          hook_event_name: "SubagentStop",
          agent_id: "agent-transcript-1",
          agent_type: "Research",
          messages: [
            { role: "user", text: "Inspect the provider adapters." },
            { role: "assistant", text: "The first adapter is covered." },
            { role: "user", text: "Check the side-chat path too." },
            { role: "assistant", text: "The side-chat path is covered." },
          ],
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      data: {
        subagent: {
          id: "agent-transcript-1",
          type: "Research",
          lastAssistantMessage: "The side-chat path is covered.",
        },
      },
    });
  });

  it("preserves explicit provider subagent task ids from nested lifecycle records", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "TaskCreated",
        detail: "Started background exploration.",
        status: "completed",
        data: {
          toolName: "TaskCreated",
          subagent: {
            task_id: "provider-task-1",
            agent_type: "Explore",
            agent_name: "Explore",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      data: {
        subagent: {
          id: "provider-task-1",
          type: "Explore",
          name: "Explore",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "provider-task-1",
            type: "Explore",
            name: "Explore",
          },
        },
      },
    });
  });

  it("classifies generic provider side-chat tools with child thread metadata as subagent calls", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "side_chat",
        detail: "Inspect migration risks without adding to the main thread.",
        status: "completed",
        data: {
          tool_name: "side_chat",
          childProviderThreadId: "provider-side-thread-1",
          agentRole: "side-chat",
          agentName: "Migration side chat",
          input: {
            prompt: "Inspect migration risks without adding to the main thread.",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      data: {
        subagent: {
          id: "provider-side-thread-1",
          type: "side-chat",
          name: "Migration side chat",
          prompt: "Inspect migration risks without adding to the main thread.",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "provider-side-thread-1",
            type: "side-chat",
            name: "Migration side chat",
          },
        },
      },
    });
  });

  it("classifies provider side-chat tools with receiver thread arrays as subagent calls", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "side_chat",
        status: "completed",
        data: {
          tool_name: "side_chat",
          receiverThreadIds: ["provider-side-thread-array-1"],
          agentRole: "side-chat",
          args: {
            message: "Inspect fan-out child routing without adding to the main thread.",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      data: {
        subagent: {
          id: "provider-side-thread-array-1",
          type: "side-chat",
          prompt: "Inspect fan-out child routing without adding to the main thread.",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "provider-side-thread-array-1",
            type: "side-chat",
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

  it("normalizes root scalar provider agent fields as subagent metadata", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "collab_agent_tool_call",
        title: "Agent task",
        detail: "Inspect provider scalar metadata.",
        status: "completed",
        agentId: "root-scalar-agent-1",
        agentName: "Scalar Reviewer",
        agentRole: "code-reviewer",
        model: "provider-scalar-model",
        data: {
          input: {
            prompt: "Inspect provider scalar metadata.",
          },
        },
      } as Extract<ProviderRuntimeEvent, { type: "item.completed" }>["payload"]),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      data: {
        subagent: {
          id: "root-scalar-agent-1",
          type: "code-reviewer",
          name: "Scalar Reviewer",
          model: "provider-scalar-model",
          prompt: "Inspect provider scalar metadata.",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "root-scalar-agent-1",
            type: "code-reviewer",
            name: "Scalar Reviewer",
            model: "provider-scalar-model",
          },
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

  it("normalizes provider side-chat child thread aliases as subagent metadata", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "collab_agent_tool_call",
        title: "Side chat",
        detail: "Open a side chat to inspect migration risks.",
        status: "completed",
        data: {
          threadId: "parent-provider-thread",
          childProviderThreadId: "side-provider-thread-1",
          agentName: "Migration Side Chat",
          agentRole: "side-chat",
          input: {
            prompt: "Inspect migration risks without polluting the main thread.",
          },
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      data: {
        subagent: {
          id: "side-provider-thread-1",
          type: "side-chat",
          name: "Migration Side Chat",
          prompt: "Inspect migration risks without polluting the main thread.",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "side-provider-thread-1",
            type: "side-chat",
            name: "Migration Side Chat",
          },
        },
      },
    });
  });

  it("normalizes provider side-chat arrays as subagent metadata", () => {
    const event = normalizeProviderRuntimeEvent(
      lifecycleEvent({
        itemType: "dynamic_tool_call",
        title: "side chat",
        detail: "Open a side conversation.",
        status: "completed",
        data: {
          sideChats: [
            {
              threadId: "provider-side-array-thread-1",
              displayName: "Architecture side chat",
              role: "side-chat",
              model: "provider-model",
              prompt: "Review the architecture without polluting the main thread.",
            },
          ],
        },
      }),
    );

    expect(event.payload).toMatchObject({
      itemType: "collab_agent_tool_call",
      title: "Subagent task",
      data: {
        subagent: {
          id: "provider-side-array-thread-1",
          type: "side-chat",
          name: "Architecture side chat",
          model: "provider-model",
          prompt: "Review the architecture without polluting the main thread.",
        },
        ace: {
          normalized: true,
          action: "collab-agent",
          itemType: "collab_agent_tool_call",
          subagent: {
            id: "provider-side-array-thread-1",
            type: "side-chat",
            name: "Architecture side chat",
            model: "provider-model",
          },
        },
      },
    });
  });
});
