import type { BrowserFrame } from "@ace/protocol";
import { expect, it } from "vitest";
import { browserSandbox } from "./fixtures/browser-sandbox.ts";

it.runIf(process.env.ACE_E2E_ELECTRON === "1")(
  "a remote viewer keeps seeing the desktop's page while the panel is closed, for the agent and after a takeover",
  async () => {
    const s = await browserSandbox();
    try {
      const threadId = s.thread.id;
      await expect
        .poll(
          async () => {
            try {
              return (
                await s.daemon.browser.open({ threadId, workspaceId: s.thread.workspaceId })
              ).backend;
            } catch {
              return "unregistered";
            }
          },
          { timeout: 30_000 },
        )
        .toBe("embedded");
      const frames: BrowserFrame[] = [];
      const phone = "phone";
      s.daemon.browser.subscribe(
        threadId,
        phone,
        {
          send: (frame) => {
            frames.push(frame);
            queueMicrotask(() => s.daemon.browser.acknowledge(threadId, phone, frame.sequence));
            return true;
          },
        },
        () => {},
      );
      const framesWithin = async (ms: number) => {
        const before = frames.length;
        await new Promise((resolve) => setTimeout(resolve, ms));
        return frames.length - before;
      };
      await s.daemon.browser.execute(threadId, { action: "navigate", url: s.url });
      expect(await framesWithin(3000)).toBeGreaterThan(3);
      s.daemon.browser.takeover(threadId, phone);
      for (const event of ["mousePressed", "mouseReleased"] as const)
        await s.daemon.browser.input(threadId, { kind: "mouse", event, x: 120, y: 90 }, phone);
      expect(await framesWithin(3000)).toBeGreaterThan(3);
    } finally {
      await s.close();
    }
  },
);
