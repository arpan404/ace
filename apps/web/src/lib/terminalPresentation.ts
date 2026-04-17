import {
  applyTerminalInputToBuffer,
  deriveTerminalTitleFromCommand,
  extractTerminalOscTitle,
} from "@ace/shared/terminalTitles";
import { DEFAULT_THREAD_TERMINAL_ID } from "../types";
import { normalizePaneRatios, resizePaneRatios } from "./paneRatios";

function stableTerminalLabelSuffix(terminalId: string): string {
  const ordinalMatch = /^terminal-(\d+)$/.exec(terminalId);
  if (ordinalMatch) {
    return String(Math.max(2, Number.parseInt(ordinalMatch[1]!, 10) + 1));
  }
  const normalized = terminalId.replace(/[^a-zA-Z0-9]/g, "");
  return normalized.length > 0 ? normalized.slice(-4).toUpperCase() : "2";
}

export { applyTerminalInputToBuffer, deriveTerminalTitleFromCommand, extractTerminalOscTitle };
export const normalizeTerminalPaneRatios = normalizePaneRatios;
export const resizeTerminalPaneRatios = resizePaneRatios;

export function buildTerminalFallbackTitle(_cwd: string, terminalId: string): string {
  if (terminalId === DEFAULT_THREAD_TERMINAL_ID) {
    return "Terminal 1";
  }
  return `Terminal ${stableTerminalLabelSuffix(terminalId)}`;
}
