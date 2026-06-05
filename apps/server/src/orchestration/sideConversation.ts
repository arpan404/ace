export function isAceSideConversationThreadId(value: string | undefined): boolean {
  return value?.startsWith("side:") === true;
}
