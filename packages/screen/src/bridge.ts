import { TargetBusyError } from "./target-busy.ts";
import {
  ScreenError,
  ScreenClientMessage,
  ScreenState,
  type ScreenServerMessage,
} from "@ace/protocol";
import type { ScreenManager } from "./manager.ts";
import type { Simulators } from "./simulator.ts";

export type ScreenPeer = {
  send: (message: ScreenServerMessage) => void;
  frame: (packet: Buffer) => Promise<void>;
};
/** Attach only after the host transport authenticates a human device. */
export function screenConnection(
  manager: ScreenManager,
  simulators: Simulators,
  owner: string,
  peer: ScreenPeer,
): { request(input: unknown): Promise<void>; close(): void } {
  const subscriptions = new Map<string, () => void>();
  let closed = false;
  let pending = 0;
  const unwatch = manager.watch((state) => {
    if (!closed) peer.send({ type: "screen.state", state });
  });
  const unwatchEnabled = manager.watchEnabled((enabled) => {
    if (!closed) peer.send({ type: "screen.enabled", enabled });
  });
  return {
    async request(input) {
      const { requestId, operation } = ScreenClientMessage.parse(input);
      const respond = (
        result: Omit<Extract<ScreenServerMessage, { type: "screen.result" }>, "type" | "requestId">,
      ) => {
        if (!closed) peer.send({ type: "screen.result", requestId, ...result });
      };
      if (closed) return;
      if (pending >= 16) {
        respond({ ok: false, error: "Screen request limit" });
        return;
      }
      pending++;
      try {
        let data: unknown;
        switch (operation.op) {
          case "status":
            data = {
              enabled: manager.isEnabled(),
              permissions: await manager.currentPermissions(),
              sessions: manager.states().length,
            };
            break;
          case "permissions.request":
            data = await manager.requestPermission(operation.permission);
            break;
          case "enable":
            await manager.enable(operation.enabled);
            break;
          case "approve":
            await manager.approve(
              operation.bundleId,
              operation.allowed,
              operation.scope,
              operation.threadId,
            );
            break;
          case "approvals":
            data = manager.approvals(operation.threadId);
            break;
          case "stop.all":
            await manager.stopAll();
            break;
          case "mode":
            data = await manager.mode(
              operation.sessionId,
              operation.mode,
              undefined,
              operation.reason,
            );
            break;
          case "secure.input":
            manager.secureInput(operation.sessionId, operation.allowed);
            data = manager.state(operation.sessionId);
            break;
          case "open.app":
            data = await manager.openApp(operation.bundleId);
            break;
          case "capabilities":
            data = await manager.capabilities();
            break;
          case "ui.tree":
            data = await manager.uiTree(operation.sessionId, operation, owner);
            break;
          case "ui.find":
            data = await manager.uiFind(operation.sessionId, operation, owner);
            break;
          case "ui.act":
            data = await manager.uiAct(operation.sessionId, "human", operation, owner);
            break;
          case "input":
            data = await manager.input(operation.sessionId, "human", operation.input, owner);
            break;
          case "permissions":
            data = await manager.permissions();
            break;
          case "sessions":
            data = manager.states();
            break;
          case "targets":
            data = await manager.targets();
            break;
          case "start": {
            const state = await manager.start(
              operation.target,
              operation.fps,
              operation.threadId ? { threadId: operation.threadId, agentId: "human" } : undefined,
            );
            if (closed) await manager.stop(state.sessionId);
            else data = state;
            break;
          }
          case "stop":
            await manager.stop(operation.sessionId);
            break;
          case "controller":
            if (operation.controller === "agent" && !operation.agentId)
              throw new Error("Agent id required for delegation");
            if (operation.controller === "agent" && operation.agentId && operation.threadId)
              manager.delegateAgent(operation.sessionId, {
                agentId: operation.agentId,
                threadId: operation.threadId,
              });
            else
              manager.controller(
                operation.sessionId,
                operation.controller,
                operation.controller === "agent" ? operation.agentId : owner,
              );
            break;
          case "action":
            await manager.action(operation.sessionId, "human", operation.action, owner);
            break;
          case "subscribe": {
            subscriptions.get(operation.sessionId)?.();
            subscriptions.delete(operation.sessionId);
            if (subscriptions.size >= 8) throw new Error("Screen subscription limit");
            const stop = manager.subscribe(operation.sessionId, async (frame) => {
              if (!closed) await peer.frame(frame.packet);
            });
            subscriptions.set(operation.sessionId, stop);
            peer.send({
              type: "screen.state",
              state: ScreenState.parse(manager.state(operation.sessionId)),
            });
            break;
          }
          case "unsubscribe":
            subscriptions.get(operation.sessionId)?.();
            subscriptions.delete(operation.sessionId);
            break;
          case "record.start":
            await manager.startRecording(operation.sessionId);
            break;
          case "record.stop":
            data = await manager.stopRecording(operation.sessionId);
            break;
          case "simulators":
            data = await simulators.list();
            break;
          case "simulator.boot":
            manager.requireApproval("com.apple.iphonesimulator");
            await simulators.boot(operation.udid);
            break;
        }
        respond({ ok: true, data });
      } catch (error) {
        respond({
          ok: false,
          error: error instanceof Error ? error.message : "Screen request failed",
          ...(error instanceof Error &&
          "code" in error &&
          ScreenError.shape.code.safeParse(error.code).success
            ? { errorCode: ScreenError.shape.code.parse(error.code) }
            : {}),
          ...(error instanceof TargetBusyError ? { holder: error.holder } : {}),
        });
      } finally {
        pending--;
      }
    },
    close() {
      closed = true;
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      unwatch();
      unwatchEnabled();
      manager.releaseController(owner);
    },
  };
}
