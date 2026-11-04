import type { ClientApi } from "@ace/client";
import { Notifications } from "@ace/client";
import type { ServerMessage, TerminalRequest } from "@ace/protocol";
import { expect, test } from "vitest";
import type { TerminalEvent } from "../sources.ts";
import { daemonTerminals } from "./daemon-terminals.ts";

type Operation = TerminalRequest["operation"];

/** A ready client whose daemon socket can be swapped while it stays ready. */
function swappingClient() {
  const notifications = new Notifications(64);
  const handlers: ((message: ServerMessage) => void)[] = [];
  const subscribes: Extract<Operation, { op: "subscribe" }>[] = [];
  let socket = 1;
  const client = {
    state: "ready",
    connectionState: () => notifications.select(["connection"], () => "ready"),
    connectionGeneration: () => notifications.select(["socket"], () => socket),
    onMessage: (handler: (message: ServerMessage) => void) => {
      handlers.push(handler);
      return () => {};
    },
    send: () => {},
    request: async (input: { operation: Operation }) => {
      if (input.operation.op === "subscribe") subscribes.push(input.operation);
      return { type: "terminal.result", requestId: "r", ok: true };
    },
  };
  return {
    client: client as unknown as ClientApi,
    subscribes,
    swap() {
      socket++;
      notifications.emit(["socket"]);
    },
    output(subscriptionId: string, offset: number, data: string) {
      const message = {
        type: "terminal.output",
        subscriptionId,
        event: {
          type: "data",
          offset,
          endOffset: offset + data.length,
          data,
          truncatedBefore: false,
        },
      } as ServerMessage;
      for (const handler of handlers) handler(message);
    },
  };
}

test("terminal output continues after the connection moves to another socket", () => {
  const daemon = swappingClient();
  const source = daemonTerminals(daemon.client);
  source.adopt?.("term-1");
  const seen: string[] = [];
  source.attach("term-1", 0, (event: TerminalEvent) => {
    if (event.type === "data") seen.push(event.data);
  });
  const first = daemon.subscribes[0];
  expect(first?.fromOffset).toBe(0);
  daemon.output(first?.subscriptionId ?? "", 0, "hello ");

  daemon.swap();

  const second = daemon.subscribes[1];
  expect(second?.terminalId).toBe("term-1");
  expect(second?.fromOffset).toBe(6);
  expect(second?.subscriptionId).not.toBe(first?.subscriptionId);
  // The old socket drains for a moment; what it still sends is not drawn twice.
  daemon.output(first?.subscriptionId ?? "", 6, "stale");
  daemon.output(second?.subscriptionId ?? "", 6, "world");
  expect(seen).toEqual(["hello ", "world"]);
});
