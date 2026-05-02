import type { ThreadId } from "@ace/contracts";

export interface ThreadBoardTitleThread {
  readonly threadId: ThreadId;
  readonly title?: string | null | undefined;
}

const LEGACY_INDEXED_BOARD_TITLE_PATTERN = /^Board (\d+)$/;
const FALLBACK_SPLIT_TITLE_PATTERN = /^Split (\d+)$/;
const ANCHORED_SPLIT_TITLE_PATTERN = /^(.+)\s\+\s(\d+)$/;

function normalizeThreadTitle(title: string | null | undefined): string | null {
  const normalized = title?.trim().replace(/\s+/g, " ");
  return normalized && normalized.length > 0 ? normalized : null;
}

export function buildFallbackSplitTitle(index: number): string {
  return `Split ${index}`;
}

export function buildAnchoredSplitTitle(
  anchorTitle: string | null | undefined,
  paneCount: number,
): string {
  const normalizedAnchorTitle = normalizeThreadTitle(anchorTitle);
  if (!normalizedAnchorTitle) {
    return paneCount > 0 ? buildFallbackSplitTitle(paneCount) : "Untitled split";
  }
  if (paneCount <= 1) {
    return normalizedAnchorTitle;
  }
  return `${normalizedAnchorTitle} + ${paneCount - 1}`;
}

export function isLikelyAutoSplitTitle(title: string | null | undefined): boolean {
  const normalized = normalizeThreadTitle(title);
  if (!normalized) {
    return true;
  }
  return (
    normalized === "Untitled split" ||
    normalized === "Previous split" ||
    normalized === "Untitled board" ||
    normalized === "Previous board" ||
    FALLBACK_SPLIT_TITLE_PATTERN.test(normalized) ||
    LEGACY_INDEXED_BOARD_TITLE_PATTERN.test(normalized) ||
    ANCHORED_SPLIT_TITLE_PATTERN.test(normalized)
  );
}

export function normalizeSplitTitle(title: string | null | undefined): string {
  const normalized = normalizeThreadTitle(title);
  if (!normalized) {
    return "Untitled split";
  }
  if (normalized === "Untitled board") {
    return "Untitled split";
  }
  if (normalized === "Previous board") {
    return "Previous split";
  }
  const legacyMatch = LEGACY_INDEXED_BOARD_TITLE_PATTERN.exec(normalized);
  if (legacyMatch) {
    return buildFallbackSplitTitle(Number(legacyMatch[1]));
  }
  return normalized;
}

export function buildThreadBoardTitle(input: {
  readonly fallbackIndex: number;
  readonly threads: ReadonlyArray<ThreadBoardTitleThread>;
}): string {
  const titles = input.threads
    .map((thread) => normalizeThreadTitle(thread.title))
    .filter((title): title is string => title !== null);

  if (titles.length === 0) {
    return buildFallbackSplitTitle(input.fallbackIndex);
  }
  if (titles.length === 1) {
    return titles[0]!;
  }
  return `${titles[0]} + ${titles.length - 1}`;
}
