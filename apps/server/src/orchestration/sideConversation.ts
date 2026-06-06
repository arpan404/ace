export function isAceSideConversationThreadId(
  value: string | undefined,
  parentThreadId?: string | undefined,
): boolean {
  if (!value?.startsWith("side:")) {
    return false;
  }
  if (!parentThreadId) {
    return /^side:[^:]+:.+/.test(value);
  }
  return value.startsWith(`side:${parentThreadId}:`);
}
