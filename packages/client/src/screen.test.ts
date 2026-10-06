import { expect, it, onTestFinished } from "vitest";
import { Client } from "./index.ts";
import { ScreenClient } from "./screen.ts";
import { DeviceId, ScreenState, ServerMessage, ClientMessage } from "@ace/protocol";
import type { TransportEvents } from "./types.ts";
import { ManualScheduler, memoryStorage, ready } from "./test-support.ts";

it("human screen controls use typed busy errors and state pushes while foreground approval waits for a human", async () => {
  let events: TransportEvents | undefined;
  const state = ScreenState.parse({
    sessionId: "app",
    lifecycle: "live",
    controller: "agent",
    indicator: false,
    mode: "background",
    holder: { threadId: "thread", agentId: "agent" },
    target: { kind: "app", bundleId: "dev.ace.test" },
    permissions: { screenRecording: true, accessibility: true },
  });
  let enabled = false,
    stopped = false,
    serial = 0;
  const receive = (message: unknown) =>
    events?.message(JSON.stringify(ServerMessage.parse(message)));
  const scheduler = new ManualScheduler();
  const modeReady = Promise.withResolvers<void>();
  const client = new Client({
    deviceId: DeviceId.parse("human"),
    storage: memoryStorage(),
    scheduler,
    random: () => 0.5,
    id: () => `client-${++serial}`,
    credential: async () => "token",
    transport: () => ({
      open(next) {
        events = next;
        next.open();
      },
      close() {
        events?.close(1000);
      },
      send(text) {
        const message = ClientMessage.parse(JSON.parse(text));
        if (message.type === "hello")
          receive({
            type: "welcome",
            protocolVersion: 1,
            hostId: "host",
            headSeq: 0,
          });
        if (message.type === "ping") receive({ type: "pong" });
        if (message.type !== "screen.request") return;
        const operation = message.operation;
        if (operation.op === "mode") {
          scheduler.set(40_000, () => {
            state.mode = operation.mode;
            receive({ type: "screen.result", requestId: message.requestId, ok: true, data: state });
          });
          modeReady.resolve();
          return;
        }
        if (operation.op === "enable") enabled = operation.enabled;
        if (operation.op === "stop.all") stopped = true;
        if (operation.op === "controller") {
          state.controller = operation.controller;
          if (operation.controller !== "agent") {
            state.mode = "background";
            state.secureInputAllowed = false;
            state.holder = undefined;
          }
          receive({ type: "screen.state", state });
        }
        if (operation.op === "start") {
          receive({
            type: "screen.result",
            requestId: message.requestId,
            ok: false,
            errorCode: "target_busy",
            error: "App held",
            holder: { sessionId: "app", owner: "agent" },
          });
        } else
          receive({
            type: "screen.result",
            requestId: message.requestId,
            ok: true,
            data: operation.op === "sessions" ? [state] : undefined,
          });
      },
    }),
  });
  onTestFinished(() => client.close());
  await ready(client);
  const screen = new ScreenClient(client),
    pushes: string[] = [];
  const unwatch = screen.watch((value) => pushes.push(value.controller));
  await screen.enable(true);
  expect(enabled).toBe(true);
  expect((await screen.sessions())[0]?.holder?.agentId).toBe("agent");
  await expect(screen.start(state.target)).rejects.toMatchObject({
    errorCode: "target_busy",
    holder: { sessionId: "app", owner: "agent" },
  });
  const foreground = screen.mode("app", "foreground");
  await modeReady.promise;
  scheduler.advance(40_000);
  expect((await foreground).mode).toBe("foreground");
  await screen.takeover("app");
  expect(pushes).toEqual(["human"]);
  unwatch();
  await screen.stopAll();
  expect(stopped).toBe(true);
});
