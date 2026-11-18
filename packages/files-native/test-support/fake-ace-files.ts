/**
 * A stand-in for ace-files that speaks files-wire on stdio. Env:
 *
 * - `FAKE_FILES_LOG`: a file this script appends JSON lines to (spawns, inbound messages, body
 *   frames), never to stdout — stdout carries frames only.
 * - `FAKE_FILES_BEHAVIOUR`: `answer` (default), `hang` (never answers requests), `silent` (never
 *   answers hello either), `exit` (exits before `hello`), `oversize` (declares a 16 MiB + 1 frame
 *   after `hello`), `answer-exit` (answers a stat, then exits), `corrupt-reply` (answers with a
 *   message the schema rejects), `read-no-body` (a read says a body follows, but none does),
 *   `search-hang` (subscribes, then never reports), `search-fails` (subscribes, then reports
 *   `searchFailed`), `search-hold` (never answers a search) or `hold-requests` (answers openRoot,
 *   never another request).
 * - `FAKE_FILES_MISSING_ROOT`: a path whose `openRoot` fails with `NOT_FOUND` while
 *   `FAKE_FILES_VANISH_FILE` exists (all generations, when that env is unset).
 * - `FAKE_FILES_SLOW_WATCH_MS`: delays a watch's reply by this many ms.
 *
 * Reply, matches and searchDone (or reply and the first changes) go out in one write, so a
 * supervisor that registers its book only after the awaiting caller resumes loses them.
 *
 * Root numbers and subscriptions carry a per-process generation, so a restarted process hands
 * out different numbers: a supervisor that sends stale ones gets `NOT_FOUND`.
 */
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { encodeBody, encodeMessage, FrameDecoder, MAX_FRAME_LEN } from "../src/wire.ts";
import type { Entry, EventPayload, Message, Reply } from "../src/schemas.ts";

const logPath = process.env.FAKE_FILES_LOG;
const behaviour = process.env.FAKE_FILES_BEHAVIOUR ?? "answer";
const version = process.env.FAKE_FILES_VERSION ?? "0.0.0-test";
const missingRoot = process.env.FAKE_FILES_MISSING_ROOT;
const vanishFile = process.env.FAKE_FILES_VANISH_FILE;
const slowWatchMs = Number(process.env.FAKE_FILES_SLOW_WATCH_MS ?? 0) || 0;

