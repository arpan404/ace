import { WebSocket, WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { guardProxy } from "./proxy.ts";
import type { Finding } from "./checks.ts";
import { ClientMessage } from "@ace/protocol";

async function peer(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}
test("the network guard refuses prompts, login, installation and malformed JSON before the daemon receives them", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const received: string[] = [];
  upstream.on("connection", (socket) =>
    socket.on("message", (data) => {
      received.push(data.toString());
      socket.send(data);
    }),
  );
  const failures: Finding[] = [];
  const proxy = await guardProxy(`ws://127.0.0.1:${address.port}/`, (failure) =>
    failures.push(failure),
  );
  try {
    for (const request of [
      JSON.stringify({
        type: "command",
        command: {
          id: "unsafe",
          deviceId: "smoke",
          payload: {
            type: "thread.send",
            threadId: "thread",
            input: [{ type: "text", text: "Do not spend quota" }],
          },
        },
      }),
      JSON.stringify({ type: "provider.login.start", requestId: "login", provider: "claude" }),
      JSON.stringify({
        type: "provider.install.run",
        requestId: "install",
        provider: "codex",
        action: "install",
        method: "bun",
      }),
      "{broken JSON",
    ]) {
      if (request !== "{broken JSON") ClientMessage.parse(JSON.parse(request));
      const socket = await peer(proxy.url);
      const closed = new Promise<number>((resolve) =>
        socket.once("close", (code) => resolve(code)),
      );
      socket.send(request);
      expect(await closed).toBe(1008);
    }
    const socket = await peer(proxy.url);
    const echoed = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    );
    socket.send(JSON.stringify({ type: "history.scan", action: "status" }));
    expect(JSON.parse(await echoed).type).toBe("history.scan");
    expect(received.map((text) => JSON.parse(text).type)).toEqual(["history.scan"]);
    expect(failures.filter((failure) => failure.code === "refused-command")).toHaveLength(4);
    socket.close();
  } finally {
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
