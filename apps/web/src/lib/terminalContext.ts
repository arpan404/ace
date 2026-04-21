import { type ThreadId } from "@ace/contracts";

import { LRUCache } from "./lruCache";
import { registerMemoryPressureHandler, shouldBypassNonEssentialCaching } from "./memoryPressure";

export interface TerminalContextSelection {
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface TerminalContextDraft extends TerminalContextSelection {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

export interface ExtractedTerminalContexts {
  promptText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
}

export interface DisplayedUserMessageState {
  visibleText: string;
  copyText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
}

export interface ParsedTerminalContextEntry {
  header: string;
  body: string;
}

export interface BrowserDesignSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserDesignElementDescriptor {
  tagName: string | null;
  id: string | null;
  className: string | null;
  selector: string | null;
  textSnippet: string | null;
  htmlSnippet: string | null;
}

export interface BrowserDesignPromptContext {
  requestId: string;
  pageUrl: string;
  pagePath: string;
  selection: BrowserDesignSelectionRect;
  targetElement: BrowserDesignElementDescriptor | null;
  mainContainer: BrowserDesignElementDescriptor | null;
}

interface CompactBrowserDesignPromptContext {
  requestId: string;
  pageUrl: string;
  selection: BrowserDesignSelectionRect;
  targetElement: {
    tagName: string | null;
    id: string | null;
    selector: string | null;
  } | null;
}

export const INLINE_TERMINAL_CONTEXT_PLACEHOLDER = "\uFFFC";

const DISPLAYED_USER_MESSAGE_STATE_CACHE_MAX_ENTRIES = 500;
const DISPLAYED_USER_MESSAGE_STATE_CACHE_MAX_MEMORY_BYTES = 4 * 1024 * 1024;
const displayedUserMessageStateCache = new LRUCache<DisplayedUserMessageState>(
  DISPLAYED_USER_MESSAGE_STATE_CACHE_MAX_ENTRIES,
  DISPLAYED_USER_MESSAGE_STATE_CACHE_MAX_MEMORY_BYTES,
);

registerMemoryPressureHandler({
  id: "displayed-user-message-state-cache",
  minLevel: "high",
  release: () => {
    displayedUserMessageStateCache.clear();
  },
});

const TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN =
  /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/;
const TRAILING_GITHUB_ISSUE_CONTEXT_BLOCK_PATTERN =
  /\n*<github_issue_context>\n([\s\S]*?)\n<\/github_issue_context>\s*$/;
const TRAILING_BROWSER_DESIGN_CONTEXT_BLOCK_PATTERN =
  /\n*<browser_design_context>\n([\s\S]*?)\n<\/browser_design_context>\s*$/;

export function normalizeTerminalContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function hasTerminalContextText(context: { text: string }): boolean {
  return normalizeTerminalContextText(context.text).length > 0;
}

export function isTerminalContextExpired(context: { text: string }): boolean {
  return !hasTerminalContextText(context);
}

export function filterTerminalContextsWithText<T extends { text: string }>(
  contexts: ReadonlyArray<T>,
): T[] {
  return contexts.filter((context) => hasTerminalContextText(context));
}

function previewTerminalContextText(text: string): string {
  const normalized = normalizeTerminalContextText(text);
  if (normalized.length === 0) {
    return "";
  }
  const lines = normalized.split("\n");
  const visibleLines = lines.slice(0, 3);
  if (lines.length > 3) {
    visibleLines.push("...");
  }
  const preview = visibleLines.join("\n");
  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

export function normalizeTerminalContextSelection(
  selection: TerminalContextSelection,
): TerminalContextSelection | null {
  const text = normalizeTerminalContextText(selection.text);
  const terminalId = selection.terminalId.trim();
  const terminalLabel = selection.terminalLabel.trim();
  if (text.length === 0 || terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(selection.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(selection.lineEnd));
  return {
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text,
  };
}

export function formatTerminalContextRange(selection: {
  lineStart: number;
  lineEnd: number;
}): string {
  return selection.lineStart === selection.lineEnd
    ? `line ${selection.lineStart}`
    : `lines ${selection.lineStart}-${selection.lineEnd}`;
}

export function formatTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return `${selection.terminalLabel} ${formatTerminalContextRange(selection)}`;
}

export function formatInlineTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  const terminalLabel = selection.terminalLabel.trim().toLowerCase().replace(/\s+/g, "-");
  const range =
    selection.lineStart === selection.lineEnd
      ? `${selection.lineStart}`
      : `${selection.lineStart}-${selection.lineEnd}`;
  return `@${terminalLabel}:${range}`;
}

export function buildTerminalContextPreviewTitle(
  contexts: ReadonlyArray<TerminalContextSelection>,
): string | null {
  if (contexts.length === 0) {
    return null;
  }
  const previews = contexts
    .map((context) => {
      const normalized = normalizeTerminalContextSelection(context);
      if (!normalized) {
        return null;
      }
      const preview = previewTerminalContextText(normalized.text);
      return preview.length > 0
        ? `${formatTerminalContextLabel(normalized)}\n${preview}`
        : formatTerminalContextLabel(normalized);
    })
    .filter((value): value is string => value !== null)
    .join("\n\n");
  return previews.length > 0 ? previews : null;
}

function buildTerminalContextBodyLines(selection: TerminalContextSelection): string[] {
  return normalizeTerminalContextText(selection.text)
    .split("\n")
    .map((line, index) => `  ${selection.lineStart + index} | ${line}`);
}

export function buildTerminalContextBlock(
  contexts: ReadonlyArray<TerminalContextSelection>,
): string {
  const normalizedContexts = contexts
    .map((context) => normalizeTerminalContextSelection(context))
    .filter((context): context is TerminalContextSelection => context !== null);
  if (normalizedContexts.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (let index = 0; index < normalizedContexts.length; index += 1) {
    const context = normalizedContexts[index]!;
    lines.push(`- ${formatTerminalContextLabel(context)}:`);
    lines.push(...buildTerminalContextBodyLines(context));
    if (index < normalizedContexts.length - 1) {
      lines.push("");
    }
  }
  return ["<terminal_context>", ...lines, "</terminal_context>"].join("\n");
}

export function materializeInlineTerminalContextPrompt(
  prompt: string,
  contexts: ReadonlyArray<{
    terminalLabel: string;
    lineStart: number;
    lineEnd: number;
  }>,
): string {
  let nextContextIndex = 0;
  let result = "";

  for (const char of prompt) {
    if (char !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      result += char;
      continue;
    }
    const context = contexts[nextContextIndex] ?? null;
    nextContextIndex += 1;
    if (!context) {
      continue;
    }
    result += formatInlineTerminalContextLabel(context);
  }

  return result;
}

export function appendTerminalContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<TerminalContextSelection>,
): string {
  const trimmedPrompt = materializeInlineTerminalContextPrompt(prompt, contexts).trim();
  const contextBlock = buildTerminalContextBlock(contexts);
  if (contextBlock.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${contextBlock}` : contextBlock;
}

export function buildBrowserDesignContextBlock(context: BrowserDesignPromptContext): string {
  const compactContext: CompactBrowserDesignPromptContext = {
    requestId: context.requestId,
    pageUrl: context.pageUrl,
    selection: context.selection,
    targetElement: context.targetElement
      ? {
          tagName: context.targetElement.tagName,
          id: context.targetElement.id,
          selector: context.targetElement.selector,
        }
      : null,
  };
  return [
    "<browser_design_context>",
    JSON.stringify(compactContext, null, 2),
    "</browser_design_context>",
  ].join("\n");
}

export function appendBrowserDesignContextToPrompt(
  prompt: string,
  context: BrowserDesignPromptContext,
): string {
  const trimmedPrompt = prompt.trim();
  const contextBlock = buildBrowserDesignContextBlock(context);
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${contextBlock}` : contextBlock;
}

export function extractTrailingTerminalContexts(prompt: string): ExtractedTerminalContexts {
  const match = TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const parsedContexts = parseTerminalContextEntries(match[1] ?? "");
  return {
    promptText,
    contextCount: parsedContexts.length,
    previewTitle:
      parsedContexts.length > 0
        ? parsedContexts
            .map(({ header, body }) => (body.length > 0 ? `${header}\n${body}` : header))
            .join("\n\n")
        : null,
    contexts: parsedContexts,
  };
}

export function extractTrailingGitHubIssueContext(prompt: string): {
  promptText: string;
  context: string | null;
} {
  const match = TRAILING_GITHUB_ISSUE_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      context: null,
    };
  }
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    context: match[1] ?? null,
  };
}

