import type { QueuedComposerTerminalContext } from "@ace/contracts";

export const MOBILE_TERMINAL_CONTEXT_MAX_LINES = 80;
const MOBILE_TERMINAL_SYSTEM_LINES = new Set(["--- Terminal session opened ---"]);

interface BuildMobileTerminalContextInput {
  readonly chunks: ReadonlyArray<string>;
  readonly createdAt?: string;
  readonly id?: QueuedComposerTerminalContext["id"];
  readonly maxLines?: number;
  readonly terminalId: string;
  readonly terminalLabel: string;
}

function splitTerminalOutputLines(chunks: ReadonlyArray<string>): string[] {
  return chunks
    .join("")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\r$/u, ""));
}

function isTerminalContextContentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !MOBILE_TERMINAL_SYSTEM_LINES.has(trimmed);
}

export function hasMobileTerminalContextOutput(chunks: ReadonlyArray<string>): boolean {
  return splitTerminalOutputLines(chunks).some(isTerminalContextContentLine);
}

export function buildMobileTerminalContextFromOutput(
  input: BuildMobileTerminalContextInput,
): QueuedComposerTerminalContext | null {
  const allLines = splitTerminalOutputLines(input.chunks);
  const numberedLines = allLines.map((line, index) => ({ line, lineNumber: index + 1 }));
  const contentLines = numberedLines.filter(({ line }) => isTerminalContextContentLine(line));
  if (contentLines.length === 0) {
    return null;
  }

  const maxLines = Math.max(1, Math.floor(input.maxLines ?? MOBILE_TERMINAL_CONTEXT_MAX_LINES));
  const selectedLines = contentLines.slice(-maxLines);
  const firstLine = selectedLines[0]!;
  const lastLine = selectedLines.at(-1)!;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const id =
    input.id ?? (`mobile-terminal-context-${createdAt}` as QueuedComposerTerminalContext["id"]);

  return {
    id,
    createdAt: createdAt as QueuedComposerTerminalContext["createdAt"],
    terminalId: input.terminalId,
    terminalLabel: input.terminalLabel,
    lineStart: firstLine.lineNumber,
    lineEnd: lastLine.lineNumber,
    text: selectedLines.map(({ line }) => line).join("\n"),
  };
}
