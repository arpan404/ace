import type { ThreadReader } from "@ace/client";
import { useItem, useThreadMeta, useThread } from "@ace/client-react";
import type { Item, ProviderKind } from "@ace/protocol";
import {
  echoesEarlierError,
  handoffSummary,
  inputLine,
  isBareErrorCode,
  modelLabel,
  noticeInput,
  parseDelegationResults,
  providerNames,
  repeatsEarlierEvent,
  settledResults,
  systemInput,
  taskPrompt,
  type EventIcon,
  type EventLine,
  type InputKind,
} from "@ace/ui-core";
import {
  ArrowClockwiseIcon,
  ArrowsLeftRightIcon,
  ClockCounterClockwiseIcon,
  InfoIcon,
  LightningIcon,
  TerminalWindowIcon,
  WarningIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useCallback, useId, useState } from "react";
import { ArtifactLine } from "@/components/attachment-artifact.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { cn } from "@/lib/cn.ts";
import { DelegationCard } from "./delegation-card.tsx";
import { ErrorRow, noticeError } from "./error-row.tsx";
import { ModelFacing } from "./model-facing.tsx";
import { ReviewNote } from "./review-note.tsx";
import { TaskCard } from "./task-card.tsx";
import { MergedForkNotice } from "../transitions/merged-fork-notice.tsx";
import { UserMessage } from "./user-message.tsx";

const icons: Record<EventIcon, PhosphorIcon> = {
  restart: ArrowClockwiseIcon,
  resume: ClockCounterClockwiseIcon,
  background: TerminalWindowIcon,
  switch: ArrowsLeftRightIcon,
  automation: LightningIcon,
};

/**
 * A quiet centred divider for something that happened to the thread rather than in the
 * conversation: a resume, a switch, a handoff. `received` keeps what the model was sent behind
 * a disclosure; `summary` is a handoff's readable summary.
 */
export function EventDivider(props: {
  line: EventLine;
  received?: string | undefined;
  summary?: string | undefined;
}) {
  const { line } = props;
  const Glyph = icons[line.icon];
  const [open, setOpen] = useState(false);
  const body = useId();
  return (
    <div role="note" aria-label={line.text} className="flex flex-col items-center gap-1">
      <Marker variant="separator" className="text-xs">
        <MarkerContent className="inline-flex items-center gap-1.5">
          {line.provider ? (
            <ProviderIcon provider={line.provider} size={12} decorative />
          ) : (
            <Glyph aria-hidden size={13} />
          )}
          {line.text}
        </MarkerContent>
      </Marker>
      {line.note && <p className="text-xs text-subtle-foreground">{line.note}</p>}
      {props.summary && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={body}
            onClick={() => setOpen(!open)}
            className="text-xs text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {open ? "Hide summary" : "Show summary"}
          </button>
          {open && (
            <div
              id={body}
              className="fx-rise-in max-h-72 w-full overflow-auto rounded-md bg-code px-3 py-2 text-sm whitespace-pre-wrap text-muted-foreground"
            >
              {props.summary}
            </div>
          )}
        </>
      )}
      {props.received && !props.summary && <ModelFacing text={props.received} />}
    </div>
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
 * work (IR-8, IR-9, IR-10, IR-11, IR-12, A3): ace's own inputs as dividers and cards, errors as
 * one readable row, notices as one quiet line. Never a chat bubble.
 */
export function EventBlock(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  const thread = useThreadMeta(props.threadId);
  const input = systemInput(item);
  const repeated = useRepeats(props.threadId, props.itemId, input?.kind ?? noticeInput(item));
  const echoed = useEchoedCode(props.threadId, item);
  if (!item || repeated || echoed) return null;
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
        if (results.length) return <DelegationCard results={results} received={input.text} />;
        return (
          <EventDivider
            line={{ icon: "automation", text: "Delegated work finished" }}
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
            <EventDivider
              line={line}
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
      if (item.raw.some((raw) => raw.type === "permission.reviewed"))
        return <ReviewNote threadId={props.threadId} item={item} />;
      const kind = noticeInput(item);
      const line = kind && inputLine({ kind, text: item.text });
      if (line) return <EventDivider line={line} received={item.text} />;
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
        <Marker variant="separator" className="text-xs">
          <MarkerContent>Context compacted</MarkerContent>
        </Marker>
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
      return <DelegationItem item={item} />;
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
  const first = props.text.split("\n").find((line) => line.trim()) ?? "";
  const more = props.text.trim() !== first.trim();
  return (
    <div className="flex items-start gap-2 text-ui text-muted-foreground">
      <InfoIcon aria-hidden size={16} className="mt-px shrink-0 text-subtle-foreground" />
      <div className="min-w-0 flex-1">
        <p className={cn(!open && "truncate", open && "whitespace-pre-wrap")}>
          {open ? props.text : first}
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

/** #116's delegation lifecycle items, read structurally until their types reach this build. */
function DelegationItem(props: { item: Item }) {
  const results = settledResults(props.item);
  if (results?.length) return <DelegationCard results={results} />;
  if ((props.item.type as string) !== "delegation.started") return null;
  const record = props.item as unknown as Record<string, unknown>;
  const title = typeof record["title"] === "string" ? record["title"] : "a new thread";
  const childThreadId = typeof record["childThreadId"] === "string" ? record["childThreadId"] : "";
  const provider = record["provider"] as ProviderKind | undefined;
  const model = typeof record["model"] === "string" ? record["model"] : undefined;
  return (
    <p className="flex items-center gap-2 text-ui text-muted-foreground">
      {provider && <ProviderIcon provider={provider} model={model} size={14} decorative />}
      <span>
        Delegated to <b className="font-medium text-foreground">{title}</b>
        {provider ? ` · ${providerNames[provider] ?? provider}` : ""}
        {model ? ` · ${modelLabel(model)}` : ""}
      </span>
      {childThreadId && (
        <Link
          to="/t/$threadId"
          params={{ threadId: childThreadId }}
          className="ml-auto text-xs underline-offset-2 hover:text-foreground hover:underline"
        >
          Open thread
        </Link>
      )}
    </p>
  );
}
