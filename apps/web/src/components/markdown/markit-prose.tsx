import { useOptionalClient, useThreadMeta } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { ItemId, ThreadId, type ForgePrRef } from "@ace/protocol";
import {
  isMarkitWebImage,
  markitLinkTarget,
  markitWorkerPath,
  shouldResolveMarkitImage,
} from "@ace/markit-web";
import { useMarkit } from "@ace/markit-web/react";
import "./markit-ace.css";
import { checkoutLinkPath, localLinkPath, normalizedPath } from "@ace/ui-core/file-references";
import { contentHash, isCheckoutPath, readAceLink } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PullRequestOpener, pullRequestAt, useOpenWebAddress } from "../web-link.tsx";
import { fileTab, pullRequestTab, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { cn } from "@/lib/cn.ts";
import { prefersReducedMotion } from "@/lib/motion.ts";
import { updateInterval } from "./cadence.ts";
import { blockRhythm } from "./rhythm.ts";
import { renderMermaid } from "./mermaid-render.ts";
import { StreamPace } from "./stream-pace.ts";

/**
 * Agent prose rendered by markit (Rust + Wasm): CommonMark, tables, tasks, code fences with
 * syntax colors, diff fences, inline/display math as SVG, bare links. Raw HTML shows as text;
 * only http(s)/mailto links reach the browser. Images draw only bytes already on the page or
 * captured by the thread.
 */
export function MarkitProse(props: ProseProps) {
  const client = useOptionalClient();
  if (props.thread?.threadId && client)
    return <MarkitThreadProse {...props} thread={props.thread} client={client} />;
  return <MarkitPlainProse {...props} />;
}

interface ProseProps {
  text: string;
  stream?: string | undefined;
  streaming?: boolean | undefined;
  className?: string | undefined;
  thread?: { threadId: string; cwd?: string; itemId?: string } | undefined;
}

interface MarkitCallbacks {
  onLink: (url: string) => void;
  onReference: (reference: { kind: string; target: string }) => void;
  resolveImage: (url: string, alt: string, signal: AbortSignal) => Promise<Blob | null>;
}

/** What a click in prose can open, beyond the system browser. */
interface LinkActions {
  openWeb: (url: string) => unknown;
  openPullRequest?: ((pr: ForgePrRef) => void) | undefined;
  openThread: (threadId: string, machine: string | undefined) => void;
  openFile?: ((path: string) => void) | undefined;
}

/** Link and reference handling shared by every prose surface. */
function linkCallbacks(actions: LinkActions): Pick<MarkitCallbacks, "onLink" | "onReference"> {
  const onLink = (url: string) => {
    const target = markitLinkTarget(url);
    if (!target) return;
    if (target.kind === "local") return actions.openFile?.(target.path);
    if (target.kind === "ace") {
      const link = readAceLink(target.href.replace(/^thread:\/\//i, "ace://thread/"));
      if (link?.kind === "thread") actions.openThread(link.threadId, link.machine);
      return;
    }
    // A pull request on any forge host opens in a side panel when there is one to show it.
    const pr = pullRequestAt(target.href);
    if (pr && actions.openPullRequest) return actions.openPullRequest(pr);
    void actions.openWeb(target.href);
  };
  return {
    onLink,
    onReference: ({ kind, target }) =>
      kind === "file" ? actions.openFile?.(target) : onLink(target),
  };
}

/** Bytes already on the page (data: and blob: URLs); markit never fetches the web itself. */
async function pageImage(url: string, signal: AbortSignal): Promise<Blob | null> {
  if (signal.aborted || !shouldResolveMarkitImage(url)) return null;
  try {
    return await (await fetch(url, { signal })).blob();
  } catch {
    return null;
  }
}

/**
 * Agent prose draws footnotes, alerts, the safe HTML subset (`<details>`, `<kbd>`…), task lists
 * and mermaid diagrams as GitHub does, but `@name`, `#12` and commit hashes stay text: an
 * answer has no repository to point them at.
 */
const proseFlavor = "agent";
/** The scheme the theme provider put on the page, for a diagram drawn now. */
const pageScheme = (): "light" | "dark" =>
  document.documentElement.dataset.scheme === "dark" ? "dark" : "light";
/** DESIGN.md code blocks: line numbers from 10 lines, folded to 20 past 22. */
const codeChrome = { lineNumbersFrom: 10, collapseAfter: 20 };

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
  callbacks: MarkitCallbacks;
}) {
  // The message reads as plain text until markit's first render replaces it, so an answer is
  // never blank: not while the worker starts, and not if it cannot run at all.
  const [drawn, setDrawn] = useState(false);
  const markit = useMarkit({
    workerURL: markitWorkerPath(),
    flavor: proseFlavor,
    code: codeChrome,
    onLink: props.callbacks.onLink,
    onReference: props.callbacks.onReference,
    resolveImage: props.callbacks.resolveImage,
    renderDiagram: (language: string, source: string) =>
      language === "mermaid" ? renderMermaid(source, pageScheme()) : null,
    onRender: () => setDrawn(true),
  });
  const { markdown, finalized, stream } = props;
  // A streaming message reaches markit 10 to 20 times a second, like the previous renderer
  // (`cadence.ts`): each update can grow the row, which re-measures and re-follows the transcript.
  const pace = useRef<StreamPace | undefined>(undefined);
  const sampled = useRef(stream);
  useEffect(() => {
    sampled.current = stream;
  }, [stream]);
  useEffect(() => {
    const paced = new StreamPace({
      now: () => performance.now(),
      schedule(delayMs, run) {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      interval: (lastMs) => updateInterval(lastMs, prefersReducedMotion()),
      send(text, done) {
        const started = performance.now();
        return markit.render(text, { finalized: done }).then((patch) => {
          if (patch.superseded || import.meta.env.MODE !== "perf") return;
          perfSamples()?.push({
            stream: sampled.current,
            chars: text.length,
            ms: performance.now() - started,
          });
        });
      },
    });
    pace.current = paced;
    return () => {
      paced.dispose();
      if (pace.current === paced) pace.current = undefined;
    };
  }, [markit]);
  useEffect(() => {
    pace.current?.push(markdown, finalized);
  }, [markdown, finalized]);
  // The controller is stable; its ref callback attaches the renderer to this element.
  const attach = useCallback((element: HTMLElement | null) => markit.ref(element), [markit]);
  return (
    <div className={cn("markit-ace", blockRhythm, props.className)}>
      {!drawn && <p className="whitespace-pre-wrap">{markdown}</p>}
      <div ref={attach} />
    </div>
  );
}

const fallbackStream = (props: ProseProps) => props.stream ?? `#${contentHash(props.text)}`;

function useThreadNavigation(): LinkActions["openThread"] {
  const navigate = useNavigate();
  return useCallback(
    (threadId: string, machine: string | undefined) =>
      void navigate({
        to: "/t/$threadId",
        params: { threadId },
        search: machine ? { machine } : {},
      }),
    [navigate],
  );
}

function MarkitPlainProse(props: ProseProps) {
  const openWeb = useOpenWebAddress();
  const openPullRequest = useContext(PullRequestOpener);
  const openThread = useThreadNavigation();
  const callbacks = useMemo(
    () => ({
      ...linkCallbacks({ openWeb, openPullRequest, openThread }),
      resolveImage: (url: string, _alt: string, signal: AbortSignal) => pageImage(url, signal),
    }),
    [openWeb, openPullRequest, openThread],
  );
  return (
    <MarkitView
      markdown={props.text}
      finalized={!props.streaming}
      stream={fallbackStream(props)}
      className={props.className}
      callbacks={callbacks}
    />
  );
}

/** A local image the thread captured (a screenshot, a generated chart), fetched from its host. */
async function threadImage(
  client: ClientApi,
  thread: { threadId: string; itemId?: string },
  reference: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  try {
    const resolved = await client.request(
      {
        type: "context.request",
        operation: {
          op: "image.resolve",
          threadId: ThreadId.parse(thread.threadId),
          reference,
          ...(thread.itemId ? { itemId: ItemId.parse(thread.itemId) } : {}),
        },
      },
      { signal },
    );
    if (resolved.result.kind !== "attachment") return null;
    const { bytes, mimeType } = await client.attachmentBytes(
      { threadId: thread.threadId, sha256: resolved.result.attachment.sha256 },
      { signal },
    );
    return new Blob([new Uint8Array(bytes)], { type: mimeType });
  } catch {
    return null;
  }
}

function MarkitThreadProse(
  props: ProseProps & {
    thread: { threadId: string; cwd?: string; itemId?: string };
    client: ClientApi;
  },
) {
  const { client } = props;
  const { threadId, cwd, itemId } = props.thread;
  const meta = useThreadMeta(threadId);
  const workspace = useWorkspaceActions(threadId);
  const openWeb = useOpenWebAddress();
  const panelOpener = useContext(PullRequestOpener);
  const openThread = useThreadNavigation();
  const root = (meta?.details?.worktree ?? meta?.details?.workspace?.path)?.replace(/\/+$/, "");
  const workspaceId = meta?.workspaceId;

  const callbacks = useMemo(() => {
    const base = cwd ?? root;
    const openFile = (target: string) => {
      const relative = checkoutLinkPath(localLinkPath(target) ?? target, root, cwd);
      if (relative && isCheckoutPath(relative)) workspace.open(fileTab(relative));
    };
    const openPullRequest =
      panelOpener ??
      (workspaceId
        ? (pr: ForgePrRef) =>
            workspace.open(
              pullRequestTab({ workspaceId, repository: pr.repository, number: pr.number }),
            )
        : undefined);
    return {
      ...linkCallbacks({ openWeb, openPullRequest, openThread, openFile }),
      resolveImage: async (url: string, _alt: string, signal: AbortSignal) => {
        if (shouldResolveMarkitImage(url)) return pageImage(url, signal);
        if (signal.aborted || isMarkitWebImage(url)) return null;
        const path = localLinkPath(url) ?? url;
        if (!/\.(png|jpe?g|webp|gif)$/i.test(path)) return null;
        const reference = itemId
          ? normalizedPath(path)
          : normalizedPath(path.startsWith("/") || !base ? path : `${base}/${path}`);
        return threadImage(client, { threadId, ...(itemId ? { itemId } : {}) }, reference, signal);
      },
    };
  }, [
    client,
    cwd,
    itemId,
    openThread,
    openWeb,
    panelOpener,
    root,
    threadId,
    workspace,
    workspaceId,
  ]);

  return (
    <MarkitView
      markdown={props.text}
      finalized={!props.streaming}
      stream={fallbackStream(props)}
      className={props.className}
      callbacks={callbacks}
    />
  );
}
