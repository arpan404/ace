import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FitAddon } from "@xterm/addon-fit";
import { IconTerminal } from "@tabler/icons-react";
import { PlusIcon, XIcon } from "lucide-react";
import { type ThreadId } from "@ace/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  type MutableRefObject,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useEffectEvent } from "~/hooks/useEffectEvent";
import { useTabStripOverflow } from "~/hooks/useTabStripOverflow";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  applyTerminalInputToBuffer,
  deriveTerminalTitleFromCommand,
  resizeTerminalPaneRatios,
  resolveTerminalDisplayTitle,
} from "~/lib/terminalPresentation";
import { openInPreferredEditor } from "../editorPreferences";
import {
  extractTerminalLinks,
  resolvePathLinkTarget,
  type TerminalLinkMatch,
} from "../terminal-links";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  type ThreadTerminalGroup,
} from "../types";
import { readNativeApi } from "~/nativeApi";
import { reportBackgroundError, runAsyncTask } from "~/lib/async";
import { SIDEBAR_RESIZE_END_EVENT, isLayoutResizeInProgress } from "~/lib/desktopChrome";
import { normalizeTerminalGroups, normalizeTerminalIdList } from "~/lib/terminalStateNormalization";
import { cn } from "~/lib/utils";
import {
  resolveTerminalGroupPaneRatios,
  resolveTerminalSelectionActionPosition,
  resolveTerminalTabDropTarget,
  shouldHandleTerminalSelectionMouseUp,
  terminalFitSignature,
  terminalSelectionActionDelayForClickCount,
} from "./threadTerminalDrawerLogic";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MIN_TERMINAL_PANE_WIDTH = 220;
const TERMINAL_FONT_LOAD_TIMEOUT_MS = 140;
const TERMINAL_LINK_LINE_CACHE_LIMIT = 512;
const TERMINAL_WRITE_CHUNK_SIZE = 64 * 1024;
const TERMINAL_RESIZE_SETTLE_DELAY_MS = 80;

function stableRuntimeEnvKey(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  const entries = Object.entries(runtimeEnv).toSorted(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return JSON.stringify(entries);
}

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  writeTerminalData(terminal, `\r\n[terminal] ${message}\r\n`);
}

function writeTerminalData(terminal: Terminal, data: string): void {
  if (data.length <= TERMINAL_WRITE_CHUNK_SIZE) {
    terminal.write(data);
    return;
  }
  for (let index = 0; index < data.length; index += TERMINAL_WRITE_CHUNK_SIZE) {
    terminal.write(data.slice(index, index + TERMINAL_WRITE_CHUNK_SIZE));
  }
}

function refreshTerminalRows(terminal: Terminal): void {
  if (terminal.rows <= 0) return;
  terminal.refresh(0, terminal.rows - 1);
}

function isTransientTerminalTransportError(error: unknown): boolean {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("socketcloseerror") ||
    message.includes("socket closed") ||
    message.includes("websocket") ||
    message.includes("1006") ||
    message.includes("connection reset")
  );
}

const DEFAULT_TERMINAL_FONT_FAMILY =
  '"JetBrainsMono Nerd Font", "JetBrainsMono Nerd Font Mono", "JetBrains Mono", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

const LIGHT_TERMINAL_THEME = {
  background: "rgb(241, 236, 228)",
  foreground: "rgb(29, 35, 42)",
  cursor: "rgb(47, 84, 136)",
  selectionBackground: "rgba(63, 97, 150, 0.18)",
  scrollbarSliderBackground: "rgba(22, 28, 36, 0.18)",
  scrollbarSliderHoverBackground: "rgba(22, 28, 36, 0.28)",
  scrollbarSliderActiveBackground: "rgba(22, 28, 36, 0.36)",
  black: "rgb(52, 60, 72)",
  red: "rgb(165, 60, 79)",
  green: "rgb(59, 112, 79)",
  yellow: "rgb(145, 106, 33)",
  blue: "rgb(53, 96, 158)",
  magenta: "rgb(120, 78, 144)",
  cyan: "rgb(46, 114, 128)",
  white: "rgb(195, 200, 208)",
  brightBlack: "rgb(116, 125, 138)",
  brightRed: "rgb(192, 83, 104)",
  brightGreen: "rgb(82, 136, 101)",
  brightYellow: "rgb(170, 127, 48)",
  brightBlue: "rgb(75, 120, 188)",
  brightMagenta: "rgb(143, 104, 168)",
  brightCyan: "rgb(67, 139, 153)",
  brightWhite: "rgb(233, 237, 241)",
} satisfies ITheme;

const DARK_TERMINAL_THEME = {
  background: "rgb(12, 14, 17)",
  foreground: "rgb(224, 229, 236)",
  cursor: "rgb(139, 190, 255)",
  selectionBackground: "rgba(116, 166, 245, 0.24)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.12)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.24)",
  black: "rgb(35, 41, 49)",
  red: "rgb(220, 96, 120)",
  green: "rgb(132, 191, 99)",
  yellow: "rgb(198, 162, 70)",
  blue: "rgb(92, 147, 219)",
  magenta: "rgb(177, 128, 223)",
  cyan: "rgb(78, 177, 188)",
  white: "rgb(190, 199, 211)",
  brightBlack: "rgb(102, 113, 128)",
  brightRed: "rgb(240, 126, 148)",
  brightGreen: "rgb(160, 214, 122)",
  brightYellow: "rgb(224, 186, 92)",
  brightBlue: "rgb(120, 176, 242)",
  brightMagenta: "rgb(204, 156, 239)",
  brightCyan: "rgb(111, 209, 219)",
  brightWhite: "rgb(238, 242, 247)",
} satisfies ITheme;

function readTerminalFontFamily(): string {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_FONT_FAMILY;
  const configuredFont = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return configuredFont.length > 0 ? configuredFont : DEFAULT_TERMINAL_FONT_FAMILY;
}

