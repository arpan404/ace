import type { SuitPage } from "@ace/protocol/suit-parts";
import type { FileRoutesById } from "../routeTree.gen.ts";

/*
 * Which Suit page (`suitPages`, docs/design/suit-parts.md) each route shows, for `data-page` on
 * the `app` part, so `[data-page=pulls] [data-part=list-row]` works anywhere in the window. A
 * route that only frames its children (`/_home`) or only redirects is null and takes its child's
 * page. Typed over every route the router defines: a new route doesn't build until it is named
 * here.
 */

type RouteId = Exclude<keyof FileRoutesById, "__root__">;

export const routePages = {
  "/_home": null,
  "/_home/": "thread",
  "/_home/t/$threadId": "thread",
  "/_home/t/$threadId_/agents/$agentId": "thread",
  "/_home/t/$threadId_/fork": "new-thread",
  "/_home/new": "new-thread",
  "/_home/chats": "chats",
  "/_home/archived": "history",
  "/_home/history": "history",
  "/_home/inbox": "inbox",
  "/_home/pulls": "pulls",
  "/_home/pulls_/$project/$number": "pull",
  "/_home/pulls_/$project/new": "pull",
  "/_home/issues": "issues",
  "/_home/issues_/$project/$number": "issue",
  "/_home/issues_/$project/new": "issue",
  "/automations": "automations",
  "/automations/": "automations",
  "/automations/new": "automation",
  "/automations/$automationId/": "automation",
  "/automations/$automationId/edit": null,
  "/skills": "skills",
  "/skills/": "skills",
  "/skills/new": "skill",
  "/skills/$skillId": "skill",
  "/spade": "spade",
  "/spade/": null,
  "/spade/$agentId": null,
  "/spade/groups/$groupId": null,
  "/spade/new": null,
  "/spade/groups/new": null,
  "/usage": "usage",
  "/setup": "setup",
  "/pair": "settings",
  "/settings": "settings",
  "/settings/": null,
  "/settings/overview": null,
  "/settings/general": null,
  "/settings/profile": null,
  "/settings/appearance": null,
  "/settings/agents": null,
  "/settings/prompts": null,
  "/settings/providers/": null,
  "/settings/providers/$provider": null,
  "/settings/keyboard": null,
  "/settings/notifications": null,
  "/settings/browser": null,
  "/settings/computer-use": null,
  "/settings/simulators": null,
  "/settings/source-control": null,
  "/settings/spade/": null,
  "/settings/spade/apps": null,
  "/settings/spade/security": null,
  "/settings/spade/models": null,
  "/settings/spade/search": null,
  "/settings/storage": null,
  "/settings/advanced": null,
  "/settings/beta": null,
  "/settings/remote/": null,
  "/settings/remote/$machine": null,
  "/settings/remote/$machine_/apps": null,
  "/settings/remote/every-machine": null,
  "/settings/remote/map": null,
  "/tray": null,
} as const satisfies Record<RouteId, SuitPage | null>;

const known: Readonly<Record<string, SuitPage | null>> = routePages;

/**
 * The page the matched routes show, outermost first (the router's `matches`): the deepest one
 * that names a page. Undefined for an address no route knows (the not-found page).
 */
export function pageForRoutes(routeIds: readonly string[]): SuitPage | undefined {
  for (let index = routeIds.length - 1; index >= 0; index--) {
    const page = known[routeIds[index] ?? ""];
    if (page) return page;
  }
  return undefined;
}
