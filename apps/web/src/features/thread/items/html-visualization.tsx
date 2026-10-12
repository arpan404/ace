import { useClient } from "@ace/client-react";
import { useEffect, useRef, useState } from "react";
import {
  ArrowsOutIcon,
  CornersOutIcon,
  DownloadSimpleIcon,
  ArrowSquareOutIcon,
  CopyIcon,
} from "@phosphor-icons/react";
import type { HtmlVisualization } from "@ace/protocol";
import {
  maxHtmlBytes,
  themeProperties,
  validateHtml,
  visualizationWindow,
  type HtmlTheme,
} from "@ace/html";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { HtmlFrame } from "./html-frame.tsx";

function readTheme(): HtmlTheme {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    themeProperties.map((name) => [name, style.getPropertyValue(`--${name}`).trim()]),
  );
}
function useHtmlTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Loaded only for a structured HTML item. Normal message prose never reaches this component. */
export function HtmlVisualizationView(props: {
  threadId: string;
  visualization: HtmlVisualization;
}) {
  const { visualization } = props;
  const client = useClient();
  const theme = useHtmlTheme();
  const toast = useToast();
  const stage = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState<{
    hash: string;
    client: typeof client;
    threadId: string;
    html?: string;
    failed?: boolean;
    attempt: number;
  }>();
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const hash = visualization.document.sha256;
  const bytes = visualization.document.bytes;
  useEffect(() => {
    const controller = new AbortController();
    void client
      .attachmentBytes(
        {
          threadId: props.threadId,
          sha256: hash,
          variant: "original",
          maxBytes: Math.min(bytes, maxHtmlBytes),
        },
        { signal: controller.signal },
      )
      .then((result) => {
        const html = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
        if (result.bytes.byteLength > maxHtmlBytes || !validateHtml(html).valid)
          throw new Error("Invalid HTML attachment");
        if (!controller.signal.aborted)
          setLoaded({ hash, client, threadId: props.threadId, attempt, html });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setLoaded({ hash, client, threadId: props.threadId, attempt, failed: true });
      });
    return () => controller.abort();
  }, [client, hash, bytes, props.threadId, attempt]);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const current =
    loaded?.hash === hash &&
    loaded.client === client &&
    loaded.threadId === props.threadId &&
    loaded.attempt === attempt
      ? loaded
      : undefined;
  const html = current?.html;
  const available =
    typeof HTMLIFrameElement !== "undefined" &&
    "sandbox" in HTMLIFrameElement.prototype &&
    "trustedTypes" in window;
  const save = () => {
    if (!html) return;
    // Export a sandbox wrapper too; opening the download keeps the same restrictions.
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
    const url = URL.createObjectURL(
      new Blob([visualizationWindow(html, theme)], { type: "text/html" }),
    );
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  return (
    <section
      ref={stage}
      aria-label={visualization.title}
      className="group/visualization min-w-0 fullscreen:bg-background fullscreen:p-6"
    >
      <div className="mb-2 flex items-center gap-2 text-ui text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{visualization.title}</span>
        <div className="flex items-center gap-1 opacity-60 transition-opacity group-hover/visualization:opacity-100 group-focus-within/visualization:opacity-100">
          <IconButton
            size="sm"
            icon={ArrowsOutIcon}
            label={expanded ? "Collapse visualization" : "Expand visualization"}
            pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          />
          {document.fullscreenEnabled && (
            <IconButton
              size="sm"
              icon={CornersOutIcon}
              label={fullscreen ? "Exit fullscreen" : "Fullscreen visualization"}
              onClick={() =>
                void (
                  fullscreen ? document.exitFullscreen() : stage.current?.requestFullscreen()
                )?.catch(() => toast.error({ title: "Fullscreen unavailable" }))
              }
            />
          )}
          <IconButton
            size="sm"
            icon={ArrowSquareOutIcon}
            label="Open visualization in new window"
            disabled={!html}
            onClick={open}
          />
          <IconButton
            size="sm"
            icon={CopyIcon}
            label="Copy visualization HTML"
            disabled={!html}
            onClick={() => {
              if (html)
                void navigator.clipboard
                  .writeText(visualizationWindow(html, theme))
                  .catch(() => toast.error({ title: "Couldn't copy visualization" }));
            }}
          />
          <IconButton
            size="sm"
            icon={DownloadSimpleIcon}
            label="Download visualization"
            disabled={!html}
            onClick={save}
          />
        </div>
      </div>
      {!available ? (
        <p className="text-ui text-muted-foreground">View this visualization on desktop/web.</p>
      ) : html ? (
        <HtmlFrame
          html={html}
          title={visualization.title}
          theme={theme}
          height={fullscreen ? 2000 : expanded ? 2000 : (visualization.height ?? 600)}
        />
      ) : current?.failed ? (
        <div className="text-ui text-muted-foreground">
          <p>Visualization unavailable. View on desktop/web with the owning daemon connected.</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setLoaded(undefined);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : (
        <p role="status" className="text-ui text-muted-foreground">
          Loading visualization…
        </p>
      )}
    </section>
  );
}
