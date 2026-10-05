import { expect, it } from "vitest";
import { z } from "zod";
import { backendFixture, FakeHeadless } from "./backend-test-support.ts";
import { installOriginGuard } from "./origin-guard.ts";

it("detaching an iframe rejects its pending snapshot while the parent remains usable", async () => {
  const backend = new FakeHeadless(),
    open = backend.open.bind(backend);
  const waiting = Promise.withResolvers<void>();
  let detach: (() => void) | undefined;
  backend.open = async (request) => {
    const session = await open(request),
      page = backend.pages.at(-1);
    if (!page) throw new Error("page");
    const baseSend = session.cdp.send;
    const cdp = {
      ...session.cdp,
      send: async (method: string, params?: Record<string, unknown>) => {
        if (method === "Target.sendMessageToTarget") {
          const envelope = z.object({ sessionId: z.string(), message: z.string() }).parse(params);
          const command = z
            .object({ id: z.number(), method: z.string() })
            .parse(JSON.parse(envelope.message));
          if (command.method === "Accessibility.getFullAXTree") {
            waiting.resolve();
            return {};
          }
          const result = command.method === "Memory.getDOMCounters" ? { nodes: 1 } : {};
          queueMicrotask(() =>
            page.events.emit("Target.receivedMessageFromTarget", {
              sessionId: envelope.sessionId,
              message: JSON.stringify({ id: command.id, result }),
            }),
          );
          return {};
        }
        return baseSend(method, params);
      },
    };
    const guard = await installOriginGuard(cdp, request.allowed);
    page.events.emit("Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: { targetId: "frame", type: "iframe" },
    });
    detach = () => page.events.emit("Target.detachedFromTarget", { sessionId: "child" });
    return {
      ...session,
      cdp,
      frames: async () => {
        await guard.ready();
        return [
          { frameId: "main", cdp },
          ...guard
            .frameSessions()
            .map((child) => ({ frameId: "frame", cdp: child, parentId: "main" })),
        ];
      },
      close: async () => {
        guard.close();
        await session.close();
      },
    };
  };
  const f = await backendFixture({ headlessBackend: backend, backendPreference: () => "headless" });
  await f.open();
  const rejected = expect(f.service.execute("thread", { action: "snapshot" })).rejects.toThrow(
    "target detached",
  );
  await waiting.promise;
  if (!detach) throw new Error("detach boundary");
  detach();
  await rejected;
  expect(await f.service.execute("thread", { action: "snapshot" })).toMatchObject({
    nodes: [{ name: "Name" }],
  });
});
