export type OrchestrationMessageTextMode = "append" | "replace" | "complete";

export function resolveOrchestrationMessageText(input: {
  readonly previousText: string;
  readonly incomingText: string;
  readonly textMode: OrchestrationMessageTextMode;
}): string {
  switch (input.textMode) {
    case "append":
      return `${input.previousText}${input.incomingText}`;
    case "complete":
      return input.incomingText.length > 0 ? input.incomingText : input.previousText;
    case "replace":
      return input.incomingText;
  }
}

export function inferOrchestrationMessageTextMode(input: {
  readonly streaming: boolean;
  readonly textMode?: OrchestrationMessageTextMode | undefined;
}): OrchestrationMessageTextMode {
  return input.textMode ?? (input.streaming ? "append" : "complete");
}
