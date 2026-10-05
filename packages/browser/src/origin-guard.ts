import { EventEmitter } from "node:events";
import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

const Paused = z.object({
  responseStatusCode: z.number().optional(),
  responseHeaders: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  requestId: z.string(),
  redirectedRequestId: z.string().optional(),
  request: z.object({ url: z.string() }),
  resourceType: z.string().optional(),
  frameId: z.string().optional(),
});
const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const Attached = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ targetId: z.string(), type: z.string() }),
});
const Received = z.object({ sessionId: z.string(), message: z.string().max(1024 * 1024) });
const Response = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
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
  allowed: (url: string, context?: { navigation?: boolean; human?: boolean }) => Promise<boolean>,
  initiator: () => boolean = () => false,
  frameInspection?: {
    attach(cdp: BrowserCdp, targetId: string): Promise<void>;
    detach(cdp: BrowserCdp): void;
  },
) {
  // Fetch redirects have new IDs. Carry the original actor along that chain.
  const actors = new Map<string, boolean>();
  const frameTree = FrameTree.safeParse(await cdp.send("Page.getFrameTree"));
  let mainFrame = frameTree.success ? frameTree.data.frameTree.frame.id : undefined;
  const frameChanged = (raw: unknown) => {
    const frame = z
      .object({ frame: z.object({ id: z.string(), parentId: z.string().optional() }) })
      .safeParse(raw);
    if (frame.success && !frame.data.frame.parentId) mainFrame = frame.data.frame.id;
  };
  cdp.on("Page.frameNavigated", frameChanged);
  const children = new Map<string, { send: Send; parent: Send; cdp: BrowserCdp; type: string }>();
  const childEvents = new Map<string, EventEmitter>();
  const pending = new Map<
    number,
    {
      sessionId: string;
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
      if (stopped || !children.has(sessionId) || pending.size >= 128)
        return Promise.reject(new Error("Browser target command limit"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Browser target command timed out"));
        }, 10_000);
        pending.set(id, { sessionId, resolve, reject, timer });
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
    const navigation =
      send === root &&
      mainFrame !== undefined &&
      request.data.resourceType === "Document" &&
      request.data.frameId === mainFrame;
    let human: boolean | undefined;
    if (navigation) {
      const previous = request.data.redirectedRequestId;
      human = previous ? actors.get(previous) === true : initiator();
      if (previous) actors.delete(previous);
      if (actors.size >= 256) {
        const oldest = actors.keys().next().value;
        if (oldest !== undefined) actors.delete(oldest);
      }
      actors.set(request.data.requestId, human);
    }
    void (async () => {
      let approved = false;
      if (checks < 32 && !stopped) {
        checks++;
        try {
          approved = await allowed(request.data.request.url, {
            navigation,
            ...(human !== undefined ? { human } : {}),
          });
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
    const events = new EventEmitter();
    const childCdp: BrowserCdp = {
      send,
      on: (method, listener) => events.on(method, listener),
      off: (method, listener) => events.off(method, listener),
    };
    children.set(sessionId, { send, parent, cdp: childCdp, type: targetInfo.type });
    childEvents.set(sessionId, events);
    const init = (async () => {
      await send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
      if (targetInfo.type === "iframe") {
        await send("Page.enable");
        await frameInspection?.attach(childCdp, targetInfo.targetId);
      }
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
      if (waiter?.sessionId === event.data.sessionId) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error("Browser target command failed"));
        else waiter.resolve(message.result);
      }
    }
    if (message.method) childEvents.get(event.data.sessionId)?.emit(message.method, message.params);
    if (message.method === "Fetch.requestPaused") paused(child.send, message.params);
    if (message.method === "Target.attachedToTarget") attached(child.send, message.params);
    if (message.method === "Target.receivedMessageFromTarget") received(message.params);
    if (message.method === "Target.detachedFromTarget") detached(message.params);
  }
  function detached(raw: unknown): void {
    const result = z.object({ sessionId: z.string() }).safeParse(raw);
    if (!result.success) return;
    const detachedIds = new Set([result.data.sessionId]);
    // A parent's transport owns all nested sessions, even without child detach events.
    for (const id of detachedIds) {
      const owner = children.get(id);
      if (owner)
        for (const [childId, child] of children)
          if (child.parent === owner.send) detachedIds.add(childId);
    }
    for (const [id, waiter] of pending)
      if (detachedIds.has(waiter.sessionId)) {
        pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Browser target detached"));
      }
    for (const id of detachedIds) {
      const child = children.get(id);
      if (child) frameInspection?.detach(child.cdp);
      children.delete(id);
      childEvents.get(id)?.removeAllListeners();
      childEvents.delete(id);
    }
  }

  const rootPaused = (raw: unknown) => paused(root, raw);
  const rootAttached = (raw: unknown) => attached(root, raw);
  cdp.on("Fetch.requestPaused", rootPaused);
  cdp.on("Target.attachedToTarget", rootAttached);
  cdp.on("Target.receivedMessageFromTarget", received);
  cdp.on("Target.detachedFromTarget", detached);
  await root("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
  await root("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
  });
  return {
    ready: () => initializing,
    frameSessions: () =>
      [...children.values()].filter((child) => child.type === "iframe").map((child) => child.cdp),
    close() {
      stopped = true;
      cdp.off("Page.frameNavigated", frameChanged);
      cdp.off("Fetch.requestPaused", rootPaused);
      cdp.off("Target.attachedToTarget", rootAttached);
      cdp.off("Target.receivedMessageFromTarget", received);
      cdp.off("Target.detachedFromTarget", detached);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Browser target closed"));
      }
      pending.clear();
      for (const child of children.values()) frameInspection?.detach(child.cdp);
      children.clear();
      childEvents.clear();
      actors.clear();
    },
  };
}
