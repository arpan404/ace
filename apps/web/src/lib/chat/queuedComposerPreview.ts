import {
  deriveDisplayedUserMessageState,
  stripInlineTerminalContextPlaceholders,
} from "../terminalContext";

const QUEUED_COMPOSER_PREVIEW_MAX_CHARS = 200;

export function formatQueuedComposerMessagePreview(options: {
  prompt: string;
  imageCount: number;
  terminalContextCount: number;
}): string {
  const truncatePreview = (value: string): string =>
    value.length > QUEUED_COMPOSER_PREVIEW_MAX_CHARS
      ? `${value.slice(0, QUEUED_COMPOSER_PREVIEW_MAX_CHARS - 3).trimEnd()}...`
      : value;
  const visiblePrompt = deriveDisplayedUserMessageState(options.prompt).visibleText;
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(visiblePrompt)
    .replace(/\s+/gu, " ")
    .trim();

  if (trimmedPrompt.length > 0) {
    return truncatePreview(trimmedPrompt);
  }

  const parts: string[] = [];
  if (options.imageCount > 0) {
    parts.push(options.imageCount === 1 ? "1 image" : `${options.imageCount} images`);
  }
  if (options.terminalContextCount > 0) {
    parts.push(
      options.terminalContextCount === 1
        ? "1 terminal context"
        : `${options.terminalContextCount} terminal contexts`,
    );
  }

  return truncatePreview(parts.length > 0 ? parts.join(" · ") : "Queued message");
}
