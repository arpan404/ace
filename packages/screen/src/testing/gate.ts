import { createServer } from "node:net";
import { deferred } from "./support.ts";
/** An independent helper IPC acknowledgement; never consumes the native command queue. */
export async function helperGate() {
  const reached = deferred<void>(),
    released = deferred<void>();
  const server = createServer((socket) => {
    socket.once("data", () => reached.resolve());
    void released.promise.then(() => socket.end("release\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing gate endpoint");
  return {
    port: String(address.port),
    reached: reached.promise,
    release: () => released.resolve(),
    close: () => {
      released.resolve();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
