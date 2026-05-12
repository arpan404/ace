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

const DEFAULT_BEST_HANDOFF_RECENT_TURNS = 32;
const DEFAULT_BEST_HANDOFF_DIGEST_MAX_CHARS = 48_000;
const DEFAULT_BEST_HANDOFF_TURN_EXCERPT_CHARS = 1_600;
const HANDOFF_CONTEXT_INSTRUCTION = [
  "Best-effort handoff context from a prior provider session.",
  "The replayed context is historical interaction between USER and ASSISTANT plus a structured handoff brief.",
  "Preserve decisions, constraints, file references, and current state from this context, but adapt to tools available in this session.",
].join(" ");
const HANDOFF_CONTEXT_SUFFIX =
  "Exact recent turns are replayed when useful, and the final replay turn contains the handoff brief to use before answering the next user request.";
const HANDOFF_BRIEF_PROMPT =
  "Record the best handoff brief for the next provider. Keep this brief available before addressing the next user request.";

function truncateMiddle(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 1) {
    return "…";
  }
  const headLength = Math.max(1, Math.floor((maxChars - 1) * 0.62));
  const tailLength = Math.max(1, maxChars - 1 - headLength);
  return `${normalized.slice(0, headLength).trimEnd()}…${normalized
    .slice(normalized.length - tailLength)
    .trimStart()}`;
}

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

function buildHandoffInstructionTurn(_mode: ThreadHandoffMode): ProviderReplayTurn {
  return {
    prompt: `${HANDOFF_CONTEXT_INSTRUCTION} ${HANDOFF_CONTEXT_SUFFIX}`,
    attachmentNames: [],
  };
}

function countAssistantResponses(replayTurns: ReadonlyArray<ProviderReplayTurn>): number {
  let count = 0;
  for (const turn of replayTurns) {
    if (turn.assistantResponse?.trim()) {
      count += 1;
    }
  }
  return count;
}

function collectUniqueAttachmentNames(replayTurns: ReadonlyArray<ProviderReplayTurn>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const turn of replayTurns) {
    for (const name of turn.attachmentNames) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function formatAttachmentSummary(names: ReadonlyArray<string>): string {
  if (names.length === 0) {
    return "None";
  }
  const visibleNames = names.slice(0, 20);
  const remaining = names.length - visibleNames.length;
  return `${visibleNames.join(", ")}${remaining > 0 ? `, +${String(remaining)} more` : ""}`;
}

function formatBestHandoffDigestTurn(
  turn: ProviderReplayTurn,
  index: number,
  total: number,
  maxExcerptChars: number,
): string {
  const sections = [`Turn ${String(index + 1)} of ${String(total)}`];
  const prompt = truncateMiddle(turn.prompt, maxExcerptChars);
  if (prompt.length > 0) {
    sections.push(`User intent:\n${prompt}`);
  }
  if (turn.attachmentNames.length > 0) {
    sections.push(`Attachments: ${turn.attachmentNames.join(", ")}`);
  }
  const assistantResponse = turn.assistantResponse?.trim();
  if (assistantResponse) {
    sections.push(`Assistant result:\n${truncateMiddle(assistantResponse, maxExcerptChars)}`);
  }
  return sections.join("\n\n");
}

function buildBestHandoffBrief(
  replayTurns: ReadonlyArray<ProviderReplayTurn>,
  recentExactTurns: ReadonlyArray<ProviderReplayTurn>,
  options?: {
    readonly maxDigestChars?: number;
    readonly maxExcerptChars?: number;
  },
): string {
  const maxDigestChars =
    options?.maxDigestChars === undefined
      ? DEFAULT_BEST_HANDOFF_DIGEST_MAX_CHARS
      : Math.max(1, Math.floor(options.maxDigestChars));
  const maxExcerptChars =
    options?.maxExcerptChars === undefined
      ? DEFAULT_BEST_HANDOFF_TURN_EXCERPT_CHARS
      : Math.max(1, Math.floor(options.maxExcerptChars));
  const attachmentNames = collectUniqueAttachmentNames(replayTurns);
  const olderTurnCount = Math.max(0, replayTurns.length - recentExactTurns.length);
  const lastTurn = replayTurns.at(-1);
  const lastAssistantResponse = [...replayTurns]
    .toReversed()
    .find((turn) => turn.assistantResponse?.trim())?.assistantResponse;
  const allDigest = replayTurns
    .map((turn, index) =>
      formatBestHandoffDigestTurn(turn, index, replayTurns.length, maxExcerptChars),
    )
    .join("\n\n---\n\n");
  const digest =
    allDigest.length <= maxDigestChars
      ? allDigest
      : `…\n${allDigest.slice(allDigest.length - maxDigestChars + 2).trimStart()}`;

  const sections = [
    "Best handoff brief",
    [
      `Prior user turns: ${String(replayTurns.length)}`,
      `Prior assistant responses: ${String(countAssistantResponses(replayTurns))}`,
      `Exact recent turns replayed before this brief: ${String(recentExactTurns.length)}`,
      `Older turns represented by digest only: ${String(olderTurnCount)}`,
      `Attachments referenced: ${formatAttachmentSummary(attachmentNames)}`,
    ].join("\n"),
  ];

  if (lastTurn?.prompt.trim()) {
    sections.push(`Most recent user intent:\n${truncateMiddle(lastTurn.prompt, maxExcerptChars)}`);
  }
  if (lastAssistantResponse?.trim()) {
    sections.push(
      `Most recent assistant state:\n${truncateMiddle(lastAssistantResponse, maxExcerptChars)}`,
    );
  }

  sections.push(
    [
      "Continuation instructions:",
      "- Treat the replayed exact turns and this brief as prior context, not as a new request.",
      "- Preserve concrete decisions, constraints, file paths, commands, and unresolved questions.",
      "- If the source provider mentioned tools that are unavailable here, translate the intent into available tools.",
      "- Before making changes, reconcile this brief with the current workspace state.",
    ].join("\n"),
  );
  sections.push(`Chronological digest:\n${digest}`);
  return sections.join("\n\n");
}

function bestHandoffReplayTurns(
  replayTurns: ReadonlyArray<ProviderReplayTurn>,
  options?: {
    readonly recentTurns?: number;
    readonly maxDigestChars?: number;
    readonly maxExcerptChars?: number;
  },
): ReadonlyArray<ProviderReplayTurn> {
  if (replayTurns.length === 0) {
    return [];
  }

  const recentTurns =
    options?.recentTurns === undefined
      ? DEFAULT_BEST_HANDOFF_RECENT_TURNS
      : Math.max(1, Math.floor(options.recentTurns));
  const recentExactTurns = replayTurns.slice(-recentTurns);
  const handoffBrief = buildBestHandoffBrief(replayTurns, recentExactTurns, {
    ...(options?.maxDigestChars !== undefined ? { maxDigestChars: options.maxDigestChars } : {}),
    ...(options?.maxExcerptChars !== undefined ? { maxExcerptChars: options.maxExcerptChars } : {}),
  });

  return [
    ...recentExactTurns,
    {
      prompt: HANDOFF_BRIEF_PROMPT,
      attachmentNames: [],
      assistantResponse: handoffBrief,
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
  return [handoffInstructionTurn, ...bestHandoffReplayTurns(replayTurns)];
}
