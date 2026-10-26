/*
 * A stand-in for `ace-screen-helper --locked-use --socket <path>` in tests: a real Unix socket
 * server speaking the service's framed protocol. By default it behaves like a healthy service
 * on a locked Mac (enable → ready; begin → covering, authorizing, unlocking, working; finish →
 * relocking, completion, ready). Tests replace any request's handling to script refusals,
 * error events, takeovers and dropped connections. It never touches the machine.
 *
 * Like the real service it serves a client only after the mutual handshake (the daemon's
 * `hello` nonce, our proof, then the daemon's `prove` proof over the shared token; anything else
 * is refused and the client dropped), and `enable` and `begin` without `optIn: true` are refused
 * as `not_enabled`, turning it off and relocking.
 *
 * Run directly (`node fake-locked-use-service.ts --locked-use --socket <path>`) it reads the
 * token as one line of 64 hex characters on stdin (exiting 2 without one in 5s), serves the
 * default behaviour (on an unlocked Mac with `--fake-session unlocked`), and exits when stdin
 * closes.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import {
  LockedUseFrameDecoder,
  encodeLockedUseFrame,
  type LockedUseServiceStatus,
} from "../locked-use-wire.ts";
import {
  lockedUseDaemonProof,
  lockedUseProofEquals,
  lockedUseServiceProof,
} from "../locked-use-handshake.ts";

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
  optIn: z.unknown().optional(),
  nonce: z.unknown().optional(),
  proof: z.unknown().optional(),
});
export type FakeRequest = z.infer<typeof FakeRequest>;

/** The token tests give the fake service unless they choose another. */
export const fakeLockedUseToken = "0123456789abcdef".repeat(4);

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
  /** Every request received after a client's hello was accepted, in order. */
  readonly requests: FakeRequest[];
  /** Every hello received, accepted or not, as the daemon nonce it carried. */
  readonly hellos: unknown[];
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

/** Whether a request must carry the person's opt-in, and lacks it. */
const lacksOptIn = (request: FakeRequest) =>
  (request.type === "enable" || request.type === "begin") && request.optIn !== true;

/** What the real service does on a missing opt-in: refuse, stop any attempt, turn off. */
function refuseWithoutOptIn(service: FakeLockedUseService, request: FakeRequest): void {
  service.reply(request, {
    code: "not_enabled",
    message: "Locked use isn't turned on by the person.",
  });
  if (service.status.attemptID) endAttempt(service, undefined, "notEnabled");
  service.publish({ phase: "disabled" });
}

export async function fakeLockedUseService(
  path: string,
  options: { token?: string } = {},
): Promise<FakeLockedUseService> {
  const token = options.token ?? fakeLockedUseToken;
  /** Clients whose handshake was accepted; only they are served and sent messages. */
  const clients = new Set<Socket>();
  const sockets = new Set<Socket>();
  /** Per-socket handshake progress until it joins `clients`. */
  const shaking = new Map<Socket, { daemonNonce: string; serviceNonce: string }>();
  const handlers = new Map<string, FakeHandler>();
  const waiters: { type: string; resolve: (request: FakeRequest) => void }[] = [];
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const decoder = new LockedUseFrameDecoder();
    socket.on("close", () => {
      clients.delete(socket);
      sockets.delete(socket);
      shaking.delete(socket);
    });
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
        const write = (message: Record<string, unknown>) =>
          socket.write(
            encodeLockedUseFrame(new TextEncoder().encode(JSON.stringify({ v: 1, ...message }))),
          );
        const refuse = () => {
          write({
            type: "reply",
            id: request.id,
            ok: false,
            error: { code: "unauthorized", message: "handshake required" },
          });
          socket.end();
        };
        if (!clients.has(socket)) {
          const progress = shaking.get(socket);
          if (!progress) {
            // First frame must be a hello carrying the daemon's nonce; answer with ours + proof.
            const daemonNonce = typeof request.nonce === "string" ? request.nonce : "";
            if (request.type !== "hello" || !/^[0-9a-f]{64}$/.test(daemonNonce)) return refuse();
            service.hellos.push(request.nonce);
            const serviceNonce = Buffer.from(randomBytes(32)).toString("hex");
            shaking.set(socket, { daemonNonce, serviceNonce });
            write({
              type: "reply",
              id: request.id,
              ok: true,
              nonce: serviceNonce,
              proof: lockedUseServiceProof(token, daemonNonce, serviceNonce),
            });
            continue;
          }
          // Second frame must be prove with the daemon's matching proof.
          const expected = lockedUseDaemonProof(token, progress.daemonNonce, progress.serviceNonce);
          if (
            request.type !== "prove" ||
            typeof request.proof !== "string" ||
            !lockedUseProofEquals(request.proof, expected)
          )
            return refuse();
          shaking.delete(socket);
          clients.add(socket);
          write({ type: "reply", id: request.id, ok: true });
          continue;
        }
        service.requests.push(request);
        for (const waiter of waiters.splice(0))
          if (waiter.type === request.type) waiter.resolve(request);
          else waiters.push(waiter);
        if (lacksOptIn(request)) refuseWithoutOptIn(service, request);
        else (handlers.get(request.type) ?? defaults[request.type])?.(service, request);
      }
    });
  });
  const service: FakeLockedUseService = {
    path,
    requests: [],
    hellos: [],
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
      for (const socket of sockets) socket.destroy();
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

/** The daemon's token: one line of 64 lowercase hex characters on stdin, within 5s. */
function readToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let text = "";
    const timer = setTimeout(() => resolve(undefined), 5_000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      const line = text.slice(0, end);
      resolve(/^[0-9a-f]{64}$/.test(line) ? line : undefined);
    });
    process.stdin.on("end", () => resolve(undefined));
  });
}

const socketFlag = process.argv.indexOf("--socket");
if (process.argv.includes("--locked-use") && socketFlag !== -1) {
  const path = process.argv[socketFlag + 1];
  if (!path) process.exit(2);
  const token = await readToken();
  if (!token) process.exit(2);
  // The daemon closing stdin means it is gone: relock (nothing to do here) and exit.
  process.stdin.on("end", () => process.exit(0));
  const service = await fakeLockedUseService(path, { token });
  // `--fake-session unlocked` starts it on an unlocked Mac (a guardian that hasn't relocked).
  if (process.argv[process.argv.indexOf("--fake-session") + 1] === "unlocked")
    service.status = fakeStatus({ session: "unlocked" });
}
