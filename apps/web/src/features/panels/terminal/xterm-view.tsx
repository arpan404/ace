import { useEffect, useEffectEvent, useId, useMemo, useRef } from "react";
import { webgl2Available } from "@/components/gpu-text/support.ts";
import { applePlatform } from "@/lib/keymap.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { keyOwner, lineEditBytes } from "./keys.ts";
import { joinWrapped } from "./search.ts";
import type { TerminalSessions } from "./sessions.ts";
import { scrollbackRows, type TerminalSurface } from "./surface.ts";
import { themeFor } from "./xterm-theme.ts";
import { loadFaces, terminalFont, terminalFontFamily } from "./fonts.ts";
import { terminalLook, type TerminalLook } from "./suit-terminal.ts";

/*
 * A terminal drawn by xterm.js with its WebGL renderer (ADR 0056): full-screen programs,
 * cursor addressing and true colour, at GPU speed for long builds. xterm loads only when a
 * terminal is shown. If the WebGL context is lost, xterm keeps drawing with its DOM renderer.
 */

/** Whether this browser can run the WebGL terminal; otherwise the DOM screen is used. */
export function canUseXterm(): boolean {
  // Probed once per page, not per terminal mount.
  return typeof ResizeObserver !== "undefined" && webgl2Available();
}

/** A monospace cell's width at `size`, before xterm has drawn one. */
function estimateCell(fontFamily: string, size: number, letterSpacing: number): number {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return size * 0.6 + letterSpacing;
  context.font = `${size}px ${fontFamily}`;
  return (context.measureText("W").width || size * 0.6) + letterSpacing;
}

/** The font stack xterm draws `look` with: the Suit's family first, then the app's monospace. */
const fontFor = (element: Element, look: TerminalLook) =>
  look.fontFamily
    ? terminalFontFamily(
        `${look.fontFamily}, ${getComputedStyle(element).fontFamily || "monospace"}`,
      )
    : terminalFont(element);

/** xterm's options that follow the Suit (`TerminalLook`), applied at start and on every change. */
const lookOptions = (element: Element, look: TerminalLook) => ({
  fontFamily: fontFor(element, look),
  fontSize: look.fontSize,
  letterSpacing: look.letterSpacing,
  cursorBlink: look.cursorBlink,
  cursorStyle: look.cursorStyle,
  // Transparent only when the Suit reveals what is behind; opaque keeps subpixel text.
  allowTransparency: look.reveal > 0,
  theme: themeFor(element, look),
});

/** Daemon resizes wait this long after the last change, so dragging the panel edge sends a few. */
const resizeSettleMs = 80;

