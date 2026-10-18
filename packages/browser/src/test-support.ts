import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach } from "vitest";
import { BrowserService, detectChromium, type BrowserServiceOptions } from "./index.ts";
export { toolPort } from "./tool-port-test-support.ts";

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
/** A ref from snapshot text lines such as `- button "Save" [ref=e1-12]`. */
export function textRef(text: string, role: string, name: string): string {
  const quoted = JSON.stringify(name);
  const line = text
    .split("\n")
    .find(
      (entry) => entry.trimStart().startsWith(`- ${role} ${quoted}`) && entry.includes("[ref="),
    );
  const found = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  if (!found) throw new Error(`No ${role} "${name}" ref in snapshot:\n${text}`);
  return found;
}
const pages: Record<string, string> = {
  "/controls": `<!doctype html><html><head><title>Controls</title></head><body style="height:3000px">
    <main><h1>Controls</h1>
    <nav aria-label="Primary"><a href="/next">Next page</a></nav>
    <section aria-label="Form area"><form onsubmit="event.preventDefault()">
      <label>Email <input aria-label="Email" aria-describedby="email-hint" value="ada@example.com"></label><small id="email-hint">Never shared</small>
      <label><input type="checkbox" aria-label="Agree"> Agree</label>
      <select aria-label="Colour"><option value="red">Red</option><option value="blue">Blue</option></select>
      <input type="file" aria-label="Attachment">
      <button type="button" onclick="document.getElementById('out').textContent='clicked'">Go</button>
      <button type="button" onmouseover="document.getElementById('out').textContent='hovered'">Hover me</button>
      <button type="button" onfocus="document.getElementById('out').textContent='focused'">Focus me</button>
      <button type="button" onclick="document.getElementById('out').textContent=String(confirm('Sure?'))">Confirm</button>
    </form></section>
    <div><div><div><span>Deeply wrapped text</span></div></div></div>
    <ul><li>Milk</li><li>Bread</li></ul>
    <div id="out" role="status" aria-label="Output"></div></main>
    <script>document.querySelector('[aria-label=Email]').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('out').textContent='entered'})</script>
    </body></html>`,
  "/next": `<!doctype html><html><head><title>Next</title></head><body><h1>Next page</h1></body></html>`,
  // Thousands of nodes, mostly wrappers: what a real app shell looks like to the AX tree.
  "/big": `<!doctype html><html><head><title>Big</title></head><body><main>${Array.from(
    { length: 400 },
    (_, index) =>
      `<div class="card"><div><div><span>Row ${index}</span></div><div><button>Edit ${index}</button><a href="#r${index}">Open ${index}</a></div></div></div>`,
  ).join(
    "",
  )}<section aria-label="Footer area"><button>Footer action</button></section></main></body></html>`,
};
export async function fixture(options: Partial<BrowserServiceOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-browser-"));
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://example.invalid/" });
      response.end();
      return;
    }
    const page = pages[request.url ?? ""];
    if (page) {
      response.setHeader("Content-Type", "text/html");
      response.end(page);
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
