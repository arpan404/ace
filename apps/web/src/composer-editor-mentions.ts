import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "./lib/terminalContext";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
    }
  | {
      type: "issue-reference";
      issueNumber: number;
    }
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    };

const MENTION_TOKEN_REGEX = /(^|\s)@([^\s@]+)(?=\s)/g;
export const COMPOSER_ISSUE_REFERENCE_MARKER = "\u2063";
const ISSUE_REFERENCE_TOKEN_REGEX = new RegExp(
  `(^|(?:\\s|,|\\(|\\[|\\{))#(\\d+)${COMPOSER_ISSUE_REFERENCE_MARKER}(?=$|(?:\\s|,|\\.|;|:|!|\\?|\\)|\\]|\\}))`,
  "g",
);

export function createMarkedIssueReferenceToken(issueNumber: number): string {
  return `#${issueNumber}${COMPOSER_ISSUE_REFERENCE_MARKER}`;
}

export function stripIssueReferenceMarkers(text: string): string {
  return text.replaceAll(COMPOSER_ISSUE_REFERENCE_MARKER, "");
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function appendMentionSegments(segments: ComposerPromptSegment[], text: string): void {
  if (!text) {
    return;
  }
  let cursor = 0;
  MENTION_TOKEN_REGEX.lastIndex = 0;
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const path = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const mentionStart = matchIndex + prefix.length;
    const mentionEnd = mentionStart + fullMatch.length - prefix.length;

    if (mentionStart > cursor) {
      pushTextSegment(segments, text.slice(cursor, mentionStart));
    }

    if (path.length > 0) {
      segments.push({ type: "mention", path });
    } else {
      pushTextSegment(segments, text.slice(mentionStart, mentionEnd));
    }

    cursor = mentionEnd;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }
}

function splitPromptTextIntoComposerSegments(text: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  let cursor = 0;
  ISSUE_REFERENCE_TOKEN_REGEX.lastIndex = 0;
  for (const match of text.matchAll(ISSUE_REFERENCE_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const issueNumberText = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const issueStart = matchIndex + prefix.length;
    const issueEnd = issueStart + fullMatch.length - prefix.length;

    if (issueStart > cursor) {
      appendMentionSegments(segments, text.slice(cursor, issueStart));
    }

    const issueNumber = Number.parseInt(issueNumberText, 10);
    if (Number.isInteger(issueNumber) && issueNumber > 0) {
      segments.push({ type: "issue-reference", issueNumber });
    } else {
      appendMentionSegments(segments, text.slice(issueStart, issueEnd));
    }

    cursor = issueEnd;
  }

  if (cursor < text.length) {
    appendMentionSegments(segments, text.slice(cursor));
  }

  return segments;
}

export function extractIssueReferenceNumbers(text: string): number[] {
  if (!text) {
    return [];
  }
  const issueNumbers: number[] = [];
  const seen = new Set<number>();
  ISSUE_REFERENCE_TOKEN_REGEX.lastIndex = 0;
  for (const match of text.matchAll(ISSUE_REFERENCE_TOKEN_REGEX)) {
    const issueNumberText = match[2] ?? "";
    const issueNumber = Number.parseInt(issueNumberText, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || seen.has(issueNumber)) {
      continue;
    }
    seen.add(issueNumber);
    issueNumbers.push(issueNumber);
  }
  return issueNumbers;
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const segments: ComposerPromptSegment[] = [];
  let textCursor = 0;
  let terminalContextIndex = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (index > textCursor) {
      segments.push(...splitPromptTextIntoComposerSegments(prompt.slice(textCursor, index)));
    }
    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextIndex] ?? null,
    });
    terminalContextIndex += 1;
    textCursor = index + 1;
  }

  if (textCursor < prompt.length) {
    segments.push(...splitPromptTextIntoComposerSegments(prompt.slice(textCursor)));
  }

  return segments;
}
