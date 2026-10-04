import type { Fact } from "@ace/core";
import { CommandId, type CommandPayload, type ProviderKind } from "@ace/protocol";
import { rootAgent, turn } from "./facts.ts";

type CreateThread = Extract<CommandPayload, { type: "thread.create" }>;

const titleLimit = 60;

/** First line of the request, trimmed to a list-sized title, like the daemon's default. */
export function defaultTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= titleLimit) return line || "New thread";
  const cut = line.slice(0, titleLimit);
  const space = cut.lastIndexOf(" ");
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

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
      title: request.title ?? "New thread",
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
      turn("root"),
    ],
  };
}
