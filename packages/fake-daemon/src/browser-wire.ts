import { BrowserState, type BrowserClientMessage, type ServerMessage } from "@ace/protocol";
import type { FakeBrowser } from "./browser.ts";
import type { FakeServiceContext } from "./service-context.ts";

/** The fixture emits data URLs for its synthetic SVG frames, with the same ACK lifetime. */
export function fakeBrowserSession(
  browser: FakeBrowser,
  host: FakeServiceContext,
  send: (message: ServerMessage) => void,
) {
  const subscriptions = new Map<
    string,
    { stop(): void; pump(): void; sent?: number; ack?: number }
  >();
  return {
    close() {
      for (const entry of subscriptions.values()) entry.stop();
      subscriptions.clear();
    },
    async handle(message: BrowserClientMessage) {
      const id = message.type === "browser.open" ? message.options.threadId : message.threadId;
      const thread = host.thread(id);
      if (!thread) throw new Error("thread_not_found");
      if (message.type === "browser.ack") {
        const subscription = subscriptions.get(id);
        if (subscription?.sent === message.sequence) {
          subscription.ack = message.sequence;
          subscription.pump();
        }
        return;
      }
      let result: unknown;
      switch (message.type) {
        case "browser.open":
          if (thread.thread.workspaceId !== message.options.workspaceId)
            throw new Error("workspace_mismatch");
          browser.drive(id, { url: "about:blank" });
          break;
        case "browser.close":
          browser.close(id);
          break;
        case "browser.takeover":
          await browser.takeover(id);
          break;
        case "browser.handback":
          await browser.handback(id);
          break;
        case "browser.input":
          if (browser.view(id)?.controller !== "human") throw new Error("human_control_required");
          browser.wireInput(id, message.input);
          break;
        case "browser.execute": {
          if (!browser.view(id) || browser.view(id)?.closed) throw new Error("browser_not_open");
          if (browser.view(id)?.controller === "human") throw new Error("human_control_active");
          const command = message.command;
          if (command.action === "navigate") browser.drive(id, { url: command.url });
          else if (command.action === "type") browser.type(id, command.text);
          else if (command.action === "resize") browser.resize(id, command.width, command.height);
          else if (command.action === "snapshot") result = { text: "Synthetic fixture page" };
          else if (command.action === "screenshot") result = browser.frame(id);
          else if (command.action === "logs") result = [];
          else if (command.action === "evaluate")
            throw new Error("evaluation_unavailable_in_fixture");
          break;
        }
        case "browser.subscribe": {
          if (subscriptions.has(id) || subscriptions.size >= 8)
            throw new Error("subscription_limit");
          const entry: { stop(): void; pump(): void; sent?: number; ack?: number } = {
            stop: noop,
            pump() {
              if (!host.thread(id)) {
                entry.stop();
                subscriptions.delete(id);
                return;
              }
              const view = browser.view(id);
              if (view) send({ type: "browser.state", state: BrowserState.parse(view) });
              const frame = browser.frame(id);
              if (
                frame &&
                frame.sequence !== entry.sent &&
                (entry.sent === undefined || entry.sent === entry.ack)
              ) {
                entry.sent = frame.sequence;
                send({
                  type: "browser.frame",
                  threadId: id,
                  frame: {
                    sequence: frame.sequence,
                    timestamp: host.now(),
                    width: frame.width,
                    height: frame.height,
                    data: frame.src,
                  },
                });
              }
            },
          };
          entry.stop = browser.subscribe(entry.pump);
          subscriptions.set(id, entry);
          // The initial frame is sent after the correlated result below.
          queueMicrotask(() => {
            if (subscriptions.get(id) === entry) entry.pump();
          });
          break;
        }
        case "browser.unsubscribe":
          subscriptions.get(id)?.stop();
          subscriptions.delete(id);
          break;
        case "browser.recording.start":
        case "browser.recording.stop":
          throw new Error("recording_unavailable_in_fixture");
      }
      send({
        type: "browser.result",
        requestId: message.requestId,
        ok: true,
        ...(result === undefined ? {} : { result }),
      });
    },
  };
}
function noop(): void {}
