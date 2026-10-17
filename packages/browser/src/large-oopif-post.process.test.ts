import { createServer } from "node:http";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { executablePath, fixture } from "./test-support.ts";

const Attached = z.object({ sessionId: z.string(), targetInfo: z.object({ type: z.string() }) });
const Received = z.object({ sessionId: z.string(), message: z.string() });
const Paused = z.object({
  method: z.literal("Fetch.requestPaused"),
  params: z.object({ request: z.object({ url: z.string() }) }),
});

it.skipIf(!executablePath)(
  "a real out-of-process iframe sends a large POST straight to the network, never paused",
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
    const paused: string[] = [];
    const f = await fixture({
      chrome: {
        args: ["--site-per-process"],
        intercept: {
          event: (method, params) => {
            const event = Attached.safeParse(params);
            if (method === "Target.attachedToTarget" && event.success)
              if (event.data.targetInfo.type === "iframe") iframeSessions.add(event.data.sessionId);
            if (method === "Fetch.requestPaused") {
              const direct = z.object({ request: z.object({ url: z.string() }) }).safeParse(params);
              if (direct.success) paused.push(direct.data.request.url);
            }
            const envelope = Received.safeParse(params);
            if (method !== "Target.receivedMessageFromTarget" || !envelope.success) return;
            const nested = Paused.safeParse(JSON.parse(envelope.data.message));
            if (nested.success) paused.push(nested.data.params.request.url);
          },
        },
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
    // The frame's document load was checked; the POST from that real out-of-process
    // iframe was not.
    expect(iframeSessions.size).toBeGreaterThan(0);
    expect(paused).toContain(frameUrl);
    expect(paused).not.toContain(`${origin}/post`);
    expect(await f.evaluate("document.querySelector('button').textContent")).toBe("Save");
  },
  60_000,
);
