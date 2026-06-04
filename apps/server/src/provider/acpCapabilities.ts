function isRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isEnabledCapability(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "enabled" || normalized === "supported";
  }
  return isRecord(value) !== null;
}

export function hasAcpSessionForkCapability(initializeResult: unknown): boolean {
  const record = isRecord(initializeResult);
  const agentCapabilities = isRecord(record?.agentCapabilities);
  const rootSessionCapabilities = isRecord(record?.sessionCapabilities);
  const agentSessionCapabilities = isRecord(agentCapabilities?.sessionCapabilities);
  const agentSessions = isRecord(agentCapabilities?.sessions);
  const rootCapabilities = isRecord(record?.capabilities);

  return [
    agentCapabilities?.forkSession,
    agentCapabilities?.sessionFork,
    agentCapabilities?.canForkSession,
    agentSessionCapabilities?.fork,
    agentSessionCapabilities?.forkSession,
    agentSessionCapabilities?.sessionFork,
    agentSessions?.fork,
    rootSessionCapabilities?.fork,
    rootSessionCapabilities?.forkSession,
    rootSessionCapabilities?.sessionFork,
    rootCapabilities?.forkSession,
    rootCapabilities?.sessionFork,
  ].some(isEnabledCapability);
}
