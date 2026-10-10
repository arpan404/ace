/** Platform bridge keeps the portable relay's byte contract outside DOM overloads. */
export function portableSocket(url: string) {
  const socket = new WebSocket(url);
  function listen(type: "open" | "error", listener: () => void): void;
  function listen(type: "message", listener: (event: { data: unknown }) => void): void;
  function listen(type: "close", listener: () => void): void;
  function listen(
    type: "open" | "error" | "message" | "close",
    listener: (event: { data: unknown }) => void,
  ) {
    if (type === "message")
      socket.addEventListener(type, (event) => listener({ data: event.data }));
    else socket.addEventListener(type, () => listener({ data: undefined }));
  }
  return {
    get binaryType() {
      return socket.binaryType;
    },
    set binaryType(value: string) {
      socket.binaryType = value === "arraybuffer" ? "arraybuffer" : "blob";
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    addEventListener: listen,
    send(data: string | Uint8Array) {
      socket.send(typeof data === "string" ? data : new Uint8Array(data).buffer);
    },
    close() {
      socket.close();
    },
  };
}
