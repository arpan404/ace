import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { FilesService, attachFilesSocket, createBlobExport } from "./index.ts";

const MetricsRequest = z.object({ type: z.literal("test.metrics") });
const [root, data] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2));
const database = join(root, "source.sqlite");
const source = new DatabaseSync(database);
const exporter = createBlobExport();
const Metadata = z.object({ rowid: z.number(), size: z.number(), sha256: z.string() });
const service = await FilesService.create({
  workspace: root,
  dataDir: data,
  artifactRoots: [root],
  now: Date.now,
  id: randomUUID,
  authorize: () => true,
  async exportRaw(_device, blobRef, guard) {
    guard();
    const info = Metadata.parse(
      source
        .prepare("SELECT rowid, length(bytes) AS size, sha256 FROM blobs WHERE id=?")
        .get(blobRef),
    );
    await exporter.export({ database, temporary: join(root, "exported.bin"), ...info });
    guard();
    return service.registerArtifact({
      root,
      path: "exported.bin",
      name: "exported.bin",
      category: "output",
    });
  },
});
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("connection", (socket) => {
  const session = attachFilesSocket(service, socket, "writer");
  socket.on("message", (raw, binary) => {
    if (binary) session.binary(z.instanceof(Buffer).parse(raw));
    else {
      const input: unknown = JSON.parse(raw.toString());
      if (MetricsRequest.safeParse(input).success)
        socket.send(
          JSON.stringify({
            type: "test.metrics",
            rss: process.memoryUsage().rss,
            peak: process.resourceUsage().maxRSS * 1024,
          }),
        );
      else session.accept(input);
    }
  });
});
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No listener");
process.send?.({ url: `ws://127.0.0.1:${address.port}` });
process.once("SIGTERM", () => {
  for (const socket of server.clients) socket.terminate();
  server.close(() => {
    void service
      .close()
      .then(() => exporter.close())
      .finally(() => {
        source.close();
        process.disconnect?.();
      });
  });
});
