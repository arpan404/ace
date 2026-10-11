import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { installOriginGuard } from "./origin-guard.ts";
import { FakePage } from "./backend-test-support.ts";

it.each(["iframe", "worker"])(
  "large POST interception in a nested %s still answers origin policy without delivering body data",
  async (type) => {
    const page = new FakePage();
    const commands: { method: string; params?: Record<string, unknown> | undefined }[] = [];
    const events = new EventEmitter();
    const cdp = {
      on: (method: string, listener: (raw: unknown) => void) => events.on(method, listener),
      off: (method: string, listener: (raw: unknown) => void) => events.off(method, listener),
      async send(method: string, params?: Record<string, unknown>) {
        if (method === "Target.sendMessageToTarget") {
          const envelope = z.object({ sessionId: z.string(), message: z.string() }).parse(params);
          const command = z
            .object({
              id: z.number(),
              method: z.string(),
              params: z.record(z.string(), z.unknown()).optional(),
            })
            .parse(JSON.parse(envelope.message));
          commands.push(command);
          queueMicrotask(() =>
            events.emit("Target.receivedMessageFromTarget", {
              sessionId: envelope.sessionId,
              message: JSON.stringify({ id: command.id, result: {} }),
            }),
          );
          return {};
        }
        return page.cdp.send(method, params);
      },
    };
    const policyUrls: string[] = [];
    const guard = await installOriginGuard(cdp, async (url) => {
      policyUrls.push(url);
      return url.endsWith("/allowed");
    });
    try {
      events.emit("Target.attachedToTarget", {
        sessionId: "child",
        targetInfo: { targetId: "target", type },
      });
      await guard.ready();
      const observed: unknown[] = [];
      guard.frameSessions()[0]?.on("Fetch.requestPaused", (raw) => observed.push(raw));
      for (const suffix of ["allowed", "denied"]) {
        events.emit("Target.receivedMessageFromTarget", {
          sessionId: "child",
          message: JSON.stringify({
            method: "Fetch.requestPaused",
            params: {
              requestId: suffix,
              resourceType: "Fetch",
              frameId: "child-frame",
              futureField: { preserved: true },
              request: {
                url: `http://localhost/${suffix}`,
                method: "POST",
                postData: "x".repeat(1_100_000),
                postDataEntries: [{ bytes: "y".repeat(1_500_000) }],
                hasPostData: true,
                futureRequestField: "preserved",
              },
            },
          }),
        });
      }
      await vi.waitFor(
        () =>
          expect(
            commands.filter(
              (command) => command.method.startsWith("Fetch.") && command.method !== "Fetch.enable",
            ),
          ).toEqual([
            {
              id: expect.any(Number),
              method: "Fetch.continueRequest",
              params: { requestId: "allowed" },
            },
            {
              id: expect.any(Number),
              method: "Fetch.failRequest",
              params: { requestId: "denied", errorReason: "BlockedByClient" },
            },
          ]),
        { timeout: 1000 },
      );
      expect(policyUrls).toEqual(["http://localhost/allowed", "http://localhost/denied"]);
      if (type === "iframe") {
        expect(observed).toHaveLength(2);
        for (const raw of observed) {
          expect(raw).toMatchObject({
            futureField: { preserved: true },
            request: { hasPostData: true, futureRequestField: "preserved" },
          });
          expect(JSON.stringify(raw)).not.toMatch(/postDataEntries|"postData"/);
        }
      }
    } finally {
      guard.close();
    }
  },
);
