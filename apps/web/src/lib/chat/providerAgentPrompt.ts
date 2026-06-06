export function buildProviderAgentComposerPrompt(input: {
  readonly currentPrompt: string;
  readonly invocationPrompt: string;
}): string {
  const invocation = input.invocationPrompt.trim();
  const current = input.currentPrompt.trim();
  if (!invocation) {
    return input.currentPrompt;
  }
  if (!current) {
    return `${invocation} `;
  }
  const normalizedCurrent = current.toLowerCase();
  const normalizedInvocation = invocation.toLowerCase();
  if (
    normalizedCurrent === normalizedInvocation ||
    normalizedCurrent.startsWith(`${normalizedInvocation} `)
  ) {
    return current;
  }
  return `${invocation} ${current}`;
}
