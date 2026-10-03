import type { Fact } from "@ace/core";
import type { CommandPayload, ProviderKind } from "@ace/protocol";
import { message, rootAgent, turn } from "./facts.ts";

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
): {
  thread: { id: string; workspaceId: string; title: string; provider: ProviderKind };
  facts: Fact[];
} {
  const text = request.input
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  return {
    thread: {
      id,
      workspaceId: request.workspaceId,
      title: request.title ?? defaultTitle(text),
      provider: request.provider,
    },
    facts: [
      rootAgent(request.provider, `/Users/dev/${request.workspaceId}`),
      turn("root"),
      message("root", "ask", "user", text),
      message("root", "reading", "assistant", "Reading the project before making changes.", false),
    ],
  };
}
