import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { executablePath, fixture } from "./test-support.ts";

const Attached = z.object({ sessionId: z.string(), targetInfo: z.object({ type: z.string() }) });
const Received = z.object({ sessionId: z.string(), message: z.string() });
const Paused = z.object({
  method: z.literal("Fetch.requestPaused"),
  params: z.object({ request: z.object({ url: z.string(), postData: z.string() }) }),
});

it.skipIf(!executablePath)(
  "a real out-of-process iframe completes a POST through an oversized nested policy envelope",
  async () => {
    let receivedBytes = 0;
    const server = createServer((request, response) => {
      if (request.url === "/post") {
        request.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.byteLength;
        });
        request.on("end", () => response.end("iframe-report"));
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(`<script>
        fetch('/post', {method: 'POST', body: 'x'.repeat(1_100_000)})
          .then(response => response.text())
          .then(value => parent.postMessage({kind: 'iframe-report', value}, '*'),
            error => parent.postMessage({kind: 'iframe-report', value: String(error)}, '*'));
      </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    onTestFinished(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server address missing");
    const origin = `http://localhost:${address.port}`;
    const frameUrl = `${origin}/frame`;
    const iframeSessions = new Set<string>();
    const nestedPosts: { sessionId: string; bytes: number }[] = [];
    const f = await fixture({
      launchContext: async (profile, options) => {
        const context = await chromium.launchPersistentContext(profile, {
          ...options,
          args: [...(options?.args ?? []), "--site-per-process"],
        });
        const attach = context.newCDPSession.bind(context);
        context.newCDPSession = async (page) => {
          const cdp = await attach(page);
          cdp.on("Target.attachedToTarget", (raw: unknown) => {
            const event = Attached.safeParse(raw);
            if (event.success && event.data.targetInfo.type === "iframe")
              iframeSessions.add(event.data.sessionId);
          });
          cdp.on("Target.receivedMessageFromTarget", (raw: unknown) => {
            const event = Received.safeParse(raw);
            if (!event.success) return;
            const paused = Paused.safeParse(JSON.parse(event.data.message));
            if (paused.success && paused.data.params.request.url === `${origin}/post`)
              nestedPosts.push({
                sessionId: event.data.sessionId,
                bytes: Buffer.byteLength(event.data.message),
              });
          });
          return cdp;
        };
        return context;
      },
    });
    await f.navigate();
    const result = await f.evaluate(`new Promise(resolve => {
      const receive = event => {
        if (event.data?.kind !== 'iframe-report') return;
        removeEventListener('message', receive);
        resolve(event.data.value);
      };
      addEventListener('message', receive);
      const iframe = document.createElement('iframe');
      iframe.src = ${JSON.stringify(frameUrl)};
      document.body.append(iframe);
    })`);
    expect(result).toBe("iframe-report");
    expect(receivedBytes).toBe(1_100_000);
    // These are facts from the real public CDP transport, before compaction.
    // A worker POST alone could have bypassed the capped nested envelope.
    expect(
      nestedPosts.some(
        ({ sessionId, bytes }) => iframeSessions.has(sessionId) && bytes > 1024 * 1024,
      ),
    ).toBe(true);
    expect(await f.evaluate("document.querySelector('button').textContent")).toBe("Save");
  },
  60_000,
);
