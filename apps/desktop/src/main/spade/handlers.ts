import type { WebContents } from "electron";
import { emit, type Handlers } from "../ipc.ts";
import type { SpadeDirect } from "./direct.ts";

type SpadeChannel =
  | "spade.endpoint"
  | "spade.health"
  | "spade.request"
  | "spade.live.open"
  | "spade.live.close";

/**
 * The bridge's `spade.*` requests, served by the direct path. A window's live streams end
 * when it loads another page or closes: nothing there reads them any more.
 */
export function spadeHandlers(direct: SpadeDirect): Pick<Handlers, SpadeChannel> {
  const owners = new Set<number>();
  const own = (sender: WebContents) => {
    if (owners.has(sender.id)) return;
    owners.add(sender.id);
    const id = sender.id;
    sender.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) direct.closeOwner(id);
    });
    sender.once("destroyed", () => {
      owners.delete(id);
      direct.closeOwner(id);
    });
  };
  return {
    "spade.endpoint": () => direct.endpoint(),
    "spade.health": () => direct.health(),
    "spade.request": (request) => direct.request(request),
    "spade.live.open": (request, sender) => {
      if (!sender) throw new Error("Live streams belong to a window");
      own(sender);
      direct.openLive(sender.id, request, (event) => emit(sender, "spade.live", event));
      return undefined;
    },
    "spade.live.close": ({ streamId }) => {
      direct.closeLive(streamId);
      return undefined;
    },
  };
}
