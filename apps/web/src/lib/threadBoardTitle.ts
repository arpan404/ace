import type { ThreadId } from "@ace/contracts";

export interface ThreadBoardTitleThread {
  readonly threadId: ThreadId;
  readonly title?: string | null | undefined;
}

function normalizeThreadTitle(title: string | null | undefined): string | null {
  const normalized = title?.trim().replace(/\s+/g, " ");
  return normalized && normalized.length > 0 ? normalized : null;
}

export function buildThreadBoardTitle(input: {
  readonly fallbackIndex: number;
  readonly threads: ReadonlyArray<ThreadBoardTitleThread>;
}): string {
  const titles = input.threads
    .map((thread) => normalizeThreadTitle(thread.title))
    .filter((title): title is string => title !== null);

  if (titles.length === 0) {
    return `Board ${input.fallbackIndex}`;
  }
  if (titles.length === 1) {
    return titles[0]!;
  }
  return `${titles[0]} + ${titles.length - 1}`;
}
