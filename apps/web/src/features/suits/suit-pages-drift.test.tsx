import type { SuitPage } from "@ace/protocol/suit-parts";
import { replayCursor, workbench, workbenchServices } from "@ace/fake-daemon";
import { act, configure, waitFor } from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { beforeEach, expect, test } from "vitest";
import { routePages } from "@/app/route-page.ts";
import { harness } from "@/test/harness.tsx";

/*
 * Every route the router defines is a Suit page (docs/design/suit-parts.md): the window's `app`
 * part says which in `data-page`, and the routed screen's canvas is the `page` part with the same
 * `data-page`. This walks one address per route with fake data and fails when a screen stops
 * naming its page, or a new route is added without one (`addresses` is typed over every route).
 */

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());

type RouteId = keyof typeof routePages;

/** One address per route and the page it shows, or null for a route that only frames others or redirects. */
const addresses: Record<RouteId, readonly [address: string, page: SuitPage] | null> = {
  "/_home": null,
  "/_home/": ["/", "thread"],
  "/_home/t/$threadId": ["/t/thread-replay-cursor", "thread"],
  "/_home/t/$threadId_/agents/$agentId": ["/t/thread-replay-cursor/agents/agent-missing", "thread"],
  "/_home/t/$threadId_/fork": ["/t/thread-replay-cursor/fork?run=run-missing", "new-thread"],
  "/_home/new": ["/new", "new-thread"],
  "/_home/chats": ["/chats", "chats"],
  "/_home/archived": ["/archived", "history"],
  "/_home/history": ["/history", "history"],
  "/_home/inbox": ["/inbox", "inbox"],
  "/_home/pulls": ["/pulls", "pulls"],
  "/_home/pulls_/$project/$number": ["/pulls/relay/1", "pull"],
  "/_home/pulls_/$project/new": ["/pulls/relay/new", "pull"],
  "/_home/issues": ["/issues", "issues"],
  "/_home/issues_/$project/$number": ["/issues/relay/1", "issue"],
  "/_home/issues_/$project/new": ["/issues/relay/new", "issue"],
  "/automations": null,
  "/automations/": ["/automations", "automations"],
  "/automations/new": ["/automations/new", "automation"],
  "/automations/$automationId/": ["/automations/auto-dependency-audit", "automation"],
  "/automations/$automationId/edit": null,
  "/skills": null,
  "/skills/": ["/skills", "skills"],
  "/skills/new": ["/skills/new", "skill"],
  "/skills/$skillId": ["/skills/engineering~skill~code-review", "skill"],
  "/spade": null,
  "/spade/": ["/spade", "spade"],
  "/spade/$agentId": ["/spade/spade", "spade"],
  "/spade/groups/$groupId": ["/spade/groups/group-missing", "spade"],
  "/spade/new": ["/spade/new", "spade"],
  "/spade/groups/new": ["/spade/groups/new", "spade"],
  "/usage": ["/usage", "usage"],
  "/setup": ["/setup", "setup"],
  // Redirects to Fleet, where pairing lives.
  "/pair": null,
  "/settings": null,
  "/settings/": ["/settings", "settings"],
  "/settings/overview": null,
  "/settings/general": ["/settings/general", "settings"],
  "/settings/profile": ["/settings/profile", "settings"],
  "/settings/appearance": ["/settings/appearance", "settings"],
  "/settings/agents": ["/settings/agents", "settings"],
  "/settings/prompts": ["/settings/prompts", "settings"],
  "/settings/providers/": ["/settings/providers", "settings"],
  "/settings/providers/$provider": ["/settings/providers/codex", "settings"],
  "/settings/keyboard": ["/settings/keyboard", "settings"],
  "/settings/notifications": ["/settings/notifications", "settings"],
  "/settings/browser": ["/settings/browser", "settings"],
  "/settings/computer-use": ["/settings/computer-use", "settings"],
  "/settings/simulators": ["/settings/simulators", "settings"],
  "/settings/source-control": ["/settings/source-control", "settings"],
  "/settings/spade/": ["/settings/spade", "settings"],
  "/settings/spade/apps": ["/settings/spade/apps", "settings"],
  "/settings/spade/security": ["/settings/spade/security", "settings"],
  "/settings/spade/models": ["/settings/spade/models", "settings"],
  "/settings/spade/search": ["/settings/spade/search", "settings"],
  "/settings/storage": ["/settings/storage", "settings"],
  "/settings/advanced": ["/settings/advanced", "settings"],
  "/settings/beta": ["/settings/beta", "settings"],
  "/settings/remote/": ["/settings/remote", "settings"],
  "/settings/remote/$machine": ["/settings/remote/machine-missing", "settings"],
  "/settings/remote/$machine_/apps": ["/settings/remote/machine-missing/apps", "settings"],
  "/settings/remote/every-machine": ["/settings/remote/every-machine", "settings"],
  "/settings/remote/map": ["/settings/remote/map", "settings"],
  // The desktop's menu-bar popover, drawn without the app's frame (no page for a Suit).
  "/tray": null,
};

/** Pages finer than their route's: a pull request's Code tab is its review. */
const finer: readonly (readonly [address: string, page: SuitPage])[] = [
  ["/pulls/relay/1?tab=code", "review"],
];

/** What the window says now: the app's page and the page parts on screen. */
function shown() {
  const app = document.querySelector('[data-part="app"]')?.getAttribute("data-page") ?? null;
  const pages = [...document.querySelectorAll('[data-part="page"]')].map((element) =>
    element.getAttribute("data-page"),
  );
  return { app, pages };
}

test("every routed screen names its Suit page on the window and on its canvas", async () => {
  const history = createMemoryHistory({ initialEntries: ["/usage"] });
  const app = harness({ clock: () => Date.now(), history });
  app.play(replayCursor()).runThrough("answered");
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now(), "UTC"));
  app.daemon.spade.status = { state: "ready", version: "0.6.0" };
  await app.open("/usage");
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await app.client.request({
    type: "settings.set",
    key: "spade.enabled",
    value: true,
    layer: { kind: "global" },
  });

  const wrong: string[] = [];
  for (const visit of [...Object.values(addresses), ...finer]) {
    if (visit === null) continue;
    const [address, page] = visit;
    act(() => history.push(address));
    try {
      await waitFor(
        () => {
          const now = shown();
          expect(now.app).toBe(page);
          expect(now.pages).toEqual([page]);
        },
        { timeout: 4000 },
      );
    } catch {
      wrong.push(`${address}: ${JSON.stringify(shown())}, wanted ${page}`);
    }
  }
  expect(wrong).toEqual([]);
}, 240_000);
