/**
 * A stand-in for ace-files that speaks files-wire on stdio. Env:
 *
 * - `FAKE_FILES_LOG`: a file this script appends JSON lines to (spawns, inbound messages, body
 *   frames), never to stdout — stdout carries frames only.
 * - `FAKE_FILES_BEHAVIOUR`: `answer` (default), `hang` (never answers requests), `exit` (exits
 *   before `hello`) or `oversize` (declares a 16 MiB + 1 frame after `hello`).
 *
 * Root numbers and subscriptions carry a per-process generation, so a restarted process hands
 * out different numbers: a supervisor that sends stale ones gets `NOT_FOUND`.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { encodeBody, encodeMessage, FrameDecoder, MAX_FRAME_LEN } from "../src/wire.ts";
import type { Entry, EventPayload, Message, Reply } from "../src/schemas.ts";

const logPath = process.env.FAKE_FILES_LOG;
const behaviour = process.env.FAKE_FILES_BEHAVIOUR ?? "answer";
const version = process.env.FAKE_FILES_VERSION ?? "0.0.0-test";

function log(entry: unknown): void {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
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

function watchEvent(subscription: number): void {
  const payload: EventPayload = {
    type: "changes",
    changes: [{ path: "ping.txt", kind: "created", directory: false }],
  };
  send({ type: "event", subscription, payload });
}

function answer(id: number, op: Extract<Message, { type: "request" }>["op"]): void {
  switch (op.op) {
    case "openRoot": {
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
    case "stat":
      if (!roots.has(op.root)) {
        send({ type: "error", id, code: "NOT_FOUND", message: `root ${op.root} is not open` });
        return;
      }
      respond(id, { type: "entry", ...entry(op.path) });
      return;
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
      const bytes = text.encode(`read:${op.path}`);
      process.stdout.write(encodeBody(id, bytes));
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
      respond(id, { type: "subscription", subscription });
      setTimeout(() => watchEvent(subscription), 10);
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
      respond(id, { type: "subscription", subscription });
      setTimeout(() => {
        send({
          type: "event",
          subscription,
          payload: {
            type: "matches",
            file: {
              path: "src/main.ts",
              lines: [{ line: 1, preview: op.pattern, ranges: [[0, op.pattern.length]] }],
            },
          },
        });
        send({
          type: "event",
          subscription,
          payload: {
            type: "searchDone",
            summary: { files: 1, bytes: 12, matches: 1, limitHit: false },
          },
        });
      }, 10);
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
    send({ type: "hello", protocol: 1, version });
    if (behaviour === "oversize") {
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, MAX_FRAME_LEN + 1, true);
      process.stdout.write(header);
    }
    return;
  }
  if (message.type === "request" && behaviour !== "hang") answer(message.id, message.op);
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
