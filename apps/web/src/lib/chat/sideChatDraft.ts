import {
  ThreadId,
  type ProviderIntegrationCapabilities,
  type ProviderKind,
  type RuntimeMode,
} from "@ace/contracts";
import { defaultProviderIntegrationCapabilities } from "@ace/shared/providerIntegrationCapabilities";

export const NEW_SIDE_CHAT_THREAD_ID = "__ace_new_side_chat__";
export const NEW_SIDE_CHAT_DRAFT_RUNTIME_MODE: RuntimeMode = "approval-required";

const SIDE_CHAT_COMMAND_PATTERN = /^\/side(?:\s+([\s\S]*))?$/i;
const EMBEDDED_SIDE_CHAT_COMMAND_PATTERN = /\/side\s*/gi;

export function newSideChatDraftThreadId(input: {
  readonly parentThreadId: ThreadId | string;
  readonly draftId?: string | undefined;
}): ThreadId {
  return ThreadId.makeUnsafe(
    `subagent:${input.parentThreadId}:${input.draftId ?? NEW_SIDE_CHAT_THREAD_ID}`,
  );
}

export function newSideChatDraftSubagentId(): string {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${NEW_SIDE_CHAT_THREAD_ID}:${id}`;
}

export function isNewSideChatDraftSubagentId(value: string): boolean {
  return value === NEW_SIDE_CHAT_THREAD_ID || value.startsWith(`${NEW_SIDE_CHAT_THREAD_ID}:`);
}

export function parseAceSideChatCommand(text: string): { prompt: string } | null {
  const match = SIDE_CHAT_COMMAND_PATTERN.exec(text.trim());
  if (!match) {
    return null;
  }
  return { prompt: normalizeAceSideChatPromptText(match[1] ?? "") };
}

export function isAceSideConversationSupported(
  mode: ProviderIntegrationCapabilities["sideConversationMode"] | undefined,
): boolean {
  return mode === "native-fork" || mode === "replay-fork";
}

export function resolveAceSideConversationMode(input: {
  readonly provider: ProviderKind | null | undefined;
  readonly providerMode?: ProviderIntegrationCapabilities["sideConversationMode"] | undefined;
  readonly sessionMode?: ProviderIntegrationCapabilities["sideConversationMode"] | undefined;
}): ProviderIntegrationCapabilities["sideConversationMode"] | undefined {
  return (
    input.sessionMode ??
    input.providerMode ??
    (input.provider
      ? defaultProviderIntegrationCapabilities(input.provider).sideConversationMode
      : undefined)
  );
}

export function stripAceSideChatCommand(text: string): string {
  const parsed = parseAceSideChatCommand(text);
  return parsed ? parsed.prompt : text.trim();
}

export function normalizeAceSideChatPromptText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.includes("/side")) {
    return trimmed;
  }

  const repeatedSegments = trimmed
    .split(EMBEDDED_SIDE_CHAT_COMMAND_PATTERN)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const firstSegment = repeatedSegments[0];
  if (
    firstSegment &&
    repeatedSegments.length > 1 &&
    repeatedSegments.every((segment) => segment === firstSegment)
  ) {
    return firstSegment;
  }

  return trimmed.replace(EMBEDDED_SIDE_CHAT_COMMAND_PATTERN, " ").replace(/\s+/g, " ").trim();
}
