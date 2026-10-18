import type { ClientApi } from "@ace/client";
import {
  BrowserAnnotationCapture,
  BrowserAnnotationConfig,
  BrowserAnnotationEvent,
  ThreadId,
  type BrowserCommand,
} from "@ace/protocol";
import type { AnnotationDriver } from "@/features/annotations/index.ts";

/** A page capture can take a few hundred milliseconds while the overlay hides its bar. */
const captureTimeoutMs = 20_000;

/**
 * Annotate mode over the browser relay (ADR 0082): commands go as `browser.execute`, events
 * arrive as `browser.annotation` messages for this connection only and are decoded leniently,
 * so a kind this client doesn't know is skipped.
 */
export function daemonAnnotate(
  client: ClientApi,
  request: ClientApi["request"],
): AnnotationDriver & { dispose(): void } {
  const listeners = new Map<string, Set<(event: BrowserAnnotationEvent) => void>>();
  let stop: (() => void) | undefined;
  try {
    stop = client.onMessage((message) => {
      if (message.type !== "browser.annotation") return;
      const event = BrowserAnnotationEvent.safeParse(message.event);
      if (!event.success) return;
      for (const listener of listeners.get(message.threadId) ?? []) listener(event.data);
    });
  } catch {
    // A closed client: nothing will arrive.
  }
  const execute = async (
    threadId: string,
    command: Extract<BrowserCommand, { action: "annotate" | "annotate_capture" }>,
    timeoutMs?: number,
  ) => {
    const reply = await request(
      { type: "browser.execute", threadId: ThreadId.parse(threadId), command },
      timeoutMs ? { timeoutMs } : undefined,
    );
    if (!reply.ok) throw new Error(reply.error ?? "browser_failed");
    return reply.result;
  };
  return {
    async start(threadId, config) {
      const result = await execute(threadId, {
        action: "annotate",
        operation: "start",
        config: BrowserAnnotationConfig.parse(config),
      });
      const documentId =
        typeof result === "object" && result !== null && "documentId" in result
          ? String(result.documentId)
          : "";
      return { documentId };
    },
    async stop(threadId) {
      await execute(threadId, { action: "annotate", operation: "stop" });
    },
    async command(threadId, command) {
      await execute(threadId, { action: "annotate", operation: "command", command });
    },
    async capture(threadId, target) {
      return BrowserAnnotationCapture.parse(
        await execute(threadId, { action: "annotate_capture", target }, captureTimeoutMs),
      );
    },
    events(threadId, listener) {
      const set = listeners.get(threadId) ?? new Set();
      set.add(listener);
      listeners.set(threadId, set);
      return () => {
        set.delete(listener);
        if (!set.size && listeners.get(threadId) === set) listeners.delete(threadId);
      };
    },
    dispose() {
      stop?.();
      listeners.clear();
    },
  };
}
