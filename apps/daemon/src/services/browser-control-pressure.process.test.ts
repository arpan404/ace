import { once } from "node:events";
import { expect, it, onTestFinished } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { connectBrowser } from "@ace/browser";
import { backendFixture } from "@ace/browser/testing";
import { BrowserClient } from "../browser-test-client.ts";
import { sendBrowserMessage } from "./browser-transport.ts";

it.each([true, false])(
  "a pressured privacy reply (private: %s) fails its exact pending request by disconnecting the live app",
  async (value) => {
    const f = await backendFixture();
    await f.open();
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
        type: "browser.tabs.private",
        requestId: "pressured-operation",
        threadId: "thread",
        tabId: "page",
        private: value,
      }),
    ).rejects.toThrow("Browser socket closed");
    expect((await closed)[0]).toBe(1006);
    buffered = 0;
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
    // The sibling thread can still perform work after the app connection fails.
    await f.open("sibling");
    await f.service.execute("sibling", { action: "press", key: "Enter" });
    expect(f.service.state("sibling").status).toBe("ready");
  },
);
