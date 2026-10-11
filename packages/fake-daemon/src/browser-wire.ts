import { BrowserOriginError } from "@ace/browser/policy";
import { BrowserState, type BrowserClientMessage, type ServerMessage } from "@ace/protocol";
import type { FakeBrowser } from "./browser.ts";
import type { FakeServiceContext } from "./service-context.ts";

/** The fixture emits data URLs for its synthetic SVG frames, with the same ACK lifetime. */
export function fakeBrowserSession(
  browser: FakeBrowser,
  host: FakeServiceContext,
  send: (message: ServerMessage) => void,
  connectionId: string,
) {
  const recording = new Set<string>();
  const subscriptions = new Map<
    string,
    {
      stop(): void;
      pump(): void;
      subscribers: Set<string>;
      generation: number;
      sent?: number;
      ack?: number;
    }
  >();
  return {
    close() {
      for (const entry of subscriptions.values()) entry.stop();
      subscriptions.clear();
      browser.disconnect(connectionId);
    },
    /** As the daemon's browser bridge: a refusal is a `browser.result` with `ok: false`. */
    async handle(message: BrowserClientMessage) {
      const id = message.type === "browser.open" ? message.options.threadId : message.threadId;
      if (!host.thread(id)) throw new Error("thread_not_found");
      try {
        await this.serve(message);
      } catch (error) {
        if (message.type === "browser.ack") return;
        send({
          type: "browser.result",
          requestId: message.requestId,
          ok: false,
          ...(error instanceof BrowserOriginError ? { blocked: error.blocked } : {}),
          error: (error instanceof Error ? error.message : "Browser operation failed").slice(
            0,
            2048,
          ),
        });
      }
    },
    async serve(message: BrowserClientMessage) {
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
        case "browser.tabs.list":
          result = browser.tabsList(id);
          break;
        case "browser.downloads.list":
          result = browser.downloadsList(id);
          break;
        case "browser.evaluate.grants.list":
          result = browser.evaluateGrantsList(id);
          break;
        case "browser.evaluate.grants.revoke":
          browser.evaluateRevoke(id, message.origin);
          result = browser.evaluateGrantsList(id);
          break;
        case "browser.tabs.open":
        case "browser.tabs.switch":
        case "browser.tabs.close":
        case "browser.dialog.answer": {
          if (browser.view(id)?.controller !== "human" || browser.view(id)?.owner !== connectionId)
            throw new Error("Browser controller mismatch");
          const pending_dialog = browser.view(id)?.pending_dialog;
          if (pending_dialog && message.type !== "browser.dialog.answer") {
            result = { pending_dialog };
            break;
          }
          if (message.type === "browser.tabs.open") {
            browser.tabOpen(id);
            if (message.url) browser.navigate(id, message.url, host.now());
          } else if (message.type === "browser.tabs.switch") browser.tabSwitch(id, message.tabId);
          else if (message.type === "browser.tabs.close") browser.tabClose(id, message.tabId);
          else {
            browser.dialogAnswer(id, message.dialogId);
          }
          result =
            message.type === "browser.dialog.answer"
              ? { ok: true }
              : { activeTabId: browser.view(id)?.activeTabId, tabs: browser.tabsList(id) };
          break;
        }
        case "browser.origins.list":
          result = browser.originsList(id);
          break;
        case "browser.origins.grant":
          browser.originsGrant(id, message.origin, host.now());
          result = browser.originsList(id);
          break;
        case "browser.origins.revoke":
          browser.originsRevoke(id, message.origin);
          result = browser.originsList(id);
          break;
        case "browser.open": {
          if (thread.thread.workspaceId !== message.options.workspaceId)
            throw new Error("workspace_mismatch");
          const download = browser.pendingDownload();
          if (download) {
            const progress = (phase: "downloading" | "ready", received: number) =>
              send({
                type: "browser.download.progress",
                version: "fake-chromium",
                phase,
                received,
                total: download.total,
              });
            progress("downloading", Math.round(download.total * 0.4));
            await download.done;
            progress("ready", download.total);
          }
          if (!browser.view(id) || browser.view(id)?.closed)
            browser.drive(id, {
              url: "about:blank",
              backend: message.options.background ? "headless" : "embedded",
            });
          browser.reopen(id);
          result = BrowserState.parse(browser.view(id));
          break;
        }
        case "browser.close":
          browser.close(id);
          break;
        case "browser.takeover":
          await browser.takeover(id, connectionId, message.mode);
          result = BrowserState.parse(browser.view(id));
          break;
        case "browser.handback":
          if (browser.view(id)?.owner !== connectionId)
            throw new Error("Browser controller mismatch");
          await browser.handback(id);
          result = BrowserState.parse(browser.view(id));
          break;
        case "browser.input":
          if (browser.view(id)?.controller !== "human" || browser.view(id)?.owner !== connectionId)
            throw new Error("human_control_required");
          browser.wireInput(id, message.input);
          break;
        case "browser.execute": {
          if (!browser.view(id) || browser.view(id)?.closed) throw new Error("Browser closed");
          const command = message.command;
          // As the daemon's browser service: a client acts as a person, and a person's commands
          // (navigate, resize, emulate) need the control lease; reads never do.
          const reads = [
            "snapshot",
            "screenshot",
            "logs",
            "wait_for",
            "find",
            "network_body",
            "navigation_history",
            "find_text",
            "selection",
          ];
          if (
            !reads.includes(command.action) &&
            (browser.view(id)?.controller !== "human" || browser.view(id)?.owner !== connectionId)
          )
            throw new Error("Browser controller mismatch");
          const pending_dialog = browser.view(id)?.pending_dialog;
          if (
            pending_dialog &&
            command.action !== "dialog" &&
            !(command.action === "tabs" && command.operation === "list")
          ) {
            result = { pending_dialog };
            break;
          }
          if (command.tabId && command.action !== "tabs" && command.action !== "dialog")
            browser.tabSwitch(id, command.tabId);
          if (command.action === "tabs") {
            if (command.operation === "open") {
              browser.tabOpen(id);
              if (command.url) browser.navigate(id, command.url, host.now());
            } else if (command.operation === "switch" && command.tabId)
              browser.tabSwitch(id, command.tabId);
            else if (command.operation === "close" && command.tabId)
              browser.tabClose(id, command.tabId);
            result = { activeTabId: browser.view(id)?.activeTabId, tabs: browser.tabsList(id) };
          } else if (command.action === "dialog") {
            browser.dialogAnswer(id, command.dialogId);
            result = { ok: true };
          } else if (command.action === "navigate") {
            browser.navigate(id, command.url, host.now());
            result = BrowserState.parse(browser.view(id));
          } else if (command.action === "navigation_history")
            result = browser.navigationHistory(id);
          else if (command.action === "history")
            result = browser.navigateHistory(id, command.direction);
          else if (command.action === "selection") result = { text: "" };
          else if (command.action === "find_text") result = { matches: 1, active: 1 };
          else if (command.action === "type") browser.type(id, command.text);
          else if (command.action === "resize") browser.resize(id, command.width, command.height);
          else if (command.action === "emulate") browser.resize(id, command.width, command.height);
          else if (command.action === "snapshot") result = { text: "Synthetic fixture page" };
          else if (command.action === "screenshot") result = browser.frame(id);
          else if (command.action === "logs") result = { entries: [], limit: command.limit };
          else if (command.action === "evaluate")
            throw new Error("evaluation_unavailable_in_fixture");
          break;
        }
        case "browser.subscribe": {
          if (!browser.view(id) || browser.view(id)?.closed) throw new Error("browser_not_open");
          const subscriber = message.subscriberId ?? "legacy";
          const existing = subscriptions.get(id);
          if (existing) {
            if (existing.subscribers.size >= 64 && !existing.subscribers.has(subscriber))
              throw new Error("subscription_limit");
            existing.subscribers.add(subscriber);
            delete existing.sent;
            delete existing.ack;
            existing.pump();
            break;
          }
          if (subscriptions.size >= 8) throw new Error("subscription_limit");
          const entry: {
            stop(): void;
            pump(): void;
            subscribers: Set<string>;
            generation: number;
            sent?: number;
            ack?: number;
          } = {
            subscribers: new Set([subscriber]),
            generation: browser.generation(id),
            stop: noop,
            pump() {
              if (!host.thread(id)) {
                entry.stop();
                subscriptions.delete(id);
                return;
              }
              if (entry.generation !== browser.generation(id)) {
                entry.generation = browser.generation(id);
                delete entry.sent;
                delete entry.ack;
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
        case "browser.unsubscribe": {
          const entry = subscriptions.get(id);
          entry?.subscribers.delete(message.subscriberId ?? "legacy");
          if (entry && !entry.subscribers.size) {
            entry.stop();
            subscriptions.delete(id);
          }
          break;
        }
        case "browser.recording.start":
          if (browser.view(id)?.takeoverMode === "private") throw new Error("human_private");
          recording.add(id);
          break;
        case "browser.recording.stop": {
          if (!recording.delete(id)) throw new Error("No browser recording");
          result = { path: `/fake/browser/${id}/player.html`, mimeType: "text/html", bytes: 128 };
          break;
        }
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
