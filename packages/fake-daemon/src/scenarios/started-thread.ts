import type { Fact } from "@ace/core";
import { CommandId, type CommandPayload, type ProviderKind } from "@ace/protocol";
import { provisionalTitle } from "@ace/ui-core";
import { message, rootAgent } from "./facts.ts";

type CreateThread = Extract<CommandPayload, { type: "thread.create" }>;

/**
 * What the fake daemon does with `thread.create`: the thread appears with the person's
 * request and its root agent starts reading the project. No provider is ever contacted.
 */
export function startedThread(
  id: string,
  request: CreateThread,
  commandId = id,
): {
  thread: { id: string; workspaceId: string; title: string; provider: ProviderKind };
  facts: Fact[];
} {
  return {
    thread: {
      id,
      workspaceId: request.workspaceId,
      // The daemon's provisional title rule (TN-1): prose only, mentions and chips left out.
      title: request.title ?? provisionalTitle(request.input),
      provider: request.provider,
    },
    facts: [
      {
        ...rootAgent(request.provider, `/Users/dev/${request.workspaceId}`),
        ...(request.model ? { model: request.model } : {}),
      },
      {
        type: "item.upsert",
        agent: "root",
        item: `input:${commandId}`,
        draft: {
          type: "message",
          role: "user",
          complete: true,
          parts: request.input,
          origin: { kind: "person", commandId: CommandId.parse(commandId) },
        },
      },
      // The run started for this command takes its admitted input (`turn-<commandId>`).
      { type: "turn.started", agent: "root", nativeTurnId: `turn-${commandId}`, trigger: "user" },
      message("root", "reading", "assistant", "Reading the project before making changes.", false),
    ],
  };
}

/** A finite demo response after the new thread has read the project. */
export function completedThread(commandId: string): Fact[] {
  return [
    message(
      "root",
      "reading",
      "assistant",
      "I've read the project and identified its entry points. What would you like to change?",
    ),
    { type: "turn.ended", agent: "root", nativeTurnId: `turn-${commandId}`, outcome: "completed" },
  ];
}
