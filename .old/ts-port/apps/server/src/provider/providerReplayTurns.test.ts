import { describe, expect, it } from "vitest";

import {
  sourceMessagesToHandoffReplayTurns,
  sourceMessagesToReplayTurns,
  type ReplaySourceMessage,
} from "./providerReplayTurns";

function imageAttachment(id: string, name: string) {
  return {
    type: "image" as const,
    id,
    name,
    mimeType: "image/png",
    sizeBytes: 1,
  };
}

describe("providerReplayTurns", () => {
  const sourceMessages: ReadonlyArray<ReplaySourceMessage> = [
    {
      role: "system",
      text: "Internal marker",
    },
    {
      role: "user",
      text: "Plan the migration",
      attachments: [
        imageAttachment("img-1", "diagram.png"),
        imageAttachment("img-2", "diagram.png"),
      ],
    },
    {
      role: "assistant",
      text: "Start with schema changes.",
    },
    {
      role: "assistant",
      text: "Then run dual writes until traffic stabilizes.",
    },
    {
      role: "user",
      text: "Can we avoid downtime?",
      attachments: [],
    },
    {
      role: "assistant",
      text: "Yes, use blue/green deployment.",
    },
  ];

  it("converts source messages into replay turns with assistant responses", () => {
    expect(sourceMessagesToReplayTurns(sourceMessages)).toEqual([
      {
        prompt: "Plan the migration",
        attachmentNames: ["diagram.png"],
        assistantResponse:
          "Start with schema changes.\n\nThen run dual writes until traffic stabilizes.",
      },
      {
        prompt: "Can we avoid downtime?",
        attachmentNames: [],
        assistantResponse: "Yes, use blue/green deployment.",
      },
    ]);
  });

  it("prepends explicit guidance and creates a best handoff packet", () => {
    const handoffReplay = sourceMessagesToHandoffReplayTurns(sourceMessages, "best");
    expect(handoffReplay).toHaveLength(4);
    expect(handoffReplay[0]?.attachmentNames).toEqual([]);
    expect(handoffReplay[0]?.prompt).toContain("historical interaction between USER and ASSISTANT");
    expect(handoffReplay[0]?.prompt).toContain("adapt to tools available in this session");
    expect(handoffReplay[0]?.prompt).toContain("structured handoff brief");
    expect(handoffReplay.slice(1, 3)).toEqual(sourceMessagesToReplayTurns(sourceMessages));

    const handoffBriefTurn = handoffReplay[3];
    expect(handoffBriefTurn?.prompt).toContain("best handoff brief");
    expect(handoffBriefTurn?.assistantResponse).toContain("Best handoff brief");
    expect(handoffBriefTurn?.assistantResponse).toContain("Most recent user intent:");
    expect(handoffBriefTurn?.assistantResponse).toContain("Most recent assistant state:");
    expect(handoffBriefTurn?.assistantResponse).toContain("Chronological digest:");
  });

  it("returns an empty replay for empty handoff history", () => {
    expect(sourceMessagesToHandoffReplayTurns([], "best")).toEqual([]);
    expect(sourceMessagesToHandoffReplayTurns([], "transcript")).toEqual([]);
    expect(sourceMessagesToHandoffReplayTurns([], "compact")).toEqual([]);
  });

  it("uses exact replay turns for fork fallback", () => {
    expect(sourceMessagesToHandoffReplayTurns(sourceMessages, "fork")).toEqual(
      sourceMessagesToReplayTurns(sourceMessages),
    );
  });
});
