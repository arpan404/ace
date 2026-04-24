import { FitAddon } from "@xterm/addon-fit";
import {
  Code2,
  Copy as CopyIcon,
  Database,
  Edit2 as Edit2Icon,
  Globe,
  RefreshCw as RefreshCwIcon,
  RotateCcw as RotateCcwIcon,
  Server,
  SquareSplitHorizontal,
  TerminalSquare,
  Trash as TrashIcon,
  Wrench,
  XIcon,
} from "lucide-react";
import { type ThreadId } from "@ace/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  Fragment,
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
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Input } from "~/components/ui/input";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  HEADER_PILL_ICON_CONTROL_CLASS_NAME,
  HEADER_PILL_SURFACE_CLASS_NAME,
} from "./thread/TopBarCluster";
import {
  applyTerminalInputToBuffer,
  buildTerminalFallbackTitle,
  deriveTerminalTitleFromCommand,
  extractTerminalOscTitle,
  normalizeTerminalPaneRatios,
  resizeTerminalPaneRatios,
} from "~/lib/terminalPresentation";
import { openInPreferredEditor } from "../editorPreferences";
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from "../terminal-links";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../types";
import { readNativeApi } from "~/nativeApi";
import { reportBackgroundError, runAsyncTask } from "~/lib/async";
import {
  TERMINAL_COLOR_OPTIONS,
  TERMINAL_ICON_OPTIONS,
  type TerminalColorName,
  type TerminalIconName,
} from "~/lib/terminalAppearance";
import {
  normalizeTerminalGroups,
  normalizeTerminalIdList,
  normalizeTerminalSidebarWidth as clampTerminalSidebarWidth,
} from "~/lib/terminalStateNormalization";
import { cn } from "~/lib/utils";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;
const TERMINAL_FONT_LOAD_TIMEOUT_MS = 140;

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

type TerminalMenuAction =
  | "split"
  | "unsplit"
  | "new"
  | "duplicate"
  | "rename"
  | "reset-title"
  | "clear"
  | "restart"
  | "close";

type TerminalSectionMenuAction = "new-terminal" | "clear-all" | "close-all";
type TerminalSidebarDensity = "compact" | "comfortable";
type TerminalSidebarDropTarget =
  | { kind: "group"; groupId: string; index: number }
  | { kind: "new-group"; groupIndex: number };
type TerminalContextMenuState =
  | { kind: "terminal"; terminalId: string; position: { x: number; y: number } }
  | { kind: "section"; position: { x: number; y: number } };

interface TerminalMenuItemDescriptor<T extends string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

interface TerminalOptionMenuItemDescriptor<T extends string> {
  id: T;
  label: string;
  current: boolean;
}

export function buildTerminalContextMenuItems(options: {
  canSplit: boolean;
  canUnsplit?: boolean;
  hasCustomTitle: boolean;
}): TerminalMenuItemDescriptor<TerminalMenuAction>[] {
  const { canSplit, canUnsplit = false, hasCustomTitle } = options;
  return [
    { id: "split", label: "Split Terminal", disabled: !canSplit },
    ...(canUnsplit ? [{ id: "unsplit" as const, label: "Unsplit Terminal" }] : []),
    { id: "new", label: "New Terminal" },
    { id: "duplicate", label: "Duplicate Terminal" },
    { id: "rename", label: "Rename Terminal" },
    ...(hasCustomTitle ? [{ id: "reset-title" as const, label: "Reset Title" }] : []),
    { id: "clear", label: "Clear Terminal" },
    { id: "restart", label: "Restart Terminal" },
    { id: "close", label: "Close Terminal", destructive: true },
  ];
}

export function buildTerminalIconMenuItems(
  currentIcon: TerminalIconName | null,
): TerminalOptionMenuItemDescriptor<TerminalIconName>[] {
  const resolvedCurrentIcon = currentIcon ?? "terminal";
  return TERMINAL_ICON_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    current: option.id === resolvedCurrentIcon,
  }));
}

export function buildTerminalColorMenuItems(
  currentColor: TerminalColorName | null,
): TerminalOptionMenuItemDescriptor<TerminalColorName>[] {
  const resolvedCurrentColor = currentColor ?? "default";
  return TERMINAL_COLOR_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    current: option.id === resolvedCurrentColor,
  }));
}

export function buildTerminalSidebarDensityItems(
  density: TerminalSidebarDensity = "comfortable",
): TerminalOptionMenuItemDescriptor<TerminalSidebarDensity>[] {
  return [
    { id: "comfortable", label: "Comfortable", current: density === "comfortable" },
    { id: "compact", label: "Compact", current: density === "compact" },
  ];
}

export function buildTerminalSectionMenuItems(): TerminalMenuItemDescriptor<TerminalSectionMenuAction>[] {
  return [
    { id: "new-terminal", label: "New Terminal" },
    { id: "clear-all", label: "Clear All Terminals" },
    { id: "close-all", label: "Kill All Terminals", destructive: true },
  ];
}

function compactShellLabel(label: string): string {
  return label.replace(/\s+shell$/i, "").trim();
}

function terminalColorClasses(color: TerminalColorName | null): string {
  switch (color) {
    case "emerald":
      return "text-emerald-500";
    case "amber":
      return "text-amber-500";
    case "sky":
      return "text-sky-500";
    case "rose":
      return "text-rose-500";
    case "violet":
      return "text-violet-500";
    default:
      return "text-muted-foreground";
  }
}

