import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  ClientMessage,
  ServerMessage,
  type ClientMessage as Request,
  type ServerMessage as Reply,
} from "@ace/protocol";
import { smokeMessage } from "./policy.ts";

export async function probe(
  url: string,
  token: string,
  every: (run: () => void, milliseconds: number) => () => void = (run, milliseconds) => {
    const timer = setInterval(run, milliseconds);
    timer.unref();
    return () => clearInterval(timer);
  },
) {
  const socket = new WebSocket(url);
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
  const rejectPending = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("Probe connection closed"));
    pending.clear();
  };
  socket.on("error", rejectPending);
  socket.on("close", rejectPending);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify(
      smokeMessage({ type: "hello", protocolVersion: 1, deviceId: "real-smoke-probe", token }),
    ),
  );
  const stopHeartbeat = every(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
  }, 20_000);
  socket.once("close", stopHeartbeat);
  return {
    async request(raw: unknown, timeoutMs = 60_000): Promise<Reply> {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("Probe connection closed");
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
      stopHeartbeat();
      rejectPending();
      socket.close();
    },
  };
}
