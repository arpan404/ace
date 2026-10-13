import type { ThreadReader } from "@ace/client";
import { useItem, useThreadMeta, useThread } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import {
  displayNotice,
  sanitizeUserText,
  echoesEarlierError,
  handoffSummary,
  inputLine,
  isBareErrorCode,
  noticeInput,
  parseDelegationResults,
  refusalCount,
  repeatsEarlierEvent,
  settledResults,
  systemInput,
  taskPrompt,
  toolRefusal,
  type EventIcon,
  type EventLine,
  type InputKind,
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
import { lazy, Suspense, useCallback, useState } from "react";
import { ArtifactLine } from "@/components/attachment-artifact.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { cn } from "@/lib/cn.ts";
import { DelegationCard } from "./delegation-card.tsx";
import { ErrorRow, noticeError } from "./error-row.tsx";
import { RefusalRow } from "./refusal-row.tsx";
import { ReviewNote } from "./review-note.tsx";
import { SystemRow } from "./system-row.tsx";
import { TaskCard } from "./task-card.tsx";
import { MergedForkNotice } from "../transitions/merged-fork-notice.tsx";
import { UserMessage } from "./user-message.tsx";

const HtmlView = lazy(() =>
  import("./html-visualization.tsx").then((module) => ({ default: module.HtmlVisualizationView })),
);

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

/** The same ace event, already shown just above (a restart notice and its echoed input). */
function useRepeats(threadId: string, itemId: string, kind: InputKind | undefined): boolean {
  const read = useCallback(
    (reader: ThreadReader) => {
      if (!kind) return false;
      const index = reader.order.indexOf(itemId);
      return index > 0 && repeatsEarlierEvent(reader.order, index, (id) => reader.item(id), kind);
    },
    [itemId, kind],
  );
  return useThread(threadId, ["order"], read) ?? false;
}

/** How many identical refusals this row stands for; 0 when an earlier row already counts it. */
function useRefusalCount(threadId: string, itemId: string, refused: boolean): number {
  const read = useCallback(
    (reader: ThreadReader) =>
      refused
        ? refusalCount(reader.order, reader.order.indexOf(itemId), (id) => reader.item(id))
        : 1,
    [itemId, refused],
  );
  return useThread(threadId, ["order"], read) ?? 1;
}

/** A bare error code that only repeats the error just above it (IR-12). */
function useEchoedCode(threadId: string, item: Item | undefined): boolean {
  const echo = item?.type === "notice" && isBareErrorCode(item.text);
  const id = item?.id ?? "";
  const read = useCallback(
    (reader: ThreadReader) => {
      if (!echo) return false;
      return echoesEarlierError(reader.order, reader.order.indexOf(id), (key) => reader.item(key));
    },
    [echo, id],
  );
  return useThread(threadId, ["order"], read) ?? false;
}

/**
 * Anything in the transcript that is neither the person's words nor the agent's answer or
 * work (IR-8, IR-9, IR-10, IR-11, IR-12, A3): ace's own inputs as quiet rows and cards, errors as
 * one readable row, notices as one quiet line. Never a chat bubble.
 */
export function EventBlock(props: { threadId: string; itemId: string }) {
  const stored = useItem(props.threadId, props.itemId);
  const item = stored?.type === "notice" ? displayNotice(stored) : stored;
  const thread = useThreadMeta(props.threadId);
  const input = systemInput(item);
  const repeated = useRepeats(props.threadId, props.itemId, input?.kind ?? noticeInput(item));
  const echoed = useEchoedCode(props.threadId, item);
  const refusal = toolRefusal(item);
  const refusals = useRefusalCount(props.threadId, props.itemId, !!refusal);
  if (!item || repeated || echoed) return null;
  if (refusal) return refusals ? <RefusalRow refusal={refusal} count={refusals} /> : null;
  if (item.type === "message" && item.mergedContext)
    return <MergedForkNotice context={item.mergedContext} />;
  // A candidate the exact check rejects is the person's own message.
  if (!input && item.type === "message" && item.role === "user" && !item.synthetic)
    return <UserMessage threadId={props.threadId} itemId={props.itemId} />;
  if (input) {
    switch (input.kind) {
      // The question block above already shows the answer with its question.
      case "interaction_answer":
        return null;
      case "subagent_result": {
        const results = parseDelegationResults(input.text);
        if (results.length)
          return (
            <DelegationCard
              threadId={props.threadId}
              results={results}
              received={input.text}
              at={item.createdAt}
            />
          );
        return (
          <EventRow
            line={{ icon: "automation", text: "Delegated work finished" }}
            at={item.createdAt}
            received={input.text}
          />
        );
      }
      case "spawn":
      case "parent_agent":
      case "automation": {
        const prompt = taskPrompt(input);
        if (prompt) return <TaskCard prompt={prompt} />;
        break;
      }
      default: {
        const line = inputLine(input);
        if (line)
          return (
            <EventRow
              line={line}
              at={item.createdAt}
              received={input.text}
              summary={input.kind === "handoff" ? handoffSummary(input.text) : undefined}
            />
          );
      }
    }
    return <QuietText text={input.text} />;
  }
  switch (item.type) {
    case "notice": {
      if (item.code === "input_queued") return null;
      if (item.raw.some((raw) => raw.type === "permission.reviewed"))
        return <ReviewNote threadId={props.threadId} item={item} />;
      const kind = noticeInput(item);
      const line = kind && inputLine({ kind, text: item.text });
      if (line) return <EventRow line={line} at={item.createdAt} received={item.text} />;
      if (item.level === "error") {
        const error = noticeError(item);
        return (
          <ErrorRow
            error={{
              ...error,
              provider: error.provider ?? thread?.provider,
              model: error.model ?? item.executionSource?.selection.model,
            }}
          />
        );
      }
      return <NoticeLine level={item.level} text={item.text} />;
    }
    case "compaction":
      return (
        <SystemRow
          text="Context compacted"
          at={item.createdAt}
          icon={<ArrowsInLineVerticalIcon aria-hidden size={14} />}
        />
      );
    case "html":
      return (
        <Suspense
          fallback={<div role="status" aria-label="Loading visualization" className="h-40" />}
        >
          <HtmlView threadId={props.threadId} visualization={item.visualization} />
        </Suspense>
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
    case "message":
      return (
        <QuietText
          text={item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")}
        />
      );
    default:
      return <DelegationItem threadId={props.threadId} item={item} />;
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
  const text = sanitizeUserText(props.text);
  if (!text) return null;
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

/** Canonical result receipts render at their delivery point; launches belong to the grouped card. */
function DelegationItem(props: { threadId: string; item: Item }) {
  const results = settledResults(props.item);
  return results?.length ? (
    <DelegationCard threadId={props.threadId} results={results} at={props.item.createdAt} />
  ) : null;
}