export function extractTrailingBrowserDesignContext(prompt: string): {
  promptText: string;
  context: { requestId: string | null } | null;
} {
  const match = TRAILING_BROWSER_DESIGN_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      context: null,
    };
  }
  const rawContext = match[1] ?? "";
  let requestId: string | null = null;
  try {
    const decoded = JSON.parse(rawContext);
    if (decoded && typeof decoded === "object" && "requestId" in decoded) {
      const value = decoded.requestId;
      if (typeof value === "string" && value.trim().length > 0) {
        requestId = value.trim();
      }
    }
  } catch {
    // Keep requestId null when the hidden context payload is malformed.
  }
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    context: { requestId },
  };
}

function stripTrailingGitHubIssueContexts(prompt: string): string {
  let promptText = prompt;
  while (true) {
    const extracted = extractTrailingGitHubIssueContext(promptText);
    if (extracted.context === null) {
      return promptText;
    }
    promptText = extracted.promptText;
  }
}

function stripTrailingBrowserDesignContexts(prompt: string): string {
  let promptText = prompt;
  while (true) {
    const extracted = extractTrailingBrowserDesignContext(promptText);
    if (extracted.context === null) {
      return promptText;
    }
    promptText = extracted.promptText;
  }
}

function stripTrailingHiddenContextBlocks(prompt: string): string {
  let promptText = prompt;
  while (true) {
    const withoutIssueContexts = stripTrailingGitHubIssueContexts(promptText);
    const withoutBrowserDesignContexts = stripTrailingBrowserDesignContexts(withoutIssueContexts);
    if (withoutBrowserDesignContexts === promptText) {
      return promptText;
    }
    promptText = withoutBrowserDesignContexts;
  }
}

