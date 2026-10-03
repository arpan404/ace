import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { TerminalSessions } from "./sessions.ts";

/*
 * A terminal drawn by xterm.js with its WebGL renderer (ADR 0050): full-screen programs,
 * cursor addressing and true colour, at GPU speed for long builds. xterm loads only when a
 * terminal is shown. If the WebGL context is lost, xterm keeps drawing with its DOM renderer.
 */

const css = (style: CSSStyleDeclaration, name: string, fallback: string) =>
  style.getPropertyValue(name).trim() || fallback;

/** Whether this browser can run the WebGL terminal; otherwise the DOM screen is used. */
export function canUseXterm(): boolean {
  if (typeof document === "undefined" || typeof ResizeObserver === "undefined") return false;
  try {
    return !!document.createElement("canvas").getContext?.("webgl2");
  } catch {
    return false;
  }
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
        theme: {
          background: "rgba(0,0,0,0)",
          foreground: css(style, "--muted-foreground", "#bbb"),
          cursor: css(style, "--foreground", "#eee"),
          selectionBackground: css(style, "--accent", "#444"),
          red: css(style, "--status-failed", "#e06c75"),
          green: css(style, "--status-done", "#98c379"),
          yellow: css(style, "--status-needs-you", "#e5c07b"),
          blue: css(style, "--status-working", "#61afef"),
          magenta: css(style, "--status-waiting", "#c678dd"),
          cyan: css(style, "--status-unresponsive", "#56b6c2"),
        },
        allowTransparency: true,
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
        className="min-h-0 flex-1 px-2 pt-2 font-mono text-[12px]"
      />
      {exitCode !== null && (
        <p className="px-4 pb-3 font-sans text-xs text-subtle-foreground">
          Process exited with code {exitCode}.
        </p>
      )}
    </div>
  );
}
