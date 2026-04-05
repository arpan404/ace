import {
  applyTerminalInputToBuffer,
  deriveTerminalTitleFromCommand,
  extractTerminalOscTitle,
} from "@t3tools/shared/terminalTitles";
import { DEFAULT_THREAD_TERMINAL_ID } from "../types";
import { normalizePaneRatios, resizePaneRatios } from "./paneRatios";

function basename(pathValue: string): string {
  const normalized = pathValue.trim().replace(/[\\/]+$/, "");
  if (normalized.length === 0) return "";
  const segments = normalized.split(/[\\/]+/);
  return segments[segments.length - 1] ?? "";
}

export { applyTerminalInputToBuffer, deriveTerminalTitleFromCommand, extractTerminalOscTitle };
export const normalizeTerminalPaneRatios = normalizePaneRatios;
export const resizeTerminalPaneRatios = resizePaneRatios;

export function buildTerminalFallbackTitle(cwd: string, terminalId: string): string {
  const cwdName = basename(cwd);
  if (terminalId === DEFAULT_THREAD_TERMINAL_ID) {
    return cwdName || "workspace";
  }
  return cwdName ? `${cwdName} shell` : "shell";
}
