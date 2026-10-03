import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { expect, it, onTestFinished } from "vitest";
import { FilesService, attachFilesSocket } from "@ace/files";
import { ClientMessage } from "@ace/protocol";
import { downloadArtifact, authenticatedChannel } from "./devices.ts";
function deferred() {
  let resolve = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function noop() {}
const schedule = (callback: () => void, delay: number) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};
it("authenticated artifact downloads stream registered bytes through awaited sink writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-portable-artifact-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(200000, 37);
  await writeFile(join(root, "recording.mp4"), bytes);
  const service = await FilesService.create({
    workspace: root,
    dataDir: join(root, "data"),
    artifactRoots: [root],
    now: () => 0,
    id: () => "recording",
    authorize: () => true,
  });
  onTestFinished(() => service.close());
  const artifactId = await service.registerArtifact({
    root,
    path: "recording.mp4",
    name: "recording.mp4",
    category: "recording",
  });
  const server = new WebSocketServer({ port: 0 });
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No socket address");
  server.on("connection", (socket) => {
    const connection = attachFilesSocket(service, socket, "reader");
    socket.on("message", (data, binary) => {
      if (binary) throw new Error("Unexpected upload");
      const frame = ClientMessage.parse(JSON.parse(data.toString()));
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({ type: "welcome", protocolVersion: 1, hostId: "host", headSeq: 0 }),
        );
      else if (frame.type.startsWith("files.")) connection.accept(frame);
    });
  });
  const channel = authenticatedChannel(
    {
      target: { kind: "local", url: `ws://127.0.0.1:${address.port}` },
      deviceId: "reader",
      credential: async () => "a".repeat(64),
      socket: (url) => new WebSocket(url),
      keys: () => {
        throw new Error("Local channel must not create relay keys");
      },
      schedule,
    },
    "files",
  );
  onTestFinished(() => channel.close());
  const blocked = deferred();
  const resume = deferred();
  const chunks: Uint8Array[] = [];
  let finished = false;
  let aborted = false;
  const download = downloadArtifact(
    { channel, requestId: "download", artifactId, schedule },
    {
      async write(chunk) {
        chunks.push(chunk);
        if (chunks.length === 1) {
          blocked.resolve();
          await resume.promise;
        }
      },
      finish() {
        finished = true;
      },
      abort() {
        aborted = true;
      },
    },
  );
  await blocked.promise;
  expect(chunks).toHaveLength(1);
  expect(finished).toBe(false);
  resume.resolve();
  await download;
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(finished).toBe(true);
  expect(aborted).toBe(false);
});