function TerminalIconGlyph(props: {
  icon: TerminalIconName | null;
  color: TerminalColorName | null;
  className?: string;
}): ReactNode {
  const { icon, color, className } = props;
  const resolvedClassName = `${terminalColorClasses(color)} ${className ?? ""}`.trim();
  switch (icon) {
    case "code":
      return <Code2 className={resolvedClassName} />;
    case "server":
      return <Server className={resolvedClassName} />;
    case "database":
      return <Database className={resolvedClassName} />;
    case "globe":
      return <Globe className={resolvedClassName} />;
    case "wrench":
      return <Wrench className={resolvedClassName} />;
    default:
      return <TerminalSquare className={resolvedClassName} />;
  }
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
  resizeEpoch: number;
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
  resizeEpoch,
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

    const fitToViewport = () => {
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
        const matches = extractTerminalLinks(lineText);
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
    void openTerminal();

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeObserver?.disconnect();
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
  }, [drawerHeight, resizeEpoch, terminalId, threadId]);
  return (
    <div ref={containerRef} className="terminal-viewport relative h-full w-full overflow-hidden" />
  );
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  height: number;
  sidebarWidth: number;
  sidebarDensity: TerminalSidebarDensity;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  runningTerminalIds: string[];
  customTerminalTitlesById: Record<string, string>;
  autoTerminalTitlesById: Record<string, string>;
  terminalIconsById: Record<string, TerminalIconName>;
  terminalColorsById: Record<string, TerminalColorName>;
  splitRatiosByGroupId: Record<string, number[]>;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onUnsplitTerminal: (terminalId: string) => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onMoveTerminal: (terminalId: string, targetGroupId: string, targetIndex: number) => void;
  onDuplicateTerminal: (terminalId: string) => void;
  onRenameTerminal: (terminalId: string, title: string) => void;
  onClearTerminal: (terminalId: string) => void;
  onClearAllTerminals: () => void;
  onRestartTerminal: (terminalId: string) => void;
  onCloseAllTerminals: () => void;
  onAutoTerminalTitleChange: (terminalId: string, title: string | null) => void;
  onTerminalIconChange: (terminalId: string, icon: TerminalIconName | null) => void;
  onTerminalColorChange: (terminalId: string, color: TerminalColorName | null) => void;
  onSplitRatiosChange: (groupId: string, ratios: number[]) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onSidebarWidthChange: (width: number) => void;
  onSidebarDensityChange: (density: TerminalSidebarDensity) => void;
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

const TERMINAL_HEADER_ACTION_GROUP_CLASS_NAME = cn(
  HEADER_PILL_SURFACE_CLASS_NAME,
  "inline-flex items-center gap-px p-0.5 shadow-none",
);

