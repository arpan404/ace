import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { sendBrowserMessage } from "./browser-transport.ts";
import { BrowserServerMessage } from "@ace/protocol";

it("a buffered frame does not disconnect the app or lose a control reply", () => {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 768 * 1024,
    send(data: unknown) {
      sent.push(String(data));
    },
  };
  const state = BrowserServerMessage.parse({
    type: "browser.state",
    state: { threadId: "thread", url: "http://localhost:3000", controller: "agent", closed: false },
  });
  expect(sendBrowserMessage(socket, state)).toBe(true);
  expect(sent.map((message) => BrowserServerMessage.parse(JSON.parse(message)))).toEqual([state]);
  socket.bufferedAmount = 5 * 1024 * 1024;
  expect(sendBrowserMessage(socket, state)).toBe(false);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  socket.bufferedAmount = 0;
  const reply = BrowserServerMessage.parse({
    type: "browser.result",
    requestId: "reply",
    ok: true,
  });
  expect(sendBrowserMessage(socket, reply)).toBe(true);
  expect(sent.map((message) => BrowserServerMessage.parse(JSON.parse(message)))).toEqual([
    state,
    reply,
  ]);
});