async function waitForTerminalFontReady(fontFamily: string, fontSize: number): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  const fontSet = document.fonts;
  const fontCandidates: string[] = [];
  for (const font of fontFamily.split(",")) {
    const normalizedFont = font.trim().replace(/^['"]|['"]$/g, "");
    if (normalizedFont.length > 0 && normalizedFont.toLowerCase() !== "monospace") {
      fontCandidates.push(normalizedFont);
    }
  }
  const resolvedFont =
    fontCandidates.find((candidate) => fontSet.check(`${fontSize}px "${candidate}"`)) ??
    fontCandidates[0];
  if (!resolvedFont) return;
  const fontLoadPromise = fontSet.load(`${fontSize}px "${resolvedFont}"`).catch((error) => {
    reportBackgroundError("Failed to load the terminal font.", error);
  });
  await Promise.race([
    fontLoadPromise,
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, TERMINAL_FONT_LOAD_TIMEOUT_MS);
    }),
  ]);
}

function readTerminalThemeToken(
  styles: CSSStyleDeclaration,
  propertyName: string,
  fallback: string,
): string {
  const value = styles.getPropertyValue(propertyName).trim();
  return value.length > 0 ? value : fallback;
}

function terminalThemeFromElement(element: HTMLElement | null): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackTheme = isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
  const styles = getComputedStyle(element ?? document.documentElement);
  return {
    background: readTerminalThemeToken(styles, "--terminal-surface", fallbackTheme.background),
    foreground: readTerminalThemeToken(styles, "--terminal-foreground", fallbackTheme.foreground),
    cursor: readTerminalThemeToken(styles, "--terminal-cursor", fallbackTheme.cursor),
    selectionBackground: readTerminalThemeToken(
      styles,
      "--terminal-selection-background",
      fallbackTheme.selectionBackground,
    ),
    scrollbarSliderBackground: readTerminalThemeToken(
      styles,
      "--terminal-scrollbar-slider",
      fallbackTheme.scrollbarSliderBackground,
    ),
    scrollbarSliderHoverBackground: readTerminalThemeToken(
      styles,
      "--terminal-scrollbar-slider-hover",
      fallbackTheme.scrollbarSliderHoverBackground,
    ),
    scrollbarSliderActiveBackground: readTerminalThemeToken(
      styles,
      "--terminal-scrollbar-slider-active",
      fallbackTheme.scrollbarSliderActiveBackground,
    ),
    black: readTerminalThemeToken(styles, "--terminal-ansi-black", fallbackTheme.black),
    red: readTerminalThemeToken(styles, "--terminal-ansi-red", fallbackTheme.red),
    green: readTerminalThemeToken(styles, "--terminal-ansi-green", fallbackTheme.green),
    yellow: readTerminalThemeToken(styles, "--terminal-ansi-yellow", fallbackTheme.yellow),
    blue: readTerminalThemeToken(styles, "--terminal-ansi-blue", fallbackTheme.blue),
    magenta: readTerminalThemeToken(styles, "--terminal-ansi-magenta", fallbackTheme.magenta),
    cyan: readTerminalThemeToken(styles, "--terminal-ansi-cyan", fallbackTheme.cyan),
    white: readTerminalThemeToken(styles, "--terminal-ansi-white", fallbackTheme.white),
    brightBlack: readTerminalThemeToken(
      styles,
      "--terminal-ansi-bright-black",
      fallbackTheme.brightBlack,
    ),
    brightRed: readTerminalThemeToken(
      styles,
      "--terminal-ansi-bright-red",
      fallbackTheme.brightRed,
    ),
    brightGreen: readTerminalThemeToken(
      styles,
      "--terminal-ansi-bright-green",
      fallbackTheme.brightGreen,
    ),
    brightYellow: readTerminalThemeToken(
      styles,
      "--terminal-ansi-bright-yellow",
      fallbackTheme.brightYellow,
    ),
    brightBlue: readTerminalThemeToken(
      styles,
      "--terminal-ansi-bright-blue",
      fallbackTheme.brightBlue,
    ),
    brightMagenta: readTerminalThemeToken(
      styles,
      "--terminal-ansi-bright-magenta",
      fallbackTheme.brightMagenta,
    ),
    brightCyan: readTerminalThemeToken(
      styles,
      "--terminal-ansi-bright-cyan",
      fallbackTheme.brightCyan,
    ),
    brightWhite: readTerminalThemeToken(
      styles,
      "--terminal-ansi-bright-white",
      fallbackTheme.brightWhite,
    ),
  };
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  interactive: boolean;
  onSessionExited: (terminalId: string) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onAutoTerminalTitleChange: (terminalId: string, title: string | null) => void;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void | Promise<void>) | null;
  focusRequestId: number;
  shouldFocusTerminal: boolean;
  drawerHeight: number;
}

