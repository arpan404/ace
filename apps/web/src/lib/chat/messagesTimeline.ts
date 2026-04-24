export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let latestUserMessageCreatedAt: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      latestUserMessageCreatedAt = message.createdAt;
    }
    result.set(message.id, latestUserMessageCreatedAt ?? message.createdAt);
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}
