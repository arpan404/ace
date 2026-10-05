import type { Command, ProviderKind, ThreadId } from "@ace/protocol";

export type ProviderThread = {
  provider: ProviderKind;
  instanceId?: string | undefined;
  parentThreadId?: ThreadId | undefined;
};
export type ProviderAdmissionFacts = {
  thread(id: ThreadId): ProviderThread | undefined;
  defaultInstance(provider: ProviderKind): string | undefined;
  enabled(provider: ProviderKind, instance?: string): boolean;
};

/** Pure enablement policy shared by real and fake command admission. */
export function providerCommandDisabled(
  payload: Command["payload"],
  facts: ProviderAdmissionFacts,
): boolean {
  switch (payload.type) {
    case "thread.create":
    case "thread.prepare":
    case "thread.send":
    case "thread.fork":
    case "thread.switch":
    case "thread.resume":
    case "queue.resume":
    case "thread.merge":
    case "thread.model.set":
    case "thread.mode.set":
      break;
    default:
      return false;
  }
  const thread =
    "threadId" in payload && payload.threadId ? facts.thread(payload.threadId) : undefined;
  const selection = "selection" in payload ? payload.selection : undefined;
  const provider =
    "provider" in payload ? payload.provider : (selection?.provider ?? thread?.provider);
  const instance =
    ("instanceId" in payload ? payload.instanceId : undefined) ??
    ("accountId" in payload ? payload.accountId : undefined) ??
    ("account" in payload ? payload.account : undefined) ??
    selection?.instanceId ??
    (provider === thread?.provider ? thread?.instanceId : undefined) ??
    (provider ? facts.defaultInstance(provider) : undefined);
  if (provider && !facts.enabled(provider, instance)) return true;
  // Both the contributing fork and the parent receiving context/patches must be enabled.
  if (payload.type === "thread.merge" && thread?.parentThreadId) {
    const destination = facts.thread(thread.parentThreadId);
    if (
      destination &&
      !facts.enabled(
        destination.provider,
        destination.instanceId ?? facts.defaultInstance(destination.provider),
      )
    )
      return true;
  }
  return false;
}
