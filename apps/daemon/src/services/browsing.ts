import { BrowserBrowsingWatch, type ThreadId } from "@ace/protocol";
import { BrowsingThreads } from "../browsing.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** Follows every thread browser's state to know which threads an agent is browsing in. */
export function startBrowsing({ services, resources }: ServiceContext): void {
  const browsing = new BrowsingThreads();
  if (services.browser)
    resources.own(services.browser.observeStates((state) => browsing.update("ace", state)));
  if (services.userBrowserSessions)
    resources.own(
      services.userBrowserSessions.observeStates((state) => browsing.update("user", state)),
    );
  services.browsing = browsing;
}

/**
 * `browser.browsing.watch`: the threads this client may read whose browser an agent works in,
 * now and again on every change, for the task list's indicator.
 */
export function createBrowsingSession({
  options,
  authorize,
  canReadThread,
  connected,
  send,
  fail,
}: SocketContext): SocketService {
  let stop: (() => void) | undefined;
  const report = (threads: readonly ThreadId[]) => {
    if (!connected() || !authorize("read")) return;
    send({
      type: "browser.browsing",
      threads: threads.filter((thread) => canReadThread(thread)).slice(0, 512),
    });
  };
  return {
    close() {
      stop?.();
    },
    handle(message) {
      if (message.type !== "browser.browsing.watch") return false;
      const request = BrowserBrowsingWatch.parse(message);
      const browsing = options.browsing;
      if (!authorize("read") || !browsing) {
        fail(browsing ? "forbidden" : "browser_unavailable", "Browsing state unavailable", false, {
          requestId: request.requestId,
        });
        return true;
      }
      stop ??= browsing.subscribe(report);
      report(browsing.threads());
      return true;
    },
  };
}
