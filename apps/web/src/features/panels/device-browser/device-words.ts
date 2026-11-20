import { describeBrowserFailure, type BrowserFailure } from "@ace/ui-core";
import type { DeviceTabFailure } from "@/boot/desktop-device-tabs.ts";

/**
 * What a device tab says when its page didn't load (ADR 0194): for a page on the machine's
 * localhost, the machine's reason when its tunnel gave one, in words a person can act on;
 * otherwise what the browser itself says. Pure.
 */
export function deviceTabProblem(failure: DeviceTabFailure): BrowserFailure {
  const port = failure.port;
  const where = port === undefined ? "that port" : `port ${port}`;
  switch (failure.tunnel) {
    case "off":
      return {
        title: "This machine's localhost is off for your devices",
        detail:
          "Turn on Localhost on your devices in the machine's settings, under More options, then reload.",
      };
    case "forbidden":
      return {
        title: "This computer can't open the machine's localhost",
        detail: "Its pairing can only watch. Pair it again with full access to open these pages.",
      };
    case "refused":
      return {
        title: `${port === undefined ? "That port" : `Port ${port}`} is ace's own`,
        detail: "ace never opens its own ports to other devices. Open your app's port instead.",
      };
    case "limit":
      return {
        title: "Too many connections to the machine at once",
        detail: "Close a few of its pages, then reload.",
      };
    case "offline":
      return {
        title: "The machine is offline",
        detail: "Reload once ace reaches it again.",
      };
    case "closed":
      return {
        title: `Nothing is running on ${where} on the machine`,
        detail: "Start the server there, then reload.",
      };
    default:
      return describeBrowserFailure(`net::${failure.description}`, failure.url);
  }
}
