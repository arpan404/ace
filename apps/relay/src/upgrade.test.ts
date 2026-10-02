import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { expect, it } from "vitest";
import { z } from "zod";
import { PROCESS_TEST_TIMEOUT } from "@ace/provider-kit/testing";
import { register } from "./testing/peer.ts";

it("malformed upgrade targets are rejected without killing the relay or occupying admission", async () => {
  const entry = new URL("./index.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { startRelay } from ${JSON.stringify(entry)};
       const relay = await startRelay({ limits: { maxConnections: 1, maxConnectionsPerIp: 1 } });
       process.send({ port: relay.port });`,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, "exit");
  const timeout = setTimeout(() => child.kill(), PROCESS_TEST_TIMEOUT / 2);
  let socket: ReturnType<typeof connect> | undefined;
  let host: Awaited<ReturnType<typeof register>> | undefined;
  try {
    const announced = await Promise.race([
      once(child, "message").then(([message]) => z.object({ port: z.number() }).parse(message)),
      exited.then(() => {
        throw new Error(`Relay exited before listening: ${stderr}`);
      }),
    ]);
    socket = connect({ host: "127.0.0.1", port: announced.port });
    await once(socket, "connect");
    const closed = once(socket, "close");
    const response = Promise.race([
      once(socket, "data"),
      closed.then(() => {
        throw new Error("Relay closed without an HTTP rejection");
      }),
      exited.then(() => {
        throw new Error(`Relay exited during upgrade: ${stderr}`);
      }),
    ]);
    socket.write(
      "GET //% HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    expect(String((await response)[0])).toContain("400 Bad Request");
    await closed;
    expect(child.exitCode).toBeNull();
    host = await register(`ws://127.0.0.1:${announced.port}`);
    expect(host.hostId).toMatch(/^[A-Z2-7]{52}$/);
  } finally {
    clearTimeout(timeout);
    host?.close();
    host?.transport.destroy();
    socket?.destroy();
    child.kill();
    await exited;
  }
});
