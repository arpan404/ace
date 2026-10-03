import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { webgl2Available } from "@/components/gpu-text/support.ts";
import { tokenColor } from "@/lib/css-color.ts";
import type { TerminalSessions } from "./sessions.ts";

/*
 * A terminal drawn by xterm.js with its WebGL renderer (ADR 0056): full-screen programs,
 * cursor addressing and true colour, at GPU speed for long builds. xterm loads only when a
 * terminal is shown. If the WebGL context is lost, xterm keeps drawing with its DOM renderer.
 */

/** The terminal palette from the theme tokens; status colours stand in for ANSI hues. */
function theme(element: Element) {
  return {
    // The WebGL renderer paints its own background; match the panel's.
    background: tokenColor(element, "--panel", "#161616"),
    foreground: tokenColor(element, "--muted-foreground", "#bbb"),
    cursor: tokenColor(element, "--foreground", "#eee"),
    selectionBackground: tokenColor(element, "--accent", "#444"),
    red: tokenColor(element, "--status-failed", "#e06c75"),
    green: tokenColor(element, "--status-done", "#98c379"),
    yellow: tokenColor(element, "--status-needs-you", "#e5c07b"),
    blue: tokenColor(element, "--status-working", "#61afef"),
    magenta: tokenColor(element, "--status-waiting", "#c678dd"),
    cyan: tokenColor(element, "--status-unresponsive", "#56b6c2"),
  };
}

/** Whether this browser can run the WebGL terminal; otherwise the DOM screen is used. */
export function canUseXterm(): boolean {
  // Probed once per page, not per terminal mount.
  return typeof ResizeObserver !== "undefined" && webgl2Available();
}

export function XtermView(props: { sessions: TerminalSessions; id: string; name: string }) {
  const { sessions, id, name } = props;
  const box = useRef<HTMLDivElement>(null);
  const watch = useCallback((changed: () => void) => sessions.watch(id, changed), [sessions, id]);
  const exitCode = useSyncExternalStore(watch, () => sessions.exitCode(id));
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
      const style = getComputedStyle(element);
      const term = new Terminal({
        fontFamily: style.fontFamily || "monospace",
        fontSize: 12,
        lineHeight: 1.6,
        scrollback: 5_000,
        cursorBlink: false,
        allowProposedApi: false,
        // The canvas is invisible to assistive technology; xterm's accessibility tree mirrors
        // the visible rows (a screen's worth of text per frame, not the scrollback) as DOM text.
        screenReaderMode: true,
        theme: theme(element),
      });
      term.open(element);
      try {
        const webgl = new WebglAddon();
        // A lost context falls back to xterm's DOM renderer rather than a blank terminal.
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* xterm's DOM renderer stays in use. */
      }
      // Follow theme changes (presets, light and dark) on the document root.
      const retheme = new MutationObserver(() => {
        term.options.theme = theme(element);
      });
      retheme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "class", "style"],
      });
      const stopOutput = sessions.output(id, (output) => {
        if (output.kind === "reset") term.reset();
        else term.write(output.data);
      });
      const input = term.onData((data) => sessions.write(id, data));
      let last = "";
      const fit = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const cols = Math.max(20, Math.floor((entry.contentRect.width - 16) / 7.2));
        const rows = Math.max(4, Math.floor(entry.contentRect.height / 19.2));
        const size = `${cols}x${rows}`;
        if (size === last) return;
        last = size;
        term.resize(cols, rows);
        sessions.resize(id, cols, rows);
      });
      fit.observe(element);
      cleanup = () => {
        retheme.disconnect();
        fit.disconnect();
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={box}
        role="group"
        aria-label={`${name} terminal`}
        className="min-h-0 flex-1 px-2 pt-2 font-mono text-[12px] [&_.xterm-viewport]:!bg-transparent"
      />
      {exitCode !== null && (
        <p className="px-4 pb-3 font-sans text-xs text-subtle-foreground">
          Process exited with code {exitCode}.
        </p>
      )}
    </div>
  );
}
