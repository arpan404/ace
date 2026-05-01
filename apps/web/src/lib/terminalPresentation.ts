import {
  applyTerminalInputToBuffer,
  deriveTerminalTitleFromCommand,
  extractTerminalOscTitle,
} from "@ace/shared/terminalTitles";
import { normalizePaneRatios, resizePaneRatios } from "./paneRatios";

function normalizeTerminalTitleText(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const normalized = title.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, 80) : null;
}

export { applyTerminalInputToBuffer, deriveTerminalTitleFromCommand, extractTerminalOscTitle };
export const normalizeTerminalPaneRatios = normalizePaneRatios;
export const resizeTerminalPaneRatios = resizePaneRatios;

export function buildTerminalFallbackTitle(_cwd: string, terminalId: string): string {
  void terminalId;
  return "Terminal";
}

export function normalizeTerminalDisplayTitle(title: string | null | undefined): string | null {
  const normalized = normalizeTerminalTitleText(title);
  if (!normalized) return null;
  if (/\bshell$/i.test(normalized)) return null;
  if (/^[\w.-]+:[\w.-]+$/.test(normalized)) return null;
  return deriveTerminalTitleFromCommand(normalized);
}

export function resolveTerminalDisplayTitle(input: {
  readonly autoTitle: string | null | undefined;
  readonly cwd: string;
  readonly isRunning: boolean;
  readonly terminalId: string;
}): string {
  const runningTitle = input.isRunning ? normalizeTerminalDisplayTitle(input.autoTitle) : null;
  return runningTitle ?? buildTerminalFallbackTitle(input.cwd, input.terminalId);
}
