import type { Transport, TransportEvents } from "./types.ts";

export interface SocketLike {
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  send(text: string): void;
  close(): void;
}
/** Supply `() => new WebSocket(url)` in browsers and React Native. */
export function webSocketTransport(createSocket: () => SocketLike): Transport {
  let socket: SocketLike | undefined;
  let events: TransportEvents | undefined;
  return {
    open(next) {
      events = next;
      socket = createSocket();
      socket.addEventListener("open", () => events?.open());
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") events?.message(event.data);
        else {
          events?.close(4002);
          socket?.close();
        }
      });
      socket.addEventListener("close", (event) => events?.close(event.code));
      socket.addEventListener("error", () => {
        events?.close(1006);
        socket?.close();
      });
    },
    send(text) {
      if (!socket) throw new Error("Transport not open");
      socket.send(text);
    },
    close() {
      events = undefined;
      socket?.close();
      socket = undefined;
    },
  };
}