export function XtermView(props: {
  sessions: TerminalSessions;
  id: string;
  name: string;
  /** Called with the view's surface once xterm is ready, and with null when it goes. */
  onSurface(surface: TerminalSurface | null): void;
  /** The shell exited: output stays readable, typing goes nowhere. */
  readOnly: boolean;
  /** Focus the terminal once it has drawn (it was just opened by a person). */
  autoFocus: boolean;
  onFind(): void;
}) {
  const { sessions, id, name } = props;
  const box = useRef<HTMLDivElement>(null);
  const api = useRef<TerminalSurface | null>(null);
  const report = useEffectEvent((surface: TerminalSurface | null) => props.onSurface(surface));
  const terminal = useRef<{ options: { disableStdin?: boolean } } | null>(null);
  const find = useEffectEvent(() => props.onFind());
  const focusFirst = useEffectEvent(() => props.autoFocus);
  const startReadOnly = useEffectEvent(() => props.readOnly);
  // The Suit on screen: its font, cursor and colours apply live, to the same xterm and session.
  const { suit, resolved } = useTheme();
  const look = useMemo(() => terminalLook(suit, resolved.scheme), [suit, resolved.scheme]);
  const currentLook = useEffectEvent(() => look);
  const restyle = useRef<((look: TerminalLook) => void) | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { WebglAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-webgl"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      let shown = currentLook();
      // A bundled face must be in before xterm measures a cell, or the grid fits a fallback.
      await loadFaces(shown.faces, document.fonts);
      if (disposed) return;
      shown = currentLook();
      const options = lookOptions(element, shown);
      // Rows exactly `rowHeight` px tall; xterm's lineHeight multiplies the font's own height (about
      // 1.2 × its size), so start from that and correct once drawn (`measure`).
      let rowHeight = shown.row;
      let lineHeight = rowHeight / (shown.fontSize * 1.2);
      const term = new Terminal({
        ...options,
        lineHeight,
        scrollback: scrollbackRows,
        cursorInactiveStyle: "outline",
        disableStdin: startReadOnly(),
        allowProposedApi: false,
        // Right-click opens the tab's menu (Copy, Paste, Find, Clear), not a word selection.
        rightClickSelectsWord: false,
        // The canvas is invisible to assistive technology; xterm's accessibility tree mirrors
        // the visible rows (a screen's worth of text per frame, not the scrollback) as DOM text.
        screenReaderMode: true,
      });
      terminal.current = term;
      term.open(element);
      try {
        const webgl = new WebglAddon();
        // A lost context falls back to xterm's DOM renderer rather than a blank terminal.
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* xterm's DOM renderer stays in use. */
      }

      // Rows exactly `rowHeight` px tall: xterm derives its row from the font's own height times
      // lineHeight, which differs by font, so measure what it drew and correct once.
      const screen = () => element.querySelector<HTMLElement>(".xterm-screen");
      let cell = estimateCell(options.fontFamily, shown.fontSize, shown.letterSpacing);
      const measure = () => {
        const drawn = screen()?.getBoundingClientRect();
        if (!drawn?.height || !term.rows) return;
        cell = drawn.width / term.cols || cell;
        const drawnRow = drawn.height / term.rows;
        if (Math.abs(drawnRow - rowHeight) > 0.01) {
          lineHeight = (lineHeight * rowHeight) / drawnRow + 0.0005;
          term.options.lineHeight = lineHeight;
        }
      };
      let last = "";
      let settle: ReturnType<typeof setTimeout> | undefined;
      const fit = () => {
        const width = element.clientWidth;
        const height = element.clientHeight;
        if (!width || !height) return;
        const cols = Math.max(20, Math.floor(width / cell));
        const rows = Math.max(4, Math.floor(height / rowHeight));
        const size = `${cols}x${rows}`;
        if (size === last) return;
        last = size;
        term.resize(cols, rows);
        clearTimeout(settle);
        settle = setTimeout(() => sessions.resize(id, cols, rows), resizeSettleMs);
      };
      let measured = term.onRender(() => {
        measured.dispose();
        measure();
        fit();
      });

      // Follow theme and mode changes on the document root.
      const retheme = new MutationObserver(() => {
        term.options.theme = themeFor(element, shown);
      });
      // A new Suit (or scheme) restyles this xterm in place: the session and its scrollback stay.
      // A new font or size re-measures the cell and refits the grid once xterm has redrawn.
      let restyling = 0;
      restyle.current = (next) => {
        const turn = ++restyling;
        void loadFaces(next.faces, document.fonts).then(() => {
          if (disposed || turn !== restyling) return;
          const sized =
            next.fontSize !== shown.fontSize ||
            next.row !== shown.row ||
            next.letterSpacing !== shown.letterSpacing ||
            next.fontFamily !== shown.fontFamily;
          shown = next;
          const nextOptions = lookOptions(element, next);
          if (sized) {
            rowHeight = next.row;
            lineHeight = rowHeight / (next.fontSize * 1.2);
            cell = estimateCell(nextOptions.fontFamily, next.fontSize, next.letterSpacing);
            measured.dispose();
            measured = term.onRender(() => {
              measured.dispose();
              measure();
              last = "";
              fit();
            });
          }
          term.options = sized ? { ...nextOptions, lineHeight } : nextOptions;
        });
      };
      retheme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-scheme", "class", "style"],
      });

      term.attachCustomKeyEventHandler((event) => {
        const line = lineEditBytes(event, applePlatform);
        if (line !== undefined) {
          event.stopPropagation();
          if (event.type === "keydown") {
            event.preventDefault();
            if (!term.options.disableStdin) sessions.write(id, line);
          }
          return false;
        }
        const owner = keyOwner(event, applePlatform);
        if (owner === "terminal") {
          // The shell's key: no ace shortcut may act on it.
          event.stopPropagation();
          return true;
        }
        if (event.type !== "keydown") return false;
        if (owner === "copy") {
          event.preventDefault();
          if (term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection());
        } else if (owner === "find") {
          event.preventDefault();
          find();
        }
        // Paste: the browser's paste event reaches xterm, which sends it as one paste.
        return false;
      });

      const stopOutput = sessions.output(id, (output) => {
        if (output.kind === "reset") term.reset();
        else term.write(output.data);
      });
      const input = term.onData((data) => sessions.write(id, data));

      const resize = new ResizeObserver(() => fit());
      resize.observe(element);
      fit();

      api.current = {
        focus: () => term.focus(),
        text: () => {
          const buffer = term.buffer.active;
          const rows: { text: string; wrapped: boolean }[] = [];
          for (let index = 0; index < buffer.length; index++) {
            const line = buffer.getLine(index);
            rows.push({ text: line?.translateToString(true) ?? "", wrapped: !!line?.isWrapped });
          }
          return { ...joinWrapped(rows), columns: term.cols };
        },
        reveal: (row, column, length) => {
          term.select(column, row, length);
          term.scrollToLine(Math.max(0, row - Math.floor(term.rows / 2)));
        },
        unmark: () => term.clearSelection(),
        selection: () => term.getSelection(),
        selectAll: () => term.selectAll(),
        paste: (text) => term.paste(text),
      };
      report(api.current);
      if (focusFirst()) term.focus();

      cleanup = () => {
        clearTimeout(settle);
        api.current = null;
        restyle.current = null;
        report(null);
        terminal.current = null;
        measured.dispose();
        retheme.disconnect();
        resize.disconnect();
        input.dispose();
        stopOutput();
        term.dispose();
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [sessions, id]);
  useEffect(() => restyle.current?.(look), [look]);
  // An exited shell keeps its output on screen but takes no more input.
  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = props.readOnly;
  }, [props.readOnly]);
  const hint = `${useId()}-hint`;
  // The box clips, so xterm's drawn size never reaches the panel's scroll area. Unclipped, a
  // terminal a pixel too tall gave that area a classic (always shown) scrollbar, which shrank
  // the box, so `fit` chose a smaller grid, the scrollbar went and the grid grew back: a resize
  // every frame, and each resize wiped the WebGL canvas, so the terminal stayed blank.
  return (
    <div
      ref={box}
      role="group"
      aria-label={`${name} terminal`}
      data-part="terminal"
      aria-describedby={hint}
      onFocus={(event) => {
        // Tabbing onto the wrapper moves on into xterm's own input.
        if (event.target === event.currentTarget) api.current?.focus();
      }}
      className="min-h-0 flex-1 overflow-hidden font-mono [&_.xterm-viewport]:!bg-transparent"
    >
      <span id={hint} hidden>
        Control+Backtick hides the terminal and returns focus.
      </span>
    </div>
  );
}
