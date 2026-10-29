import { useOptionalClient, useThreadMeta } from "@ace/client-react";
import { ItemId, ThreadId } from "@ace/protocol";
import { markitWorkerPath, shouldResolveMarkitImage, isMarkitWebImage } from "@ace/markit-web";
import { useMarkit } from "@ace/markit-web/react";
import "./markit-ace.css";
import { checkoutLinkPath, localLinkPath, normalizedPath } from "@ace/ui-core/file-references";
import { contentHash, isCheckoutPath } from "@ace/ui-core";
import { useContext, useCallback, useEffect, useMemo, type ReactNode } from "react";
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
  stream?: string | undefined;
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

interface MarkitCallbacks {
  onLink: (url: string) => void;
  onReference: (reference: { kind: string; target: string }) => void;
  resolveImage: (
    url: string,
    alt: string,
    signal: AbortSignal,
  ) => Blob | Uint8Array | null | Promise<Blob | Uint8Array | null>;
}

/** Applied renders sampled for tools/web-perf, mirroring the old markdown service's samples. */
const perfSamples = (): Array<{ stream: string; chars: number; ms: number }> | undefined => {
  const perf: unknown = Reflect.get(globalThis, "acePerf");
  return typeof perf === "object" && perf !== null && "markit" in perf && Array.isArray(perf.markit)
    ? (perf.markit as Array<{ stream: string; chars: number; ms: number }>)
    : undefined;
};

/** One markit renderer for one element; text updates stream through it, never React state. */
function MarkitView(props: {
  markdown: string;
  finalized: boolean;
  stream: string;
  className?: string | undefined;
  tail?: ReactNode;
  callbacks: MarkitCallbacks;
}) {
  const markit = useMarkit({
    workerURL: markitWorkerPath(),
    onLink: props.callbacks.onLink,
    onReference: props.callbacks.onReference,
    resolveImage: props.callbacks.resolveImage,
  });
  useEffect(() => {
    const started = performance.now();
    const { markdown, finalized, stream } = props;
    let live = true;
    void markit.render(markdown, { finalized }).then(
      (patch) => {
        if (!live || patch.superseded || import.meta.env.MODE !== "perf") return;
        perfSamples()?.push({ stream, chars: markdown.length, ms: performance.now() - started });
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- callbacks ride useMarkit's latest ref.
  }, [markit, props.markdown, props.finalized, props.stream]);
  const attach = useCallback(
    (element: HTMLElement | null) => {
      markit.ref(element);
    },
    [markit],
  );
  return (
    <div className={cn("markit-ace", blockRhythm, props.className)}>
      <div ref={attach} />
      {props.tail}
    </div>
  );
}

function MarkitPlainProse(props: {
  text: string;
  stream?: string | undefined;
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
    <MarkitView
      markdown={props.text}
      finalized={!props.streaming}
      stream={props.stream ?? `#${contentHash(props.text)}`}
      className={props.className}
      tail={props.tail}
      callbacks={callbacks}
    />
  );
}

function MarkitThreadProse(props: {
  text: string;
  stream?: string | undefined;
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
    <MarkitView
      markdown={props.text}
      finalized={!props.streaming}
      stream={props.stream ?? `#${contentHash(props.text)}`}
      className={props.className}
      tail={props.tail}
      callbacks={callbacks}
    />
  );
}
