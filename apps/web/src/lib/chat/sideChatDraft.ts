import { ThreadId, type RuntimeMode } from "@ace/contracts";

export const NEW_SIDE_CHAT_THREAD_ID = "__ace_new_side_chat__";
export const NEW_SIDE_CHAT_DRAFT_RUNTIME_MODE: RuntimeMode = "approval-required";

const SIDE_CHAT_COMMAND_PATTERN = /^\/side(?:\s+([\s\S]*))?$/i;

export function newSideChatDraftThreadId(input: {
  readonly parentThreadId: ThreadId | string;
}): ThreadId {
  return ThreadId.makeUnsafe(`subagent:${input.parentThreadId}:${NEW_SIDE_CHAT_THREAD_ID}`);
}

export function parseAceSideChatCommand(text: string): { prompt: string } | null {
  const match = SIDE_CHAT_COMMAND_PATTERN.exec(text.trim());
  if (!match) {
    return null;
  }
  return { prompt: (match[1] ?? "").trim() };
}

export function stripAceSideChatCommand(text: string): string {
  const parsed = parseAceSideChatCommand(text);
  return parsed ? parsed.prompt : text.trim();
}
