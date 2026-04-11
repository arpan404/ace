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

  it("prepends explicit handoff guidance for transcript mode", () => {
    const handoffReplay = sourceMessagesToHandoffReplayTurns(sourceMessages, "transcript");
    expect(handoffReplay).toHaveLength(3);
    expect(handoffReplay[0]?.attachmentNames).toEqual([]);
    expect(handoffReplay[0]?.prompt).toContain("historical interaction between USER and ASSISTANT");
    expect(handoffReplay[0]?.prompt).toContain("Tool availability can differ across providers");
    expect(handoffReplay[0]?.prompt).toContain("full transcript replay");
    expect(handoffReplay.slice(1)).toEqual(sourceMessagesToReplayTurns(sourceMessages));
  });

  it("returns compact handoff replay with a summary assistant message", () => {
    const handoffReplay = sourceMessagesToHandoffReplayTurns(sourceMessages, "compact");
    expect(handoffReplay).toHaveLength(2);
    expect(handoffReplay[0]?.prompt).toContain("historical interaction between USER and ASSISTANT");
    expect(handoffReplay[0]?.prompt).toContain("compact interaction summary");

    const compactSummaryTurn = handoffReplay[1];
    expect(compactSummaryTurn?.prompt).toContain(
      "Please provide a concise summary of the prior USER and ASSISTANT interaction",
    );
    expect(compactSummaryTurn?.assistantResponse).toContain("Prior interaction summary:");
    expect(compactSummaryTurn?.assistantResponse).toContain("Turn 1 of 2");
    expect(compactSummaryTurn?.assistantResponse).toContain("User:");
    expect(compactSummaryTurn?.assistantResponse).toContain("Assistant:");
  });

  it("returns an empty replay for empty handoff history", () => {
    expect(sourceMessagesToHandoffReplayTurns([], "transcript")).toEqual([]);
    expect(sourceMessagesToHandoffReplayTurns([], "compact")).toEqual([]);
  });
});
