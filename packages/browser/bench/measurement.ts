import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";
import { BrowserService, detectChromium } from "../src/index.ts";
import { InteractionMeasurement } from "@ace/protocol";

// Non-gating: a busy local renderer, an isolated temporary profile and no provider processes.
const executablePath = await detectChromium();
if (!executablePath) throw new Error("No isolated test Chromium available");
const home = await mkdtemp(join(tmpdir(), "ace-measurement-bench-"));
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<!doctype html><div id="motion" style="width:1000px;height:500px;background:linear-gradient(red,blue)"></div><script>let frame=0;function update(){motion.style.transform='translateX('+(frame++%100)+'px)';requestAnimationFrame(update)}update()</script>`,
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing benchmark server address");
const service = new BrowserService({ dataDir: home, executablePath });
const baseline = process.memoryUsage().rss;
try {
  await service.open({ threadId: "bench", workspaceId: "bench", background: true });
  await service.execute("bench", { action: "navigate", url: `http://127.0.0.1:${address.port}/` });
  const start = performance.now();
  const measurement = InteractionMeasurement.parse(
    await service.execute("bench", {
      action: "measure_interaction",
      observeMs: 2000,
      repeat: 3,
      filmstrip: true,
    }),
  );
  console.log(
    JSON.stringify(
      {
        hostLoad: loadavg()[0],
        elapsedMs: performance.now() - start,
        rssDeltaBytes: process.memoryUsage().rss - baseline,
        hostCaptureOverheadPct: measurement.repeat?.metrics.captureOverheadPct,
        frames: measurement.repeat?.metrics.frames,
        filmstripBytes: Buffer.from(measurement.filmstrip?.data ?? "", "base64").length,
        notes: measurement.notes,
      },
      null,
      2,
    ),
  );
} finally {
  await service.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
}
