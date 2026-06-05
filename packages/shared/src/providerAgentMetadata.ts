export type ProviderAgentMetadata = {
  readonly id?: string;
  readonly type?: string;
  readonly name?: string;
  readonly model?: string;
  readonly description?: string;
  readonly prompt?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstTrimmedString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
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
    asRecord(record.subagent) ??
    asRecord(record.agent) ??
    asRecord(record.assignedAgent) ??
    asRecord(record.assigned_agent) ??
    asRecord(record.delegatedAgent) ??
    asRecord(record.delegated_agent) ??
    asRecord(record.delegate) ??
    asRecord(record.assignee) ??
    asRecord(record.worker)
  );
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
    record.subagentId,
    record.subagent_id,
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
  const description = firstTrimmedString(record.description);
  const prompt = firstTrimmedString(record.prompt);
  return {
    ...(id ? { id } : {}),
    ...(type ? { type } : {}),
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
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
    "prompt",
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
      ...(merged.type === undefined && metadata.type ? { type: metadata.type } : {}),
      ...(merged.name === undefined && metadata.name ? { name: metadata.name } : {}),
      ...(merged.model === undefined && metadata.model ? { model: metadata.model } : {}),
      ...(merged.description === undefined && metadata.description
        ? { description: metadata.description }
        : {}),
      ...(merged.prompt === undefined && metadata.prompt ? { prompt: metadata.prompt } : {}),
    });
  }
  return merged;
}
