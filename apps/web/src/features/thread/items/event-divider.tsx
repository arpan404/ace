import type { ThreadReader } from "@ace/client";
import { useItem, useThreadMeta, useThread } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import {
  eventCounts,
  eventView,
  type EventCounts,
  type EventIcon,
  type EventLine,
} from "@ace/ui-core";
import {
  ArrowClockwiseIcon,
  ArrowsInLineVerticalIcon,
  ArrowsLeftRightIcon,
  ClockCounterClockwiseIcon,
  InfoIcon,
  LightningIcon,
  TerminalWindowIcon,
  WarningIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Suspense, useCallback, useState } from "react";
import { ArtifactLine } from "@/components/attachment-artifact.tsx";
import { PostedImage } from "@/components/attachment-tiles.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { DelegationCard } from "./delegation-card.tsx";
import { HandoffDivider } from "./handoff-divider.tsx";
import { ErrorRow } from "./error-row.tsx";
import { NotSentNotice } from "./not-sent-notice.tsx";
import { RefusalRow } from "./refusal-row.tsx";
import { SystemRow } from "./system-row.tsx";
import { TaskCard } from "./task-card.tsx";
import { MergedForkNotice } from "../transitions/merged-fork-notice.tsx";
import { UserMessage } from "./user-message.tsx";
import { VisualizationItem } from "@/features/visualization/index.ts";

const icons: Record<EventIcon, PhosphorIcon> = {
  restart: ArrowClockwiseIcon,
  resume: ClockCounterClockwiseIcon,
  background: TerminalWindowIcon,
  switch: ArrowsLeftRightIcon,
  automation: LightningIcon,
};

/**
 * Something that happened to the thread rather than in the conversation (a resume, a switch, a
 * handoff) as one muted row. The line's note, a handoff's readable `summary` and otherwise what
 * the model was sent (`received`) wait behind the row's own caret.
 */
export function EventRow(props: {
  line: EventLine;
  at?: number | undefined;
  received?: string | undefined;
  summary?: string | undefined;
}) {
  const { line } = props;
  const Glyph = icons[line.icon];
  const shown = props.summary ?? props.received;
  return (
    <SystemRow
      text={line.text}
      at={props.at}
      icon={
        line.provider ? (
          <ProviderIcon provider={line.provider} size={14} decorative />
        ) : (
          <Glyph aria-hidden size={14} />
        )
      }
    >
      {(line.note || shown) && (
        <>
          {line.note && <p>{line.note}</p>}
          {shown && (
            <p className={cn(line.note && "mt-1", !props.summary && "font-mono")}>{shown}</p>
          )}
        </>
      )}
    </SystemRow>
  );
}

const sameCounts = (a: EventCounts, b: EventCounts) =>
  a.repeated === b.repeated &&
  a.echoed === b.echoed &&
  a.refusals === b.refusals &&
  a.failures === b.failures;

/** What the rows around this one decide about it: repeats, echoes and ×N counts. */
function useEventCounts(threadId: string, itemId: string): EventCounts | undefined {
  const read = useCallback((reader: ThreadReader) => eventCounts(reader, itemId), [itemId]);
  return useThread(threadId, ["order", `item:${itemId}`], read, sameCounts);
}

/**
 * Anything in the transcript that is neither the person's words nor the agent's answer or
 * work, drawn as `eventView` decides (shared with the native apps): ace's own inputs as quiet
 * rows and cards, errors as one readable row, notices as one quiet line. Never a chat bubble.
 */
export function EventBlock(props: { threadId: string; itemId: string }) {
  const stored = useItem(props.threadId, props.itemId);
  const thread = useThreadMeta(props.threadId);
  const counts = useEventCounts(props.threadId, props.itemId);
  if (!stored || !counts) return null;
  const view = eventView(stored, counts, thread?.provider);
  switch (view.kind) {
    case "none":
      return null;
    case "refusal":
      return <RefusalRow refusal={view.refusal} count={view.count} />;
    case "merged":
      return <MergedForkNotice context={view.context} />;
    case "user":
      return <UserMessage threadId={props.threadId} itemId={props.itemId} />;
    case "handoff":
      return <HandoffDivider marker={view.marker} at={view.at} />;
    case "delegation":
      return (
        <DelegationCard threadId={props.threadId} results={view.results} received={view.received} />
      );
    case "event":
      return (
        <EventRow line={view.line} at={view.at} received={view.received} summary={view.summary} />
      );
    case "task":
      return <TaskCard prompt={view.prompt} />;
    case "system":
      return (
        <SystemRow
          text={view.text}
          at={view.at}
          icon={
            view.icon === "restart" ? (
              <ArrowClockwiseIcon aria-hidden size={14} />
            ) : (
              <ArrowsInLineVerticalIcon aria-hidden size={14} />
            )
          }
        />
      );
    case "notSent":
      return (
        <NotSentNotice threadId={props.threadId} notice={view.notice} commandId={view.commandId} />
      );
    case "error":
      return <ErrorRow count={view.count} error={view.error} />;
    case "notice":
      return <NoticeLine level={view.level} text={view.text} />;
    case "quiet":
      return <QuietText text={view.text} />;
    case "html":
    case "image":
    case "artifact":
      return <PostedItem threadId={props.threadId} item={stored} />;
  }
}

/** Something the agent published: a visualization, an image or a file. */
function PostedItem(props: { threadId: string; item: Item }) {
  const { item } = props;
  switch (item.type) {
    case "html":
      return (
        <Suspense
          fallback={<div role="status" aria-label="Loading visualization" className="h-40" />}
        >
          <VisualizationItem threadId={props.threadId} visualization={item.visualization} />
        </Suspense>
      );
    case "image":
      return (
        <PostedImage
          threadId={props.threadId}
          attachment={item.image.attachment}
          alt={item.image.alt}
          caption={item.image.caption}
        />
      );
    case "artifact":
      return (
        <ArtifactLine
          threadId={props.threadId}
          path={item.path}
          mimeType={item.mimeType}
          artifactId={item.artifactId}
          bytes={item.bytes}
          filename={item.filename}
        />
      );
    default:
      return null;
  }
}

function NoticeLine(props: { level: "info" | "warning" | "error"; text: string }) {
  return (
    <p className="flex items-start gap-2 text-ui text-muted-foreground">
      {props.level === "info" ? (
        <InfoIcon aria-hidden size={16} className="mt-px shrink-0 text-subtle-foreground" />
      ) : (
        <WarningIcon aria-hidden size={16} className="mt-px shrink-0 text-subtle-foreground" />
      )}
      <span className="whitespace-pre-wrap">{props.text}</span>
    </p>
  );
}

/** A message the provider injected that ace has no words for: one line, the rest on demand. */
function QuietText(props: { text: string }) {
  const [open, setOpen] = useState(false);
  const text = props.text;
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  const more = text.trim() !== first.trim();
  return (
    <div className="flex items-start gap-2 text-ui text-muted-foreground">
      <InfoIcon aria-hidden size={16} className="mt-px shrink-0 text-subtle-foreground" />
      <div className="min-w-0 flex-1">
        <p className={cn(!open && "truncate", open && "whitespace-pre-wrap")}>
          {open ? text : first}
        </p>
        {more && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {open ? "Show less" : "Show all"}
          </button>
        )}
      </div>
    </div>
  );
}
