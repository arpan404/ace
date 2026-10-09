import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  ClientMessage,
  ServerMessage,
  type ClientMessage as Request,
  type ServerMessage as Reply,
} from "@ace/protocol";
import { smokeMessage } from "./policy.ts";

export async function probe(url: string, token: string) {
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
  socket.on("error", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("Probe connection failed"));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify(
      smokeMessage({ type: "hello", protocolVersion: 1, deviceId: "real-smoke-probe", token }),
    ),
  );
  return {
    async request(raw: unknown, timeoutMs = 60_000): Promise<Reply> {
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
      socket.close();
    },
  };
}