const TERMINAL_HEADER_ACTION_BUTTON_CLASS_NAME = cn(
  HEADER_PILL_ICON_CONTROL_CLASS_NAME,
  "!size-6 !rounded-[var(--control-radius)] inline-flex items-center justify-center leading-none text-pill-foreground/78 hover:text-pill-foreground [&_svg]:shrink-0",
);

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  height,
  sidebarWidth,
  sidebarDensity,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  runningTerminalIds,
  customTerminalTitlesById,
  autoTerminalTitlesById,
  terminalIconsById,
  terminalColorsById,
  splitRatiosByGroupId,
  focusRequestId,
  onSplitTerminal,
  onUnsplitTerminal,
  onNewTerminal,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onMoveTerminal,
  onDuplicateTerminal,
  onRenameTerminal,
  onClearTerminal,
  onClearAllTerminals,
  onRestartTerminal,
  onCloseAllTerminals,
  onAutoTerminalTitleChange,
  onTerminalIconChange,
  onTerminalColorChange,
  onSplitRatiosChange,
  onCloseTerminal,
  onHeightChange,
  onSidebarWidthChange,
  onSidebarDensityChange,
  onAddTerminalContext,
}: ThreadTerminalDrawerProps) {
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const [sidebarPanelWidth, setSidebarPanelWidth] = useState(() =>
    clampTerminalSidebarWidth(sidebarWidth),
  );
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [draggedTerminalId, setDraggedTerminalId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TerminalSidebarDropTarget | null>(null);
  const [contextMenuState, setContextMenuState] = useState<TerminalContextMenuState | null>(null);
  const drawerHeightRef = useRef(drawerHeight);
  const sidebarWidthRef = useRef(sidebarPanelWidth);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const lastSyncedSidebarWidthRef = useRef(clampTerminalSidebarWidth(sidebarWidth));
  const onHeightChangeRef = useRef(onHeightChange);
  const onSidebarWidthChangeRef = useRef(onSidebarWidthChange);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitResizeStateRef = useRef<{
    pointerId: number;
    dividerIndex: number;
    startX: number;
    startRatios: number[];
  } | null>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const sidebarResizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const didResizeSidebarDuringDragRef = useRef(false);

  const normalizedTerminalIds = useMemo(() => {
    return normalizeTerminalIdList(terminalIds);
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    return normalizeTerminalGroups(terminalGroups, normalizedTerminalIds);
  }, [normalizedTerminalIds, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const hasTerminalSidebar = normalizedTerminalIds.length > 0;
  const isSplitView = visibleTerminalIds.length > 1;
  const visibleTerminalGroupId =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.id ?? `group-${resolvedActiveTerminalId}`;
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
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
  const terminalIconById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId) => [
          terminalId,
          terminalIconsById[terminalId] ?? null,
        ]),
      ),
    [normalizedTerminalIds, terminalIconsById],
  );
  const terminalColorById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId) => [
          terminalId,
          terminalColorsById[terminalId] ?? null,
        ]),
      ),
    [normalizedTerminalIds, terminalColorsById],
  );
  const activeGroupSplitRatios = useMemo(
    () =>
      normalizeTerminalPaneRatios(
        splitRatiosByGroupId[visibleTerminalGroupId] ?? [],
        visibleTerminalIds.length,
      ),
    [splitRatiosByGroupId, visibleTerminalGroupId, visibleTerminalIds.length],
  );
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal (${splitShortcutLabel})`
      : "Split Terminal";
  const unsplitTerminalActionLabel = isSplitView ? "Unsplit Active Terminal" : "Unsplit Terminal";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const isCompactDensity = sidebarDensity === "compact";
  const rowPaddingClass = isCompactDensity ? "px-2 py-1.5" : "px-2.5 py-2";
  const rowTextClass = isCompactDensity ? "text-[11px]" : "text-[12px]";
  const runningTerminalCount = runningTerminalIds.length;
  const railSummaryLabel =
    runningTerminalCount > 0
      ? `${runningTerminalCount} running · ${normalizedTerminalIds.length} open`
      : `${normalizedTerminalIds.length} open`;
  const sidebarGroups = useMemo(() => {
    const seenTerminalIds = new Set<string>();
    return resolvedTerminalGroups
      .map((group) => ({
        ...group,
        terminalIds: group.terminalIds.filter((terminalId) => {
          if (seenTerminalIds.has(terminalId)) {
            return false;
          }
          seenTerminalIds.add(terminalId);
          return true;
        }),
      }))
      .filter((group) => group.terminalIds.length > 0);
  }, [resolvedTerminalGroups]);
  const activeContextMenuTerminalId =
    contextMenuState?.kind === "terminal" ? contextMenuState.terminalId : null;
  const activeContextMenuHasCustomTitle = activeContextMenuTerminalId
    ? Boolean(customTerminalTitlesById[activeContextMenuTerminalId])
    : false;
  const activeContextMenuGroup = activeContextMenuTerminalId
    ? (sidebarGroups.find((group) => group.terminalIds.includes(activeContextMenuTerminalId)) ??
      null)
    : null;
  const activeContextMenuCanSplit =
    (activeContextMenuGroup?.terminalIds.length ?? visibleTerminalIds.length) <
    MAX_TERMINALS_PER_GROUP;
  const activeContextMenuCanUnsplit = (activeContextMenuGroup?.terminalIds.length ?? 0) > 1;
  const activeContextMenuIcon = activeContextMenuTerminalId
    ? (terminalIconById.get(activeContextMenuTerminalId) ?? null)
    : null;
  const activeContextMenuColor = activeContextMenuTerminalId
    ? (terminalColorById.get(activeContextMenuTerminalId) ?? null)
    : null;
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);
  const cancelRename = useCallback(() => {
    setEditingTerminalId(null);
    setEditingTitle("");
  }, []);
  const beginRename = useCallback(
    (terminalId: string) => {
      setEditingTerminalId(terminalId);
      setEditingTitle(terminalLabelById.get(terminalId) ?? "");
    },
    [terminalLabelById],
  );
  const commitRename = useCallback(() => {
    if (!editingTerminalId) return;
    onRenameTerminal(editingTerminalId, editingTitle);
    cancelRename();
  }, [cancelRename, editingTerminalId, editingTitle, onRenameTerminal]);
  const closeContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, []);
  const clearDragState = useCallback(() => {
    setDraggedTerminalId(null);
    setDropTarget(null);
  }, []);
  const handleTerminalContextMenu = useCallback(
    (terminalId: string, position: { x: number; y: number }) => {
      setContextMenuState({ kind: "terminal", terminalId, position });
    },
    [],
  );
  const handleTerminalSectionMenu = useCallback((position: { x: number; y: number }) => {
    setContextMenuState({ kind: "section", position });
  }, []);
  const handleTerminalMenuAction = useCallback(
    (terminalId: string, action: TerminalMenuAction) => {
      closeContextMenu();
      if (action === "split") {
        onSplitTerminalAction();
        return;
      }
      if (action === "unsplit") {
        onUnsplitTerminal(terminalId);
        return;
      }
      if (action === "new") {
        onNewTerminalAction();
        return;
      }
      if (action === "duplicate") {
        onDuplicateTerminal(terminalId);
        return;
      }
      if (action === "rename") {
        beginRename(terminalId);
        return;
      }
      if (action === "reset-title") {
        onRenameTerminal(terminalId, "");
        return;
      }
      if (action === "clear") {
        onClearTerminal(terminalId);
        return;
      }
      if (action === "restart") {
        onRestartTerminal(terminalId);
        return;
      }
      if (action === "close") {
        onCloseTerminal(terminalId);
      }
    },
    [
      beginRename,
      closeContextMenu,
      onClearTerminal,
      onCloseTerminal,
      onDuplicateTerminal,
      onNewTerminalAction,
      onUnsplitTerminal,
      onRenameTerminal,
      onRestartTerminal,
      onSplitTerminalAction,
    ],
  );
  const handleTerminalIconSelect = useCallback(
    (terminalId: string, icon: TerminalIconName) => {
      closeContextMenu();
      onTerminalIconChange(terminalId, icon);
    },
    [closeContextMenu, onTerminalIconChange],
  );
  const handleTerminalColorSelect = useCallback(
    (terminalId: string, color: TerminalColorName) => {
      closeContextMenu();
      onTerminalColorChange(terminalId, color);
    },
    [closeContextMenu, onTerminalColorChange],
  );
  const handleTerminalSectionAction = useCallback(
    (action: TerminalSectionMenuAction) => {
      closeContextMenu();
      if (action === "new-terminal") {
        onNewTerminalAction();
        return;
      }
      if (action === "clear-all") {
        onClearAllTerminals();
        return;
      }
      if (action === "close-all") {
        onCloseAllTerminals();
      }
    },
    [closeContextMenu, onClearAllTerminals, onCloseAllTerminals, onNewTerminalAction],
  );
  const handleSidebarDensitySelect = useCallback(
    (density: TerminalSidebarDensity) => {
      closeContextMenu();
      onSidebarDensityChange(density);
    },
    [closeContextMenu, onSidebarDensityChange],
  );
  const handleTerminalDragStart = useCallback((terminalId: string) => {
    setDraggedTerminalId(terminalId);
    setDropTarget(null);
  }, []);
  const canDropTerminalIntoGroup = useCallback(
    (_terminalId: string, _targetGroupId: string) => true,
    [],
  );
  const handleTerminalDrop = useCallback(
    (terminalId: string, targetGroupId: string, targetIndex: number) => {
      if (!terminalId) return;
      if (!canDropTerminalIntoGroup(terminalId, targetGroupId)) {
        clearDragState();
        return;
      }
      onMoveTerminal(terminalId, targetGroupId, targetIndex);
      clearDragState();
    },
    [canDropTerminalIntoGroup, clearDragState, onMoveTerminal],
  );
  useEffect(() => {
    if (editingTerminalId && !normalizedTerminalIds.includes(editingTerminalId)) {
      cancelRename();
    }
  }, [cancelRename, editingTerminalId, normalizedTerminalIds]);

  useEffect(() => {
    if (
      contextMenuState?.kind === "terminal" &&
      !normalizedTerminalIds.includes(contextMenuState.terminalId)
    ) {
      closeContextMenu();
    }
  }, [closeContextMenu, contextMenuState, normalizedTerminalIds]);

  useEffect(() => {
    if (draggedTerminalId && !normalizedTerminalIds.includes(draggedTerminalId)) {
      clearDragState();
    }
  }, [clearDragState, draggedTerminalId, normalizedTerminalIds]);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    onSidebarWidthChangeRef.current = onSidebarWidthChange;
  }, [onSidebarWidthChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  useEffect(() => {
    sidebarWidthRef.current = sidebarPanelWidth;
  }, [sidebarPanelWidth]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  const syncSidebarWidth = useCallback((nextWidth: number) => {
    const clampedWidth = clampTerminalSidebarWidth(nextWidth);
    if (lastSyncedSidebarWidthRef.current === clampedWidth) return;
    lastSyncedSidebarWidthRef.current = clampedWidth;
    onSidebarWidthChangeRef.current(clampedWidth);
  }, []);

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [height, threadId]);

  useEffect(() => {
    const clampedWidth = clampTerminalSidebarWidth(sidebarWidth);
    setSidebarPanelWidth(clampedWidth);
    sidebarWidthRef.current = clampedWidth;
    lastSyncedSidebarWidthRef.current = clampedWidth;
  }, [sidebarWidth, threadId]);

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
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  const handleSidebarResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeSidebarDuringDragRef.current = false;
    sidebarResizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidthRef.current,
    };
  }, []);

  const handleSidebarResizePointerMove = useCallback((event: PointerEvent) => {
    const resizeState = sidebarResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const clampedWidth = clampTerminalSidebarWidth(
      resizeState.startWidth + (resizeState.startX - event.clientX),
    );
    if (clampedWidth === sidebarWidthRef.current) {
      return;
    }
    didResizeSidebarDuringDragRef.current = true;
    sidebarWidthRef.current = clampedWidth;
    setSidebarPanelWidth(clampedWidth);
  }, []);

  const handleSidebarResizePointerEnd = useCallback(
    (event?: PointerEvent) => {
      const resizeState = sidebarResizeStateRef.current;
      if (!resizeState || (event && resizeState.pointerId !== event.pointerId)) return;
      sidebarResizeStateRef.current = null;
      if (!didResizeSidebarDuringDragRef.current) {
        return;
      }
      syncSidebarWidth(sidebarWidthRef.current);
    },
    [syncSidebarWidth],
  );

  useEffect(() => {
    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      const clampedSidebarWidth = clampTerminalSidebarWidth(sidebarWidthRef.current);
      if (changed) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (clampedSidebarWidth !== sidebarWidthRef.current) {
        setSidebarPanelWidth(clampedSidebarWidth);
        sidebarWidthRef.current = clampedSidebarWidth;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      if (!sidebarResizeStateRef.current) {
        syncSidebarWidth(clampedSidebarWidth);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight, syncSidebarWidth]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
      syncSidebarWidth(sidebarWidthRef.current);
    };
  }, [syncHeight, syncSidebarWidth]);

  const handleSplitResizePointerDown = useCallback(
    (dividerIndex: number, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const container = splitContainerRef.current;
      if (!container || visibleTerminalIds.length <= 1) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      splitResizeStateRef.current = {
        pointerId: event.pointerId,
        dividerIndex,
        startX: event.clientX,
        startRatios: activeGroupSplitRatios,
      };
    },
    [activeGroupSplitRatios, visibleTerminalIds.length],
  );

  const handleSplitResizePointerMove = useCallback(
    (event: PointerEvent) => {
      const resizeState = splitResizeStateRef.current;
      const container = splitContainerRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !container) return;
      const nextRatios = resizeTerminalPaneRatios({
        ratios: resizeState.startRatios,
        dividerIndex: resizeState.dividerIndex,
        deltaPx: event.clientX - resizeState.startX,
        containerWidthPx: container.clientWidth,
      });
      onSplitRatiosChange(visibleTerminalGroupId, nextRatios);
      setResizeEpoch((value) => value + 1);
    },
    [onSplitRatiosChange, visibleTerminalGroupId],
  );

  const handleSplitResizePointerEnd = useCallback((event?: PointerEvent) => {
    const resizeState = splitResizeStateRef.current;
    if (!resizeState || (event && resizeState.pointerId !== event.pointerId)) return;
    splitResizeStateRef.current = null;
    setResizeEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      handleResizePointerMove(event);
      handleSidebarResizePointerMove(event);
      handleSplitResizePointerMove(event);
    };
    const handlePointerEnd = (event: PointerEvent) => {
      handleResizePointerEnd(event);
      handleSidebarResizePointerEnd(event);
      handleSplitResizePointerEnd(event);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [
    handleResizePointerEnd,
    handleResizePointerMove,
    handleSidebarResizePointerEnd,
    handleSidebarResizePointerMove,
    handleSplitResizePointerEnd,
    handleSplitResizePointerMove,
  ]);

  return (
    <aside
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/40 bg-terminal"
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        className="terminal-resize-handle absolute inset-x-0 top-0 z-20 h-2 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
      />

      {contextMenuState ? (
        <Menu
          key={
            contextMenuState.kind === "terminal"
              ? `terminal:${contextMenuState.terminalId}:${contextMenuState.position.x}:${contextMenuState.position.y}`
              : `section:${contextMenuState.position.x}:${contextMenuState.position.y}`
          }
          defaultOpen
          modal={false}
          onOpenChange={(open) => {
            if (!open) {
              closeContextMenu();
            }
          }}
        >
          <MenuTrigger
            render={
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                className="pointer-events-none fixed z-50 size-px opacity-0"
                style={{
                  left: `${contextMenuState.position.x}px`,
                  top: `${contextMenuState.position.y}px`,
                }}
              />
            }
          />
          <MenuPopup
            align="start"
            side="bottom"
            sideOffset={6}
            className="terminal-context-menu min-w-48"
          >
            {contextMenuState.kind === "terminal" ? (
              <>
                <MenuItem
                  onClick={() => handleTerminalMenuAction(contextMenuState.terminalId, "split")}
                  disabled={!activeContextMenuCanSplit}
                  className="menu-item-with-icon"
                >
                  <SquareSplitHorizontal className="size-4 text-muted-foreground" />
                  <span>Split Terminal</span>
                </MenuItem>
                {activeContextMenuCanUnsplit ? (
                  <MenuItem
                    onClick={() => handleTerminalMenuAction(contextMenuState.terminalId, "unsplit")}
                    className="menu-item-with-icon"
                  >
                    <RotateCcwIcon className="size-4 text-muted-foreground" />
                    <span>Unsplit Terminal</span>
                  </MenuItem>
                ) : null}
                <MenuItem
                  onClick={() => handleTerminalMenuAction(contextMenuState.terminalId, "new")}
                  className="menu-item-with-icon"
                >
                  <TerminalSquare className="size-4 text-muted-foreground" />
                  <span>New Terminal</span>
                </MenuItem>
                <MenuItem
                  onClick={() => handleTerminalMenuAction(contextMenuState.terminalId, "duplicate")}
                  className="menu-item-with-icon"
                >
                  <CopyIcon className="size-4 text-muted-foreground" />
                  <span>Duplicate</span>
                </MenuItem>

                <div className="mx-2 my-1 h-px bg-border" />

                <MenuSub>
                  <MenuSubTrigger className="menu-item-with-icon">
                    <TerminalIconGlyph
                      icon={activeContextMenuIcon}
                      color={activeContextMenuColor}
                      className="size-4 shrink-0"
                    />
                    <span>Icon</span>
                    <span className="ms-auto truncate text-[10px] text-muted-foreground">
                      {TERMINAL_ICON_OPTIONS.find(
                        (o) => o.id === (activeContextMenuIcon ?? "terminal"),
                      )?.label ?? "Terminal"}
                    </span>
                  </MenuSubTrigger>
                  <MenuSubPopup className="p-1.5" sideOffset={4}>
                    <div className="terminal-icon-picker">
                      {TERMINAL_ICON_OPTIONS.map((option) => {
                        const isSelected = (activeContextMenuIcon ?? "terminal") === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className={`icon-option ${isSelected ? "selected" : ""}`}
                            onClick={() => {
                              handleTerminalIconSelect(
                                contextMenuState.terminalId,
                                option.id as TerminalIconName,
                              );
                            }}
                          >
                            {TerminalIconGlyph({
                              icon: option.id as TerminalIconName,
                              color: activeContextMenuColor,
                              className: "size-5",
                            })}
                            <span>{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </MenuSubPopup>
                </MenuSub>

                <MenuSub>
                  <MenuSubTrigger className="menu-item-with-icon">
                    <span
                      className={`terminal-color-swatch ${activeContextMenuColor ?? "default"}`}
                      style={{ width: 14, height: 14 }}
                    />
                    <span>Color</span>
                    <span className="ms-auto truncate text-[10px] text-muted-foreground">
                      {TERMINAL_COLOR_OPTIONS.find(
                        (o) => o.id === (activeContextMenuColor ?? "default"),
                      )?.label ?? "Default"}
                    </span>
                  </MenuSubTrigger>
                  <MenuSubPopup className="p-1.5" sideOffset={4}>
                    <div className="terminal-color-picker">
                      {TERMINAL_COLOR_OPTIONS.map((option) => {
                        const isSelected = (activeContextMenuColor ?? "default") === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className={`color-option ${isSelected ? "selected" : ""}`}
                            onClick={() => {
                              handleTerminalColorSelect(
                                contextMenuState.terminalId,
                                option.id as TerminalColorName,
                              );
                            }}
                          >
                            <span className={`terminal-color-swatch ${option.id}`} />
                            <span>{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </MenuSubPopup>
                </MenuSub>

                <div className="mx-2 my-1 h-px bg-border" />

                <MenuItem
                  onClick={() => handleTerminalMenuAction(contextMenuState.terminalId, "rename")}
                  className="menu-item-with-icon"
                >
                  <Edit2Icon className="size-4 text-muted-foreground" />
                  <span>Rename</span>
                </MenuItem>
                {activeContextMenuHasCustomTitle && (
                  <MenuItem
                    onClick={() =>
                      handleTerminalMenuAction(contextMenuState.terminalId, "reset-title")
                    }
                    className="menu-item-with-icon"
                  >
                    <RotateCcwIcon className="size-4 text-muted-foreground" />
                    <span>Reset Title</span>
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => handleTerminalMenuAction(contextMenuState.terminalId, "clear")}
                  className="menu-item-with-icon"
                >
                  <TrashIcon className="size-4 text-muted-foreground" />
                  <span>Clear</span>
                </MenuItem>
                <MenuItem
                  onClick={() => handleTerminalMenuAction(contextMenuState.terminalId, "restart")}
                  className="menu-item-with-icon"
                >
                  <RefreshCwIcon className="size-4 text-muted-foreground" />
                  <span>Restart</span>
                </MenuItem>

                <div className="mx-2 my-1 h-px bg-border" />

                <MenuItem
                  onClick={() => handleTerminalMenuAction(contextMenuState.terminalId, "close")}
                  variant="destructive"
                  className="menu-item-with-icon menu-item-danger"
                >
                  <XIcon className="size-4" />
                  <span>Close</span>
                </MenuItem>
              </>
            ) : (
              <>
                <MenuItem
                  onClick={() => handleTerminalSectionAction("new-terminal")}
                  className="menu-item-with-icon"
                >
                  <TerminalSquare className="size-4 text-muted-foreground" />
                  <span>New Terminal</span>
                </MenuItem>

                <div className="mx-2 my-1 h-px bg-border" />

                <MenuItem
                  onClick={() =>
                    handleSidebarDensitySelect(
                      sidebarDensity === "comfortable" ? "compact" : "comfortable",
                    )
                  }
                  className="menu-item-with-icon"
                >
                  <span className="text-[10px] text-muted-foreground mr-1">
                    {sidebarDensity === "comfortable" ? "Compact" : "Comfortable"}
                  </span>
                  <span className="text-muted-foreground/60 text-[9px]">toggle density</span>
                </MenuItem>
                <MenuItem
                  onClick={() => handleTerminalSectionAction("clear-all")}
                  className="menu-item-with-icon"
                >
                  <TrashIcon className="size-4 text-muted-foreground" />
                  <span>Clear All</span>
                </MenuItem>

                <div className="mx-2 my-1 h-px bg-border" />

                <MenuItem
                  onClick={() => handleTerminalSectionAction("close-all")}
                  variant="destructive"
                  className="menu-item-with-icon menu-item-danger"
                >
                  <XIcon className="size-4" />
                  <span>Kill All Terminals</span>
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      ) : null}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div ref={splitContainerRef} className="flex h-full w-full min-w-0 overflow-hidden">
                {visibleTerminalIds.map((terminalId, index) => (
                  <Fragment key={terminalId}>
                    <div
                      className="min-h-0 min-w-0"
                      style={{ flexBasis: 0, flexGrow: activeGroupSplitRatios[index] ?? 1 }}
                      onMouseDown={() => {
                        if (terminalId !== resolvedActiveTerminalId) {
                          onActiveTerminalChange(terminalId);
                        }
                      }}
                    >
                      <div className="h-full">
                        <TerminalViewport
                          threadId={threadId}
                          terminalId={terminalId}
                          terminalLabel={terminalLabelById.get(terminalId) ?? "terminal"}
                          cwd={cwd}
                          {...(runtimeEnv ? { runtimeEnv } : {})}
                          onSessionExited={() => onCloseTerminal(terminalId)}
                          onAddTerminalContext={onAddTerminalContext}
                          onAutoTerminalTitleChange={(title) =>
                            onAutoTerminalTitleChange(terminalId, title)
                          }
                          focusRequestId={focusRequestId}
                          autoFocus={terminalId === resolvedActiveTerminalId}
                          resizeEpoch={resizeEpoch}
                          drawerHeight={drawerHeight}
                        />
                      </div>
                    </div>
                    {index < visibleTerminalIds.length - 1 ? (
                      <div
                        className="terminal-split-divider relative flex w-3 shrink-0 cursor-col-resize items-center justify-center"
                        onPointerDown={(event) => handleSplitResizePointerDown(index, event)}
                      >
                        <div className="h-full w-px bg-border/20" />
                        <div className="pointer-events-none absolute h-10 w-1 rounded-full bg-border/52 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]" />
                      </div>
                    ) : null}
                  </Fragment>
                ))}
              </div>
            ) : (
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
                  resizeEpoch={resizeEpoch}
                  drawerHeight={drawerHeight}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <>
              <div
                className="terminal-sidebar-resize-handle relative w-2 shrink-0 cursor-col-resize"
                onPointerDown={handleSidebarResizePointerDown}
                aria-hidden="true"
              />

              <aside
                className="terminal-sidebar flex shrink-0 flex-col overflow-hidden"
                style={{ width: `${sidebarPanelWidth}px`, minWidth: `${sidebarPanelWidth}px` }}
              >
                <div
                  className="terminal-sidebar-header flex flex-col gap-2 px-3 py-2.5"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    handleTerminalSectionMenu({ x: event.clientX, y: event.clientY });
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        terminals
                      </div>
                      <div className="truncate text-[11px] font-medium text-foreground">
                        {railSummaryLabel}
                      </div>
                    </div>
                    <div className={TERMINAL_HEADER_ACTION_GROUP_CLASS_NAME}>
                      <TerminalActionButton
                        className={cn(
                          "terminal-action-btn",
                          TERMINAL_HEADER_ACTION_BUTTON_CLASS_NAME,
                          hasReachedSplitLimit
                            ? "cursor-not-allowed opacity-40"
                            : "hover:bg-background/70",
                        )}
                        onClick={onSplitTerminalAction}
                        label={splitTerminalActionLabel}
                      >
                        <SquareSplitHorizontal className="size-3.5" />
                      </TerminalActionButton>
                      {isSplitView ? (
                        <TerminalActionButton
                          className={cn(
                            "terminal-action-btn hover:bg-background/70",
                            TERMINAL_HEADER_ACTION_BUTTON_CLASS_NAME,
                          )}
                          onClick={() => onUnsplitTerminal(resolvedActiveTerminalId)}
                          label={unsplitTerminalActionLabel}
                        >
                          <RotateCcwIcon className="size-3.5" />
                        </TerminalActionButton>
                      ) : null}
                      <TerminalActionButton
                        className={cn(
                          "terminal-action-btn hover:bg-background/70",
                          TERMINAL_HEADER_ACTION_BUTTON_CLASS_NAME,
                        )}
                        onClick={onNewTerminalAction}
                        label={newTerminalActionLabel}
                      >
                        <TerminalSquare className="size-3.5" />
                      </TerminalActionButton>
                      <TerminalActionButton
                        className={cn(
                          "terminal-action-btn hover:bg-background/70",
                          TERMINAL_HEADER_ACTION_BUTTON_CLASS_NAME,
                        )}
                        onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                        label={closeTerminalActionLabel}
                      >
                        <XIcon className="size-3.5" />
                      </TerminalActionButton>
                    </div>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
                  <div className="space-y-2">
                    {sidebarGroups.map((terminalGroup) => {
                      const isSplitGroup = terminalGroup.terminalIds.length > 1;
                      return (
                        <div
                          key={terminalGroup.id}
                          className={cn(
                            "space-y-0.5",
                            terminalGroup !== sidebarGroups[0]
                              ? "border-t border-border/18 pt-2"
                              : null,
                          )}
                        >
                          <div
                            className={cn(
                              "space-y-0.5",
                              isSplitGroup
                                ? "rounded-[var(--control-radius)] border border-border/28 bg-muted/[0.045] p-1"
                                : null,
                            )}
                            onDragOver={(event) => {
                              if (
                                !draggedTerminalId ||
                                !canDropTerminalIntoGroup(draggedTerminalId, terminalGroup.id)
                              ) {
                                return;
                              }
                              event.preventDefault();
                              setDropTarget({
                                kind: "group",
                                groupId: terminalGroup.id,
                                index: terminalGroup.terminalIds.length,
                              });
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const droppedTerminalId =
                                event.dataTransfer.getData("text/plain") || draggedTerminalId;
                              if (!droppedTerminalId) return;
                              handleTerminalDrop(
                                droppedTerminalId,
                                terminalGroup.id,
                                terminalGroup.terminalIds.length,
                              );
                            }}
                          >
                            {isSplitGroup ? (
                              <div className="mb-1 flex items-center gap-2 px-1.5 pb-1">
                                <span className="h-px flex-1 bg-border/18" />
                                <span className="inline-flex items-center gap-1 rounded-full border border-border/38 bg-background/76 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/78">
                                  <SquareSplitHorizontal className="size-3" />
                                  Split {terminalGroup.terminalIds.length}
                                </span>
                              </div>
                            ) : null}
                            {terminalGroup.terminalIds.map((terminalId, terminalIndex) => {
                              const isActive = terminalId === resolvedActiveTerminalId;
                              const isEditing = editingTerminalId === terminalId;
                              const displayLabel =
                                sidebarTerminalLabelById.get(terminalId) ?? "shell";
                              const isRunning = runningTerminalIds.includes(terminalId);
                              const terminalIcon = terminalIconById.get(terminalId) ?? null;
                              const terminalColor = terminalColorById.get(terminalId) ?? null;
                              const closeTerminalLabel = `Close ${
                                displayLabel
                              }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;
                              return (
                                <Fragment key={terminalId}>
                                  {isSplitGroup && terminalIndex > 0 ? (
                                    <div className="mx-2 h-px bg-border/16" />
                                  ) : null}
                                  <div
                                    className={`terminal-item group flex items-center gap-2 rounded-[var(--control-radius)] border ${rowPaddingClass} ${rowTextClass} ${
                                      isActive
                                        ? "active border-border/60 text-foreground"
                                        : "border-transparent text-muted-foreground"
                                    } ${isEditing ? "" : "cursor-grab active:cursor-grabbing"}`}
                                    draggable={!isEditing}
                                    onDragStart={(event) => {
                                      if (isEditing) {
                                        event.preventDefault();
                                        return;
                                      }
                                      event.dataTransfer.effectAllowed = "move";
                                      event.dataTransfer.setData("text/plain", terminalId);
                                      handleTerminalDragStart(terminalId);
                                    }}
                                    onDragEnd={clearDragState}
                                    onDragOver={(event) => {
                                      if (
                                        !draggedTerminalId ||
                                        !canDropTerminalIntoGroup(
                                          draggedTerminalId,
                                          terminalGroup.id,
                                        )
                                      ) {
                                        return;
                                      }
                                      event.preventDefault();
                                      setDropTarget({
                                        kind: "group",
                                        groupId: terminalGroup.id,
                                        index: terminalGroup.terminalIds.indexOf(terminalId),
                                      });
                                    }}
                                    onDrop={(event) => {
                                      event.preventDefault();
                                      const droppedTerminalId =
                                        event.dataTransfer.getData("text/plain") ||
                                        draggedTerminalId;
                                      if (!droppedTerminalId) return;
                                      handleTerminalDrop(
                                        droppedTerminalId,
                                        terminalGroup.id,
                                        terminalGroup.terminalIds.indexOf(terminalId),
                                      );
                                    }}
                                    onContextMenu={(event) => {
                                      event.preventDefault();
                                      void handleTerminalContextMenu(terminalId, {
                                        x: event.clientX,
                                        y: event.clientY,
                                      });
                                    }}
                                    data-drop-active={
                                      dropTarget?.kind === "group" &&
                                      dropTarget.groupId === terminalGroup.id &&
                                      dropTarget.index ===
                                        terminalGroup.terminalIds.indexOf(terminalId)
                                    }
                                  >
                                    <span
                                      className={`terminal-live-indicator shrink-0 rounded-full ${
                                        isRunning ? "size-2 bg-emerald-400" : "size-1.5 bg-border"
                                      }`}
                                    />
                                    {isEditing ? (
                                      <div className="flex min-w-0 flex-1 items-center">
                                        <Input
                                          size="sm"
                                          nativeInput
                                          value={editingTitle}
                                          autoFocus
                                          onChange={(event) =>
                                            setEditingTitle(event.currentTarget.value)
                                          }
                                          onBlur={commitRename}
                                          onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                              event.preventDefault();
                                              commitRename();
                                            }
                                            if (event.key === "Escape") {
                                              event.preventDefault();
                                              cancelRename();
                                            }
                                          }}
                                        />
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
                                          draggedTerminalId === terminalId ? "opacity-60" : ""
                                        } ${
                                          dropTarget?.kind === "group" &&
                                          dropTarget.groupId === terminalGroup.id &&
                                          dropTarget.index ===
                                            terminalGroup.terminalIds.indexOf(terminalId)
                                            ? "rounded-md bg-accent/55"
                                            : ""
                                        }`}
                                        onClick={() => onActiveTerminalChange(terminalId)}
                                      >
                                        {TerminalIconGlyph({
                                          icon: terminalIcon,
                                          color: terminalColor,
                                          className: "size-3.5 shrink-0",
                                        })}
                                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                          {displayLabel}
                                        </span>
                                      </button>
                                    )}
                                    {normalizedTerminalIds.length > 1 && (
                                      <Popover>
                                        <PopoverTrigger
                                          openOnHover
                                          render={
                                            <button
                                              type="button"
                                              className="inline-flex size-5 items-center justify-center rounded-[calc(var(--control-radius)-2px)] text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-background/85 hover:text-foreground group-hover:opacity-100"
                                              onClick={() => onCloseTerminal(terminalId)}
                                              aria-label={closeTerminalLabel}
                                            />
                                          }
                                        >
                                          <XIcon className="size-2.5" />
                                        </PopoverTrigger>
                                        <PopoverPopup
                                          tooltipStyle
                                          side="bottom"
                                          sideOffset={6}
                                          align="center"
                                          className="pointer-events-none select-none"
                                        >
                                          {closeTerminalLabel}
                                        </PopoverPopup>
                                      </Popover>
                                    )}
                                  </div>
                                </Fragment>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </aside>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
