import type { CDPSession } from "@playwright/test";
import { z } from "zod";

export interface WorkerSession {
  send(
    method: Parameters<CDPSession["send"]>[0],
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  on(method: string, listener: (event: unknown) => void): unknown;
  off(method: string, listener: (event: unknown) => void): unknown;
  detach(): Promise<void>;
}
export interface WorkerBrowser {
  newBrowserCDPSession(): Promise<WorkerSession>;
}
/** The client worker's heap, through the browser's own DevTools session (flat protocol off). */
export async function workerHeap(browser: WorkerBrowser, timeoutMs = 10_000): Promise<number> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = z
      .object({
        targetInfos: z.array(
          z.object({ type: z.string(), title: z.string(), url: z.string(), targetId: z.string() }),
        ),
      })
      .parse(await session.send("Target.getTargets"));
    const target = targetInfos.find(
      (info) =>
        (info.type === "worker" || info.type === "shared_worker") &&
        /client/.test(info.title + info.url),
    );
    if (!target) throw new Error("Client worker target missing during heap measurement");
    const { sessionId } = z.object({ sessionId: z.string() }).parse(
      await session.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: false,
      }),
    );
    let id = 0;
    let lost: Error | undefined;
    let failPending: ((error: Error) => void) | undefined;
    const fail = (error: Error) => {
      lost = error;
      failPending?.(error);
    };
    const detached = (raw: unknown) => {
      const event = z.object({ sessionId: z.string() }).safeParse(raw);
      if (event.success && event.data.sessionId === sessionId)
        fail(new Error("Client worker target detached during heap measurement"));
    };
    const disconnected = () => fail(new Error("CDP session disconnected during heap measurement"));
    session.on("Target.detachedFromTarget", detached);
    session.on("close", disconnected);
    const call = (method: string) => {
      if (lost) return Promise.reject(lost);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const ask = ++id;
        const finish = (error?: Error, result?: Record<string, unknown>) => {
          if (failPending !== failRequest) return;
          failPending = undefined;
          clearTimeout(timer);
          session.off("Target.receivedMessageFromTarget", listener);
          if (error) reject(error);
          else resolve(result ?? {});
        };
        const failRequest = (error: Error) => finish(error);
        const listener = (raw: unknown) => {
          const event = z.object({ sessionId: z.string(), message: z.string() }).safeParse(raw);
          if (!event.success || event.data.sessionId !== sessionId) return;
          try {
            const reply = z
              .object({
                id: z.number().optional(),
                result: z.record(z.string(), z.unknown()).optional(),
                error: z.object({ message: z.string() }).optional(),
              })
              .parse(JSON.parse(event.data.message));
            if (reply.id !== ask) return;
            if (reply.error) finish(new Error(`Worker CDP error: ${reply.error.message}`));
            else finish(undefined, reply.result);
          } catch (error) {
            finish(new Error("Invalid worker CDP reply", { cause: error }));
          }
        };
        const timer = setTimeout(
          () => finish(new Error(`Worker CDP request timed out: ${method}`)),
          timeoutMs,
        );
        failPending = failRequest;
        session.on("Target.receivedMessageFromTarget", listener);
        void session
          .send("Target.sendMessageToTarget", {
            sessionId,
            message: JSON.stringify({ id: ask, method }),
          })
          .catch((error: unknown) => finish(new Error("Worker CDP send failed", { cause: error })));
      });
    };
    try {
      await call("HeapProfiler.enable");
      await call("HeapProfiler.collectGarbage");
      await call("HeapProfiler.collectGarbage");
      const usage = z
        .object({ usedSize: z.number().finite().nonnegative() })
        .parse(await call("Runtime.getHeapUsage"));
      return usage.usedSize;
    } finally {
      session.off("Target.detachedFromTarget", detached);
      session.off("close", disconnected);
      if (!lost) await session.send("Target.detachFromTarget", { sessionId });
    }
  } finally {
    await session.detach();
  }
}
