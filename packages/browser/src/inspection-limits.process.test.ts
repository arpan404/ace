import { expect, it } from "vitest";
import { z } from "zod";
import { BrowserInspection } from "./inspection.ts";
import { backendFixture, FakeHeadless } from "./backend-test-support.ts";

it.each([false, true])(
  "body byte limits reject oversized CDP data even when response lengths underreport it (base64=%s)",
  async (base64Encoded) => {
    const backend = new FakeHeadless(),
      open = backend.open.bind(backend);
    let inject: (() => void) | undefined;
    backend.open = async (request) => {
      const session = await open(request),
        page = backend.pages.at(-1);
      if (!page) throw new Error("page");
      const text = "€".repeat(100 * 1024);
      const cdp = {
        ...session.cdp,
        send: async (method: string, params?: Record<string, unknown>) =>
          method === "Network.getResponseBody"
            ? { body: base64Encoded ? Buffer.from(text).toString("base64") : text, base64Encoded }
            : session.cdp.send(method, params),
      };
      const inspection = new BrowserInspection(request.log);
      await inspection.attach(cdp, "tab");
      inject = () => {
        page.events.emit("Network.requestWillBeSent", {
          requestId: "oversized",
          request: { url: "http://localhost/body" },
        });
        page.events.emit("Network.responseReceived", {
          requestId: "oversized",
          response: { url: "http://localhost/body", status: 200, mimeType: "text/plain" },
        });
        page.events.emit("Network.loadingFinished", {
          requestId: "oversized",
          encodedDataLength: 1,
        });
      };
      return {
        ...session,
        cdp,
        networkBody: (id) => inspection.body(id),
        close: async () => {
          inspection.clear();
          await session.close();
        },
      };
    };
    const f = await backendFixture({
      headlessBackend: backend,
      backendPreference: () => "headless",
    });
    await f.open();
    if (!inject) throw new Error("response boundary");
    inject();
    const logs = z
      .object({ entries: z.array(z.object({ requestId: z.string() })) })
      .parse(await f.service.execute("thread", { action: "logs" }));
    expect(logs.entries).toHaveLength(1);
    await expect(
      f.service.execute("thread", {
        action: "network_body",
        requestId: logs.entries[0]?.requestId,
      }),
    ).rejects.toThrow("exceeds limit");
  },
);
