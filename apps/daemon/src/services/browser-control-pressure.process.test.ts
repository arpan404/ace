import { once } from "node:events";
import { expect, it, onTestFinished } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { connectBrowser } from "@ace/browser";
import { backendFixture } from "@ace/browser/testing";
import { BrowserClient } from "../browser-test-client.ts";
import { sendBrowserMessage } from "./browser-transport.ts";

it.each(["takeover", "rejected handback"])(
  "a pressured %s reply fails its exact pending request by disconnecting the live app",
  async (operation) => {
    const f = await backendFixture();
    await f.open();
    if (operation === "rejected handback") f.service.takeover("thread", "another-owner");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const connected = once(server, "connection");
    const client = new BrowserClient(`ws://127.0.0.1:${address.port}`);
    onTestFinished(() => client.close());
    await once(client.socket, "open");
    const socket = (await connected)[0];
    if (!(socket instanceof WebSocket)) throw new Error("Missing app socket");
    onTestFinished(() => socket.terminate());
    let buffered = 0;
    Object.defineProperty(socket, "bufferedAmount", { get: () => buffered });
    const bridge = connectBrowser(f.service, {
      connectionId: "app",
      authorize: () => true,
      send: (message, serialized) => sendBrowserMessage(socket, message, serialized),
    });
    onTestFinished(() => bridge.close());
    socket.on("message", (data) => {
      void bridge.handle(JSON.parse(data.toString()));
    });
    socket.on("close", () => bridge.close());
    expect(
      await client.request({ type: "browser.tabs.list", requestId: "before", threadId: "thread" }),
    ).toMatchObject({ ok: true });
    buffered = 5 * 1024 * 1024;
    const closed = once(client.socket, "close");
    await expect(
      client.request({
        type: operation === "takeover" ? "browser.takeover" : "browser.handback",
        requestId: "pressured-operation",
        threadId: "thread",
      }),
    ).rejects.toThrow("Browser socket closed");
    expect((await closed)[0]).toBe(1006);
    buffered = 0;
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
    if (operation === "rejected handback")
      expect(f.service.state("thread").owner).toBe("another-owner");
    // The sibling thread can still perform work after the app connection fails.
    await f.open("sibling");
    await f.service.execute("sibling", { action: "press", key: "Enter" });
    expect(f.service.state("sibling").status).toBe("ready");
  },
);
