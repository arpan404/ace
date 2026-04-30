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
  memo,
  type MutableRefObject,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useTabStripOverflow } from "~/hooks/useTabStripOverflow";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  applyTerminalInputToBuffer,
  buildTerminalFallbackTitle,
  deriveTerminalTitleFromCommand,
  extractTerminalOscTitle,
} from "~/lib/terminalPresentation";
import { openInPreferredEditor } from "../editorPreferences";
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
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

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;
const TERMINAL_FONT_LOAD_TIMEOUT_MS = 140;
const TERMINAL_LINK_LINE_CACHE_LIMIT = 512;

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
  terminal.write(`\r\n[terminal] ${message}\r\n`);
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
  const fontCandidates = fontFamily
    .split(",")
    .map((font) => font.trim().replace(/^['"]|['"]$/g, ""))
    .filter((font) => font.length > 0 && font.toLowerCase() !== "monospace");
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

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

export function resolveTerminalTabDropTarget(
  terminalGroups: ReadonlyArray<ThreadTerminalGroup>,
  overTerminalId: string,
): { groupId: string; index: number } | null {
  for (const group of terminalGroups) {
    const index = group.terminalIds.indexOf(overTerminalId);
    if (index >= 0) {
      return { groupId: group.id, index };
    }
  }
  return null;
}

function compactShellLabel(label: string): string {
  return label.replace(/\s+shell$/i, "").trim();
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onAutoTerminalTitleChange: (title: string | null) => void;
  focusRequestId: number;
  autoFocus: boolean;
  drawerHeight: number;
}

function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  onAutoTerminalTitleChange,
  focusRequestId,
  autoFocus,
  drawerHeight,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onSessionExitedRef = useRef(onSessionExited);
  const onAddTerminalContextRef = useRef(onAddTerminalContext);
  const onAutoTerminalTitleChangeRef = useRef(onAutoTerminalTitleChange);
  const terminalLabelRef = useRef(terminalLabel);
  const hasHandledExitRef = useRef(false);
  const commandBufferRef = useRef("");
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);

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
    terminalLabelRef.current = terminalLabel;
  }, [terminalLabel]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;

    const fitAddon = new FitAddon();
    const fontFamily = readTerminalFontFamily();
    const terminal = new Terminal({
      cursorBlink: true,
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
    let lastObservedSize: `${number}x${number}` | null = null;
    let pendingNativeWindowResizeFit = false;

    const fitToViewport = () => {
      pendingNativeWindowResizeFit = false;
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !activeFitAddon || !mountElement) return;
      const nextWidth = mountElement.clientWidth;
      const nextHeight = mountElement.clientHeight;
      if (nextWidth <= 0 || nextHeight <= 0) return;
      const nextSize = `${nextWidth}x${nextHeight}` as const;
      if (nextSize === lastObservedSize) return;
      lastObservedSize = nextSize;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
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

    const scheduleFitToViewport = () => {
      if (isLayoutResizeInProgress()) {
        pendingNativeWindowResizeFit = true;
        return;
      }
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        fitToViewport();
      });
    };

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
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
      } finally {
        selectionActionOpenRef.current = false;
      }
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
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                void api.shell.openExternal(match.text).catch((error) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void openInPreferredEditor(api, target).catch((error) => {
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
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
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
        lastObservedSize = null;
        scheduleFitToViewport();
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
        });
        if (disposed) return;
        activeTerminal.write("\u001bc");
        onAutoTerminalTitleChangeRef.current(snapshot.title);
        if (snapshot.history.length > 0) {
          activeTerminal.write(snapshot.history);
        }
        if (autoFocus) {
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
        const oscTitle = extractTerminalOscTitle(event.data);
        if (oscTitle) {
          onAutoTerminalTitleChangeRef.current(oscTitle);
        }
        activeTerminal.write(event.data);
        clearSelectionAction();
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        commandBufferRef.current = "";
        terminalLinkMatchCache.clear();
        clearSelectionAction();
        activeTerminal.reset();
        onAutoTerminalTitleChangeRef.current(event.snapshot.title);
        if (event.snapshot.history.length > 0) {
          activeTerminal.write(event.snapshot.history);
        }
        return;
      }

      if (event.type === "title") {
        onAutoTerminalTitleChangeRef.current(event.title);
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
          onSessionExitedRef.current();
        }, 0);
      }
    });

    const fitTimer = window.setTimeout(() => {
      lastObservedSize = null;
      scheduleFitToViewport();
    }, 30);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            lastObservedSize = null;
            scheduleFitToViewport();
          });
    resizeObserver?.observe(mount);
    const handleNativeWindowResizeEnd = () => {
      if (!pendingNativeWindowResizeFit) {
        return;
      }
      lastObservedSize = null;
      scheduleFitToViewport();
    };
    window.addEventListener("ace:native-window-resize-end", handleNativeWindowResizeEnd);
    window.addEventListener(SIDEBAR_RESIZE_END_EVENT, handleNativeWindowResizeEnd);
    void openTerminal();

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("ace:native-window-resize-end", handleNativeWindowResizeEnd);
      window.removeEventListener(SIDEBAR_RESIZE_END_EVENT, handleNativeWindowResizeEnd);
      unsubscribe();
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, runtimeEnv, terminalId, threadId]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
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

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  runningTerminalIds: string[];
  customTerminalTitlesById: Record<string, string>;
  autoTerminalTitlesById: Record<string, string>;
  focusRequestId: number;
  onNewTerminal: () => void;
  newShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onMoveTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  onAutoTerminalTitleChange: (terminalId: string, title: string | null) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
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
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/tab relative inline-flex h-8 min-w-0 max-w-56 shrink-0 touch-none cursor-default items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors",
        props.active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        isDragging && "z-20 opacity-70",
        isOver && !isDragging && "bg-accent/70",
      )}
      title={props.label}
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
      role="button"
      tabIndex={0}
      aria-pressed={props.active}
      {...listeners}
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <IconTerminal className="size-4 text-muted-foreground" />
        {props.canClose ? (
          <span
            role="button"
            tabIndex={-1}
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
          </span>
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <span
        className={cn(
          "terminal-live-indicator shrink-0 rounded-full",
          props.running ? "size-2 bg-emerald-400" : "size-1.5 bg-border",
        )}
      />
    </div>
  );
}

