import { describe, expect, it } from "vitest";

import {
  isProviderSideConversationType,
  mergeProviderAgentMetadata,
  normalizeProviderSideConversationType,
  providerAgentLooseRecord,
  providerAgentMetadataFromRecord,
  providerAgentRecord,
  providerAgentRecords,
} from "./providerAgentMetadata";

describe("providerAgentMetadata", () => {
  it("finds provider delegated agent records", () => {
    const agent = {
      id: "agent-1",
      displayName: "Platform Specialist",
      role: "platform",
    };

    expect(providerAgentRecord({ assignedAgent: agent })).toBe(agent);
    expect(providerAgentRecord({ delegated_agent: agent })).toBe(agent);
    expect(providerAgentRecord({ worker: agent })).toBe(agent);
    expect(providerAgentRecord({ sideConversation: agent })).toBe(agent);
    expect(providerAgentRecord({ child_session: agent })).toBe(agent);
  });

  it("finds provider child records from plural side-chat containers", () => {
    const sideChat = {
      threadId: "provider-side-thread-1",
      displayName: "Migration side chat",
      role: "side-chat",
    };
    const childSession = {
      session_id: "provider-child-session-1",
      agentName: "Runtime Reviewer",
      agentRole: "code-reviewer",
    };

    expect(providerAgentRecord({ sideChats: [sideChat] })).toBe(sideChat);
    expect(providerAgentRecord({ childSessions: [childSession] })).toBe(childSession);
    expect(providerAgentRecord({ child_conversations: [sideChat] })).toBe(sideChat);
  });

  it("returns every provider child record from plural side-chat containers", () => {
    const firstSideChat = {
      threadId: "provider-side-thread-1",
      displayName: "Migration side chat",
      role: "side-chat",
    };
    const secondSideChat = {
      threadId: "provider-side-thread-2",
      displayName: "Runtime side chat",
      role: "side-chat",
    };

    expect(providerAgentRecords({ sideChats: [firstSideChat, secondSideChat] })).toEqual([
      firstSideChat,
      secondSideChat,
    ]);
    expect(providerAgentRecords({ side_conversations: [firstSideChat, secondSideChat] })).toEqual([
      firstSideChat,
      secondSideChat,
    ]);
  });

  it("normalizes provider agent identity aliases", () => {
    expect(
      providerAgentMetadataFromRecord({
        agent_id: "agent-1",
        agent_display_name: "Runtime Reviewer",
        agentRole: "code-reviewer",
        model_id: "gpt-provider",
        description: "Review runtime events.",
        prompt: "Inspect the runtime stream.",
      }),
    ).toEqual({
      id: "agent-1",
      type: "code-reviewer",
      name: "Runtime Reviewer",
      model: "gpt-provider",
      description: "Review runtime events.",
      prompt: "Inspect the runtime stream.",
    });
  });

  it("normalizes provider side-chat conversation id aliases", () => {
    expect(
      providerAgentMetadataFromRecord({
        provider_side_conversation_id: "provider-side-conversation-1",
        side_chat_id: "side-chat-1",
        agentRole: "side-chat",
        agentNickname: "Context helper",
      }),
    ).toEqual({
      id: "provider-side-conversation-1",
      type: "side-chat",
      name: "Context helper",
    });

    expect(
      mergeProviderAgentMetadata(
        providerAgentLooseRecord({
          sideConversationId: "side-conversation-2",
          subagent_type: "btw",
          subagent_name: "Background context",
        }),
      ),
    ).toEqual({
      id: "side-conversation-2",
      type: "btw",
      name: "Background context",
    });
  });

  it("normalizes provider task prompt aliases", () => {
    expect(
      providerAgentMetadataFromRecord({
        agentId: "agent-instructions",
        agentName: "Instruction Reviewer",
        agentRole: "reviewer",
        instructions: "Review the routing contract.",
      }),
    ).toEqual({
      id: "agent-instructions",
      type: "reviewer",
      name: "Instruction Reviewer",
      prompt: "Review the routing contract.",
    });

    expect(
      providerAgentMetadataFromRecord({
        childProviderThreadId: "side-thread-message",
        role: "side-chat",
        message: "Explain the current branch without changing the main thread.",
      }),
    ).toEqual({
      id: "side-thread-message",
      type: "side-chat",
      prompt: "Explain the current branch without changing the main thread.",
    });
  });

  it("normalizes provider subagent transcript lifecycle aliases", () => {
    expect(
      providerAgentMetadataFromRecord({
        agent_id: "agent-hook-1",
        agent_type: "Explore",
        agent_transcript_path: "/repo/.claude/projects/session/subagents/agent-hook-1.jsonl",
        last_assistant_message: "Found two relevant files.",
      }),
    ).toEqual({
      id: "agent-hook-1",
      type: "Explore",
      transcriptPath: "/repo/.claude/projects/session/subagents/agent-hook-1.jsonl",
      lastAssistantMessage: "Found two relevant files.",
    });
  });

  it("normalizes provider subagent final message content parts", () => {
    expect(
      providerAgentMetadataFromRecord({
        agent_id: "agent-content-1",
        agent_type: "Explore",
        finalAssistantMessage: {
          content: [
            { type: "text", text: "Found the adapter." },
            { type: "text", text: "The event path is covered." },
          ],
        },
      }),
    ).toEqual({
      id: "agent-content-1",
      type: "Explore",
      lastAssistantMessage: "Found the adapter.\nThe event path is covered.",
    });

    expect(
      providerAgentMetadataFromRecord({
        agent_id: "agent-output-1",
        output: {
          content: [{ text: "Provider returned nested output." }],
        },
      }),
    ).toEqual({
      id: "agent-output-1",
      lastAssistantMessage: "Provider returned nested output.",
    });
  });

  it("normalizes provider subagent transcript arrays to the latest assistant message", () => {
    expect(
      providerAgentMetadataFromRecord({
        agent_id: "agent-transcript-1",
        agent_type: "Research",
        messages: [
          { role: "user", content: [{ text: "Inspect the provider adapters." }] },
          { role: "assistant", content: [{ text: "The first adapter is covered." }] },
          { role: "user", content: [{ text: "Check the side-chat path too." }] },
          { role: "assistant", content: [{ text: "The side-chat path is covered." }] },
        ],
      }),
    ).toEqual({
      id: "agent-transcript-1",
      type: "Research",
      lastAssistantMessage: "The side-chat path is covered.",
    });

    expect(
      providerAgentMetadataFromRecord({
        agent_id: "agent-model-role-1",
        transcript: {
          messages: [
            { role: "user", text: "Review Gemini output." },
            { role: "model", parts: [{ text: "Gemini-style model output." }] },
          ],
        },
      }),
    ).toEqual({
      id: "agent-model-role-1",
      lastAssistantMessage: "Gemini-style model output.",
    });
  });

  it("normalizes explicit provider subagent task ids without loose task leakage", () => {
    expect(
      providerAgentMetadataFromRecord({
        task_id: "provider-task-1",
        agent_type: "Explore",
      }),
    ).toEqual({
      id: "provider-task-1",
      type: "Explore",
    });

    expect(
      mergeProviderAgentMetadata(
        providerAgentLooseRecord({
          id: "runtime-item-1",
          type: "task.progress",
          task_id: "ordinary-task-progress",
        }),
      ),
    ).toEqual({});
  });

  it("preserves loose provider subagent transcript lifecycle aliases", () => {
    expect(
      mergeProviderAgentMetadata(
        providerAgentLooseRecord({
          id: "runtime-item-1",
          type: "hook.completed",
          agent_id: "agent-hook-2",
          agent_type: "Plan",
          agent_transcript_path: "/repo/.claude/projects/session/subagents/agent-hook-2.jsonl",
          last_assistant_message: "Plan complete.",
        }),
      ),
    ).toEqual({
      id: "agent-hook-2",
      type: "Plan",
      transcriptPath: "/repo/.claude/projects/session/subagents/agent-hook-2.jsonl",
      lastAssistantMessage: "Plan complete.",
    });
  });

  it("merges metadata from ordered provider records", () => {
    expect(
      mergeProviderAgentMetadata(
        {
          id: "agent-1",
          role: "researcher",
        },
        {
          displayName: "Researcher",
          model: "provider-model",
        },
      ),
    ).toEqual({
      id: "agent-1",
      type: "researcher",
      name: "Researcher",
      model: "provider-model",
    });
  });

  it("normalizes nested provider child thread and session identifiers", () => {
    expect(
      providerAgentMetadataFromRecord({
        threadId: "agent-thread-1",
        session_id: "agent-session-ignored",
        displayName: "Planning Thread",
        role: "side-chat",
      }),
    ).toEqual({
      id: "agent-thread-1",
      type: "side-chat",
      name: "Planning Thread",
    });
  });

  it("normalizes provider child thread array identifiers", () => {
    expect(
      providerAgentMetadataFromRecord({
        receiverThreadIds: ["", "receiver-thread-1", "receiver-thread-2"],
        displayName: "Receiver Thread",
        role: "side-chat",
      }),
    ).toEqual({
      id: "receiver-thread-1",
      type: "side-chat",
      name: "Receiver Thread",
    });

    expect(
      providerAgentMetadataFromRecord({
        child_provider_thread_ids: ["child-thread-1"],
        agentRole: "researcher",
      }),
    ).toEqual({
      id: "child-thread-1",
      type: "researcher",
    });
  });

  it("normalizes provider parent agent relationship aliases", () => {
    expect(
      providerAgentMetadataFromRecord({
        subagent_id: "copilot-subagent-1",
        parentId: "copilot-parent-event-1",
        agentDisplayName: "Runtime Reviewer",
        agentRole: "code-reviewer",
      }),
    ).toEqual({
      id: "copilot-subagent-1",
      parentId: "copilot-parent-event-1",
      type: "code-reviewer",
      name: "Runtime Reviewer",
    });

    expect(
      mergeProviderAgentMetadata(
        providerAgentLooseRecord({
          id: "runtime-item-1",
          type: "collabAgentToolCall",
          childProviderThreadId: "opencode-session-child",
          parentProviderThreadId: "opencode-session-parent",
          agentName: "scout",
        }),
      ),
    ).toEqual({
      id: "opencode-session-child",
      parentId: "opencode-session-parent",
      name: "scout",
    });
  });

  it("keeps loose runtime payload fields from masquerading as agent identity", () => {
    expect(
      mergeProviderAgentMetadata(
        providerAgentLooseRecord({
          id: "runtime-item-1",
          type: "collabAgentToolCall",
          name: "Task",
          subagentId: "agent-1",
          subagentType: "reviewer",
          agentDisplayName: "Reviewer",
        }),
      ),
    ).toEqual({
      id: "agent-1",
      type: "reviewer",
      name: "Reviewer",
    });
  });

  it("preserves loose child-thread aliases without accepting root runtime ids", () => {
    expect(
      mergeProviderAgentMetadata(
        providerAgentLooseRecord({
          id: "runtime-item-1",
          threadId: "parent-thread-1",
          type: "collabAgentToolCall",
          name: "Task",
          childProviderThreadId: "child-thread-1",
          providerConversationId: "provider-conversation-ignored",
          agentName: "Side Reviewer",
        }),
      ),
    ).toEqual({
      id: "child-thread-1",
      name: "Side Reviewer",
    });
  });

  it("preserves loose child-thread array aliases", () => {
    expect(
      mergeProviderAgentMetadata(
        providerAgentLooseRecord({
          id: "runtime-item-1",
          type: "collabAgentToolCall",
          name: "Task",
          receiverThreadIds: ["receiver-thread-1"],
          subagentType: "side-chat",
        }),
      ),
    ).toEqual({
      id: "receiver-thread-1",
      type: "side-chat",
    });
  });

  it("preserves loose provider task prompt aliases", () => {
    expect(
      mergeProviderAgentMetadata(
        providerAgentLooseRecord({
          id: "runtime-item-1",
          type: "dynamic_tool_call",
          name: "Task",
          subagentId: "agent-2",
          subagentType: "planner",
          instructions: "Plan the provider-side event flow.",
        }),
      ),
    ).toEqual({
      id: "agent-2",
      type: "planner",
      prompt: "Plan the provider-side event flow.",
    });
  });

  it("recognizes provider side conversation type spellings", () => {
    expect(normalizeProviderSideConversationType("side_chat")).toBe("side-chat");
    expect(normalizeProviderSideConversationType(".side")).toBe("side");
    expect(normalizeProviderSideConversationType("Side Conversation")).toBe("side-conversation");
    expect(isProviderSideConversationType("side")).toBe(true);
    expect(isProviderSideConversationType("/side")).toBe(true);
    expect(isProviderSideConversationType(".side")).toBe(true);
    expect(isProviderSideConversationType("side chat")).toBe(true);
    expect(isProviderSideConversationType("side-chat")).toBe(true);
    expect(isProviderSideConversationType("side_conversation")).toBe(true);
    expect(isProviderSideConversationType("/btw")).toBe(true);
    expect(isProviderSideConversationType("btw")).toBe(true);
    expect(isProviderSideConversationType("code-reviewer")).toBe(false);
  });
});
