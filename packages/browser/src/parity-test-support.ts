import { afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BrowserService, detectChromium } from "./index.ts";
export const executablePath = await detectChromium();
export const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
}, 60_000);
export async function setup(
  options: Partial<import("./service-options.ts").BrowserServiceOptions> = {},
) {
  const home = await mkdtemp(join(tmpdir(), "ace-parity-"));
  const artifacts: import("@ace/protocol").BrowserArtifact[] = [];
  const slowComplete = Promise.withResolvers<void>();
  let writes = 0;
  const server = createServer((req, res) => {
    if (req.method !== "GET") writes++;
    if (req.url === "/plain") {
      res.setHeader(
        "Content-Type",
        req.headers["x-preview"] ? "application/octet-stream" : "text/plain",
      );
      res.end("plain-fixture");
      return;
    }
    if (req.url === "/large") {
      res.setHeader("Content-Type", "text/plain");
      res.end("x".repeat(300 * 1024));
      return;
    }
    if (req.url?.startsWith("/retained")) {
      res.setHeader("Content-Type", "text/plain");
      res.end("retention-marker");
      return;
    }
    if (req.url === "/file") {
      res.writeHead(200, {
        "Content-Disposition": "attachment; filename=example.zip",
        "Content-Type": "application/zip",
      });
      res.end("zip-fixture");
      return;
    }
    if (req.url === "/failed") {
      res.destroy();
      return;
    }
    if (req.url === "/slow") {
      res.writeHead(200, {
        "Content-Disposition": "attachment; filename=slow.txt",
        "Content-Type": "text/plain",
      });
      res.write("start".repeat(256));
      void slowComplete.promise.then(() => {
        if (!res.destroyed) res.end("finish");
      });
      return;
    }
    if (req.url === "/body") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"token":"secret-value","safe":"body-marker"}');
      return;
    }
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/frame") {
      res.end(
        `<button onclick="this.textContent='Clicked frame'">Frame button</button><input aria-label="Frame input">`,
      );
      return;
    }
    const host = req.headers.host ?? "";
    res.end(`<!doctype html><title>Parity</title><body>
    <input aria-label="Name"><input type="file" aria-label="File"><input type="checkbox" aria-label="Agree">
    <select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>
    <a href="/plain" download="plain.txt">Plain download</a><a href="/other" target="_blank">Popup</a><a href="/file">Download</a><a href="/slow">Slow download</a>
    <button onclick="document.body.dataset.answer=prompt('Question','default')">Prompt</button>
    <button onmouseover="document.body.dataset.hovered=1">Hover</button>
    <div role="button" aria-label="Drag source" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','dragged')" style="width:100px;height:40px">Drag</div>
    <div role="button" aria-label="Drop target" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.body.dataset.dropped=event.dataTransfer.getData('text/plain')" style="width:100px;height:40px">Drop</div>
    <iframe src="/frame" title="same"></iframe><iframe src="http://localhost:${host.split(":")[1]}/frame" title="cross"></iframe>
    <script>
    fetch('/body');console.warn('console-marker');
    window.addEventListener('load', () => {
      document.body.insertAdjacentHTML('beforeend', '<p>Fixture ready</p>');
    });
    </script></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const url = `http://127.0.0.1:${address.port}`;
  const service = new BrowserService({
    dataDir: home,
    ...(executablePath ? { executablePath } : {}),
    workspaceRoot: () => home,
    evaluatePolicy: () => true,
    downloadPolicy: () => true,
    onArtifact: (_thread, artifact) => {
      artifacts.push(artifact);
    },
    ...options,
  });
  cleanups.push(async () => {
    slowComplete.resolve();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  await service.open({ threadId: "thread", workspaceId: "workspace", background: true });
  const execute = (command: unknown) => service.execute("thread", command);
  await execute({ action: "navigate", url });
  // DOMContentLoaded does not wait for iframe documents; their commits invalidate refs.
  await execute({ action: "wait_for", text: "Fixture ready" });
  return {
    service,
    execute,
    url,
    home,
    artifacts,
    writes: () => writes,
    finishSlow: () => slowComplete.resolve(),
    evaluate: (expression: string) => execute({ action: "evaluate", expression }),
  };
}
export const tabs = z.object({
  activeTabId: z.string(),
  tabs: z.array(z.object({ tabId: z.string(), url: z.string() })),
});
