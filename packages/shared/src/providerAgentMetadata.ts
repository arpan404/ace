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

function firstProviderText(value: unknown, depth = 0): string | undefined {
  if (depth > 12) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => firstProviderText(item, depth + 1))
      .filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join("\n").trim() : undefined;
  }
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return firstProviderText(
    [
      record.text,
      record.outputText,
      record.output_text,
      record.message,
      record.content,
      record.contents,
      record.parts,
      record.response,
      record.result,
      record.output,
    ],
    depth + 1,
  );
}

function firstProviderTextFrom(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    const normalized = firstProviderText(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function providerMessageRole(value: unknown): string | undefined {
  const record = asRecord(value);
  const rawRole = record?.role ?? record?.speaker ?? record?.author ?? record?.type ?? record?.kind;
  return typeof rawRole === "string"
    ? rawRole
        .trim()
        .toLowerCase()
        .replace(/[_\s-]+/g, "-")
    : undefined;
}

function isProviderAssistantRole(value: unknown): boolean {
  const role = providerMessageRole(value);
  return (
    role === "assistant" ||
    role === "agent" ||
    role === "model" ||
    role === "subagent" ||
    role === "sub-agent"
  );
}

function lastProviderAssistantText(value: unknown, depth = 0): string | undefined {
  if (depth > 12) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value.toReversed()) {
      const normalized = lastProviderAssistantText(item, depth + 1);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (isProviderAssistantRole(record)) {
    return firstProviderText(record, depth + 1);
  }
  return lastProviderAssistantText(
    [
      record.messages,
      record.message,
      record.transcript,
      record.conversation,
      record.events,
      record.items,
      record.outputs,
      record.results,
    ],
    depth + 1,
  );
}

function lastProviderAssistantTextFrom(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    const normalized = lastProviderAssistantText(value);
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
    firstRecord(record.agents) ??
    firstRecord(record.teamAgent) ??
    firstRecord(record.team_agent) ??
    firstRecord(record.teamAgents) ??
    firstRecord(record.team_agents) ??
    firstRecord(record.agentTeam) ??
    firstRecord(record.agent_team) ??
    firstRecord(record.agentTeams) ??
    firstRecord(record.agent_teams) ??
    firstRecord(record.fleet) ??
    firstRecord(record.fleets) ??
    firstRecord(record.subtask) ??
    firstRecord(record.subtasks) ??
    firstRecord(record.taskAgent) ??
    firstRecord(record.task_agent) ??
    firstRecord(record.taskAgents) ??
    firstRecord(record.task_agents) ??
    firstRecord(record.task) ??
    firstRecord(record.tasks) ??
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
    ...recordsFrom(record.agents),
    ...recordsFrom(record.teamAgent),
    ...recordsFrom(record.team_agent),
    ...recordsFrom(record.teamAgents),
    ...recordsFrom(record.team_agents),
    ...recordsFrom(record.agentTeam),
    ...recordsFrom(record.agent_team),
    ...recordsFrom(record.agentTeams),
    ...recordsFrom(record.agent_teams),
    ...recordsFrom(record.fleet),
    ...recordsFrom(record.fleets),
    ...recordsFrom(record.subtask),
    ...recordsFrom(record.subtasks),
    ...recordsFrom(record.taskAgent),
    ...recordsFrom(record.task_agent),
    ...recordsFrom(record.taskAgents),
    ...recordsFrom(record.task_agents),
    ...recordsFrom(record.task),
    ...recordsFrom(record.tasks),
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
  const attributes = asRecord(record.attributes) ?? asRecord(record.attribute);
  const id = firstTrimmedString(
    record.id,
    record["gen_ai.agent.id"],
    attributes?.["gen_ai.agent.id"],
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
    record["gen_ai.agent.parent_id"],
    attributes?.["gen_ai.agent.parent_id"],
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
    record["gen_ai.agent.type"],
    attributes?.["gen_ai.agent.type"],
    record["gen_ai.agent.role"],
    attributes?.["gen_ai.agent.role"],
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
    record["gen_ai.agent.name"],
    attributes?.["gen_ai.agent.name"],
    record["gen_ai.agent.nickname"],
    attributes?.["gen_ai.agent.nickname"],
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
  const model = firstTrimmedString(
    record.model,
    record["gen_ai.request.model"],
    attributes?.["gen_ai.request.model"],
    record["gen_ai.response.model"],
    attributes?.["gen_ai.response.model"],
    record.modelId,
    record.model_id,
  );
  const description = firstTrimmedString(
    record.description,
    record["gen_ai.agent.description"],
    attributes?.["gen_ai.agent.description"],
    record.summary,
  );
  const prompt = firstTrimmedString(
    record.prompt,
    record["gen_ai.agent.prompt"],
    attributes?.["gen_ai.agent.prompt"],
    record["gen_ai.agent.instructions"],
    attributes?.["gen_ai.agent.instructions"],
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
    record["gen_ai.agent.transcript_path"],
    attributes?.["gen_ai.agent.transcript_path"],
    record.transcript_path,
    record.agentTranscriptPath,
    record.agent_transcript_path,
    record.subagentTranscriptPath,
    record.subagent_transcript_path,
  );
  const lastAssistantMessage =
    firstProviderTextFrom(
      record.lastAssistantMessage,
      record.last_assistant_message,
      record.finalAssistantMessage,
      record.final_assistant_message,
      record.finalMessage,
      record.final_message,
      record.outputText,
      record.output_text,
      record.content,
      record.response,
      record.result,
      record.output,
    ) ??
    lastProviderAssistantTextFrom(
      record.messages,
      record.transcript,
      record.conversation,
      record.events,
      record.items,
      record.outputs,
      record.results,
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
  const attributes = asRecord(record.attributes) ?? asRecord(record.attribute);
  for (const key of [
    "gen_ai.agent.id",
    "gen_ai.agent.parent_id",
    "gen_ai.agent.type",
    "gen_ai.agent.role",
    "gen_ai.agent.name",
    "gen_ai.agent.nickname",
    "gen_ai.agent.description",
    "gen_ai.agent.prompt",
    "gen_ai.agent.instructions",
    "gen_ai.agent.transcript_path",
    "gen_ai.request.model",
    "gen_ai.response.model",
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
    "finalMessage",
    "final_message",
    "outputText",
    "output_text",
    "content",
    "response",
    "result",
    "output",
    "messages",
    "transcript",
    "conversation",
    "events",
    "items",
    "outputs",
    "results",
  ]) {
    if (record[key] !== undefined) {
      loose[key] = record[key];
    } else if (attributes?.[key] !== undefined) {
      loose[key] = attributes[key];
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
