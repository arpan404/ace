/**
 * A stand-in for ace-media that speaks the control protocol for the supervisor's process test:
 * `init` → a control socket and `ready`, lane authentication, `ping` → `pong`, revocations →
 * `revoked`/`closed`, and exit on stdin EOF.
 */
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { controlFrameReader, laneAccepted } from "../lanes.ts";
import { decodeToMedia, encodeControl, type ControlLane, type FromMedia } from "../wire.ts";

let secret: Uint8Array | undefined;
const lanes = new Set<number>();

function send(sink: { write(chunk: Uint8Array): unknown }, message: FromMedia, lane: ControlLane) {
  sink.write(encodeControl(message, new Uint8Array(0), lane).header);
}

function serveLane(socket: Socket): void {
  let hello = new Uint8Array(0);
  let reader: ReturnType<typeof controlFrameReader> | undefined;
  socket.on("error", () => {});
  socket.on("data", (chunk: Uint8Array) => {
    if (reader) {
      for (const frame of reader.push(chunk)) {
        const { message } = decodeToMedia(frame, "priority");
        if (message.type === "revoke")
          send(socket, { type: "revoked", id: message.id }, "priority");
        if (message.type === "connection.close" || message.type === "relay.close")
          send(socket, { type: "closed", id: message.id }, "priority");
        if (message.type === "shutdown") process.exit(0);
      }
      return;
    }
    hello = Uint8Array.from([...hello, ...chunk]);
    if (hello.length < 37) return;
    const tag = hello[4] ?? 0;
    const known = secret;
    const valid =
      known !== undefined &&
      new DataView(hello.buffer).getUint32(0) === 0x4143454c &&
      (tag === 1 || tag === 2) &&
      !lanes.has(tag) &&
      hello.subarray(5, 37).every((byte, i) => byte === known[i]);
    if (!valid) return void socket.destroy();
    lanes.add(tag);
    if (lanes.size === 2) secret?.fill(0);
    socket.write(Uint8Array.of(laneAccepted));
    if (tag === 1) reader = controlFrameReader("priority");
  });
}

const stdin = controlFrameReader("normal");
process.stdin.on("data", (chunk: Uint8Array) => {
  for (const frame of stdin.push(chunk)) {
    const { message, payload } = decodeToMedia(frame, "normal");
    if (message.type === "init") {
      secret = payload.slice();
      const control =
        process.platform === "win32"
          ? `\\\\.\\pipe\\ace-media-fake-${process.pid}`
          : join(message.runtimeDir, "control.sock");
      const server = createServer(serveLane);
      server.listen(control, () =>
        send(
          process.stdout,
          {
            type: "ready",
            protocol: 1,
            version: process.env.FAKE_MEDIA_VERSION ?? message.version,
            pid: process.pid,
            capabilities: { encoders: [], decoders: [], stills: false },
            ingest: { socket: join(message.runtimeDir, "ingest.sock"), websocketPort: 0 },
            control: { socket: control },
            listen: { loopbackPort: 0 },
          },
          "normal",
        ),
      );
    }
    if (message.type === "ping")
      send(
        process.stdout,
        {
          type: "pong",
          id: message.id,
          stats: {
            sources: 0,
            viewers: 0,
            connections: 0,
            cpuMs: 0,
            rssBytes: 0,
            bytesOut: 0,
            priorityLagMs: 0,
          },
        },
        "normal",
      );
  }
});
process.stdin.on("end", () => process.exit(0));
