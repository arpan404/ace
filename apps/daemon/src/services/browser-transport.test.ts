import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { sendBrowserMessage } from "./browser-transport.ts";
import { BrowserServerMessage } from "@ace/protocol";

function fixture(bufferedAmount: number) {
  const sent: string[] = [];
  let readyState: WebSocket["readyState"] = WebSocket.OPEN;
  const socket: Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "terminate"> = {
    get readyState() {
      return readyState;
    },
    bufferedAmount,
    send(data: unknown) {
      sent.push(String(data));
    },
    terminate() {
      readyState = WebSocket.CLOSED;
    },
  };
  return {
    socket,
    messages: () => sent.map((message) => BrowserServerMessage.parse(JSON.parse(message))),
  };
}
const state = BrowserServerMessage.parse({
  type: "browser.state",
  state: {
    threadId: "thread",
    url: "http://localhost:3000",
    controller: "human",
    owner: "owner",
    closed: false,
  },
});
const success = BrowserServerMessage.parse({
  type: "browser.result",
  requestId: "takeover",
  ok: true,
});
const failure = BrowserServerMessage.parse({
  type: "browser.result",
  requestId: "handback",
  ok: false,
  error: "Browser controller mismatch",
});
const loss = BrowserServerMessage.parse({
  type: "browser.backend.lost",
  threadId: "thread",
  backend: "embedded",
  recovery: "pause",
  url: "about:blank",
  pageStateLost: true,
  reason: "Desktop disconnected",
});
const frame = BrowserServerMessage.parse({
  type: "browser.frame",
  threadId: "thread",
  frame: { sequence: 1, timestamp: 0, data: "AA==", width: 100, height: 100 },
});

it("a pressured frame drops while control replies still reach a healthy app", () => {
  const f = fixture(768 * 1024);
  expect(sendBrowserMessage(f.socket, frame)).toBe(false);
  expect(f.socket.readyState).toBe(WebSocket.OPEN);
  expect(sendBrowserMessage(f.socket, state)).toBe(true);
  expect(sendBrowserMessage(f.socket, success)).toBe(true);
  expect(f.messages()).toEqual([state, success]);
});

it.each([success, failure, state, loss])(
  "undeliverable $type closes the app connection so it cannot lose reliable browser messages silently",
  (message) => {
    const f = fixture(5 * 1024 * 1024);
    expect(sendBrowserMessage(f.socket, message)).toBe(false);
    expect(f.socket.readyState).toBe(WebSocket.CLOSED);
    f.socket.bufferedAmount = 0;
    expect(sendBrowserMessage(f.socket, success)).toBe(false);
    expect(f.messages()).toEqual([]);
  },
);

it("even heavy frame pressure leaves the socket available when the buffer drains", () => {
  const f = fixture(5 * 1024 * 1024);
  expect(sendBrowserMessage(f.socket, frame)).toBe(false);
  expect(f.socket.readyState).toBe(WebSocket.OPEN);
  f.socket.bufferedAmount = 0;
  expect(sendBrowserMessage(f.socket, success)).toBe(true);
  expect(f.messages()).toEqual([success]);
});
