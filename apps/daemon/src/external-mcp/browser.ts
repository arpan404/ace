import { z } from "zod";
import {
  browserToolkit,
  type BrowserCaller,
  type BrowserService,
  type BrowserToolPort,
} from "@ace/browser";
import type { Toolkit } from "@ace/mcp-server";
import { PublicToolError } from "@ace/mcp-server/errors";
import { ThreadId, WorkspaceId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { GrantStore } from "./grants.ts";
import { grantOfCaller } from "./principals.ts";

const ProjectRow = z.object({ id: z.string() });

/**
 * ace's browser for outside clients (ADR 0117, ADR 0104): each grant has one private session of
 * its own, keyed by its caller `external:<grantId>`, so its tabs belong to it and close with it.
 * The session is ephemeral: an outside client never reads the person's cookies.
 */
export function outsideBrowserToolkit(
  browser: BrowserService,
  store: Store,
  grants: GrantStore,
): Toolkit {
  /** The project the grant's session is filed under: its first allowed one. */
  const project = (grantId: string): WorkspaceId => {
    const grant = grants.live(grantId);
    if (!grant) throw new PublicToolError("session_ended");
    if (grant.projects !== "all") {
      const first = grant.projects.find((id) => store.getWorkspace(id));
      if (first) return first;
    } else {
      const row = ProjectRow.safeParse(
        store
          .statement(
            "SELECT id FROM workspaces WHERE NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY rowid LIMIT 1",
          )
          .get(),
      );
      if (row.success) return WorkspaceId.parse(row.data.id);
    }
    throw new PublicToolError("tool_unavailable");
  };
  const actor = (caller: BrowserCaller) => ({
    kind: "agent" as const,
    ...(caller.agentId ? { agentId: caller.agentId } : {}),
  });
  const ensure = async (caller: BrowserCaller, signal: AbortSignal) => {
    signal.throwIfAborted();
    const threadId = ThreadId.parse(caller.threadId);
    const grantId = grantOfCaller(caller.threadId);
    if (!grantId) throw new PublicToolError("tool_unavailable");
    await browser.open({
      threadId,
      workspaceId: project(grantId),
      background: true,
      profile: "ephemeral",
    });
    signal.throwIfAborted();
    return threadId;
  };
  const port: BrowserToolPort = {
    async open(caller, signal) {
      const threadId = await ensure(caller, signal);
      return browser.claimTab(threadId, actor(caller));
    },
    async tab(caller, tabId, signal) {
      const threadId = await ensure(caller, signal);
      if (tabId === undefined) return browser.currentTab(threadId, actor(caller));
      const listed = browser.state(threadId).tabs?.find((tab) => tab.tabId === tabId);
      return listed
        ? { tabId, url: listed.url, title: listed.title }
        : { tabId, url: "", title: "" };
    },
    state: (caller) => browser.state(caller.threadId),
    async execute(caller, command, signal) {
      const threadId = await ensure(caller, signal);
      return browser.execute(threadId, command, actor(caller), signal);
    },
    async screenshot(caller, options, signal) {
      const threadId = await ensure(caller, signal);
      return browser.capture(threadId, signal, options.tabId, options, actor(caller));
    },
    async close(caller, signal) {
      signal.throwIfAborted();
      await browser.closeThread(caller.threadId, actor(caller), signal);
    },
  };
  return browserToolkit(port);
}
