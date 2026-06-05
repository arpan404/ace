export type ProviderAgentMetadata = {
  readonly id?: string;
  readonly parentId?: string;
  readonly type?: string;
  readonly name?: string;
  readonly model?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly transcriptPath?: string;
  readonly lastAssistantMessage?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record) {
    return record;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    const itemRecord = asRecord(item);
    if (itemRecord) {
      return itemRecord;
    }
  }
  return undefined;
}

function recordsFrom(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  if (record) {
    return [record];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const itemRecord = asRecord(item);
    return itemRecord ? [itemRecord] : [];
  });
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstTrimmedString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      const normalized = firstTrimmedString(...value);
      if (normalized) {
        return normalized;
      }
      continue;
    }
    const normalized = asTrimmedString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

export function providerAgentRecord(
  record: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }
  return (
    firstRecord(record.subagent) ??
    firstRecord(record.subagents) ??
    firstRecord(record.agent) ??
    firstRecord(record.assignedAgent) ??
    firstRecord(record.assigned_agent) ??
    firstRecord(record.delegatedAgent) ??
    firstRecord(record.delegated_agent) ??
    firstRecord(record.delegate) ??
    firstRecord(record.assignee) ??
    firstRecord(record.worker) ??
    firstRecord(record.childAgent) ??
    firstRecord(record.child_agent) ??
    firstRecord(record.childAgents) ??
    firstRecord(record.child_agents) ??
    firstRecord(record.childThread) ??
    firstRecord(record.child_thread) ??
    firstRecord(record.childThreads) ??
    firstRecord(record.child_threads) ??
    firstRecord(record.childSession) ??
    firstRecord(record.child_session) ??
    firstRecord(record.childSessions) ??
    firstRecord(record.child_sessions) ??
    firstRecord(record.childConversation) ??
    firstRecord(record.child_conversation) ??
    firstRecord(record.childConversations) ??
    firstRecord(record.child_conversations) ??
    firstRecord(record.sideChat) ??
    firstRecord(record.side_chat) ??
    firstRecord(record.sideChats) ??
    firstRecord(record.side_chats) ??
    firstRecord(record.sideConversation) ??
    firstRecord(record.side_conversation) ??
    firstRecord(record.sideConversations) ??
    firstRecord(record.side_conversations)
  );
}

export function providerAgentRecords(
  record: Record<string, unknown> | null | undefined,
): ReadonlyArray<Record<string, unknown>> {
  if (!record) {
    return [];
  }
  return [
    ...recordsFrom(record.subagent),
    ...recordsFrom(record.subagents),
    ...recordsFrom(record.agent),
    ...recordsFrom(record.assignedAgent),
    ...recordsFrom(record.assigned_agent),
    ...recordsFrom(record.delegatedAgent),
    ...recordsFrom(record.delegated_agent),
    ...recordsFrom(record.delegate),
    ...recordsFrom(record.assignee),
    ...recordsFrom(record.worker),
    ...recordsFrom(record.childAgent),
    ...recordsFrom(record.child_agent),
    ...recordsFrom(record.childAgents),
    ...recordsFrom(record.child_agents),
    ...recordsFrom(record.childThread),
    ...recordsFrom(record.child_thread),
    ...recordsFrom(record.childThreads),
    ...recordsFrom(record.child_threads),
    ...recordsFrom(record.childSession),
    ...recordsFrom(record.child_session),
    ...recordsFrom(record.childSessions),
    ...recordsFrom(record.child_sessions),
    ...recordsFrom(record.childConversation),
    ...recordsFrom(record.child_conversation),
    ...recordsFrom(record.childConversations),
    ...recordsFrom(record.child_conversations),
    ...recordsFrom(record.sideChat),
    ...recordsFrom(record.side_chat),
    ...recordsFrom(record.sideChats),
    ...recordsFrom(record.side_chats),
    ...recordsFrom(record.sideConversation),
    ...recordsFrom(record.side_conversation),
    ...recordsFrom(record.sideConversations),
    ...recordsFrom(record.side_conversations),
  ];
}

