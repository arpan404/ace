import { z } from "zod";

const Paused = z.looseObject({ request: z.looseObject({ url: z.string() }) });
const TabEvent = z.looseObject({ tabId: z.string(), method: z.string(), params: z.unknown() });
const Received = z.looseObject({ sessionId: z.string(), message: z.string() });
const Message = z.looseObject({ method: z.string().optional(), params: z.unknown().optional() });

/** Policy needs request identity and provenance, never POST bytes. Keep unknown metadata.
 * CDP nests target events in JSON strings; native tabs add a second envelope. */
export function compactPolicyEvent(method: string, raw: unknown): unknown {
  return compact(method, raw, 0);
}
function compact(method: string, raw: unknown, depth: number): unknown {
  if (depth > 16) throw new Error("Browser policy event nesting limit");
  if (method === "Fetch.requestPaused") {
    const event = Paused.parse(raw);
    delete event.request["postData"];
    delete event.request["postDataEntries"];
    return event;
  }
  if (method === "ace.tabs.event") {
    const event = TabEvent.parse(raw);
    return { ...event, params: compact(event.method, event.params, depth + 1) };
  }
  if (method === "Target.receivedMessageFromTarget") {
    const event = Received.parse(raw);
    if (event.message.length > 64 * 1024 * 1024)
      throw new Error("Browser policy event payload limit");
    const message = Message.parse(JSON.parse(event.message));
    if (!message.method) return raw;
    return {
      ...event,
      message: JSON.stringify({
        ...message,
        params: compact(message.method, message.params, depth + 1),
      }),
    };
  }
  return raw;
}
