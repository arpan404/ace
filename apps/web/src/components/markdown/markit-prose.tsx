import { useOptionalClient, useThreadMeta } from "@ace/client-react";
import { ItemId, ThreadId } from "@ace/protocol";
import { markitWorkerPath, shouldResolveMarkitImage, isMarkitWebImage } from "@ace/markit-web";
import { Markit } from "@ace/markit-web/react";
import "./markit-ace.css";
import { checkoutLinkPath, localLinkPath, normalizedPath } from "@ace/ui-core/file-references";
import { isCheckoutPath } from "@ace/ui-core";
import { useContext, useMemo, type ReactNode } from "react";
import { PullRequestOpener, pullRequestAt, useOpenWebAddress } from "../web-link.tsx";
import { fileTab, pullRequestTab, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { cn } from "@/lib/cn.ts";
import { blockRhythm } from "./rhythm.ts";

/**
 * Agent prose rendered by markit (Rust + Wasm): CommonMark, tables, tasks, code fences with
 * syntax colors, diff fences, inline/display math as SVG, bare links. Raw HTML shows as text;
 * only http(s)/mailto links navigate. Images draw only bytes already on the page.
 */
export function MarkitProse(props: {
  text: string;
  streaming?: boolean | undefined;
  className?: string | undefined;
  tail?: ReactNode;
  thread?: { threadId: string; cwd?: string; itemId?: string } | undefined;
}) {
  const client = useOptionalClient();
  if (props.thread?.threadId && client)
    return <MarkitThreadProse {...props} thread={props.thread} />;
  return <MarkitPlainProse {...props} />;
}

function MarkitPlainProse(props: {
  text: string;
  streaming?: boolean | undefined;
  className?: string | undefined;
  tail?: ReactNode;
}) {
  const openWeb = useOpenWebAddress();
  const callbacks = useMemo(
    () => ({
      onLink: (url: string) => {
        void openWeb(url);
      },
      onReference: () => {},
      resolveImage: async (url: string, _alt: string, signal: AbortSignal) => {
        if (signal.aborted) return null;
        if (!shouldResolveMarkitImage(url)) return null;
        try {
          const response = await fetch(url, { signal });
          return await response.blob();
        } catch {
          return null;
        }
      },
    }),
    [openWeb],
  );
  return (
    <div className={cn("markit-ace", blockRhythm, props.className)}>
      <Markit
        markdown={props.text}
        finalized={!props.streaming}
        workerURL={markitWorkerPath()}
        onLink={callbacks.onLink}
        onReference={callbacks.onReference}
        resolveImage={callbacks.resolveImage}
      />
      {props.tail}
    </div>
  );
}

function MarkitThreadProse(props: {
  text: string;
  streaming?: boolean | undefined;
  className?: string | undefined;
  tail?: ReactNode;
  thread: { threadId: string; cwd?: string; itemId?: string };
}) {
  const { thread } = props;
  const client = useOptionalClient();
  const meta = useThreadMeta(thread.threadId);
  const workspace = useWorkspaceActions(thread.threadId);
  const openWeb = useOpenWebAddress();
  const openPr = useContext(PullRequestOpener);

  const root = (meta?.details?.worktree ?? meta?.details?.workspace?.path)?.replace(/\/+$/, "");
  const base = thread.cwd ?? root;

  const callbacks = useMemo(() => {
    const resolvePath = (value: string, cwd = base) =>
      normalizedPath(value.startsWith("/") || !cwd ? value : `${cwd}/${value}`);
    return {
      onLink: (url: string) => {
        void openWeb(url);
      },
      onReference: ({ kind, target }: { kind: string; target: string }) => {
        if (kind === "file") {
          const path = localLinkPath(target) ?? target;
          const relative = checkoutLinkPath(path, root, thread.cwd);
          if (relative && isCheckoutPath(relative)) workspace.open(fileTab(relative));
          return;
        }
        if (kind === "pull_request") {
          const pr = pullRequestAt(target);
          if (!pr) return;
          if (openPr) return openPr(pr);
          const workspaceId = meta?.workspaceId;
          if (workspaceId)
            workspace.open(
              pullRequestTab({ workspaceId, repository: pr.repository, number: pr.number }),
            );
        }
      },
      resolveImage: async (url: string, _alt: string, signal: AbortSignal) => {
        if (signal.aborted) return null;
        if (shouldResolveMarkitImage(url)) {
          try {
            const response = await fetch(url, { signal });
            return await response.blob();
          } catch {
            return null;
          }
        }
        if (isMarkitWebImage(url)) return null;
        if (!client) return null;
        const path = localLinkPath(url) ?? url;
        if (!/\.(png|jpe?g|webp|gif)$/i.test(path)) return null;
        try {
          const resolved = await client.request(
            {
              type: "context.request",
              operation: {
                op: "image.resolve",
                threadId: ThreadId.parse(thread.threadId),
                reference: thread.itemId ? normalizedPath(path) : resolvePath(path),
                ...(thread.itemId ? { itemId: ItemId.parse(thread.itemId) } : {}),
              },
            },
            { signal },
          );
          if (resolved.result.kind !== "attachment") return null;
          const bytes = await client.attachmentBytes(
            { threadId: thread.threadId, sha256: resolved.result.attachment.sha256 },
            { signal },
          );
          return new Blob([bytes as unknown as BlobPart], { type: "image/png" });
        } catch {
          return null;
        }
      },
    };
  }, [base, client, meta?.workspaceId, openWeb, openPr, root, thread, workspace]);

  return (
    <div className={cn("markit-ace", blockRhythm, props.className)}>
      <Markit
        markdown={props.text}
        finalized={!props.streaming}
        workerURL={markitWorkerPath()}
        onLink={callbacks.onLink}
        onReference={callbacks.onReference}
        resolveImage={callbacks.resolveImage}
      />
      {props.tail}
    </div>
  );
}