export function providerAgentMetadataFromRecord(
  record: Record<string, unknown> | null | undefined,
): ProviderAgentMetadata {
  if (!record) {
    return {};
  }
  const id = firstTrimmedString(
    record.id,
    record.agentId,
    record.agent_id,
    record.taskId,
    record.taskID,
    record.task_id,
    record.subagentId,
    record.subagent_id,
    record.providerThreadId,
    record.provider_thread_id,
    record.providerThreadIds,
    record.provider_thread_ids,
    record.childProviderThreadId,
    record.child_provider_thread_id,
    record.childProviderThreadIds,
    record.child_provider_thread_ids,
    record.childThreadId,
    record.child_thread_id,
    record.childThreadIds,
    record.child_thread_ids,
    record.receiverThreadId,
    record.receiver_thread_id,
    record.receiverThreadIds,
    record.receiver_thread_ids,
    record.agentThreadId,
    record.agent_thread_id,
    record.agentThreadIds,
    record.agent_thread_ids,
    record.providerConversationId,
    record.provider_conversation_id,
    record.providerSideConversationId,
    record.provider_side_conversation_id,
    record.providerSideChatId,
    record.provider_side_chat_id,
    record.childProviderConversationId,
    record.child_provider_conversation_id,
    record.childProviderConversationIds,
    record.child_provider_conversation_ids,
    record.sideConversationId,
    record.side_conversation_id,
    record.sideChatId,
    record.side_chat_id,
    record.threadId,
    record.thread_id,
    record.sessionId,
    record.session_id,
    record.conversationId,
    record.conversation_id,
  );
  const parentId = firstTrimmedString(
    record.parentId,
    record.parent_id,
    record.parentAgentId,
    record.parent_agent_id,
    record.parentSubagentId,
    record.parent_subagent_id,
    record.parentTaskId,
    record.parentTaskID,
    record.parent_task_id,
    record.parentToolUseId,
    record.parent_tool_use_id,
    record.parentProviderThreadId,
    record.parent_provider_thread_id,
    record.parentProviderConversationId,
    record.parent_provider_conversation_id,
    record.parentThreadId,
    record.parent_thread_id,
    record.parentSessionId,
    record.parentSessionID,
    record.parent_session_id,
    record.parentConversationId,
    record.parent_conversation_id,
  );
  const type = firstTrimmedString(
    record.type,
    record.role,
    record.agentRole,
    record.agent_role,
    record.subagentType,
    record.subagent_type,
    record.agentType,
    record.agent_type,
  );
  const name = firstTrimmedString(
    record.name,
    record.displayName,
    record.display_name,
    record.nickname,
    record.agentDisplayName,
    record.agent_display_name,
    record.agentNickname,
    record.agent_nickname,
    record.agentName,
    record.agent_name,
    record.subagentName,
    record.subagent_name,
  );
  const model = firstTrimmedString(record.model, record.modelId, record.model_id);
  const description = firstTrimmedString(record.description, record.summary);
  const prompt = firstTrimmedString(
    record.prompt,
    record.instructions,
    record.instruction,
    record.message,
    record.task,
    record.objective,
    record.request,
    record.query,
  );
  const transcriptPath = firstTrimmedString(
    record.transcriptPath,
    record.transcript_path,
    record.agentTranscriptPath,
    record.agent_transcript_path,
    record.subagentTranscriptPath,
    record.subagent_transcript_path,
  );
  const lastAssistantMessage = firstTrimmedString(
    record.lastAssistantMessage,
    record.last_assistant_message,
    record.finalAssistantMessage,
    record.final_assistant_message,
    record.response,
    record.result,
  );
  return {
    ...(id ? { id } : {}),
    ...(parentId ? { parentId } : {}),
    ...(type ? { type } : {}),
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
  };
}

