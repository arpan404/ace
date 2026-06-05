import { describe, expect, it } from "vitest";

import {
  mergeProviderAgentMetadata,
  providerAgentLooseRecord,
  providerAgentMetadataFromRecord,
  providerAgentRecord,
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
});