export default memo(function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  runningTerminalIds,
  customTerminalTitlesById,
  autoTerminalTitlesById,
  focusRequestId,
  onNewTerminal,
  newShortcutLabel,
  onActiveTerminalChange,
  onMoveTerminal,
  onAutoTerminalTitleChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
}: ThreadTerminalDrawerProps) {
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const suppressTerminalTabClickAfterDragRef = useRef(false);
  const { tabStripRef, tabsOverflow } = useTabStripOverflow<HTMLDivElement>();
  const terminalTabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const normalizedTerminalIds = useMemo(() => {
    return normalizeTerminalIdList(terminalIds);
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    return normalizeTerminalGroups(terminalGroups, normalizedTerminalIds);
  }, [normalizedTerminalIds, terminalGroups]);

  const terminalLabelById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId) => [
          terminalId,
          customTerminalTitlesById[terminalId] ??
            autoTerminalTitlesById[terminalId] ??
            buildTerminalFallbackTitle(cwd, terminalId),
        ]),
      ),
    [autoTerminalTitlesById, customTerminalTitlesById, cwd, normalizedTerminalIds],
  );
  const sidebarTerminalLabelById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId) => {
          const rawLabel = terminalLabelById.get(terminalId) ?? "shell";
          if (customTerminalTitlesById[terminalId] || autoTerminalTitlesById[terminalId]) {
            return [terminalId, rawLabel] as const;
          }
          const compactLabel = compactShellLabel(rawLabel);
          return [terminalId, compactLabel.length > 0 ? compactLabel : rawLabel] as const;
        }),
      ),
    [autoTerminalTitlesById, customTerminalTitlesById, normalizedTerminalIds, terminalLabelById],
  );
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);
  const handleTerminalTabDragStart = useCallback((event: DragStartEvent) => {
    suppressTerminalTabClickAfterDragRef.current = true;
    void event;
  }, []);
  const handleTerminalTabDragEnd = useCallback(
    (event: DragEndEvent) => {
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
    },
    [onMoveTerminal, resolvedTerminalGroups],
  );
  const handleTerminalTabDragCancel = useCallback((_event: DragCancelEvent) => {
    window.setTimeout(() => {
      suppressTerminalTabClickAfterDragRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [height, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: PointerEvent) => {
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
    setDrawerHeight(clampedHeight);
  }, []);

  const handleResizePointerEnd = useCallback(
    (event?: PointerEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || (event && resizeState.pointerId !== event.pointerId)) return;
      resizeStateRef.current = null;
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
    },
    [syncHeight],
  );

  useEffect(() => {
    let resizeFrame: number | null = null;
    const syncWindowBounds = () => {
      resizeFrame = null;
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const heightChanged = clampedHeight !== drawerHeightRef.current;

      if (!heightChanged) {
        return;
      }

      if (heightChanged) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (heightChanged && !resizeStateRef.current) {
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
  }, [syncHeight]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      handleResizePointerMove(event);
    };
    const handlePointerEnd = (event: PointerEvent) => {
      handleResizePointerEnd(event);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [handleResizePointerEnd, handleResizePointerMove]);
  useEffect(() => {
    const resetResizeInteractions = () => {
      handleResizePointerEnd();
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
  }, [handleResizePointerEnd]);

  const renderNewTerminalButton = () => (
    <TerminalActionButton
      className="terminal-action-btn inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={onNewTerminalAction}
      label={newTerminalActionLabel}
    >
      <PlusIcon className="size-4" />
    </TerminalActionButton>
  );

  return (
    <aside
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/70 bg-terminal"
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        className="terminal-resize-handle absolute inset-x-0 top-0 z-20 h-2 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
      />

      <div className="terminal-tabs-strip flex h-11 shrink-0 items-center gap-2 border-b border-border/50 bg-card/80 px-3">
        <div
          ref={tabStripRef}
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden scroll-px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <DndContext
            sensors={terminalTabSensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleTerminalTabDragStart}
            onDragEnd={handleTerminalTabDragEnd}
            onDragCancel={handleTerminalTabDragCancel}
          >
            <SortableContext items={normalizedTerminalIds} strategy={horizontalListSortingStrategy}>
              <div className="flex min-w-max items-center gap-1.5">
                {normalizedTerminalIds.map((terminalId) => (
                  <SortableTerminalTab
                    key={terminalId}
                    active={terminalId === resolvedActiveTerminalId}
                    canClose={normalizedTerminalIds.length > 1}
                    label={sidebarTerminalLabelById.get(terminalId) ?? "shell"}
                    running={runningTerminalIds.includes(terminalId)}
                    suppressClickAfterDragRef={suppressTerminalTabClickAfterDragRef}
                    terminalId={terminalId}
                    onClose={onCloseTerminal}
                    onSelect={onActiveTerminalChange}
                  />
                ))}
                {tabsOverflow ? (
                  <span className="size-8 shrink-0" aria-hidden="true" />
                ) : (
                  renderNewTerminalButton()
                )}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        {tabsOverflow ? renderNewTerminalButton() : null}
      </div>

      <div className="min-h-0 w-full flex-1">
        <div className="flex h-full min-h-0">
          <div className="min-w-0 flex-1">
            <div className="h-full">
              <TerminalViewport
                key={resolvedActiveTerminalId}
                threadId={threadId}
                terminalId={resolvedActiveTerminalId}
                terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                cwd={cwd}
                {...(runtimeEnv ? { runtimeEnv } : {})}
                onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                onAddTerminalContext={onAddTerminalContext}
                onAutoTerminalTitleChange={(title) =>
                  onAutoTerminalTitleChange(resolvedActiveTerminalId, title)
                }
                focusRequestId={focusRequestId}
                autoFocus
                drawerHeight={drawerHeight}
              />
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
});
