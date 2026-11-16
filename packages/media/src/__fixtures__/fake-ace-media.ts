/**
 * A stand-in for ace-media that speaks the control protocol for the supervisor's process test:
 * `init` → a control socket and `ready`, lane authentication, `ping` → `pong`, revocations →
 * `revoked`/`closed`, and exit on stdin EOF. With `FAKE_MEDIA_EGRESS_FLOOD` set it keeps the
 * egress lane full: 4 MiB of frames once the lanes are up, and one 64 KiB frame for every
 * `source.picture` it reads.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { encodeEgress } from "../frame.ts";
import { deriveLaneKeys, LaneRecords, laneTranscript } from "../lane-records.ts";
import { controlFrameReader, laneAccepted } from "../lanes.ts";
import { decodeToMedia, encodeControl, type ControlLane, type FromMedia } from "../wire.ts";

let secret: Uint8Array | undefined;
const lanes = new Set<number>();
/** The egress lane, sealing what is written to it. */
let egressLane: { write(chunk: Uint8Array): unknown } | undefined;
const flood = process.env.FAKE_MEDIA_EGRESS_FLOOD !== undefined;
const egressUnit = encodeEgress(1, 0, {
  kind: 1,
  flags: 0,
  ageUs: 0,
  width: 2,
  height: 2,
  displayWidth: 2,
  displayHeight: 2,
  scale: 1000,
  rotation: 0,
  codec: 1,
  encode: 0,
  epoch: 0,
  codecString: "",
  description: new Uint8Array(0),
  extension: new Uint8Array(0),
  payload: new Uint8Array(64 * 1024),
});

function send(sink: { write(chunk: Uint8Array): unknown }, message: FromMedia, lane: ControlLane) {
  sink.write(encodeControl(message, new Uint8Array(0), lane).header);
}

const label = (direction: string) => new TextEncoder().encode(`ace-media lane v1 ${direction}`);
function mac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const hmac = createHmac("sha256", key);
  for (const part of parts) hmac.update(part);
  return new Uint8Array(hmac.digest());
}

/**
 * The lane hello as ace-media serves it: a well-formed hello for a free tag is answered with
 * this side's proof and a fresh nonce; the daemon's proof over both nonces opens the lane.
 */
function serveLane(socket: Socket): void {
  let buffered = new Uint8Array(0);
  let challenge:
    | {
        tag: number;
        expected: Uint8Array;
        clientNonce: Uint8Array;
        serverNonce: Uint8Array;
        serverProof: Uint8Array;
      }
    | undefined;
  let records: LaneRecords | undefined;
  let reader: ReturnType<typeof controlFrameReader> | undefined;
  const sealed = { write: (chunk: Uint8Array) => records && socket.write(records.seal(chunk)) };
  socket.on("error", () => {});
  socket.on("data", (chunk: Uint8Array) => {
    if (records) {
      let plains: Uint8Array[];
      try {
        plains = records.open(chunk);
      } catch {
        return void socket.destroy();
      }
      for (const plain of plains)
        for (const frame of reader?.push(plain) ?? []) {
          const { message } = decodeToMedia(frame, "priority");
          if (message.type === "revoke")
            send(sealed, { type: "revoked", id: message.id }, "priority");
          if (message.type === "connection.close" || message.type === "relay.close")
            send(sealed, { type: "closed", id: message.id }, "priority");
          if (message.type === "shutdown") process.exit(0);
        }
      return;
    }
    buffered = Uint8Array.from([...buffered, ...chunk]);
    const known = secret;
    if (!challenge) {
      if (buffered.length < 37) return;
      const tag = buffered[4] ?? 0;
      const valid =
        known !== undefined &&
        known.length === 32 &&
        new DataView(buffered.buffer).getUint32(0) === 0x4143454c &&
        (tag === 1 || tag === 2) &&
        !lanes.has(tag);
      if (!valid || !known) return void socket.destroy();
      const clientNonce = buffered.slice(5, 37);
      const serverNonce = new Uint8Array(randomBytes(32));
      const serverProof = mac(known, label("server"), Uint8Array.of(tag), clientNonce);
      challenge = {
        tag,
        clientNonce,
        serverNonce,
        serverProof,
        expected: mac(known, label("client"), Uint8Array.of(tag), clientNonce, serverNonce),
      };
      socket.write(Uint8Array.from([...serverProof, ...serverNonce]));
      buffered = buffered.subarray(37);
    }
    if (buffered.length < 32 || !known) return;
    const { tag, expected, clientNonce, serverNonce, serverProof } = challenge;
    // The proof is compared in constant time, as ace-media does.
    if (!timingSafeEqual(buffered.subarray(0, 32), expected) || lanes.has(tag))
      return void socket.destroy();
    lanes.add(tag);
    // From here every byte is a record, the accept byte first.
    const keys = deriveLaneKeys(
      known,
      laneTranscript(tag, clientNonce, serverNonce, serverProof, buffered.subarray(0, 32)),
    );
    records = new LaneRecords(keys.toDaemon, keys.toMedia);
    if (lanes.size === 2) secret?.fill(0);
    sealed.write(Uint8Array.of(laneAccepted));
    if (tag === 2) {
      egressLane = sealed;
      if (flood) for (let i = 0; i < 64; i++) sealed.write(egressUnit);
    }
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
            capabilities: [],
            ingest: { socket: join(message.runtimeDir, "ingest.sock"), websocketPort: 0 },
            control: { socket: control },
            listen: { loopbackPort: 0 },
          },
          "normal",
        ),
      );
    }
    if (message.type === "source.picture" && flood) egressLane?.write(egressUnit);
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
