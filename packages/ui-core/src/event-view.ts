import type { Item, ProviderKind } from "@ace/protocol";
import { sanitizeUserText, stripAceOriginMarker } from "@ace/native-session/user-text";
import {
  describeProviderError,
  echoesEarlierError,
  isBareErrorCode,
  isLimitError,
  type ErrorInput,
} from "./error-display.ts";
import { handoffMarker, type HandoffMarker } from "./handoff-marker.ts";
import { notSentCommand } from "./not-sent.ts";
import { noticeError } from "./notice-error.ts";
import { displayNotice } from "./notice-text.ts";
import { failureCount } from "./repeated-events.ts";
import {
  handoffSummary,
  inputLine,
  interruptionNotice,
  noticeInput,
  parseDelegationResults,
  repeatsEarlierEvent,
  settledResults,
  systemInput,
  taskPrompt,
  type DelegationResult,
  type EventLine,
  type TaskPrompt,
} from "./system-events.ts";
import { refusalCount, toolRefusal, type ToolRefusal } from "./tool-refusals.ts";
import { usageWarning } from "./usage-warning.ts";

/*
 * What an item that is neither the person's words nor the agent's answer or work shows as
 * (IR-8, IR-9, IR-10, IR-11, IR-12, A3): ace's own inputs as quiet rows and cards, errors as one
 * readable row, notices as one quiet line, a handoff as the one centred divider. Never a chat
 * bubble. Web and native draw the same decision. Pure over the thread's order.
 */

type Notice = Extract<Item, { type: "notice" }>;
type Message = Extract<Item, { type: "message" }>;

/** What the rows around an event decide about it. */
export interface EventCounts {
  /** The same ace event is already shown just above (a restart notice and its echoed input). */
  repeated: boolean;
  /** A bare error code that only repeats the error just above it. */
  echoed: boolean;
  /** How many identical refusals this row stands for; 0 when an earlier row counts it. */
  refusals: number;
  /** How many identical failures this row stands for; 0 when an earlier row counts it. */
  failures: number;
}

export type EventView =
  | { kind: "none" }
  /** The person's own message after all: draw the bubble. */
  | { kind: "user" }
  | { kind: "refusal"; refusal: ToolRefusal; count: number }
  | { kind: "merged"; context: NonNullable<Message["mergedContext"]> }
  | { kind: "handoff"; marker: HandoffMarker; at: number }
  | { kind: "delegation"; results: DelegationResult[]; received?: string | undefined }
  /** One quiet row; the note, summary or what the model received open from it. */
  | {
      kind: "event";
      line: EventLine;
      at: number;
      received?: string | undefined;
      summary?: string | undefined;
    }
  | { kind: "task"; prompt: TaskPrompt }
  /** A row with nothing to open: "Context compacted", an interruption. */
  | { kind: "system"; icon: "restart" | "compaction"; text: string; at: number }
  | { kind: "notSent"; notice: Notice; commandId: string }
  | { kind: "error"; error: ErrorInput; count: number }
  | { kind: "notice"; level: Notice["level"]; text: string }
  /** Injected text ace has no words for: its first line, the rest on demand. */
  | { kind: "quiet"; text: string }
  | { kind: "html" | "image" | "artifact" };

interface Reader {
  readonly order: readonly string[];
  item(id: string): Item | undefined;
}

/** The item as shown: a notice the person never needs to read is none. */
function shown(stored: Item | undefined): Item | undefined {
  return stored?.type === "notice" ? displayNotice(stored) : stored;
}

/** The neighbour reads behind an event's row, from the thread's order. */
export function eventCounts(reader: Reader, itemId: string): EventCounts {
  const stored = reader.item(itemId);
  const item = shown(stored);
  const index = reader.order.indexOf(itemId);
  const lookup = (id: string) => reader.item(id);
  const kind = systemInput(item)?.kind ?? noticeInput(item);
  const refused = !!toolRefusal(item);
  const failed = !refused && item?.type === "notice" && item.level === "error";
  return {
    repeated: !!kind && index > 0 && repeatsEarlierEvent(reader.order, index, lookup, kind),
    echoed:
      item?.type === "notice" &&
      isBareErrorCode(item.text) &&
      echoesEarlierError(reader.order, index, lookup),
    refusals: refused ? refusalCount(reader.order, index, lookup) : 1,
    failures: failed ? failureCount(reader.order, index, lookup) : 1,
  };
}

