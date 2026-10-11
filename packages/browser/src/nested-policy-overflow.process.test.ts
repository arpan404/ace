import { expect, it } from "vitest";
import { z } from "zod";
import type { BrowserCdp } from "./index.ts";
import { backendFixture, FakeHeadless } from "./backend-test-support.ts";
import { installOriginGuard } from "./origin-guard.ts";

const Envelope = z.object({ sessionId: z.string(), message: z.string() });
const Command = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

it("nested residual policy overflow rejects branch work while the parent and sibling iframe stay usable", async () => {
  const backend = new FakeHeadless();
  const open = backend.open.bind(backend);
  const waiting = Promise.withResolvers<void>();
  const closedTargets: string[] = [];
  let overflow: (() => void) | undefined;
  backend.open = async (request) => {
    const session = await open(request);
    const page = backend.pages.at(-1);
    if (!page) throw new Error("Page missing");
    const parents = new Map([
      ["branch", undefined],
      ["nested", "branch"],
      ["sibling", undefined],
    ]);
    const frames = new Map<string, BrowserCdp>();
    function receive(sessionId: string, message: unknown): void {
      const envelope = { sessionId, message: JSON.stringify(message) };
      const parent = parents.get(sessionId);
      if (parent) receive(parent, { method: "Target.receivedMessageFromTarget", params: envelope });
      else page?.events.emit("Target.receivedMessageFromTarget", envelope);
    }
    function dispatch(sessionId: string, message: string): void {
      const command = Command.parse(JSON.parse(message));
      if (command.method === "Target.sendMessageToTarget") {
        const envelope = Envelope.parse(command.params);
        dispatch(envelope.sessionId, envelope.message);
      } else if (sessionId === "nested" && command.method === "Accessibility.getFullAXTree") {
        waiting.resolve();
        return;
      }
      queueMicrotask(() =>
        receive(sessionId, {
          id: command.id,
          result: page?.command(command.method, command.params) ?? {},
        }),
      );
    }
    const cdp = {
      ...session.cdp,
      async send(method: string, params?: Record<string, unknown>) {
        if (method === "Target.sendMessageToTarget") {
          const envelope = Envelope.parse(params);
          dispatch(envelope.sessionId, envelope.message);
          return {};
        }
        if (method === "Target.closeTarget")
          closedTargets.push(z.object({ targetId: z.string() }).parse(params).targetId);
        return session.cdp.send(method, params);
      },
    };
    const guard = await installOriginGuard(cdp, request.allowed, request.initiator, {
      async attach(child, targetId) {
        frames.set(targetId, child);
      },
      detach(child) {
        for (const [id, frame] of frames) if (frame === child) frames.delete(id);
      },
    });
    for (const id of ["branch", "sibling"])
      page.events.emit("Target.attachedToTarget", {
        sessionId: id,
        targetInfo: { type: "iframe", targetId: `${id}-target` },
      });
    await guard.ready();
    receive("branch", {
      method: "Target.attachedToTarget",
      params: { sessionId: "nested", targetInfo: { type: "iframe", targetId: "nested-target" } },
    });
    await guard.ready();
    overflow = () =>
      receive("nested", {
        method: "Fetch.requestPaused",
        params: {
          requestId: "overflow",
          request: { url: "http://localhost/post", postData: "removable body" },
          futureMetadata: "x".repeat(1_100_000),
        },
      });
    return {
      ...session,
      cdp,
      frames: async () => {
        await guard.ready();
        return [
          { frameId: "main", cdp },
          ...[...frames].map(([frameId, child]) => ({ frameId, cdp: child, parentId: "main" })),
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
  const snapshot = expect(f.service.execute("thread", { action: "snapshot" })).rejects.toThrow(
    "target detached",
  );
  await waiting.promise;
  if (!overflow) throw new Error("Target boundary missing");
  overflow();
  await snapshot;
  expect(closedTargets).toEqual(["branch-target"]);
  expect(f.service.state("thread")).toMatchObject({ status: "ready", closed: false });
  const usable = z
    .object({ nodes: z.array(z.object({ frameId: z.string().optional(), name: z.string() })) })
    .parse(await f.service.execute("thread", { action: "snapshot" }));
  expect(usable.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Name", frameId: "main" }),
      expect.objectContaining({ name: "Name", frameId: "sibling-target" }),
    ]),
  );
});
