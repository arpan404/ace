// Real isolated daemon-side transfer process for memory tests and benchmarks.
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { attachFilesSocket, FilesService } from "./index.ts";

const MetricsRequest = z.object({ type: z.literal("test.metrics") });
const [root, dataDir] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2));
const service = await FilesService.create({
  workspace: root,
  dataDir,
  now: Date.now,
  id: randomUUID,
  authorize: () => true,
});
const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
server.on("connection", (socket) => {
  const session = attachFilesSocket(service, socket, "test");
  socket.on("message", (data, binary) => {
    if (binary) {
      session.binary(z.instanceof(Buffer).parse(data));
      return;
    }
    const input: unknown = JSON.parse(data.toString());
    const metric = MetricsRequest.safeParse(input);
    if (metric.success)
      socket.send(
        JSON.stringify({
          type: "test.metrics",
          rss: process.memoryUsage().rss,
          peak: process.resourceUsage().maxRSS * 1024,
        }),
      );
    else session.accept(input);
  });
});
server.on("listening", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    process.send?.({ url: `ws://127.0.0.1:${address.port}` });
});
