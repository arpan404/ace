import type { DeviceId, DeviceScope, ServerMessage } from "@ace/protocol";
import type { CommandLanes } from "./command-lanes.ts";
import { commandState } from "./command-status.ts";
import type { ServerOptions } from "./server-options.ts";
import type { SocketMessage } from "./services/socket.ts";
import { pageSubscription, subscribe } from "./subscription.ts";
import type { WireEncoder } from "./wire-encoder.ts";

/** What the core reads need from one authenticated socket. */
export interface CoreReader {
  options: ServerOptions;
  device: DeviceId;
  subscriptions: Map<string, () => void>;
  authorize(scope: DeviceScope): boolean;
  send(message: ServerMessage): void;
  fail(
    code: string,
    message: string,
    close?: boolean,
    scope?: { requestId?: string; subscriptionId?: string },
  ): void;
  delay(run: () => void, milliseconds: number): () => void;
  encoder: WireEncoder;
  lanes: CommandLanes;
}

/**
 * Subscriptions, pages, output reads and command status: core messages answered from the
 * store in socket order. Returns false for any other message.
 */
export function readCore(message: SocketMessage, reader: CoreReader): boolean {
  const { options, device, subscriptions, authorize, send, fail, encoder, lanes } = reader;
  switch (message.type) {
    case "threads.page": {
      const stop = subscriptions.get(message.subscriptionId);
      try {
        if (!authorize("read") || !stop) throw new Error("Subscription unavailable");
        pageSubscription(stop, message.before, message.requestId);
      } catch {
        fail("page_failed", "Unable to load this page; retry or refresh the list", false, {
          requestId: message.requestId,
        });
      }
      break;
    }
    case "command.status": {
      // Queued in order, so a command sent before this request is already on its lane.
      // Only the asking device's own commands are looked up.
      const actor = device;
      const commands = message.commandIds.map((commandId) => {
        const known = commandState(
          commandId,
          options.store.commandReceipt(commandId, actor),
          lanes.running(actor, commandId) ||
            options.workspaceActions?.creationDrafts.get(commandId, actor)?.operation?.active ===
              true,
        );
        if (known.result) send({ type: "commandResult", ...known.result });
        return { commandId, state: known.state };
      });
      send({ type: "command.status", requestId: message.requestId, commands });
      break;
    }
    case "unsubscribe":
      subscriptions.get(message.subscriptionId)?.();
      subscriptions.delete(message.subscriptionId);
      break;
    case "subscribe": {
      if (!authorize("read")) {
        fail("forbidden", "Read scope required", false, {
          subscriptionId: message.subscriptionId,
        });
        break;
      }
      subscriptions.get(message.subscriptionId)?.();
      subscriptions.delete(message.subscriptionId);
      if (subscriptions.size >= 64) {
        fail("subscription_limit", "Too many subscriptions", false, {
          subscriptionId: message.subscriptionId,
        });
        break;
      }
      if (
        message.scope.kind === "thread" &&
        options.canReadThread?.(device, message.scope.threadId) === false
      ) {
        fail("read_denied", "Thread is not readable", false, {
          subscriptionId: message.subscriptionId,
        });
        break;
      }
      try {
        const stop = subscribe(
          options.store,
          message.subscriptionId,
          message.scope,
          message.afterSeq,
          options.replayLimit ?? 5000,
          send,
          250,
          reader.delay,
          message.paced,
          encoder,
        );
        subscriptions.set(message.subscriptionId, stop);
      } catch {
        fail("subscribe_failed", "Unknown thread or invalid cursor", false, {
          subscriptionId: message.subscriptionId,
        });
      }
      break;
    }
    case "output.read": {
      if (!authorize("read")) {
        fail("forbidden", "Read scope required", false, { requestId: message.requestId });
        break;
      }
      const threadId = options.store.outputThread(message.streamId);
      if (!threadId || options.canReadThread?.(device, threadId) === false) {
        fail("read_denied", "Output stream is not readable", false, {
          requestId: message.requestId,
        });
        break;
      }
      send({
        type: "output.data",
        requestId: message.requestId,
        streamId: message.streamId,
        offset: message.offset,
        ...options.store.readOutput(message.streamId, message.offset, message.limit),
      });
      break;
    }
    case "entities.page": {
      if (
        !authorize("read") ||
        !options.store.getThread(message.threadId) ||
        options.canReadThread?.(device, message.threadId) === false
      ) {
        fail("read_denied", "Thread is not readable", false, { requestId: message.requestId });
        break;
      }
      try {
        send({
          type: "entities.page",
          requestId: message.requestId,
          page: options.store.readEntityPage(
            message.threadId,
            message.collection,
            message.before,
            message.limit,
          ),
        });
      } catch {
        fail("page_failed", "Could not read entity page", false, {
          requestId: message.requestId,
        });
      }
      break;
    }
    case "items.page": {
      if (!authorize("read")) {
        fail("forbidden", "Read scope required", false, { requestId: message.requestId });
        break;
      }
      if (
        !options.store.getThread(message.threadId) ||
        options.canReadThread?.(device, message.threadId) === false
      ) {
        fail("read_denied", "Thread is not readable", false, { requestId: message.requestId });
        break;
      }
      try {
        send({
          type: "items.page",
          requestId: message.requestId,
          ...options.store.readItemPage(
            message.threadId,
            message.before,
            message.limit,
            1024 * 1024 -
              Buffer.byteLength(
                JSON.stringify({
                  type: "items.page",
                  requestId: message.requestId,
                  threadId: message.threadId,
                }),
              ) -
              128,
          ),
        });
      } catch {
        fail("read_denied", "Invalid item cursor", false, { requestId: message.requestId });
      }
      break;
    }
    default:
      return false;
  }
  return true;
}
