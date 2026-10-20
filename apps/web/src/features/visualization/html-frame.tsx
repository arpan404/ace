import { useEffect, useRef, useState } from "react";
import { HtmlHeightMessage, type HtmlMode } from "@ace/protocol";
import {
  heightFromTitle,
  themeMessage,
  visualizationPartition,
  visualizationUrl,
  type HtmlTheme,
} from "@ace/html";

interface SurfaceProps {
  /** The sandboxed document, built once per page so theme changes never reload it. */
  source: string;
  title: string;
  theme: HtmlTheme;
  /** CSS height of the surface. */
  height: string;
  onHeight(height: number): void;
}

/**
 * One rendered chat visualization. Inline, the frame takes the page's whole content height, so
 * the transcript is the only thing that scrolls; theme changes reach the running page, which
 * keeps its state.
 */
export function HtmlFrame(props: {
  html: string;
  /** The agent's choice: `static` strips and blocks the page's scripts. */
  mode: HtmlMode;
  title: string;
  theme: HtmlTheme;
  /** Height held until the page reports its own (the agent's hint, or a default). */
  initialHeight: number;
  /** Fill the container instead of fitting content (fullscreen). */
  fill: boolean;
  /** Desktop: a `<webview>` in the locked visualization session. */
  webview: boolean;
  /** The last content height, kept by the caller so an unloaded frame holds its place. */
  measured: number | undefined;
  onHeight(height: number): void;
}) {
  // A new document only for new HTML or mode; the theme then updates live.
  const [built, setBuilt] = useState(() => ({
    html: props.html,
    mode: props.mode,
    source: visualizationUrl(props.html, props.theme, props.mode),
  }));
  if (built.html !== props.html || built.mode !== props.mode)
    setBuilt({
      html: props.html,
      mode: props.mode,
      source: visualizationUrl(props.html, props.theme, props.mode),
    });
  const height = props.fill ? "100%" : `${Math.max(48, props.measured ?? props.initialHeight)}px`;
  const Surface = props.webview ? WebviewSurface : IframeSurface;
  return (
    <Surface
      source={built.source}
      title={props.title}
      theme={props.theme}
      height={height}
      onHeight={props.onHeight}
    />
  );
}

/** Content height changes ease in, so a page that grows (a tab, a step) doesn't jump. */
const resizes = "transition-[height] duration-200 ease-out motion-reduce:transition-none";

function IframeSurface(props: SurfaceProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useRef(props.theme);
  const { onHeight } = props;
  useEffect(() => {
    let pending: number | undefined;
    const resized = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const parsed = HtmlHeightMessage.safeParse(event.data);
      if (!parsed.success) return;
      if (pending !== undefined) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => onHeight(Math.ceil(parsed.data.height)));
    };
    window.addEventListener("message", resized);
    return () => {
      window.removeEventListener("message", resized);
      if (pending !== undefined) cancelAnimationFrame(pending);
    };
  }, [onHeight]);
  // An opaque-origin frame can only be addressed with "*"; only the outer bridge reads it.
  const send = () => frame.current?.contentWindow?.postMessage(themeMessage(theme.current), "*");
  useEffect(() => {
    if (theme.current === props.theme) return;
    theme.current = props.theme;
    frame.current?.contentWindow?.postMessage(themeMessage(props.theme), "*");
  }, [props.theme]);
  return (
    <iframe
      ref={frame}
      title={props.title}
      src={props.source}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={send}
      className={`block w-full border-0 ${resizes}`}
      style={{ height: props.height }}
    />
  );
}

/** Electron's `<webview>` methods this surface uses, read without trusting its shape. */
function runInGuest(view: HTMLElement, code: string): void {
  const execute: unknown = Reflect.get(view, "executeJavaScript");
  if (typeof execute !== "function") return;
  const result: unknown = Reflect.apply(execute, view, [code]);
  if (result instanceof Promise) result.catch(() => {});
}

function WebviewSurface(props: SurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLElement>(null);
  const ready = useRef(false);
  const theme = useRef(props.theme);
  const { onHeight, source, title } = props;
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const element = document.createElement("webview");
    element.setAttribute("partition", visualizationPartition);
    element.setAttribute("src", source);
    element.setAttribute("title", title);
    element.style.cssText = "display:flex;width:100%;height:100%;border:0";
    const send = () =>
      runInGuest(element, `postMessage(${JSON.stringify(themeMessage(theme.current))}, "*")`);
    const domReady = () => {
      ready.current = true;
      send();
    };
    const titled = (event: Event) => {
      const value: unknown = Reflect.get(event, "title");
      const height = typeof value === "string" ? heightFromTitle(value) : undefined;
      if (height !== undefined) onHeight(height);
    };
    element.addEventListener("dom-ready", domReady);
    element.addEventListener("page-title-updated", titled);
    container.append(element);
    view.current = element;
    return () => {
      element.removeEventListener("dom-ready", domReady);
      element.removeEventListener("page-title-updated", titled);
      element.remove();
      view.current = null;
      ready.current = false;
    };
  }, [source, title, onHeight]);
  useEffect(() => {
    if (theme.current === props.theme) return;
    theme.current = props.theme;
    if (ready.current && view.current)
      runInGuest(view.current, `postMessage(${JSON.stringify(themeMessage(props.theme))}, "*")`);
  }, [props.theme]);
  return <div ref={host} className={`block w-full ${resizes}`} style={{ height: props.height }} />;
}
