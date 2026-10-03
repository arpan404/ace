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
      socket?.close();
      events = next;
      const opened = createSocket();
      socket = opened;
      const current = () => socket === opened && events === next;
      opened.addEventListener("open", () => {
        if (current()) next.open();
      });
      opened.addEventListener("message", (event) => {
        if (!current()) return;
        if (typeof event.data === "string") next.message(event.data);
        else {
          next.close(4002);
          opened.close();
        }
      });
      opened.addEventListener("close", (event) => {
        if (current()) next.close(event.code);
      });
      opened.addEventListener("error", () => {
        if (!current()) return;
        next.close(1006);
        opened.close();
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