function log(record: Record<string, unknown>): void {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...record })}\n`);
}

const generation =
  logPath && existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes('"event":"spawn"')).length
    : 0;
const rootBase = (generation + 1) * 1000;
const subscriptionBase = (generation + 1) * 10_000;
let nextRoot = 0;
let nextSubscription = 0;

log({ event: "spawn", generation });
if (behaviour === "exit") process.exit(1);

const roots = new Map<number, string>();
const text = new TextEncoder();

function send(message: Message): void {
  process.stdout.write(encodeMessage(message));
}

/** Several frames in one write, so the reader sees them in one stdout chunk. */
function sendBundle(...messages: Message[]): void {
  const frames = messages.map((message) => encodeMessage(message));
  const bytes = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    bytes.set(frame, offset);
    offset += frame.length;
  }
  process.stdout.write(bytes);
}

function rawFrame(kind: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(5 + payload.length);
  new DataView(bytes.buffer).setUint32(0, 1 + payload.length, true);
  bytes[4] = kind;
  bytes.set(payload, 5);
  return bytes;
}

function respond(id: number, result: Reply): void {
  send({ type: "response", id, result });
}

function entry(path: string): Entry {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind: { type: "file" },
    size: 12,
    mtimeMs: 1_670_000_000_123,
    ignored: false,
  };
}

function watchEvent(subscription: number): Message {
  const payload: EventPayload = {
    type: "changes",
    changes: [{ path: "ping.txt", kind: "created", directory: false }],
  };
  return { type: "event", subscription, payload };
}

function answer(id: number, op: Extract<Message, { type: "request" }>["op"]): void {
  switch (op.op) {
    case "openRoot": {
      if (missingRoot && op.path === missingRoot && (!vanishFile || existsSync(vanishFile))) {
        send({
          type: "error",
          id,
          code: "NOT_FOUND",
          message: `${op.path} does not exist`,
        });
        return;
      }
      const root = rootBase + nextRoot++;
      roots.set(root, op.path);
      respond(id, { type: "root", root });
      return;
    }
    case "closeRoot":
      roots.delete(op.root);
      respond(id, { type: "done" });
      return;
    case "list":
      respond(id, { type: "page", entries: [entry("main.ts")], total: 1 });
      return;
    case "stat": {
      const result: Reply = { type: "entry", ...entry(op.path) };
      if (behaviour === "answer-exit") {
        writeSync(1, encodeMessage({ type: "response", id, result }));
        process.exit(0);
      }
      respond(id, result);
      return;
    }
    case "read": {
      respond(id, {
        type: "read",
        size: 12,
        version: "0:0:0:0:0",
        binary: false,
        encoding: "UTF-8",
        bom: false,
        eof: true,
        body: true,
      });
      if (behaviour !== "read-no-body")
        process.stdout.write(encodeBody(id, text.encode(`read:${op.path}`)));
      return;
    }
    case "write":
    case "createFile":
      respond(id, { type: "version", version: "0:0:0:1:1" });
      return;
    case "createDir":
    case "rename":
    case "remove":
    case "unwatch":
      respond(id, { type: "done" });
      return;
    case "watch": {
      const subscription = subscriptionBase + nextSubscription++;
      const reply: Message = {
        type: "response",
        id,
        result: { type: "subscription", subscription },
      };
      const deliver = () => sendBundle(reply, watchEvent(subscription));
      if (slowWatchMs > 0) setTimeout(deliver, slowWatchMs);
      else deliver();
      return;
    }
    case "indexQuery":
      respond(id, {
        type: "index",
        hits: [{ path: "src/main.ts", score: 1, positions: [] }],
        total: 1,
        truncated: false,
        ready: true,
      });
      return;
    case "search": {
      const subscription = subscriptionBase + nextSubscription++;
      const reply: Message = {
        type: "response",
        id,
        result: { type: "subscription", subscription },
      };
      if (behaviour === "search-hang") {
        send(reply);
        return;
      }
      if (behaviour === "search-fails") {
        sendBundle(reply, {
          type: "event",
          subscription,
          payload: {
            type: "searchFailed",
            code: "INVALID_ARGUMENT",
            message: `the pattern could not be compiled: ${op.pattern}`,
          },
        });
        return;
      }
      sendBundle(
        reply,
        {
          type: "event",
          subscription,
          payload: {
            type: "matches",
            file: {
              path: "src/main.ts",
              lines: [{ line: 1, preview: op.pattern, ranges: [[0, op.pattern.length]] }],
            },
          },
        },
        {
          type: "event",
          subscription,
          payload: {
            type: "searchDone",
            summary: { files: 1, bytes: 12, matches: 1, limitHit: false },
          },
        },
      );
      return;
    }
  }
}

const decoder = new FrameDecoder();

function handle(frame: ReturnType<FrameDecoder["poll"]>): void {
  if (!frame) return;
  if (frame.kind === "body") {
    log({ event: "body", id: frame.id, bytes: frame.bytes.length });
    return;
  }
  const message = frame.message;
  log({ event: "message", message });
  if (message.type === "hello") {
    if (behaviour === "silent") return;
    send({ type: "hello", protocol: 1, version });
    if (behaviour === "oversize") {
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, MAX_FRAME_LEN + 1, true);
      process.stdout.write(header);
    }
    return;
  }
  if (message.type !== "request") return;
  if (behaviour === "hang" || (behaviour === "search-hold" && message.op.op === "search")) return;
  if (behaviour === "hold-requests" && message.op.op !== "openRoot") return;
  if (behaviour === "corrupt-reply") {
    const payload = text.encode(
      JSON.stringify({ type: "response", id: message.id, result: { type: "bogus" } }),
    );
    process.stdout.write(rawFrame(1, payload));
    return;
  }
  answer(message.id, message.op);
}

process.stdin.on("data", (chunk: Buffer) => {
  decoder.push(chunk);
  for (;;) {
    let frame: ReturnType<FrameDecoder["poll"]>;
    try {
      frame = decoder.poll();
    } catch (error) {
      log({ event: "error", message: String(error) });
      return;
    }
    if (!frame) break;
    handle(frame);
  }
});

process.stdin.on("end", () => process.exit(0));
