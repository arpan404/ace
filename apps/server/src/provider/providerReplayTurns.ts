import {
  type ChatAttachment,
  type ProviderReplayTurn,
  type ThreadHandoffMode,
} from "@ace/contracts";

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

const DEFAULT_COMPACT_MAX_CHARS = 12_000;
const DEFAULT_COMPACT_MAX_TURNS = 24;
const HANDOFF_CONTEXT_INSTRUCTION = [
  "Handoff context from a prior provider session.",
  "The replayed context is historical interaction between USER and ASSISTANT.",
  "Tool availability can differ across providers, so treat referenced tools and outputs as historical context and adapt to tools available in this session.",
].join(" ");
const HANDOFF_TRANSCRIPT_MODE_SUFFIX = "The full transcript replay appears after this note.";
const HANDOFF_COMPACT_MODE_SUFFIX = "A compact interaction summary appears after this note.";
const HANDOFF_COMPACT_SUMMARY_PROMPT =
  "Please provide a concise summary of the prior USER and ASSISTANT interaction before addressing the latest user request in this session.";

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

function formatReplayTurnForCompact(
  turn: ProviderReplayTurn,
  index: number,
  total: number,
): string {
  const sections: string[] = [`Turn ${String(index + 1)} of ${String(total)}`];
  const prompt = turn.prompt.trim();
  if (prompt.length > 0) {
    sections.push(`User:\n${prompt}`);
  }
  if (turn.attachmentNames.length > 0) {
    sections.push(`Attachments: ${turn.attachmentNames.join(", ")}`);
  }
  if (turn.assistantResponse?.trim()) {
    sections.push(`Assistant:\n${turn.assistantResponse.trim()}`);
  }
  return sections.join("\n\n");
}

function buildHandoffInstructionTurn(mode: ThreadHandoffMode): ProviderReplayTurn {
  const suffix = mode === "compact" ? HANDOFF_COMPACT_MODE_SUFFIX : HANDOFF_TRANSCRIPT_MODE_SUFFIX;
  return {
    prompt: `${HANDOFF_CONTEXT_INSTRUCTION} ${suffix}`,
    attachmentNames: [],
  };
}

export function compactReplayTurns(
  replayTurns: ReadonlyArray<ProviderReplayTurn>,
  options?: {
    readonly maxChars?: number;
    readonly maxTurns?: number;
  },
): ReadonlyArray<ProviderReplayTurn> {
  if (replayTurns.length === 0) {
    return [];
  }

  const maxTurns =
    options?.maxTurns === undefined
      ? DEFAULT_COMPACT_MAX_TURNS
      : Math.max(1, Math.floor(options.maxTurns));
  const maxChars =
    options?.maxChars === undefined
      ? DEFAULT_COMPACT_MAX_CHARS
      : Math.max(1, Math.floor(options.maxChars));
  const recentTurns = replayTurns.slice(-maxTurns);
  const body = recentTurns
    .map((turn, index) => formatReplayTurnForCompact(turn, index, recentTurns.length))
    .join("\n\n---\n\n");
  const compacted =
    body.length <= maxChars ? body : `…\n${body.slice(body.length - maxChars + 2).trimStart()}`;

  return [
    {
      prompt: HANDOFF_COMPACT_SUMMARY_PROMPT,
      attachmentNames: [],
      assistantResponse: `Prior interaction summary:\n\n${compacted}`,
    },
  ];
}

export function sourceMessagesToHandoffReplayTurns(
  messages: ReadonlyArray<ReplaySourceMessage>,
  mode: ThreadHandoffMode,
): ReadonlyArray<ProviderReplayTurn> {
  const replayTurns = sourceMessagesToReplayTurns(messages);
  if (replayTurns.length === 0) {
    return [];
  }
  const handoffInstructionTurn = buildHandoffInstructionTurn(mode);
  return mode === "compact"
    ? [handoffInstructionTurn, ...compactReplayTurns(replayTurns)]
    : [handoffInstructionTurn, ...replayTurns];
}
