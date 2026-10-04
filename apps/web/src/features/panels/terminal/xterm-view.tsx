import { useEffect, useEffectEvent, useId, useRef } from "react";
import { webgl2Available } from "@/components/gpu-text/support.ts";
import { applePlatform } from "@/lib/keymap.ts";
import { keyOwner } from "./keys.ts";
import { joinWrapped } from "./search.ts";
import type { TerminalSessions } from "./sessions.ts";
import { scrollbackRows, terminalText, type TerminalSurface } from "./surface.ts";
import { themeFor } from "./xterm-theme.ts";
import { terminalFontFamily } from "./fonts.ts";

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

/** A monospace cell's width at the terminal's size, before xterm has drawn one. */
function estimateCell(fontFamily: string): number {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return terminalText.size * 0.6;
  context.font = `${terminalText.size}px ${fontFamily}`;
  return context.measureText("W").width || terminalText.size * 0.6;
}

/** Daemon resizes wait this long after the last change, so dragging a dock sends a few. */
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
      if (disposed) return;
      const fontFamily = terminalFontFamily(getComputedStyle(element).fontFamily || "monospace");
      let lineHeight = terminalText.row / (terminalText.size * 1.2);
      const term = new Terminal({
        fontFamily,
        fontSize: terminalText.size,
        lineHeight,
        letterSpacing: 0,
        scrollback: scrollbackRows,
        cursorBlink: false,
        cursorStyle: "block",
        cursorInactiveStyle: "outline",
        disableStdin: startReadOnly(),
        allowProposedApi: false,
        // Right-click opens the tab's menu (Copy, Paste, Find, Clear), not a word selection.
        rightClickSelectsWord: false,
        // The canvas is invisible to assistive technology; xterm's accessibility tree mirrors
        // the visible rows (a screen's worth of text per frame, not the scrollback) as DOM text.
        screenReaderMode: true,
        theme: themeFor(element),
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

      // Rows exactly `terminalText.row` px tall: xterm derives its row from the font's own
      // height times lineHeight, which differs by font, so measure what it drew and correct once.
      const screen = () => element.querySelector<HTMLElement>(".xterm-screen");
      let cell = estimateCell(fontFamily);
      const measure = () => {
        const drawn = screen()?.getBoundingClientRect();
        if (!drawn?.height || !term.rows) return;
        cell = drawn.width / term.cols || cell;
        const row = drawn.height / term.rows;
        if (Math.abs(row - terminalText.row) > 0.01) {
          lineHeight = (lineHeight * terminalText.row) / row + 0.0005;
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
        const rows = Math.max(4, Math.floor(height / terminalText.row));
        const size = `${cols}x${rows}`;
        if (size === last) return;
        last = size;
        term.resize(cols, rows);
        clearTimeout(settle);
        settle = setTimeout(() => sessions.resize(id, cols, rows), resizeSettleMs);
      };
      const measured = term.onRender(() => {
        measured.dispose();
        measure();
        fit();
      });

      // Follow theme changes (presets, light and dark, accent) on the document root.
      const retheme = new MutationObserver(() => {
        term.options.theme = themeFor(element);
      });
      retheme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-accent", "class", "style"],
      });

      term.attachCustomKeyEventHandler((event) => {
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
  // An exited shell keeps its output on screen but takes no more input.
  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = props.readOnly;
  }, [props.readOnly]);
  const hint = `${useId()}-hint`;
  return (
    <div
      ref={box}
      role="group"
      aria-label={`${name} terminal`}
      aria-describedby={hint}
      onFocus={(event) => {
        // Tabbing onto the wrapper moves on into xterm's own input.
        if (event.target === event.currentTarget) api.current?.focus();
      }}
      className="min-h-0 flex-1 font-mono [&_.xterm-viewport]:!bg-transparent"
    >
      <span id={hint} hidden>
        Control+Backtick hides the terminal and returns focus.
      </span>
    </div>
  );
}
