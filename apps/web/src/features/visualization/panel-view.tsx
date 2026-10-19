import { useMemo, useState } from "react";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  DownloadSimpleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { resolveHtmlMode } from "@ace/html";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { desktopVisualizations } from "@/boot/desktop-visualizations.ts";
import type { TabViewProps } from "@/lib/workspace/index.ts";
import { HtmlFrame } from "./html-frame.tsx";
import { usePageActions } from "./page-actions.ts";
import { useHtmlTheme, usePageHtml, type PageDocument } from "./page-source.ts";
import { visualizationTabData, type VisualizationTabData } from "./visualization-tab.ts";

/**
 * A published page opened beside the conversation: it fills the side panel, scrolls inside it
 * and keeps following the app theme. It is a second live copy; the reply keeps its own.
 */
export default function VisualizationPanel(props: TabViewProps) {
  const data = visualizationTabData(props.tab);
  if (!data)
    return (
      <EmptyState
        icon={WarningCircleIcon}
        title="This visualization can't open"
        description="Open it again from the conversation."
      />
    );
  return <PanelPage threadId={props.scope} data={data} />;
}

function PanelPage(props: { threadId: string; data: VisualizationTabData }) {
  const { data } = props;
  const theme = useHtmlTheme();
  const page: PageDocument = useMemo(
    () => ({ sha256: data.sha256, bytes: data.bytes }),
    [data.sha256, data.bytes],
  );
  const { html, failed, retry } = usePageHtml(props.threadId, page);
  const mode = useMemo(
    () => (html === undefined ? "static" : resolveHtmlMode(html, data.mode)),
    [html, data.mode],
  );
  const [measured, setMeasured] = useState<number>();
  return (
    <section aria-label={data.title} className="flex h-full min-h-0 flex-col bg-background">
      <h2 className="sr-only">{data.title}</h2>
      <div className="min-h-0 flex-1 px-5 pt-4">
        {html ? (
          <HtmlFrame
            html={html}
            mode={mode}
            title={data.title}
            theme={theme}
            initialHeight={160}
            fill
            webview={desktopVisualizations() !== undefined}
            measured={measured}
            onHeight={setMeasured}
          />
        ) : failed ? (
          <EmptyState
            icon={WarningCircleIcon}
            title="Couldn't load this visualization"
            action={
              <Button size="sm" variant="secondary" onClick={retry}>
                Try again
              </Button>
            }
          />
        ) : (
          <div role="status" aria-label="Loading visualization" className="flex flex-col gap-3">
            <Skeleton className="h-6 w-1/3 rounded-md" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        )}
      </div>
    </section>
  );
}

/** The strip's buttons while a visualization shows: Open in window, Copy source, Download. */
export function VisualizationActions(props: TabViewProps) {
  const data = visualizationTabData(props.tab);
  if (!data) return null;
  return <PanelActions threadId={props.scope} data={data} />;
}

function PanelActions(props: { threadId: string; data: VisualizationTabData }) {
  const { data } = props;
  const theme = useHtmlTheme();
  const page = useMemo(
    () => ({ sha256: data.sha256, bytes: data.bytes }),
    [data.sha256, data.bytes],
  );
  // The same cached page the view draws.
  const { html } = usePageHtml(props.threadId, page);
  const mode = html === undefined ? "static" : resolveHtmlMode(html, data.mode);
  const actions = usePageActions({ html, title: data.title, theme, mode });
  const disabled = html === undefined;
  return (
    <>
      <IconButton
        size="sm"
        className="size-7"
        icon={ArrowSquareOutIcon}
        label="Open in window"
        disabled={disabled}
        onClick={actions.open}
      />
      <IconButton
        size="sm"
        className="size-7"
        icon={actions.copied ? CheckIcon : CopyIcon}
        label={actions.copied ? "Copied" : "Copy source"}
        disabled={disabled}
        onClick={actions.copy}
      />
      <IconButton
        size="sm"
        className="size-7"
        icon={DownloadSimpleIcon}
        label="Download"
        disabled={disabled}
        onClick={actions.save}
      />
    </>
  );
}
