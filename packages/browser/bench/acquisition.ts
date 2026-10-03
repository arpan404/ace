import { performance } from "node:perf_hooks";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireChromium } from "../src/index.ts";
import { archive } from "../src/archive-test-support.ts";
const home = await mkdtemp(join(tmpdir(), "ace-acquire-bench-"));
const data = archive([{ name: "chrome", data: "x".repeat(16 * 1024 * 1024) }]);
const server = createServer((_request, response) => {
  response.setHeader("content-length", data.length);
  response.end(data);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const start = performance.now();
  await acquireChromium({
    dataDir: home,
    artifact: {
      version: "1.2.3.4",
      url: `http://127.0.0.1:${address.port}/`,
      checksum: createHash("md5").update(data).digest("hex"),
      executable: "chrome",
    },
  });
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      path: "streamed download, checksum, extraction and atomic publish",
      bytes: data.length,
      bytesPerSecond: (data.length * 1000) / elapsed,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
}