export function providerAgentLooseRecord(
  record: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }
  const loose: Record<string, unknown> = {};
  for (const key of [
    "agentId",
    "agent_id",
    "subagentId",
    "subagent_id",
    "childProviderThreadId",
    "child_provider_thread_id",
    "childProviderThreadIds",
    "child_provider_thread_ids",
    "childThreadId",
    "child_thread_id",
    "childThreadIds",
    "child_thread_ids",
    "receiverThreadId",
    "receiver_thread_id",
    "receiverThreadIds",
    "receiver_thread_ids",
    "agentThreadId",
    "agent_thread_id",
    "agentThreadIds",
    "agent_thread_ids",
    "providerConversationId",
    "provider_conversation_id",
    "providerSideConversationId",
    "provider_side_conversation_id",
    "providerSideChatId",
    "provider_side_chat_id",
    "childProviderConversationId",
    "child_provider_conversation_id",
    "childProviderConversationIds",
    "child_provider_conversation_ids",
    "sideConversationId",
    "side_conversation_id",
    "sideChatId",
    "side_chat_id",
    "threadId",
    "thread_id",
    "sessionId",
    "session_id",
    "conversationId",
    "conversation_id",
    "parentId",
    "parent_id",
    "parentAgentId",
    "parent_agent_id",
    "parentSubagentId",
    "parent_subagent_id",
    "parentTaskId",
    "parentTaskID",
    "parent_task_id",
    "parentToolUseId",
    "parent_tool_use_id",
    "parentProviderThreadId",
    "parent_provider_thread_id",
    "parentProviderConversationId",
    "parent_provider_conversation_id",
    "parentThreadId",
    "parent_thread_id",
    "parentSessionId",
    "parentSessionID",
    "parent_session_id",
    "parentConversationId",
    "parent_conversation_id",
    "agentRole",
    "agent_role",
    "subagentType",
    "subagent_type",
    "agentType",
    "agent_type",
    "agentDisplayName",
    "agent_display_name",
    "agentNickname",
    "agent_nickname",
    "agentName",
    "agent_name",
    "subagentName",
    "subagent_name",
    "model",
    "modelId",
    "model_id",
    "description",
    "summary",
    "prompt",
    "instructions",
    "instruction",
    "message",
    "task",
    "objective",
    "request",
    "query",
    "transcriptPath",
    "transcript_path",
    "agentTranscriptPath",
    "agent_transcript_path",
    "subagentTranscriptPath",
    "subagent_transcript_path",
    "lastAssistantMessage",
    "last_assistant_message",
    "finalAssistantMessage",
    "final_assistant_message",
  ]) {
    if (record[key] !== undefined) {
      loose[key] = record[key];
    }
  }
  return Object.keys(loose).length > 0 ? loose : undefined;
}

export function mergeProviderAgentMetadata(
  ...records: ReadonlyArray<Record<string, unknown> | null | undefined>
): ProviderAgentMetadata {
  const merged: ProviderAgentMetadata = {};
  for (const record of records) {
    const metadata = providerAgentMetadataFromRecord(record);
    Object.assign(merged, {
      ...(merged.id === undefined && metadata.id ? { id: metadata.id } : {}),
      ...(merged.parentId === undefined && metadata.parentId
        ? { parentId: metadata.parentId }
        : {}),
      ...(merged.type === undefined && metadata.type ? { type: metadata.type } : {}),
      ...(merged.name === undefined && metadata.name ? { name: metadata.name } : {}),
      ...(merged.model === undefined && metadata.model ? { model: metadata.model } : {}),
      ...(merged.description === undefined && metadata.description
        ? { description: metadata.description }
        : {}),
      ...(merged.prompt === undefined && metadata.prompt ? { prompt: metadata.prompt } : {}),
      ...(merged.transcriptPath === undefined && metadata.transcriptPath
        ? { transcriptPath: metadata.transcriptPath }
        : {}),
      ...(merged.lastAssistantMessage === undefined && metadata.lastAssistantMessage
        ? { lastAssistantMessage: metadata.lastAssistantMessage }
        : {}),
    });
  }
  return merged;
}

export function normalizeProviderSideConversationType(value: string | undefined): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/^[./]+/, "")
    .replace(/[_\s]+/g, "-");
  return normalized && normalized.length > 0 ? normalized : null;
}

export function isProviderSideConversationType(value: string | undefined): boolean {
  const normalized = normalizeProviderSideConversationType(value);
  return (
    normalized === "side" ||
    normalized === "side-chat" ||
    normalized === "side-conversation" ||
    normalized === "btw"
  );
}
