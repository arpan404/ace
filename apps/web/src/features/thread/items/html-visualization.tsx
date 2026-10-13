import { useClient } from "@ace/client-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  CornersInIcon,
  CornersOutIcon,
  DownloadSimpleIcon,
} from "@phosphor-icons/react";
import type { HtmlVisualization } from "@ace/protocol";
import {
  maxHtmlBytes,
  themeProperties,
  validateHtml,
  visualizationUrl,
  visualizationWindow,
  type HtmlTheme,
  type ThemeProperty,
} from "@ace/html";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { desktopVisualizations } from "@/boot/desktop-visualizations.ts";
import { HtmlFrame } from "./html-frame.tsx";
import { useLiveFrame } from "./live-frames.ts";

/** Where a page variable comes from in the app theme, when the names differ. */
const appToken: Partial<Record<ThemeProperty, string>> = {
  "card-foreground": "--foreground",
  accent: "--ring",
  "accent-foreground": "--ring-foreground",
  success: "--status-done",
  warning: "--status-needs-you",
  info: "--status-working",
};
function readTheme(): HtmlTheme {
  const style = getComputedStyle(document.documentElement);
  const scheme = style.colorScheme.trim();
  return {
    ...Object.fromEntries(
      themeProperties.map((name) => [
        name,
        style.getPropertyValue(appToken[name] ?? `--${name}`).trim(),
      ]),
    ),
    ...(scheme === "dark" || scheme === "light" ? { colorScheme: scheme } : {}),
  };
}
const sameTheme = (a: HtmlTheme, b: HtmlTheme) =>
  a.colorScheme === b.colorScheme && themeProperties.every((name) => a[name] === b[name]);
/** The app theme, re-read whenever the root's theme attributes change. */
function useHtmlTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme((current) => {
        const next = readTheme();
        return sameTheme(current, next) ? current : next;
      }),
    );
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Fetches and validates the page's bytes from the owning daemon. */
function usePageHtml(threadId: string, visualization: HtmlVisualization) {
  const client = useClient();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; html?: string; failed?: boolean }>();
  const hash = visualization.document.sha256;
  const bytes = visualization.document.bytes;
  const key = `${threadId}:${hash}:${attempt}`;
  useEffect(() => {
    const controller = new AbortController();
    void client
      .attachmentBytes(
        { threadId, sha256: hash, variant: "original", maxBytes: Math.min(bytes, maxHtmlBytes) },
        { signal: controller.signal },
      )
      .then((result) => {
        const html = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
        if (result.bytes.byteLength > maxHtmlBytes || !validateHtml(html).valid)
          throw new Error("Invalid HTML attachment");
        if (!controller.signal.aborted) setLoaded({ key, html });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ key, failed: true });
      });
    return () => controller.abort();
  }, [client, threadId, hash, bytes, key]);
  const current = loaded?.key === key ? loaded : undefined;
  return {
    html: current?.html,
    failed: current?.failed === true,
    retry: () => setAttempt((n) => n + 1),
  };
}

/**
 * A published HTML page, inline in the agent's reply at the message column's full width: no
 * card, no title bar. It fits its content height, follows the app theme live, and runs its own
 * scripts in a sandbox that cannot reach the app or the network. Actions appear on hover.
 */
export function HtmlVisualizationView(props: {
  threadId: string;
  visualization: HtmlVisualization;
}) {
  const { visualization } = props;
  const theme = useHtmlTheme();
  const toast = useToast();
  const stage = useRef<HTMLElement>(null);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    stage.current = node;
    setElement(node);
  }, []);
  const id = useId();
  const live = useLiveFrame(id, element);
  const [fullscreen, setFullscreen] = useState(false);
  const [measured, setMeasured] = useState<number>();
  const [copied, setCopied] = useState(false);
  const { html, failed, retry } = usePageHtml(props.threadId, visualization);
  const desktop = desktopVisualizations();
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const available =
    typeof HTMLIFrameElement !== "undefined" && "sandbox" in HTMLIFrameElement.prototype;
  const title = visualization.title;
  const save = () => {
    if (!html) return;
    // The export keeps the same sandbox and CSP around the page.
    const url = URL.createObjectURL(
      new Blob([visualizationWindow(html, theme)], { type: "text/html" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "visualization.html";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const open = () => {
    if (!html) return;
    if (desktop) {
      void desktop
        .open({ title, url: visualizationUrl(html, theme) })
        .catch(() => toast.error({ title: "Couldn't open the visualization" }));
      return;
    }
    const url = URL.createObjectURL(
      new Blob([visualizationWindow(html, theme)], { type: "text/html" }),
    );
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const maxHeight = visualization.height ?? 800;
  return (
    <section
      ref={attach}
      aria-label={title}
      className="group/visualization w-full min-w-0 fullscreen:flex fullscreen:flex-col fullscreen:bg-background fullscreen:p-6"
    >
      <div className="w-full min-w-0 fullscreen:min-h-0 fullscreen:flex-1">
        {!available ? (
          <p className="text-ui text-muted-foreground">{title}</p>
        ) : html && live ? (
          <HtmlFrame
            html={html}
            title={title}
            theme={theme}
            maxHeight={maxHeight}
            fill={fullscreen}
            webview={desktop !== undefined}
            measured={measured}
            onHeight={setMeasured}
          />
        ) : html ? (
          // Unloaded while far from view: hold its place until it comes back.
          <div style={{ height: Math.min(maxHeight, measured ?? 160) }} />
        ) : failed ? (
          <div className="flex items-center gap-2 text-ui text-muted-foreground">
            <span>Couldn't load this visualization.</span>
            <Button size="sm" variant="ghost" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading visualization">
            <Skeleton className="h-40 w-full rounded-md" />
          </div>
        )}
      </div>
      {html && (
        <div className="mt-1 flex h-7 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within/visualization:opacity-100 group-hover/visualization:opacity-100 fullscreen:opacity-100">
          <IconButton size="sm" icon={ArrowSquareOutIcon} label="Open in window" onClick={open} />
          {document.fullscreenEnabled && (
            <IconButton
              size="sm"
              icon={fullscreen ? CornersInIcon : CornersOutIcon}
              label={fullscreen ? "Exit full screen" : "Full screen"}
              onClick={() =>
                void (
                  fullscreen ? document.exitFullscreen() : stage.current?.requestFullscreen()
                )?.catch(() => toast.error({ title: "Full screen unavailable" }))
              }
            />
          )}
          <IconButton
            size="sm"
            icon={copied ? CheckIcon : CopyIcon}
            label={copied ? "Copied" : "Copy source"}
            onClick={() =>
              void navigator.clipboard
                .writeText(html)
                .then(() => setCopied(true))
                .catch(() => toast.error({ title: "Couldn't copy the source" }))
            }
          />
          <IconButton size="sm" icon={DownloadSimpleIcon} label="Download" onClick={save} />
        </div>
      )}
    </section>
  );
}
