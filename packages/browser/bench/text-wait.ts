// Not executed during development. Run at merge to record actual latency and RSS.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BrowserService, detectChromium } from "../src/index.ts";
const executablePath = await detectChromium();
if (!executablePath)
  throw new Error("Install Chromium locally before this benchmark; no download is attempted");
const cases = [
  { nodes: 100, characters: 100 },
  { nodes: 500, characters: 500 },
  { nodes: 10000, characters: 10000 },
  { nodes: 1, characters: 65537 },
];
const server = createServer((request, response) => {
  const index = Number(new URL(request.url ?? "/", "http://localhost").pathname.slice(1));
  const sample = cases[index];
  if (!sample) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<!doctype html><body>${sample.nodes === 1 ? "x".repeat(sample.characters) : "<span>x</span>".repeat(sample.nodes)}<p>last marker</p></body>`,
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing loopback endpoint");
const home = await mkdtemp(join(tmpdir(), "ace-text-wait-bench-"));
const browser = new BrowserService({ dataDir: home, executablePath });
try {
  await browser.open({ threadId: "bench", workspaceId: "bench" });
  for (const [index, sample] of cases.entries()) {
    await browser.execute("bench", {
      action: "navigate",
      url: `http://127.0.0.1:${address.port}/${index}`,
    });
    const latencies: number[] = [];
    let limited = 0;
    for (let iteration = 0; iteration < 100; iteration++) {
      const start = performance.now();
      try {
        await browser.execute("bench", { action: "wait_for", text: "last marker" });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "page_text_limit")
          limited++;
        else throw error;
      }
      latencies.push(performance.now() - start);
    }
    latencies.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        ...sample,
        samples: latencies.length,
        limited,
        p50Ms: latencies[49],
        p95Ms: latencies[94],
        rssBytes: process.memoryUsage().rss,
      }),
    );
  }
} finally {
  try {
    await browser.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}