function useTerminalViewportComponent({
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  runtimeEnv,
  interactive,
  onSessionExited,
  onAddTerminalContext,
  onAutoTerminalTitleChange,
  onOpenBrowserUrl = null,
  onOpenFilePath = null,
  focusRequestId,
  shouldFocusTerminal,
  drawerHeight,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onSessionExitedRef = useRef(onSessionExited);
  const onAddTerminalContextRef = useRef(onAddTerminalContext);
  const onAutoTerminalTitleChangeRef = useRef(onAutoTerminalTitleChange);
  const onOpenBrowserUrlRef = useRef(onOpenBrowserUrl);
  const onOpenFilePathRef = useRef(onOpenFilePath);
  const interactiveRef = useRef(interactive);
  const shouldFocusTerminalRef = useRef(shouldFocusTerminal);
  const runtimeEnvRef = useRef(runtimeEnv);
  const runtimeEnvKey = stableRuntimeEnvKey(runtimeEnv);
  const terminalLabelRef = useRef(terminalLabel);
  const hasHandledExitRef = useRef(false);
  const commandBufferRef = useRef("");
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const handledFocusRequestIdRef = useRef(0);

  useEffect(() => {
    onSessionExitedRef.current = onSessionExited;
  }, [onSessionExited]);

  useEffect(() => {
    onAddTerminalContextRef.current = onAddTerminalContext;
  }, [onAddTerminalContext]);

  useEffect(() => {
    onAutoTerminalTitleChangeRef.current = onAutoTerminalTitleChange;
  }, [onAutoTerminalTitleChange]);

  useEffect(() => {
    onOpenBrowserUrlRef.current = onOpenBrowserUrl;
  }, [onOpenBrowserUrl]);

  useEffect(() => {
    onOpenFilePathRef.current = onOpenFilePath;
  }, [onOpenFilePath]);

  useEffect(() => {
    interactiveRef.current = interactive;
  }, [interactive]);

  useEffect(() => {
    shouldFocusTerminalRef.current = shouldFocusTerminal;
  }, [shouldFocusTerminal]);

  useEffect(() => {
    runtimeEnvRef.current = runtimeEnv;
  }, [runtimeEnv, runtimeEnvKey]);

  useEffect(() => {
    terminalLabelRef.current = terminalLabel;
  }, [terminalLabel]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;
    const mountInteractive = interactiveRef.current;
    const mountShouldFocusTerminal = shouldFocusTerminalRef.current;

    const fitAddon = new FitAddon();
    const fontFamily = readTerminalFontFamily();
    const terminal = new Terminal({
      cursorBlink: mountInteractive,
      lineHeight: 1.16,
      fontSize: 13,
      letterSpacing: 0.2,
      scrollback: 5_000,
      fontFamily,
      theme: terminalThemeFromElement(mount),
    });
    terminal.loadAddon(fitAddon);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const api = readNativeApi();
    if (!api) return;
    let resizeFrame: number | null = null;
    let resizeSettleTimer: number | null = null;
    let lastAppliedFitSignature: `${number}x${number}:${number}x${number}` | null = null;
    let pendingNativeWindowResizeFit = false;
    let pendingTerminalOutput = "";
    let pendingTerminalOutputFrame: number | null = null;
    let selectionActionTimer: number | null = null;

    const fitToViewport = (options: { force?: boolean; syncPty?: boolean } = {}) => {
      const { force = false, syncPty = true } = options;
      pendingNativeWindowResizeFit = false;
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !activeFitAddon || !mountElement) return;
      const nextWidth = mountElement.clientWidth;
      const nextHeight = mountElement.clientHeight;
      if (nextWidth <= 0 || nextHeight <= 0) return;
      const proposedDimensions = activeFitAddon.proposeDimensions();
      if (
        !proposedDimensions ||
        !Number.isFinite(proposedDimensions.cols) ||
        !Number.isFinite(proposedDimensions.rows)
      ) {
        return;
      }
      const nextFitSignature = terminalFitSignature({
        width: nextWidth,
        height: nextHeight,
        cols: proposedDimensions.cols,
        rows: proposedDimensions.rows,
      });
      if (!force && nextFitSignature === lastAppliedFitSignature) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      refreshTerminalRows(activeTerminal);
      lastAppliedFitSignature = terminalFitSignature({
        width: nextWidth,
        height: nextHeight,
        cols: activeTerminal.cols,
        rows: activeTerminal.rows,
      });
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      if (!syncPty) return;
      runAsyncTask(
        api.terminal.resize({
          threadId,
          terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        }),
        "Failed to resize the terminal after viewport changes.",
      );
    };

    const scheduleFitToViewport = (options: { force?: boolean; syncPty?: boolean } = {}) => {
      if (isLayoutResizeInProgress()) {
        pendingNativeWindowResizeFit = true;
        return;
      }
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        fitToViewport(options);
      });
    };

    const scheduleSettledFitToViewport = () => {
      if (resizeSettleTimer !== null) {
        window.clearTimeout(resizeSettleTimer);
      }
      resizeSettleTimer = window.setTimeout(() => {
        resizeSettleTimer = null;
        lastAppliedFitSignature = null;
        scheduleFitToViewport({ force: true });
      }, TERMINAL_RESIZE_SETTLE_DELAY_MS);
    };

    const flushPendingTerminalOutput = () => {
      if (pendingTerminalOutput.length === 0) return;

      const output = pendingTerminalOutput;
      pendingTerminalOutput = "";
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      writeTerminalData(activeTerminal, output);
    };

    const schedulePendingTerminalOutputFlush = () => {
      if (pendingTerminalOutputFrame !== null) return;

      pendingTerminalOutputFrame = window.requestAnimationFrame(() => {
        pendingTerminalOutputFrame = null;
        flushPendingTerminalOutput();
      });
    };

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimer !== null) {
        window.clearTimeout(selectionActionTimer);
        selectionActionTimer = null;
      }
    };
    const terminalLinkMatchCache = new Map<
      number,
      { lineText: string; matches: readonly TerminalLinkMatch[] }
    >();
    const readCachedTerminalLinkMatches = (
      bufferLineNumber: number,
      lineText: string,
    ): readonly TerminalLinkMatch[] => {
      const cached = terminalLinkMatchCache.get(bufferLineNumber);
      if (cached && cached.lineText === lineText) {
        return cached.matches;
      }

      const matches = extractTerminalLinks(lineText);
      terminalLinkMatchCache.set(bufferLineNumber, { lineText, matches });
      if (terminalLinkMatchCache.size > TERMINAL_LINK_LINE_CACHE_LIMIT) {
        const oldestLineNumber = terminalLinkMatchCache.keys().next().value;
        if (typeof oldestLineNumber === "number") {
          terminalLinkMatchCache.delete(oldestLineNumber);
        }
      }
      return matches;
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: terminalLabelRef.current,
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await api.contextMenu.show(
          [{ id: "add-to-chat", label: "Add to chat" }],
          nextAction.position,
        );
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        onAddTerminalContextRef.current(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } catch (error) {
        selectionActionOpenRef.current = false;
        throw error;
      }
      selectionActionOpenRef.current = false;
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        if (isTransientTerminalTransportError(error)) {
          return;
        }
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to send terminal shortcut");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const line = activeTerminal.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }

        const lineText = line.translateToString(true);
        const matches = readCachedTerminalLinkMatches(bufferLineNumber, lineText);
        if (matches.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          matches.map((match) => ({
            text: match.text,
            range: {
              start: { x: match.start + 1, y: bufferLineNumber },
              end: { x: match.end, y: bufferLineNumber },
            },
            activate: (event: MouseEvent) => {
              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                const openBrowserUrl = onOpenBrowserUrlRef.current;
                if (!event.metaKey && !event.ctrlKey && openBrowserUrl) {
                  openBrowserUrl(match.text);
                  return;
                }
                void api.shell.openExternal(match.text).catch((error) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              const openFilePath = onOpenFilePathRef.current;
              if (!event.metaKey && !event.ctrlKey && openFilePath) {
                void openFilePath(target);
                return;
              }
              void (async () => {
                try {
                  const pathInfo = await api.shell.pathInfo(target);
                  if (pathInfo.kind === "directory") {
                    await api.shell.revealInFileManager(target);
                    return;
                  }
                } catch (error) {
                  console.warn("Failed to inspect terminal path before opening editor.", error);
                }
                await openInPreferredEditor(api, target);
              })().catch((error) => {
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              });
            },
          })),
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      const nextInputState = applyTerminalInputToBuffer(commandBufferRef.current, data);
      commandBufferRef.current = nextInputState.buffer;
      if (nextInputState.submittedCommand) {
        onAutoTerminalTitleChangeRef.current(
          terminalId,
          deriveTerminalTitleFromCommand(nextInputState.submittedCommand),
        );
      }
      void api.terminal.write({ threadId, terminalId, data }).catch((err) => {
        if (isTransientTerminalTransportError(err)) {
          return;
        }
        writeSystemMessage(terminal, err instanceof Error ? err.message : "Terminal write failed");
      });
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimer = window.setTimeout(() => {
        selectionActionTimer = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromElement(containerRef.current);
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme-preset"],
    });

    const openTerminal = async () => {
      try {
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        await waitForTerminalFontReady(fontFamily, activeTerminal.options.fontSize ?? 13);
        if (disposed || !containerRef.current || containerRef.current.childElementCount > 0) {
          return;
        }
        activeTerminal.open(containerRef.current);
        lastAppliedFitSignature = null;
        fitToViewport({ force: true, syncPty: false });
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnvRef.current ? { env: runtimeEnvRef.current } : {}),
        });
        if (disposed) return;
        lastAppliedFitSignature = null;
        scheduleFitToViewport({ force: true });
        activeTerminal.write("\u001bc");
        if (snapshot.history.length > 0) {
          writeTerminalData(activeTerminal, snapshot.history);
        }
        if (mountShouldFocusTerminal && mountInteractive) {
          window.requestAnimationFrame(() => {
            activeTerminal.focus();
          });
        }
      } catch (err) {
        if (disposed) return;
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      }
    };

    const unsubscribe = api?.terminal.onEvent((event) => {
      if (event.threadId !== threadId || event.terminalId !== terminalId) return;
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;

      if (event.type === "output") {
        pendingTerminalOutput += event.data;
        schedulePendingTerminalOutputFlush();
        clearSelectionAction();
        return;
      }

      flushPendingTerminalOutput();

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        commandBufferRef.current = "";
        terminalLinkMatchCache.clear();
        clearSelectionAction();
        activeTerminal.reset();
        if (event.snapshot.history.length > 0) {
          writeTerminalData(activeTerminal, event.snapshot.history);
        }
        return;
      }

      if (event.type === "title") {
        onAutoTerminalTitleChangeRef.current(terminalId, event.title);
        return;
      }

      if (event.type === "cleared") {
        commandBufferRef.current = "";
        terminalLinkMatchCache.clear();
        clearSelectionAction();
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }

      if (event.type === "exited") {
        commandBufferRef.current = "";
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        writeSystemMessage(
          activeTerminal,
          details.length > 0 ? `Process exited (${details})` : "Process exited",
        );
        if (hasHandledExitRef.current) {
          return;
        }
        hasHandledExitRef.current = true;
        window.setTimeout(() => {
          if (!hasHandledExitRef.current) {
            return;
          }
          onSessionExitedRef.current(terminalId);
        }, 0);
      }
    });

    const fitTimer = window.setTimeout(() => {
      lastAppliedFitSignature = null;
      scheduleFitToViewport({ force: true });
    }, 30);
    const settledFitTimer = window.setTimeout(() => {
      lastAppliedFitSignature = null;
      scheduleFitToViewport({ force: true });
    }, 160);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleFitToViewport();
            scheduleSettledFitToViewport();
          });
    resizeObserver?.observe(mount);
    const handleNativeWindowResizeEnd = () => {
      if (!pendingNativeWindowResizeFit) {
        return;
      }
      lastAppliedFitSignature = null;
      scheduleFitToViewport({ force: true });
      scheduleSettledFitToViewport();
    };
    window.addEventListener("ace:native-window-resize-end", handleNativeWindowResizeEnd);
    window.addEventListener(SIDEBAR_RESIZE_END_EVENT, handleNativeWindowResizeEnd);
    void openTerminal();

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      window.clearTimeout(settledFitTimer);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      if (resizeSettleTimer !== null) {
        window.clearTimeout(resizeSettleTimer);
      }
      if (pendingTerminalOutputFrame !== null) {
        window.cancelAnimationFrame(pendingTerminalOutputFrame);
        pendingTerminalOutputFrame = null;
      }
      flushPendingTerminalOutput();
      resizeObserver?.disconnect();
      window.removeEventListener("ace:native-window-resize-end", handleNativeWindowResizeEnd);
      window.removeEventListener(SIDEBAR_RESIZE_END_EVENT, handleNativeWindowResizeEnd);
      unsubscribe();
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimer !== null) {
        window.clearTimeout(selectionActionTimer);
        selectionActionTimer = null;
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [cwd, runtimeEnvKey, terminalId, threadId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorBlink = interactive;
    if (!interactive) {
      terminal.blur?.();
    }
  }, [interactive]);

  useEffect(() => {
    if (!shouldFocusTerminal || !interactive) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (focusRequestId <= handledFocusRequestIdRef.current) {
      return;
    }
    handledFocusRequestIdRef.current = focusRequestId;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusRequestId, interactive, shouldFocusTerminal]);

  useEffect(() => {
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
      refreshTerminalRows(terminal);
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      runAsyncTask(
        api.terminal.resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        }),
        "Failed to resize the terminal after drawer layout changed.",
      );
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, terminalId, threadId]);
  return (
    <div ref={containerRef} className="terminal-viewport relative h-full w-full overflow-hidden" />
  );
}

function shallowRuntimeEnvEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightKeys = Object.keys(right);
  if (leftEntries.length !== rightKeys.length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}

function terminalViewportPropsEqual(
  previous: TerminalViewportProps,
  next: TerminalViewportProps,
): boolean {
  return (
    previous.threadId === next.threadId &&
    previous.terminalId === next.terminalId &&
    previous.terminalLabel === next.terminalLabel &&
    previous.cwd === next.cwd &&
    previous.interactive === next.interactive &&
    previous.focusRequestId === next.focusRequestId &&
    previous.shouldFocusTerminal === next.shouldFocusTerminal &&
    previous.drawerHeight === next.drawerHeight &&
    previous.onSessionExited === next.onSessionExited &&
    previous.onAddTerminalContext === next.onAddTerminalContext &&
    previous.onAutoTerminalTitleChange === next.onAutoTerminalTitleChange &&
    previous.onOpenBrowserUrl === next.onOpenBrowserUrl &&
    previous.onOpenFilePath === next.onOpenFilePath &&
    shallowRuntimeEnvEqual(previous.runtimeEnv, next.runtimeEnv)
  );
}

function TerminalViewport(props: TerminalViewportProps) {
  return useTerminalViewportComponent(props);
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  layout?: "bottom" | "panel";
  height: number;
  interactive: boolean;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  runningTerminalIds: string[];
  autoTerminalTitlesById: Record<string, string>;
  splitRatiosByGroupId: Record<string, number[]>;
  focusRequestId: number;
  onNewTerminal: () => void;
  newShortcutLabel?: string | undefined;
  toggleShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onMoveTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  onSplitRatiosChange: (groupId: string, ratios: number[]) => void;
  onAutoTerminalTitleChange: (terminalId: string, title: string | null) => void;
  onCloseTerminal: (terminalId: string) => void;
  onToggleTerminal: () => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onOpenBrowserUrl?: ((url: string) => void) | null;
  onOpenFilePath?: ((path: string) => void | Promise<void>) | null;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  pressed?: boolean;
  children: ReactNode;
}

