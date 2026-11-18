import { once } from "node:events";
import { WebSocket } from "ws";
import { ServerMessage } from "@ace/protocol";
import { appSocketProof } from "@ace/service/app-key";
import { hostConnection } from "./cli/connection.ts";

/**
 * A raw socket on the host token, as any process that read `daemon-token` can open. With
 * `appKey`, its hello also carries the proof the desktop app's page makes with that key for the
 * daemon's port (ADR 0178 §12.8). `hello` replaces what the hello carries, for a paired
 * device's ticket.
 */
export async function hostSocket(
  home: string,
  deviceId: string,
  cleanup: (() => Promise<unknown>)[],
  options: {
    appKey?: Uint8Array;
    hello?: Record<string, unknown>;
  } = {},
) {
  const { origin, token } = hostConnection(home);
  const appProof = options.appKey
    ? appSocketProof(options.appKey, Number(new URL(origin).port))
    : undefined;
  const socket = new WebSocket(origin.replace("http:", "ws:"));
  cleanup.push(async () => socket.close());
  const frames: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (data) => {
    frames.push(ServerMessage.parse(JSON.parse(String(data))));
    for (const wake of waiters.splice(0)) wake();
  });
  const next = async (match: (message: ServerMessage) => boolean): Promise<ServerMessage> => {
    for (;;) {
      const found = frames.findIndex(match);
      if (found >= 0) return frames.splice(found, 1)[0] ?? frames[0]!;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId,
      token,
      ...(appProof ? { appProof } : {}),
      ...options.hello,
    }),
  );
  await next((message) => message.type === "welcome");
  return {
    market: async (requestId: string, operation: unknown) => {
      socket.send(JSON.stringify({ type: "marketplace.request", requestId, operation }));
      const answer = await next(
        (message) => message.type === "marketplace.result" && message.requestId === requestId,
      );
      return answer.type === "marketplace.result" ? answer.result : undefined;
    },
    settings: async (requestId: string, key: string, value: unknown) => {
      socket.send(
        JSON.stringify({
          type: "settings.set",
          requestId,
          key,
          value,
          layer: { kind: "global" },
        }),
      );
      return next(
        (message) => message.type === "settings.result" && message.requestId === requestId,
      );
    },
    answer: async (
      commandId: string,
      interactionId: string,
      resolution: unknown = { kind: "approval", optionId: "run" },
    ) => {
      socket.send(
        JSON.stringify({
          type: "command",
          command: {
            id: commandId,
            deviceId,
            payload: {
              type: "interaction.resolve",
              interactionId,
              resolution,
            },
          },
        }),
      );
      return next(
        (message) =>
          (message.type === "commandResult" && message.commandId === commandId) ||
          (message.type === "error" && message.commandId === commandId),
      );
    },
  };
}
