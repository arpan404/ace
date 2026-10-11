import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  ClientMessage,
  ServerMessage,
  type ClientMessage as Request,
  type ServerMessage as Reply,
} from "@ace/protocol";
import { smokeMessage } from "./policy.ts";

type ProbeClock = { repeat(callback: () => void, milliseconds: number): () => void };
const systemClock: ProbeClock = {
  repeat(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    return () => clearInterval(timer);
  },
};
export async function probe(url: string, token: string, clock: ProbeClock = systemClock) {
  const socket = new WebSocket(url);
  let closeError: Error | undefined;
  let stopKeepalive: (() => void) | undefined;
  const pending = new Map<string, { resolve(value: Reply): void; reject(error: Error): void }>();
  socket.on("message", (data) => {
    const parsed = ServerMessage.safeParse(JSON.parse(data.toString()));
    if (!parsed.success) return;
    const message = parsed.data;
    if ("requestId" in message && message.requestId) {
      const waiter = pending.get(message.requestId);
      if (message.type === "error") waiter?.reject(new Error(message.code));
      else waiter?.resolve(message);
    }
  });
  const fail = (error: Error) => {
    closeError = error;
    stopKeepalive?.();
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("close", (code, reason) =>
    fail(new Error(`Probe closed (${code}): ${reason.toString() || "connection ended"}`)),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify(
      smokeMessage({ type: "hello", protocolVersion: 1, deviceId: "real-smoke-probe", token }),
    ),
  );
  stopKeepalive = clock.repeat(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
  }, 20_000);
  return {
    async request(raw: unknown, timeoutMs = 60_000): Promise<Reply> {
      if (closeError) throw closeError;
      const id = randomUUID();
      const request: Request = ClientMessage.parse({ ...Object(raw), requestId: id });
      smokeMessage(request);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Reply>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${request.type} exceeded ${timeoutMs}ms`)),
            timeoutMs,
          );
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify(request));
        });
      } finally {
        if (timer) clearTimeout(timer);
        pending.delete(id);
      }
    },
    close() {
      stopKeepalive?.();
      socket.close();
    },
  };
}
