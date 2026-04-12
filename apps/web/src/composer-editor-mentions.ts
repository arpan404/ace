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
const ISSUE_REFERENCE_TOKEN_REGEX = /(^|[\s,])#(\d+)(?=$|[\s,])/g;

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function splitPromptTextIntoComposerSegments(text: string): ComposerPromptSegment[] {
  const issueCommandMatch = /^\s*\/issues(?:\s+|$)/i.exec(text);
  if (issueCommandMatch) {
    const segments: ComposerPromptSegment[] = [];
    let cursor = 0;
    ISSUE_REFERENCE_TOKEN_REGEX.lastIndex = 0;
    const issueArguments = text.slice(issueCommandMatch[0].length);
    for (const match of issueArguments.matchAll(ISSUE_REFERENCE_TOKEN_REGEX)) {
      const fullMatch = match[0];
      const prefix = match[1] ?? "";
      const issueNumberText = match[2] ?? "";
      const matchIndex = (match.index ?? 0) + issueCommandMatch[0].length;
      const issueStart = matchIndex + prefix.length;
      const issueEnd = issueStart + fullMatch.length - prefix.length;
      if (issueStart > cursor) {
        pushTextSegment(segments, text.slice(cursor, issueStart));
      }
      const issueNumber = Number.parseInt(issueNumberText, 10);
      if (Number.isInteger(issueNumber) && issueNumber > 0) {
        segments.push({ type: "issue-reference", issueNumber });
      } else {
        pushTextSegment(segments, text.slice(issueStart, issueEnd));
      }
      cursor = issueEnd;
    }
    if (cursor < text.length) {
      pushTextSegment(segments, text.slice(cursor));
    }
    if (segments.length > 0) {
      return segments;
    }
  }

  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  let cursor = 0;
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

  return segments;
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
