import { ThreadId, type RuntimeMode } from "@ace/contracts";

export const NEW_SIDE_CHAT_THREAD_ID = "__ace_new_side_chat__";
export const NEW_SIDE_CHAT_DRAFT_RUNTIME_MODE: RuntimeMode = "approval-required";

export function newSideChatDraftThreadId(input: {
  readonly parentThreadId: ThreadId | string;
}): ThreadId {
  return ThreadId.makeUnsafe(`subagent:${input.parentThreadId}:${NEW_SIDE_CHAT_THREAD_ID}`);
}
