import { useEffect, useRef, useState } from "react";
import {
  HtmlHeightMessage,
  type HtmlMode,
  type HtmlStyleKit,
  type PanelHostMessage,
} from "@ace/protocol";
import {
  heightFromTitle,
  inlineVisualizationUrl,
  panelMessageFromTitle,
  panelTheme,
  panelUrl,
  themeMessage,
  visualizationPartition,
  visualizationUrl,
  type HtmlTheme,
} from "@ace/html";

/**
 * A package panel's channel (ADR 0200 §5.2), in place of a visualization's height alone: the
 * same frame and sandbox, with typed messages each way. The caller reads every message.
 */
export interface PanelChannel {
  /** A message the page's outer document relayed, unread: the caller checks it. */
  onMessage(raw: unknown): void;
  /** The page loaded: how to send it a message, until it unloads (`undefined` then). */
  onReady(send: ((message: PanelHostMessage) => void) | undefined): void;
}

interface SurfaceProps {
  /** The sandboxed document, built once per page so theme changes never reload it. */
  source: string;
  title: string;
  theme: HtmlTheme;
  /** CSS height of the surface. */
  height: string;
  /** Height changes ease in rather than land at once. */
  ease: boolean;
  onHeight(height: number): void;
  panel: PanelChannel | undefined;
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
  /** The style kit the page was published against; absent on pages from before kits had versions. */
  kit: HtmlStyleKit | undefined;
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
  /**
   * The page's height is known (it reported one, now or before): changes ease in, so a page
   * that grows (a tab, a step) doesn't jump. Until then its first report replaces the guess at
   * once, in one move the transcript can hold its place through.
   */
  settled: boolean;
  onHeight(height: number): void;
  /** A package panel's page: built as a panel, filling its place, with its channel. */
  panel?: PanelChannel | undefined;
}) {
  // A new document only for new HTML, mode or fit; the theme then updates live. Inline, the
  // frame is sized to its page, so that document never shows a scrollbar (`inlineVisualizationUrl`).
  const build: typeof visualizationUrl = props.panel
    ? (html, theme) => panelUrl(html, theme)
    : props.fill
      ? visualizationUrl
      : inlineVisualizationUrl;
  const [built, setBuilt] = useState(() => ({
    html: props.html,
    mode: props.mode,
    fill: props.fill,
    source: build(props.html, props.theme, props.mode, props.kit),
  }));
  if (built.html !== props.html || built.mode !== props.mode || built.fill !== props.fill)
    setBuilt({
      html: props.html,
      mode: props.mode,
      fill: props.fill,
      source: build(props.html, props.theme, props.mode, props.kit),
    });
  const height = props.fill ? "100%" : `${Math.max(48, props.measured ?? props.initialHeight)}px`;
  const Surface = props.webview ? WebviewSurface : IframeSurface;
  return (
    <Surface
      source={built.source}
      title={props.title}
      theme={props.theme}
      height={height}
      ease={props.settled}
      onHeight={props.onHeight}
      panel={props.panel}
    />
  );
}

/** The theme as the page takes it: a panel's own message, or a visualization's. */
const themeFor = (panel: PanelChannel | undefined, theme: HtmlTheme) =>
  panel ? panelTheme(theme) : themeMessage(theme);

/** Content height changes ease in, so a page that grows (a tab, a step) doesn't jump. */
const resizes = "transition-[height] duration-200 ease-out motion-reduce:transition-none";
const surface = (ease: boolean) => (ease ? resizes : "");

function IframeSurface(props: SurfaceProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useRef(props.theme);
  const { onHeight, panel } = props;
  useEffect(() => {
    let pending: number | undefined;
    const resized = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      if (panel) return panel.onMessage(event.data);
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
  }, [onHeight, panel]);
  // An opaque-origin frame can only be addressed with "*"; only the outer bridge reads it.
  const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
  const send = () => {
    if (panel) panel.onReady(post);
    else post(themeMessage(theme.current));
  };
  useEffect(() => () => panel?.onReady(undefined), [panel]);
  useEffect(() => {
    if (theme.current === props.theme) return;
    theme.current = props.theme;
    frame.current?.contentWindow?.postMessage(themeFor(panel, props.theme), "*");
  }, [props.theme, panel]);
  return (
    <iframe
      ref={frame}
      title={props.title}
      src={props.source}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={send}
      className={`block w-full border-0 ${surface(props.ease)}`}
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
  const { onHeight, source, title, panel } = props;
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const element = document.createElement("webview");
    const post = (message: unknown) =>
      runInGuest(element, `postMessage(${JSON.stringify(message)}, "*")`);
    element.setAttribute("partition", visualizationPartition);
    element.setAttribute("src", source);
    element.setAttribute("title", title);
    element.style.cssText = "display:flex;width:100%;height:100%;border:0";
    const domReady = () => {
      ready.current = true;
      if (panel) panel.onReady(post);
      else post(themeMessage(theme.current));
    };
    const titled = (event: Event) => {
      const value: unknown = Reflect.get(event, "title");
      if (typeof value !== "string") return;
      // A panel's outer document reports its messages through its title, numbered.
      if (panel) return panel.onMessage(panelMessageFromTitle(value));
      const height = heightFromTitle(value);
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
      panel?.onReady(undefined);
    };
  }, [source, title, onHeight, panel]);
  useEffect(() => {
    if (theme.current === props.theme) return;
    theme.current = props.theme;
    if (ready.current && view.current)
      runInGuest(view.current, `postMessage(${JSON.stringify(themeFor(panel, props.theme))}, "*")`);
  }, [props.theme, panel]);
  return (
    <div
      ref={host}
      className={`block w-full ${surface(props.ease)}`}
      style={{ height: props.height }}
    />
  );
}
