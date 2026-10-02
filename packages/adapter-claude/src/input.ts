import { z } from "zod";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import type {
  PermissionResult,
  PermissionUpdate,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const ImageMime = z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Open input stream; ending it is part of graceful session shutdown. */
export class InputStream implements AsyncIterable<SDKUserMessage> {
  #queue: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #closed = false;
  push(message: SDKUserMessage): void {
    if (this.#closed) throw new Error("Claude session is closed");
    this.#queue.push(message);
    this.#wake?.();
  }
  close(): void {
    this.#closed = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.#closed) {
      const message = this.#queue.shift();
      if (message) yield message;
      else
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
    }
  }
}
export function content(input: ContentPart[]): SDKUserMessage["message"]["content"] {
  return input.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    if (part.type === "file") return { type: "text" as const, text: `@${part.path}` };
    const mime = ImageMime.safeParse(part.mimeType);
    const data = /^data:([^;,]+);base64,(.+)$/s.exec(part.url);
    if (!data || !mime.success || data[1] !== part.mimeType)
      throw new Error("Claude image inputs require a matching base64 data URL");
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: mime.data,
        data: data[2] ?? "",
      },
    };
  });
}
export function permissionResult(
  resolution: InteractionResolution,
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[],
): PermissionResult {
  if (resolution.kind === "question") {
    if (resolution.dismissed)
      return { behavior: "deny", message: "The user dismissed the question." };
    return {
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: Object.fromEntries(
          Object.entries(resolution.answers).map(([q, answers]) => [
            q,
            answers.length === 1 ? answers[0] : answers,
          ]),
        ),
      },
    };
  }
  if (resolution.kind === "plan_review")
    return resolution.decision === "approve"
      ? { behavior: "allow", updatedInput: input }
      : {
          behavior: "deny",
          message: resolution.feedback ?? "Plan rejected.",
          ...(resolution.decision === "cancel" ? { interrupt: true } : {}),
        };
  if (resolution.kind !== "approval")
    throw new Error("Interaction kind does not match a tool permission");
  if (resolution.optionId === "allow_once") return { behavior: "allow", updatedInput: input };
  if (resolution.optionId.startsWith("allow_session:")) {
    const index = Number(resolution.optionId.slice("allow_session:".length));
    const suggestion = Number.isInteger(index) ? suggestions[index] : undefined;
    if (!suggestion) throw new Error("Unknown Claude permission suggestion");
    return { behavior: "allow", updatedInput: input, updatedPermissions: [suggestion] };
  }
  if (resolution.optionId !== "deny") throw new Error("Unknown Claude approval option");
  return { behavior: "deny", message: resolution.message ?? "Permission denied." };
}
