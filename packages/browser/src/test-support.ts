import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach } from "vitest";
import { BrowserService, detectChromium, type BrowserServiceOptions } from "./index.ts";

export const executablePath = await detectChromium();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
}, 60_000);

export const Snapshot = z.object({
  nodes: z.array(
    z.object({
      ref: z.string().optional(),
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
    }),
  ),
});
export function ref(raw: unknown, name: string): string {
  const node = Snapshot.parse(raw).nodes.find(
    (candidate) => candidate.name === name && candidate.ref,
  );
  if (!node?.ref) throw new Error(`No snapshot ref for ${name}`);
  return node.ref;
}
export async function fixture(options: Partial<BrowserServiceOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-browser-"));
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://example.invalid/" });
      response.end();
      return;
    }
    if (request.url === "/data") {
      response.end("response-data");
      return;
    }
    if (request.url === "/iframe") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<script>fetch('/redirect').then(()=>parent.postMessage('finished','*'),()=>parent.postMessage('finished','*'))</script>",
      );
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><body style="height:3000px">
      <label>Name <input aria-label="Name"></label><button onclick="document.getElementById('result').textContent=document.querySelector('input').value">Save</button>
      <div id="result" role="status" aria-label="Result"></div><button id="gone">Remove me</button>
      <script>console.log('console-marker');fetch('/data');
      document.querySelector('input').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('result').textContent='entered'});
      </script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const url = `http://127.0.0.1:${address.port}`;
  const service = new BrowserService({
    dataDir: home,
    ...(executablePath ? { executablePath } : {}),
    evaluatePolicy: () => true,
    ...options,
  });
  cleanups.push(async () => {
    try {
      await service.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(home, { recursive: true, force: true });
    }
  });
  await service.open({ threadId: "thread", workspaceId: "workspace" });
  return {
    service,
    home,
    url,
    execute: (command: unknown) => service.execute("thread", command),
    evaluate: (expression: string) => service.execute("thread", { action: "evaluate", expression }),
    navigate: () => service.execute("thread", { action: "navigate", url }),
  };
}