function TerminalActionButton({
  label,
  className,
  onClick,
  pressed = false,
  children,
}: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={
          <button
            type="button"
            className={className}
            onClick={onClick}
            aria-label={label}
            aria-pressed={pressed}
            data-pressed={pressed ? "" : undefined}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

function SortableTerminalTab(props: {
  active: boolean;
  canClose: boolean;
  label: string;
  running: boolean;
  suppressClickAfterDragRef: MutableRefObject<boolean>;
  terminalId: string;
  onClose: (terminalId: string) => void;
  onSelect: (terminalId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: props.terminalId });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            ref={setNodeRef}
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={cn(
              "group/tab relative inline-flex h-8 min-w-0 max-w-56 shrink-0 touch-none cursor-default items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-all duration-200",
              props.active
                ? "bg-accent text-accent-foreground ring-1 ring-border/45"
                : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
              isDragging && "z-20 opacity-70",
              isOver && !isDragging && "bg-foreground/[0.06]",
            )}
            onClick={(event) => {
              event.preventDefault();
              if (props.suppressClickAfterDragRef.current) {
                return;
              }
              props.onSelect(props.terminalId);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onSelect(props.terminalId);
                return;
              }
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            {...attributes}
            aria-pressed={props.active}
            {...listeners}
          />
        }
      >
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <IconTerminal className="size-4 text-muted-foreground" />
          {props.canClose ? (
            <button
              type="button"
              className="absolute inset-0 inline-flex items-center justify-center rounded-full bg-muted-foreground/80 text-background opacity-0 transition-opacity hover:bg-foreground group-hover/tab:opacity-100"
              aria-label={`Close ${props.label}`}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onClose(props.terminalId);
              }}
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </span>
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        <span
          className={cn(
            "terminal-live-indicator shrink-0 rounded-full",
            props.running ? "size-2 bg-emerald-400" : "size-1.5 bg-border",
          )}
        />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap">
        {props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

type ThreadTerminalTabsStripProps = {
  activeTerminalId: string;
  canCloseTerminals: boolean;
  labelById: ReadonlyMap<string, string>;
  newTerminalButton: ReactNode;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onDragCancel: (event: DragCancelEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragStart: (event: DragStartEvent) => void;
  runningTerminalIds: ReadonlySet<string>;
  suppressClickAfterDragRef: MutableRefObject<boolean>;
  tabStripRef: MutableRefObject<HTMLDivElement | null>;
  tabsOverflow: boolean;
  terminalIds: readonly string[];
  terminalTabSensors: ReturnType<typeof useSensors>;
  toggleTerminalButton: ReactNode;
};

function ThreadTerminalTabsStrip({
  activeTerminalId,
  canCloseTerminals,
  labelById,
  newTerminalButton,
  onActiveTerminalChange,
  onCloseTerminal,
  onDragCancel,
  onDragEnd,
  onDragStart,
  runningTerminalIds,
  suppressClickAfterDragRef,
  tabStripRef,
  tabsOverflow,
  terminalIds,
  terminalTabSensors,
  toggleTerminalButton,
}: ThreadTerminalTabsStripProps) {
  return (
    <div className="terminal-tabs-strip flex shrink-0 items-center gap-2 bg-transparent px-3 pb-3 pt-2.5">
      <div
        ref={tabStripRef}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden scroll-px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <DndContext
          sensors={terminalTabSensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SortableContext items={[...terminalIds]} strategy={horizontalListSortingStrategy}>
            <div className="flex min-w-max items-center gap-1.5">
              {terminalIds.map((terminalId) => (
                <SortableTerminalTab
                  key={terminalId}
                  active={terminalId === activeTerminalId}
                  canClose={canCloseTerminals}
                  label={labelById.get(terminalId) ?? "Terminal"}
                  running={runningTerminalIds.has(terminalId)}
                  suppressClickAfterDragRef={suppressClickAfterDragRef}
                  terminalId={terminalId}
                  onClose={onCloseTerminal}
                  onSelect={onActiveTerminalChange}
                />
              ))}
              {tabsOverflow ? (
                <span className="size-8 shrink-0" aria-hidden="true" />
              ) : (
                newTerminalButton
              )}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {tabsOverflow ? newTerminalButton : null}
      {toggleTerminalButton}
    </div>
  );
}

type ThreadTerminalPaneGroupProps = {
  activePaneRatios: readonly number[];
  activeTerminalId: string;
  cwd: string;
  drawerHeight: number;
  focusRequestId: number;
  group: ThreadTerminalGroup;
  groupContainerRef: MutableRefObject<HTMLDivElement | null>;
  interactive: boolean;
  labelById: ReadonlyMap<string, string>;
  onActiveTerminalChange: (terminalId: string) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onAutoTerminalTitleChange: (terminalId: string, title: string | null) => void;
  onCloseTerminal: (terminalId: string) => void;
  onOpenBrowserUrl: ((url: string) => void) | null;
  onOpenFilePath: ((path: string) => void) | null;
  onPaneResizePointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    groupId: string,
    dividerIndex: number,
    ratios: number[],
  ) => void;
  runningTerminalIds: ReadonlySet<string>;
  runtimeEnv: Record<string, string> | undefined;
  threadId: ThreadId;
};

function ThreadTerminalPaneGroup({
  activePaneRatios,
  activeTerminalId,
  cwd,
  drawerHeight,
  focusRequestId,
  group,
  groupContainerRef,
  interactive,
  labelById,
  onActiveTerminalChange,
  onAddTerminalContext,
  onAutoTerminalTitleChange,
  onCloseTerminal,
  onOpenBrowserUrl,
  onOpenFilePath,
  onPaneResizePointerDown,
  runningTerminalIds,
  runtimeEnv,
  threadId,
}: ThreadTerminalPaneGroupProps) {
  const hasSplitPanes = group.terminalIds.length > 1;

  return (
    <div className="min-h-0 w-full flex-1">
      <div ref={groupContainerRef} className="flex h-full min-h-0">
        {group.terminalIds.map((terminalId, index) => {
          const ratio = activePaneRatios[index] ?? 1 / group.terminalIds.length;
          const terminalLabel = labelById.get(terminalId) ?? "Terminal";
          const isActiveTerminal = terminalId === activeTerminalId;

          return (
            <div key={terminalId} className="flex min-h-0 min-w-0" style={{ flex: `${ratio} 1 0` }}>
              {index > 0 ? (
                <hr
                  aria-orientation="vertical"
                  aria-label="Resize terminal split"
                  className="group/split relative z-10 h-auto w-3 shrink-0 cursor-col-resize touch-none select-none border-0 bg-transparent before:absolute before:inset-y-2 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border/55 before:transition-colors before:content-[''] after:absolute after:inset-y-3 after:left-1/2 after:w-2 after:-translate-x-1/2 after:rounded-full after:bg-transparent after:transition-colors after:content-[''] hover:before:bg-primary/55 hover:after:bg-primary/10"
                  onPointerDown={(event) =>
                    onPaneResizePointerDown(event, group.id, index - 1, [...activePaneRatios])
                  }
                />
              ) : null}
              <div
                className={cn(
                  "relative min-h-0 min-w-0 flex-1 overflow-hidden",
                  !isActiveTerminal && "border-l border-border/25",
                )}
                onPointerDown={() => {
                  if (!isActiveTerminal) {
                    onActiveTerminalChange(terminalId);
                  }
                }}
              >
                {hasSplitPanes ? (
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-7 items-center justify-between gap-2 border-b px-2 text-[11px] font-medium backdrop-blur",
                      isActiveTerminal
                        ? "border-primary/25 bg-primary/8 text-foreground"
                        : "glass-inset border-border/35 text-muted-foreground",
                    )}
                  >
                    <span className="min-w-0 truncate">{terminalLabel}</span>
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        runningTerminalIds.has(terminalId) ? "bg-emerald-400" : "bg-border",
                      )}
                    />
                  </div>
                ) : null}
                <div className={cn("h-full", hasSplitPanes && "pt-7")}>
                  <TerminalViewport
                    threadId={threadId}
                    terminalId={terminalId}
                    terminalLabel={terminalLabel}
                    cwd={cwd}
                    {...(runtimeEnv ? { runtimeEnv } : {})}
                    interactive={interactive && isActiveTerminal}
                    onSessionExited={onCloseTerminal}
                    onAddTerminalContext={onAddTerminalContext}
                    onAutoTerminalTitleChange={onAutoTerminalTitleChange}
                    onOpenBrowserUrl={onOpenBrowserUrl}
                    onOpenFilePath={onOpenFilePath}
                    focusRequestId={focusRequestId}
                    shouldFocusTerminal={interactive && isActiveTerminal}
                    drawerHeight={drawerHeight}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ThreadTerminalResizeController = {
  drawerHeight: number;
  groupContainerRef: MutableRefObject<HTMLDivElement | null>;
  onDrawerResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPaneResizePointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    groupId: string,
    dividerIndex: number,
    ratios: number[],
  ) => void;
};

function useThreadTerminalResizeController({
  height,
  onHeightChange,
  onSplitRatiosChange,
  threadId,
}: {
  height: number;
  onHeightChange: (height: number) => void;
  onSplitRatiosChange: (groupId: string, ratios: number[]) => void;
  threadId: ThreadId;
}): ThreadTerminalResizeController {
  const clampedPropHeight = clampDrawerHeight(height);
  const [drawerHeightState, setDrawerHeightState] = useState(() => ({
    threadId,
    propHeight: clampedPropHeight,
    height: clampedPropHeight,
  }));
  const drawerHeight =
    drawerHeightState.threadId === threadId && drawerHeightState.propHeight === clampedPropHeight
      ? drawerHeightState.height
      : clampedPropHeight;
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef<number>(null!);
  if (lastSyncedHeightRef.current === null) {
    lastSyncedHeightRef.current = clampDrawerHeight(height);
  }
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const paneResizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    groupId: string;
    dividerIndex: number;
    startRatios: number[];
    containerWidth: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const groupContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useStableCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  });

  const handleDrawerResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  };

  const handleResizePointerMove = useStableCallback((event: PointerEvent) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    setDrawerHeightState({ threadId, propHeight: clampedPropHeight, height: clampedHeight });
  });

  const handleResizePointerEnd = (event?: PointerEvent) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || (event && resizeState.pointerId !== event.pointerId)) return;
    resizeStateRef.current = null;
    if (!didResizeDuringDragRef.current) {
      return;
    }
    syncHeight(drawerHeightRef.current);
  };

  const handlePaneResizePointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    groupId: string,
    dividerIndex: number,
    ratios: number[],
  ) => {
    if (event.button !== 0) return;
    const containerWidth = groupContainerRef.current?.clientWidth ?? 0;
    if (containerWidth <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    paneResizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      groupId,
      dividerIndex,
      startRatios: ratios,
      containerWidth,
    };
  };

  const handlePaneResizePointerMove = (event: PointerEvent) => {
    const resizeState = paneResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const nextRatios = resizeTerminalPaneRatios({
      ratios: resizeState.startRatios,
      dividerIndex: resizeState.dividerIndex,
      deltaPx: event.clientX - resizeState.startX,
      containerWidthPx: resizeState.containerWidth,
      minPaneWidthPx: MIN_TERMINAL_PANE_WIDTH,
    });
    onSplitRatiosChange(resizeState.groupId, nextRatios);
  };

  const handlePaneResizePointerEnd = (event?: PointerEvent) => {
    const resizeState = paneResizeStateRef.current;
    if (!resizeState || (event && resizeState.pointerId !== event.pointerId)) return;
    paneResizeStateRef.current = null;
  };
  const handleResizePointerMoveEvent = useEffectEvent(handleResizePointerMove);
  const handlePaneResizePointerMoveEvent = useEffectEvent(handlePaneResizePointerMove);
  const handleResizePointerEndEvent = useEffectEvent(handleResizePointerEnd);
  const handlePaneResizePointerEndEvent = useEffectEvent(handlePaneResizePointerEnd);

  useEffect(() => {
    let resizeFrame: number | null = null;
    const syncWindowBounds = () => {
      resizeFrame = null;
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const heightChanged = clampedHeight !== drawerHeightRef.current;

      if (!heightChanged) {
        return;
      }

      setDrawerHeightState({ threadId, propHeight: clampedPropHeight, height: clampedHeight });
      drawerHeightRef.current = clampedHeight;
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
    };
    const onWindowResize = () => {
      if (resizeFrame !== null) {
        return;
      }
      resizeFrame = window.requestAnimationFrame(syncWindowBounds);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      window.removeEventListener("resize", onWindowResize);
    };
  }, [clampedPropHeight, syncHeight, threadId]);

  useEffect(() => {
    const drawerHeight = drawerHeightRef.current;
    return () => {
      syncHeight(drawerHeight);
    };
  }, [syncHeight]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      handleResizePointerMoveEvent(event);
      handlePaneResizePointerMoveEvent(event);
    };
    const handlePointerEnd = (event: PointerEvent) => {
      handleResizePointerEndEvent(event);
      handlePaneResizePointerEndEvent(event);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, []);

  useEffect(() => {
    const resetResizeInteractions = () => {
      handleResizePointerEndEvent();
      handlePaneResizePointerEndEvent();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        resetResizeInteractions();
      }
    };
    window.addEventListener("blur", resetResizeInteractions);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", resetResizeInteractions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return {
    drawerHeight,
    groupContainerRef,
    onDrawerResizePointerDown: handleDrawerResizePointerDown,
    onPaneResizePointerDown: handlePaneResizePointerDown,
  };
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  layout = "bottom",
  height,
  interactive,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  runningTerminalIds,
  autoTerminalTitlesById,
  splitRatiosByGroupId,
  focusRequestId,
  onNewTerminal,
  newShortcutLabel,
  toggleShortcutLabel,
  onActiveTerminalChange,
  onMoveTerminal,
  onSplitRatiosChange,
  onAutoTerminalTitleChange,
  onCloseTerminal,
  onToggleTerminal,
  onHeightChange,
  onAddTerminalContext,
  onOpenBrowserUrl = null,
  onOpenFilePath = null,
}: ThreadTerminalDrawerProps) {
  const { drawerHeight, groupContainerRef, onDrawerResizePointerDown, onPaneResizePointerDown } =
    useThreadTerminalResizeController({
      height,
      onHeightChange,
      onSplitRatiosChange,
      threadId,
    });
  const suppressTerminalTabClickAfterDragRef = useRef(false);
  const { tabStripRef, tabsOverflow } = useTabStripOverflow<HTMLDivElement>();
  const terminalTabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const normalizedTerminalIds = normalizeTerminalIdList(terminalIds);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = normalizeTerminalGroups(terminalGroups, normalizedTerminalIds);

  const runningTerminalIdSet = new Set(runningTerminalIds);
  const activeTerminalGroup = resolvedTerminalGroups.find((group) =>
    group.terminalIds.includes(resolvedActiveTerminalId),
  ) ??
    resolvedTerminalGroups[0] ?? {
      id: `group-${resolvedActiveTerminalId}`,
      terminalIds: [resolvedActiveTerminalId],
    };
  const visibleTerminalGroup =
    layout === "panel"
      ? { id: activeTerminalGroup.id, terminalIds: [resolvedActiveTerminalId] }
      : activeTerminalGroup;
  const activeGroupPaneRatios = resolveTerminalGroupPaneRatios(
    splitRatiosByGroupId[visibleTerminalGroup.id],
    visibleTerminalGroup.terminalIds.length,
  );

  const terminalLabelById = new Map(
    normalizedTerminalIds.map((terminalId) => [
      terminalId,
      resolveTerminalDisplayTitle({
        autoTitle: autoTerminalTitlesById[terminalId],
        cwd,
        isRunning: runningTerminalIdSet.has(terminalId),
        terminalId,
      }),
    ]),
  );
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const toggleTerminalActionLabel = toggleShortcutLabel
    ? `Hide Terminal (${toggleShortcutLabel})`
    : "Hide Terminal";
  const onNewTerminalAction = () => {
    onNewTerminal();
  };
  const handleTerminalTabDragStart = (event: DragStartEvent) => {
    suppressTerminalTabClickAfterDragRef.current = true;
    void event;
  };
  const handleTerminalTabDragEnd = (event: DragEndEvent) => {
    const draggedTerminalId = String(event.active.id);
    const overTerminalId = event.over ? String(event.over.id) : null;
    if (overTerminalId && draggedTerminalId !== overTerminalId) {
      const target = resolveTerminalTabDropTarget(resolvedTerminalGroups, overTerminalId);
      if (target) {
        onMoveTerminal(draggedTerminalId, target.groupId, target.index);
      }
    }
    window.setTimeout(() => {
      suppressTerminalTabClickAfterDragRef.current = false;
    }, 0);
  };
  const handleTerminalTabDragCancel = (_event: DragCancelEvent) => {
    window.setTimeout(() => {
      suppressTerminalTabClickAfterDragRef.current = false;
    }, 0);
  };

  const newTerminalButton = (
    <TerminalActionButton
      className="terminal-action-btn inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={onNewTerminalAction}
      label={newTerminalActionLabel}
    >
      <PlusIcon className="size-4" />
    </TerminalActionButton>
  );
  const toggleTerminalButton = (
    <TerminalActionButton
      className="terminal-action-btn inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={onToggleTerminal}
      label={toggleTerminalActionLabel}
    >
      <XIcon className="size-4" />
    </TerminalActionButton>
  );
  return (
    <aside
      className={cn(
        "thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden bg-terminal",
        layout === "bottom" ? "border-t border-border/70" : "h-full flex-1 border-0",
        !interactive && "pointer-events-none select-none",
      )}
      style={layout === "bottom" ? { height: `${drawerHeight}px` } : undefined}
    >
      {layout === "bottom" ? (
        <div
          className="terminal-resize-handle absolute inset-x-0 top-0 z-20 h-2 cursor-row-resize"
          onPointerDown={onDrawerResizePointerDown}
        />
      ) : null}

      {layout === "bottom" ? (
        <ThreadTerminalTabsStrip
          activeTerminalId={resolvedActiveTerminalId}
          canCloseTerminals={normalizedTerminalIds.length > 1}
          labelById={terminalLabelById}
          newTerminalButton={newTerminalButton}
          onActiveTerminalChange={onActiveTerminalChange}
          onCloseTerminal={onCloseTerminal}
          onDragCancel={handleTerminalTabDragCancel}
          onDragEnd={handleTerminalTabDragEnd}
          onDragStart={handleTerminalTabDragStart}
          runningTerminalIds={runningTerminalIdSet}
          suppressClickAfterDragRef={suppressTerminalTabClickAfterDragRef}
          tabStripRef={tabStripRef}
          tabsOverflow={tabsOverflow}
          terminalIds={normalizedTerminalIds}
          terminalTabSensors={terminalTabSensors}
          toggleTerminalButton={toggleTerminalButton}
        />
      ) : null}

      <ThreadTerminalPaneGroup
        activePaneRatios={activeGroupPaneRatios}
        activeTerminalId={resolvedActiveTerminalId}
        cwd={cwd}
        drawerHeight={drawerHeight}
        focusRequestId={focusRequestId}
        group={visibleTerminalGroup}
        groupContainerRef={groupContainerRef}
        interactive={interactive}
        labelById={terminalLabelById}
        onActiveTerminalChange={onActiveTerminalChange}
        onAddTerminalContext={onAddTerminalContext}
        onAutoTerminalTitleChange={onAutoTerminalTitleChange}
        onCloseTerminal={onCloseTerminal}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenFilePath={onOpenFilePath}
        onPaneResizePointerDown={onPaneResizePointerDown}
        runningTerminalIds={runningTerminalIdSet}
        runtimeEnv={runtimeEnv}
        threadId={threadId}
      />
    </aside>
  );
}