export function extractBrowserDesignRequestId(prompt: string): string | null {
  const withoutIssueContext = stripTrailingGitHubIssueContexts(prompt);
  return extractTrailingBrowserDesignContext(withoutIssueContext).context?.requestId ?? null;
}

export function hasBrowserDesignContext(prompt: string): boolean {
  const withoutIssueContext = stripTrailingGitHubIssueContexts(prompt);
  return extractTrailingBrowserDesignContext(withoutIssueContext).context !== null;
}

export function deriveDisplayedUserMessageState(prompt: string): DisplayedUserMessageState {
  if (!shouldBypassNonEssentialCaching()) {
    const cached = displayedUserMessageStateCache.get(prompt);
    if (cached) {
      return cached;
    }
  }

  const promptWithoutTrailingIssueContext = stripTrailingHiddenContextBlocks(prompt);
  const extractedContexts = extractTrailingTerminalContexts(promptWithoutTrailingIssueContext);
  const visibleText = stripTrailingHiddenContextBlocks(extractedContexts.promptText);
  const displayedState = {
    visibleText,
    copyText: prompt,
    contextCount: extractedContexts.contextCount,
    previewTitle: extractedContexts.previewTitle,
    contexts: extractedContexts.contexts,
  };
  if (!shouldBypassNonEssentialCaching()) {
    displayedUserMessageStateCache.set(
      prompt,
      displayedState,
      Math.max(
        256,
        prompt.length * 2 +
          displayedState.visibleText.length * 2 +
          displayedState.contexts.reduce(
            (total, context) => total + (context.header.length + context.body.length) * 2,
            0,
          ),
      ),
    );
  }
  return displayedState;
}

function parseTerminalContextEntries(block: string): ParsedTerminalContextEntry[] {
  const entries: ParsedTerminalContextEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;

  const commitCurrent = () => {
    if (!current) {
      return;
    }
    entries.push({
      header: current.header,
      body: current.bodyLines.join("\n").trimEnd(),
    });
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      current = {
        header: headerMatch[1]!,
        bodyLines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (rawLine.startsWith("  ")) {
      current.bodyLines.push(rawLine.slice(2));
      continue;
    }
    if (rawLine.length === 0) {
      current.bodyLines.push("");
    }
  }

  commitCurrent();
  return entries;
}

export function countInlineTerminalContextPlaceholders(prompt: string): number {
  let count = 0;
  for (const char of prompt) {
    if (char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      count += 1;
    }
  }
  return count;
}

export function ensureInlineTerminalContextPlaceholders(
  prompt: string,
  terminalContextCount: number,
): string {
  const missingCount = terminalContextCount - countInlineTerminalContextPlaceholders(prompt);
  if (missingCount <= 0) {
    return prompt;
  }
  return `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER.repeat(missingCount)}${prompt}`;
}

function isInlineTerminalContextBoundaryWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\n" || char === "\t" || char === "\r";
}

export function insertInlineTerminalContextPlaceholder(
  prompt: string,
  cursorInput: number,
): { prompt: string; cursor: number; contextIndex: number } {
  const cursor = Math.max(0, Math.min(prompt.length, Math.floor(cursorInput)));
  const needsLeadingSpace = !isInlineTerminalContextBoundaryWhitespace(prompt[cursor - 1]);
  const replacement = `${needsLeadingSpace ? " " : ""}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} `;
  const rangeEnd = prompt[cursor] === " " ? cursor + 1 : cursor;
  return {
    prompt: `${prompt.slice(0, cursor)}${replacement}${prompt.slice(rangeEnd)}`,
    cursor: cursor + replacement.length,
    contextIndex: countInlineTerminalContextPlaceholders(prompt.slice(0, cursor)),
  };
}

export function stripInlineTerminalContextPlaceholders(prompt: string): string {
  return prompt.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, "");
}

export function removeInlineTerminalContextPlaceholder(
  prompt: string,
  contextIndex: number,
): { prompt: string; cursor: number } {
  if (contextIndex < 0) {
    return { prompt, cursor: prompt.length };
  }

  let placeholderIndex = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }
    if (placeholderIndex === contextIndex) {
      return {
        prompt: prompt.slice(0, index) + prompt.slice(index + 1),
        cursor: index,
      };
    }
    placeholderIndex += 1;
  }

  return { prompt, cursor: prompt.length };
}

export function syncTerminalContextsByIds(
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
}

export function terminalContextIdListsEqual(
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean {
  return (
    contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index])
  );
}
