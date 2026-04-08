import { type ChatAttachment, type ProviderReplayTurn } from "@ace/contracts";

import type { ProjectionThreadMessage } from "../persistence/Services/ProjectionThreadMessages.ts";

export type ReplaySourceMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

type MutableReplayTurn = {
  prompt: string;
  attachmentNames: Array<string>;
  assistantParts: Array<string>;
};

function uniqueAttachmentNames(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): Array<string> {
  const seen = new Set<string>();
  const names: Array<string> = [];
  for (const attachment of attachments ?? []) {
    const normalized = attachment.name.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    names.push(normalized);
  }
  return names;
}

function finalizeReplayTurn(
  turn: MutableReplayTurn | null,
  replayTurns: Array<ProviderReplayTurn>,
): void {
  if (!turn) {
    return;
  }

  const prompt = turn.prompt.trim();
  if (prompt.length === 0 && turn.attachmentNames.length === 0) {
    return;
  }

  const assistantResponse = turn.assistantParts.join("\n\n").trim();
  replayTurns.push(
    assistantResponse.length > 0
      ? {
          prompt,
          attachmentNames: [...turn.attachmentNames],
          assistantResponse,
        }
      : {
          prompt,
          attachmentNames: [...turn.attachmentNames],
        },
  );
}

export function sourceMessagesToReplayTurns(
  messages: ReadonlyArray<ReplaySourceMessage>,
): ReadonlyArray<ProviderReplayTurn> {
  const replayTurns: Array<ProviderReplayTurn> = [];
  let currentTurn: MutableReplayTurn | null = null;

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      finalizeReplayTurn(currentTurn, replayTurns);
      currentTurn = {
        prompt: message.text,
        attachmentNames: uniqueAttachmentNames(message.attachments),
        assistantParts: [],
      };
      continue;
    }

    if (!currentTurn) {
      continue;
    }

    const assistantText = message.text.trim();
    if (assistantText.length > 0) {
      currentTurn.assistantParts.push(assistantText);
    }
  }

  finalizeReplayTurn(currentTurn, replayTurns);
  return replayTurns;
}

export function projectionMessagesToReplayTurns(
  messages: ReadonlyArray<ProjectionThreadMessage>,
): ReadonlyArray<ProviderReplayTurn> {
  return sourceMessagesToReplayTurns(messages);
}
