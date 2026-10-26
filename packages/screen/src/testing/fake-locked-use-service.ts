/*
 * A stand-in for `ace-screen-helper --locked-use --socket <path>` in tests: a real Unix socket
 * server speaking the service's framed protocol. By default it behaves like a healthy service
 * on a locked Mac (enable → ready; begin → covering, authorizing, unlocking, working; finish →
 * relocking, completion, ready). Tests replace any request's handling to script refusals,
 * error events, takeovers and dropped connections. It never touches the machine.
 *
 * Run directly (`node fake-locked-use-service.ts --locked-use --socket <path>`) it serves the
 * default behaviour until killed.
 */
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import {
  LockedUseFrameDecoder,
  encodeLockedUseFrame,
  type LockedUseServiceStatus,
} from "../locked-use-wire.ts";

export const FakeRequest = z.looseObject({
  id: z.string(),
  type: z.string(),
  attemptID: z.string().optional(),
  scope: z
    .looseObject({
      userID: z.number(),
      sessionID: z.number(),
      threadID: z.string(),
      turnID: z.string(),
      attemptID: z.string(),
    })
    .optional(),
  agentProcessIDs: z.array(z.number()).optional(),
});
export type FakeRequest = z.infer<typeof FakeRequest>;

export function fakeStatus(patch: Partial<LockedUseServiceStatus> = {}): LockedUseServiceStatus {
  return {
    phase: "disabled",
    session: "locked",
    userID: 501,
    sessionID: 100003,
    attemptID: null,
    installation: {
      pluginSigned: true,
      ruleReachesMechanism: true,
      lockOnDisplaySleep: true,
      brokerLinked: true,
      guardianLinked: true,
      verified: true,
    },
    ...patch,
  };
}

export type FakeHandler = (service: FakeLockedUseService, request: FakeRequest) => void;

export interface FakeLockedUseService {
  readonly path: string;
  /** Every request received, in order. */
  readonly requests: FakeRequest[];
  status: LockedUseServiceStatus;
  /** Replace how one request type is handled. */
  handle(type: string, handler: FakeHandler): void;
  /** Called when an attempt reaches working, and when the Mac relocks. */
  onWorking?: () => void;
  onRelocked?: () => void;
  reply(request: FakeRequest, outcome?: { code: string; message: string }): void;
  /** Change the status and publish a `state` message. */
  publish(patch: Partial<LockedUseServiceStatus>): void;
  send(message: Record<string, unknown>): void;
  sendBytes(bytes: Uint8Array): void;
  /** The default handling, for scripts that wrap it. */
  readonly defaults: Record<string, FakeHandler>;
  /** Resolves once a request of `type` has arrived. */
  received(type: string): Promise<FakeRequest>;
  dropClients(): void;
  close(): Promise<void>;
}

const defaults: Record<string, FakeHandler> = {
  status: (service, request) => service.reply(request),
  enable(service, request) {
    service.status = { ...service.status, phase: "ready" };
    service.reply(request);
  },
  disable(service, request) {
    service.status = { ...service.status, phase: "disabled" };
    service.reply(request);
  },
  begin(service, request) {
    const attemptID = request.scope?.attemptID ?? null;
    service.status = { ...service.status, phase: "covering", attemptID };
    service.reply(request);
    service.publish({ phase: "authorizing" });
    service.publish({ phase: "unlocking" });
    service.publish({ phase: "working", session: "unlocked" });
    service.onWorking?.();
  },
  finish: (service, request) => endAttempt(service, request, "finished"),
  cancel: (service, request) => endAttempt(service, request, "cancelled"),
};

/** Relocks, then reports completion: the order the real service keeps. */
export function endAttempt(
  service: FakeLockedUseService,
  request: FakeRequest | undefined,
  reason: string,
  workError: string | null = null,
): void {
  const attemptID = service.status.attemptID;
  const scope = service.requests.findLast((each) => each.type === "begin")?.scope;
  if (request) {
    if (!attemptID || request.attemptID !== attemptID)
      return service.reply(request, { code: "unknown_attempt", message: "No active attempt" });
    service.reply(request);
  }
  service.publish({ phase: "relocking" });
  service.status = { ...service.status, session: "locked" };
  service.onRelocked?.();
  service.send({
    type: "completion",
    attemptID,
    threadID: scope?.threadID ?? "",
    turnID: scope?.turnID ?? "",
    reason,
    workError,
  });
  service.publish({ phase: "ready", attemptID: null });
}

export async function fakeLockedUseService(path: string): Promise<FakeLockedUseService> {
  const clients = new Set<Socket>();
  const handlers = new Map<string, FakeHandler>();
  const waiters: { type: string; resolve: (request: FakeRequest) => void }[] = [];
  const server: Server = createServer((socket) => {
    clients.add(socket);
    const decoder = new LockedUseFrameDecoder();
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      let frames: Buffer[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        const request = FakeRequest.parse(JSON.parse(frame.toString("utf8")));
        service.requests.push(request);
        for (const waiter of waiters.splice(0))
          if (waiter.type === request.type) waiter.resolve(request);
          else waiters.push(waiter);
        (handlers.get(request.type) ?? defaults[request.type])?.(service, request);
      }
    });
  });
  const service: FakeLockedUseService = {
    path,
    requests: [],
    status: fakeStatus(),
    defaults,
    handle: (type, handler) => handlers.set(type, handler),
    reply(request, outcome) {
      service.send(
        outcome
          ? { type: "reply", id: request.id, ok: false, error: outcome }
          : { type: "reply", id: request.id, ok: true, status: service.status },
      );
    },
    publish(patch) {
      service.status = { ...service.status, ...patch };
      service.send({ type: "state", status: service.status });
    },
    send(message) {
      service.sendBytes(
        encodeLockedUseFrame(new TextEncoder().encode(JSON.stringify({ v: 1, ...message }))),
      );
    },
    sendBytes(bytes) {
      for (const client of clients) client.write(bytes);
    },
    received(type) {
      const seen = service.requests.find((request) => request.type === type);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    dropClients() {
      for (const client of clients) client.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        service.dropClients();
        server.close(() => resolve());
      }),
  };
  // Like the real service, a stale socket file from an earlier run is replaced.
  rmSync(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return service;
}

const socketFlag = process.argv.indexOf("--socket");
if (process.argv.includes("--locked-use") && socketFlag !== -1) {
  const path = process.argv[socketFlag + 1];
  if (!path) process.exit(2);
  await fakeLockedUseService(path);
}
