import type { OrchestrationEvent } from "@ace/contracts";

// The event router coalesces and applies all thread events once per animation frame
// (see __root.tsx), so there is no longer a per-event "flush priority" or an
// immediate-flush fast path — every streamed delta is paint-aligned.

interface FrameScheduler {
  readonly request: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
}

type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;

const defaultFrameScheduler: FrameScheduler = {
  request: (callback) =>
    typeof globalThis.requestAnimationFrame === "function"
      ? globalThis.requestAnimationFrame(callback)
      : (globalThis.setTimeout(callback, 16) as unknown as number),
  cancel: (handle) => {
    if (typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(handle);
    }
    globalThis.clearTimeout(handle);
  },
};

export function createOrchestrationUiEventFrameBatcher(
  applyEvents: (events: readonly OrchestrationEvent[]) => void,
  scheduler: FrameScheduler = defaultFrameScheduler,
) {
  let disposed = false;
  let frame: number | null = null;
  let pendingEvents: OrchestrationEvent[] = [];

  const flush = () => {
    if (frame !== null) {
      scheduler.cancel(frame);
      frame = null;
    }
    if (pendingEvents.length === 0) {
      return;
    }
    const events = coalesceOrchestrationUiEvents(pendingEvents);
    pendingEvents = [];
    applyEvents(events);
  };

  return {
    enqueue(event: OrchestrationEvent): void {
      if (disposed) {
        return;
      }
      pendingEvents.push(event);
      if (frame === null) {
        frame = scheduler.request(flush);
      }
    },
    flush,
    dispose(): void {
      disposed = true;
      if (frame !== null) {
        scheduler.cancel(frame);
        frame = null;
      }
      pendingEvents = [];
    },
  };
}

export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    if (
      previous?.type === "thread.activity-appended" &&
      event.type === "thread.activity-appended"
    ) {
      const mergedActivityEvent = coalesceToolOutputActivityEvents(previous, event);
      if (mergedActivityEvent) {
        coalesced[coalesced.length - 1] = mergedActivityEvent;
        continue;
      }
    }

    coalesced.push(event);
  }

  return coalesced;
}

function coalesceToolOutputActivityEvents(
  previous: ThreadActivityAppendedEvent,
  event: ThreadActivityAppendedEvent,
): ThreadActivityAppendedEvent | null {
  const previousActivity = previous.payload.activity;
  const nextActivity = event.payload.activity;
  if (
    previous.payload.threadId !== event.payload.threadId ||
    previousActivity.kind !== "tool.updated" ||
    nextActivity.kind !== "tool.updated" ||
    previousActivity.tone !== "tool" ||
    nextActivity.tone !== "tool" ||
    previousActivity.turnId !== nextActivity.turnId
  ) {
    return null;
  }

  const previousPayload = asRecord(previousActivity.payload);
  const nextPayload = asRecord(nextActivity.payload);
  if (!previousPayload || !nextPayload) {
    return null;
  }
  const previousItemId = asNonEmptyString(previousPayload?.itemId);
  const nextItemId = asNonEmptyString(nextPayload?.itemId);
  const previousStreamKind = asToolOutputStreamKind(previousPayload?.streamKind);
  const nextStreamKind = asToolOutputStreamKind(nextPayload?.streamKind);
  const previousTerminalOutput = asString(previousPayload?.terminalOutput);
  const nextTerminalOutput = asString(nextPayload?.terminalOutput);
  if (
    !previousItemId ||
    previousItemId !== nextItemId ||
    previousStreamKind === null ||
    previousStreamKind !== nextStreamKind ||
    previousTerminalOutput === null ||
    nextTerminalOutput === null
  ) {
    return null;
  }

  return {
    ...event,
    payload: {
      ...event.payload,
      activity: {
        ...previousActivity,
        ...nextActivity,
        createdAt: previousActivity.createdAt,
        ...(previousActivity.sequence !== undefined || nextActivity.sequence !== undefined
          ? { sequence: previousActivity.sequence ?? nextActivity.sequence }
          : {}),
        payload: {
          ...previousPayload,
          ...nextPayload,
          terminalOutput: previousTerminalOutput + nextTerminalOutput,
          ...(previousPayload.terminalOutputTruncated === true ||
          nextPayload.terminalOutputTruncated === true
            ? { terminalOutputTruncated: true }
            : {}),
        },
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  const stringValue = asString(value);
  if (stringValue === null) {
    return null;
  }
  const trimmed = stringValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asToolOutputStreamKind(value: unknown): "command_output" | "file_change_output" | null {
  return value === "command_output" || value === "file_change_output" ? value : null;
}
