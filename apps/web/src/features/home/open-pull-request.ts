import { useThreadMeta } from "@ace/client-react";
import type { ForgeRepository } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import { openExternal } from "@/boot/open-external.ts";
import { applePlatform } from "@/lib/keymap.ts";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { asksForSystemBrowser, type LinkClick } from "@/lib/web-links.ts";

/**
 * Open a thread's linked pull request from its row: ace's page for it in the main column.
 * ⌘/Ctrl or middle click opens it on the forge in the system's browser, and so does a click
 * while the thread's project isn't known yet.
 */
export function useOpenThreadPullRequest(threadId: string) {
  const navigate = useNavigate();
  const workspaceId = useThreadMeta(threadId)?.workspaceId;
  return (pr: { number: number; url: string; repo?: ForgeRepository }, click?: LinkClick) => {
    if (!workspaceId || asksForSystemBrowser(click, applePlatform)) {
      void openExternal(pr.url).catch(() => {});
      return;
    }
    void navigate({
      to: "/pulls/$project/$number",
      params: { project: workspaceId, number: String(pr.number) },
      search: pr.repo ? { repo: repositoryParam(pr.repo) } : {},
    });
  };
}
