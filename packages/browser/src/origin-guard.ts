import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

const Paused = z.object({ requestId: z.string(), request: z.object({ url: z.string() }) });
const Attached = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ targetId: z.string(), type: z.string() }),
});
const Received = z.object({ sessionId: z.string(), message: z.string().max(1024 * 1024) });
const Response = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  error: z.unknown().optional(),
});
type Send = (
  method: Parameters<BrowserCdp["send"]>[0],
  params?: Record<string, unknown>,
) => Promise<unknown>;

/** Fetch must be enabled on out-of-process frames and dedicated workers too.
 * Nested target sessions use the public CDP Target API, not Playwright internals. */
export async function installOriginGuard(
  cdp: BrowserCdp,
  allowed: (url: string) => Promise<boolean>,
) {
  const children = new Map<string, { send: Send; parent: Send }>();
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const root: Send = (method, params) => cdp.send(method, params);
  let nextId = 0,
    checks = 0,
    stopped = false;
  let initializing: Promise<unknown> = Promise.resolve();

  function sendChild(parent: Send, sessionId: string): Send {
    return (method, params) => {
      if (stopped || pending.size >= 128)
        return Promise.reject(new Error("Browser target command limit"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Browser target command timed out"));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        void parent("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        }).catch((error: unknown) => {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        });
      });
    };
  }
  function paused(send: Send, raw: unknown): void {
    const request = Paused.safeParse(raw);
    if (!request.success) return;
    void (async () => {
      let approved = false;
      if (checks < 32 && !stopped) {
        checks++;
        try {
          approved = await allowed(request.data.request.url);
        } catch {
          /* Deny policy errors. */
        } finally {
          checks--;
        }
      }
      await send(approved ? "Fetch.continueRequest" : "Fetch.failRequest", {
        requestId: request.data.requestId,
        ...(!approved ? { errorReason: "BlockedByClient" } : {}),
      });
    })().catch(() => {});
  }
  function attached(parent: Send, raw: unknown): void {
    const parsed = Attached.safeParse(raw);
    if (!parsed.success) return;
    const { sessionId, targetInfo } = parsed.data;
    if (stopped || children.size >= 64 || !["iframe", "worker"].includes(targetInfo.type)) {
      void root("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => {});
      return;
    }
    const send = sendChild(parent, sessionId);
    children.set(sessionId, { send, parent });
    const init = (async () => {
      await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      await send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: false,
      });
      await send("Runtime.runIfWaitingForDebugger");
    })().catch(() => root("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => {}));
    initializing = Promise.all([initializing, init]).then(() => undefined);
  }
  function received(raw: unknown): void {
    const event = Received.safeParse(raw);
    if (!event.success) return;
    const child = children.get(event.data.sessionId);
    if (!child) return;
    let message: z.infer<typeof Response>;
    try {
      message = Response.parse(JSON.parse(event.data.message));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error("Browser target command failed"));
        else waiter.resolve(undefined);
      }
    }
    if (message.method === "Fetch.requestPaused") paused(child.send, message.params);
    if (message.method === "Target.attachedToTarget") attached(child.send, message.params);
    if (message.method === "Target.receivedMessageFromTarget") received(message.params);
    if (message.method === "Target.detachedFromTarget") detached(message.params);
  }
  function detached(raw: unknown): void {
    const result = z.object({ sessionId: z.string() }).safeParse(raw);
    if (result.success) children.delete(result.data.sessionId);
  }
  const rootPaused = (raw: unknown) => paused(root, raw);
  const rootAttached = (raw: unknown) => attached(root, raw);
  cdp.on("Fetch.requestPaused", rootPaused);
  cdp.on("Target.attachedToTarget", rootAttached);
  cdp.on("Target.receivedMessageFromTarget", received);
  cdp.on("Target.detachedFromTarget", detached);
  await root("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await root("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
  });
  return {
    ready: () => initializing,
    close() {
      stopped = true;
      cdp.off("Fetch.requestPaused", rootPaused);
      cdp.off("Target.attachedToTarget", rootAttached);
      cdp.off("Target.receivedMessageFromTarget", received);
      cdp.off("Target.detachedFromTarget", detached);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Browser target closed"));
      }
      pending.clear();
      children.clear();
    },
  };
}
