import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { workerHeap, type WorkerSession } from "@ace/web-perf";
import { z } from "zod";

type Outcome = "reply" | "detach" | "close" | "send-error" | "protocol-error" | "silent";
class WorkerBoundary extends EventEmitter implements WorkerSession {
  closed = false;
  outcome: Outcome;
  constructor(outcome: Outcome) {
    super();
    this.outcome = outcome;
  }
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "Target.getTargets")
      return { targetInfos: [{ type: "worker", title: "client", url: "", targetId: "worker" }] };
    if (method === "Target.attachToTarget") return { sessionId: "attached" };
    if (method === "Target.sendMessageToTarget") {
      const request = z
        .object({ sessionId: z.literal("attached"), message: z.string() })
        .parse(params);
      const command = z
        .object({ id: z.number(), method: z.string() })
        .parse(JSON.parse(request.message));
      if (this.outcome === "send-error") throw new Error("send rejected");
      queueMicrotask(() => {
        if (this.outcome === "detach")
          this.emit("Target.detachedFromTarget", { sessionId: "attached" });
        if (this.outcome === "close") this.emit("close");
        if (this.outcome === "reply" || this.outcome === "protocol-error")
          this.emit("Target.receivedMessageFromTarget", {
            sessionId: "attached",
            message: JSON.stringify({
              id: command.id,
              ...(this.outcome === "protocol-error"
                ? { error: { message: "heap unavailable" } }
                : {
                    result: command.method === "Runtime.getHeapUsage" ? { usedSize: 1048576 } : {},
                  }),
            }),
          });
      });
    }
    return {};
  }
  async detach() {
    this.closed = true;
  }
}

test.each([
  ["detach", "detached"],
  ["close", "disconnected"],
  ["send-error", "send failed"],
  ["protocol-error", "heap unavailable"],
  ["silent", "timed out"],
] as const)("%s fails the heap sample and releases its session", async (outcome, message) => {
  const session = new WorkerBoundary(outcome);
  await expect(workerHeap({ newBrowserCDPSession: async () => session }, 100)).rejects.toThrow(
    message,
  );
  expect(session.closed).toBe(true);
  // Listeners are resources owned by the request, including on a timed-out live session.
  expect(session.eventNames()).toEqual([]);
});

test("a live worker returns its collected heap and releases its session", async () => {
  const session = new WorkerBoundary("reply");
  expect(await workerHeap({ newBrowserCDPSession: async () => session })).toBe(1048576);
  expect(session.closed).toBe(true);
  expect(session.eventNames()).toEqual([]);
});