/** Whether an item's row depends on the rows around it, so it must be read again as they change. */
export function eventFollowsOrder(stored: Item | undefined): boolean {
  const item = shown(stored);
  return (
    !!systemInput(item) ||
    !!noticeInput(item) ||
    !!toolRefusal(item) ||
    (item?.type === "notice" && item.level === "error")
  );
}

const none = { kind: "none" } as const;

function quiet(text: string): EventView {
  const clean = sanitizeUserText(text);
  return clean ? { kind: "quiet", text: clean } : none;
}

/**
 * How an event item shows. `provider` names the thread's provider for an error that doesn't say
 * whose it is.
 */
export function eventView(
  stored: Item | undefined,
  counts: EventCounts,
  provider?: ProviderKind | undefined,
): EventView {
  if (usageWarning(stored)) return none;
  const item = shown(stored);
  if (!item || counts.repeated || counts.echoed) return none;
  const refusal = toolRefusal(item);
  if (refusal) return counts.refusals ? { kind: "refusal", refusal, count: counts.refusals } : none;
  if (item.type === "message" && item.mergedContext)
    return { kind: "merged", context: item.mergedContext };
  const input = systemInput(item);
  // A candidate the exact check rejects is the person's own message.
  if (!input && item.type === "message" && item.role === "user" && !item.synthetic)
    return { kind: "user" };
  if (input) {
    const marker = input.kind === "handoff" ? handoffMarker(item) : undefined;
    if (marker) return { kind: "handoff", marker, at: item.createdAt };
    switch (input.kind) {
      // The question block above already shows the answer with its question.
      case "interaction_answer":
        return none;
      case "subagent_result": {
        const results = parseDelegationResults(input.text);
        if (results.length) return { kind: "delegation", results, received: input.text };
        return {
          kind: "event",
          line: { icon: "automation", text: "Delegated work finished" },
          at: item.createdAt,
          received: stripAceOriginMarker(input.text.trimStart()),
        };
      }
      case "spawn":
      case "parent_agent":
      case "automation": {
        const prompt = taskPrompt(input);
        if (prompt) return { kind: "task", prompt };
        break;
      }
      default: {
        const line = inputLine(input);
        if (line)
          return {
            kind: "event",
            line,
            at: item.createdAt,
            received: input.text,
            summary: input.kind === "handoff" ? handoffSummary(input.text) : undefined,
          };
      }
    }
    return quiet(input.text);
  }
  switch (item.type) {
    case "notice":
      return noticeView(item, counts, provider);
    case "compaction":
      return { kind: "system", icon: "compaction", text: "Context compacted", at: item.createdAt };
    case "html":
    case "image":
    case "artifact":
      return { kind: item.type };
    case "message":
      return quiet(
        item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
      );
    default: {
      const results = settledResults(item);
      return results?.length ? { kind: "delegation", results } : none;
    }
  }
}

function noticeView(
  item: Notice,
  counts: EventCounts,
  provider: ProviderKind | undefined,
): EventView {
  if (item.code === "input_queued") return none;
  // One quiet row; Continue lives on the pill over the composer, not here.
  if (interruptionNotice(item))
    return { kind: "system", icon: "restart", text: item.text, at: item.createdAt };
  const kind = noticeInput(item);
  const line = kind && inputLine({ kind, text: item.text });
  if (line) return { kind: "event", line, at: item.createdAt, received: item.text };
  const commandId = notSentCommand(item);
  if (commandId) return { kind: "notSent", notice: item, commandId };
  if (item.level === "error") {
    if (!counts.failures) return none;
    const error = noticeError(item);
    // A usage or rate limit pauses the turn: the composer's strip says so while it holds.
    if (isLimitError(describeProviderError(error))) return none;
    return {
      kind: "error",
      count: counts.failures,
      error: {
        ...error,
        provider: error.provider ?? provider,
        model: error.model ?? item.executionSource?.selection.model,
      },
    };
  }
  return { kind: "notice", level: item.level, text: item.text };
}
