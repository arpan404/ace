import { useCallback, useId, useMemo, useState } from "react";
import { CheckIcon, CopyIcon, CornersOutIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { usePageActions } from "./page-actions.ts";
import type { HtmlVisualization } from "@ace/protocol";
import { resolveHtmlMode } from "@ace/html";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { controlDivider } from "@/components/ui/rules.ts";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { desktopVisualizations } from "@/boot/desktop-visualizations.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { HtmlFrame } from "./html-frame.tsx";
import { useLiveFrame } from "./live-frames.ts";
import { useHtmlTheme, usePageHtml } from "./page-source.ts";
import { visualizationTab } from "./visualization-tab.ts";

/** An action, dimmed until hovered, focused or pressed. */
const action =
  "opacity-60 transition-[background-color,color,transform,opacity] hover:opacity-100 focus-visible:opacity-100 active:opacity-100 motion-reduce:transition-none";

/**
 * A published HTML page, inline in the agent's reply at the message column's full width: no
 * card, no title bar, so it reads as part of the conversation. It shows its whole content height,
 * follows the app theme live, and runs its own scripts in a sandbox that cannot reach the app or
 * the network. Full screen, copy and download sit in one outlined group in a row above
 * it, always shown but dimmed until hovered, focused or pressed; Full
 * screen opens it at the side panel's full size, whose strip adds open in window.
 */
export function HtmlVisualizationView(props: {
  threadId: string;
  visualization: HtmlVisualization;
}) {
  const { visualization } = props;
  const theme = useHtmlTheme();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => setElement(node), []);
  const id = useId();
  const live = useLiveFrame(id, element);
  const [measured, setMeasured] = useState<number>();
  const page = useMemo(
    () => ({ sha256: visualization.document.sha256, bytes: visualization.document.bytes }),
    [visualization.document.sha256, visualization.document.bytes],
  );
  const { html, failed, retry } = usePageHtml(props.threadId, page);
  const mode = useMemo(
    () => (html === undefined ? "static" : resolveHtmlMode(html, visualization.mode)),
    [html, visualization.mode],
  );
  const title = visualization.title;
  const actions = usePageActions({ html, title, theme, mode });
  const panel = useWorkspaceActions(props.threadId);
  const available =
    typeof HTMLIFrameElement !== "undefined" && "sandbox" in HTMLIFrameElement.prototype;
  // The page is shown whole; the agent's height only holds its place until it measures itself.
  const initialHeight = visualization.height ?? 160;
  return (
    <section ref={attach} aria-label={title} className="group/visualization w-full min-w-0">
      {html && (
        <div
          role="toolbar"
          aria-label={`${title} actions`}
          className="flex h-7 items-center justify-end"
        >
          <div className="inline-flex items-center rounded-md p-0.5 shadow-[inset_0_0_0_1px_var(--border)]">
            <IconButton
              size="sm"
              icon={CornersOutIcon}
              label="Full screen"
              className={action}
              onClick={() => panel.open(visualizationTab(visualization))}
            />
            <span aria-hidden className={controlDivider} />
            <IconButton
              size="sm"
              icon={actions.copied ? CheckIcon : CopyIcon}
              label={actions.copied ? "Copied" : "Copy source"}
              className={action}
              onClick={actions.copy}
            />
            <span aria-hidden className={controlDivider} />
            <IconButton
              size="sm"
              icon={DownloadSimpleIcon}
              label="Download"
              className={action}
              onClick={actions.save}
            />
          </div>
        </div>
      )}
      <div className="w-full min-w-0">
        {!available ? (
          <p className="text-ui text-muted-foreground">{title}</p>
        ) : html && live ? (
          <HtmlFrame
            html={html}
            mode={mode}
            title={title}
            theme={theme}
            initialHeight={initialHeight}
            fill={false}
            webview={desktopVisualizations() !== undefined}
            measured={measured}
            onHeight={setMeasured}
          />
        ) : html ? (
          // Unloaded while far from view: hold its place until it comes back.
          <div style={{ height: measured ?? initialHeight }} />
        ) : failed ? (
          <div className="flex items-center gap-2 text-ui text-muted-foreground">
            <span>Couldn't load this visualization.</span>
            <Button size="sm" variant="ghost" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading visualization" className="flex flex-col gap-2">
            <Skeleton className="h-5 w-2/5 rounded-md" />
            <Skeleton className="h-36 w-full rounded-lg" />
          </div>
        )}
      </div>
    </section>
  );
}
