import { BrowserBrowsingWatch, type ThreadId } from "@ace/protocol";
import { BrowsingThreads } from "../browsing.ts";
import type { BrowserService } from "@ace/browser";
import type { ServiceContext } from "./types.ts";
import { followService } from "./service-watch.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/**
 * Follows every thread browser's state to know which threads an agent is browsing in. ace's
 * browser (and with it the person's Chrome sessions) may start after this, on a startup retry,
 * or start again: each one published is followed in place of the last.
 */
export function startBrowsing(context: ServiceContext): void {
  const { services, resources } = context;
  const browsing = new BrowsingThreads();
  const follow = (key: "browser" | "userBrowserSessions", source: string) => {
    let stop: (() => void) | undefined;
    let followed: BrowserService | undefined;
    resources.own(
      followService(context, key, (browser) => {
        if (browser === followed) return;
        stop?.();
        stop = undefined;
        // What the last browser reported no longer holds: it is gone.
        if (followed) browsing.forget(source);
        followed = browser;
        stop = browser?.observeStates((state) => browsing.update(source, state));
      }),
    );
    resources.own(() => stop?.());
  };
  follow("browser", "ace");
  follow("userBrowserSessions", "user");
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
