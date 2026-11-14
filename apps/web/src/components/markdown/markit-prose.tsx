import { useOptionalClient, useThreadField, useThreadStore } from "@ace/client-react";
import { threadCheckoutRoot, threadWorkspaceId } from "@/lib/thread-fields.ts";
import type { ClientApi } from "@ace/client";
import { ItemId, ThreadId, type ForgeIssueRef, type ForgePrRef } from "@ace/protocol";
import { isMarkitWebImage, markitLinkTarget, shouldResolveMarkitImage } from "@ace/markit-web";
import "./markit-ace.css";
import { checkoutLinkPath, localLinkPath, normalizedPath } from "@ace/ui-core/file-references";
import { contentHash, isCheckoutPath, readAceLink } from "@ace/ui-core";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useContext, useMemo } from "react";
import {
  IssueOpener,
  PullRequestOpener,
  issueAt,
  pullRequestAt,
  useOpenWebAddress,
} from "../web-link.tsx";
import { displayName } from "../attachment-format.ts";
import { LinkedFileOpener } from "../linked-file.tsx";
import type { LinkClick } from "@/lib/web-links.ts";
import { fileTab, pullRequestTab, useOptionalWorkspace } from "@/lib/workspace/index.ts";
import { watchImageCaptures } from "./image-refresh.ts";
import { useFileLinks } from "./use-file-links.ts";
import { keptAnswersFor } from "./kept-answers.ts";
import { MarkitView, type MarkitCallbacks } from "./markit-view.tsx";

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
  /**
   * Forge text (PR and issue bodies, comments): draws `@name`, `#12` and commit hashes as links
   * (markit's GitHub flavour), and gives the address each one opens.
   */
  forgeReference?: ForgeReferenceAddress | undefined;
}

type ForgeReferenceAddress = (reference: { kind: string; target: string }) => string | undefined;

/** What a click in prose can open, beyond the system browser. */
interface LinkActions {
  openWeb: (url: string, click?: LinkClick) => Promise<void>;
  openPullRequest?: ((pr: ForgePrRef) => void) | undefined;
  openIssue?: ((issue: ForgeIssueRef) => void) | undefined;
  openThread: (threadId: string, machine: string | undefined) => void;
  openFile?: ((path: string) => void) | undefined;
  /** A file an answer names (`socket.ts:3`), found in the thread's checkout. */
  openMention?: ((target: string) => void) | undefined;
  forgeReference?: ForgeReferenceAddress | undefined;
}

/** Link and reference handling shared by every prose surface. */
function linkCallbacks(
  actions: LinkActions,
): Pick<MarkitCallbacks, "onLink" | "onSystemLink" | "onReference"> {
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
    // An issue opens ace's page for it, where the screen has one.
    const issue = issueAt(target.href);
    if (issue && actions.openIssue) return actions.openIssue(issue);
    void actions.openWeb(target.href).catch(() => {});
  };
  return {
    onLink,
    onSystemLink: (url, click) => void actions.openWeb(url, click).catch(() => {}),
    onReference: (reference) => {
      if (reference.kind === "file") return actions.openMention?.(reference.target);
      onLink(actions.forgeReference?.(reference) ?? reference.target);
    },
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

/** The stream prose is drawn as: its own, else its text's hash, hashed once per text. */
function useStreamName(props: ProseProps): string {
  const { stream, text } = props;
  return useMemo(() => stream ?? `#${contentHash(text)}`, [stream, text]);
}

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
  const openIssue = useContext(IssueOpener);
  const openThread = useThreadNavigation();
  const { forgeReference } = props;
  const stream = useStreamName(props);
  const callbacks = useMemo(
    () => ({
      ...linkCallbacks({ openWeb, openPullRequest, openIssue, openThread, forgeReference }),
      resolveImage: (url: string, _alt: string, signal: AbortSignal) => pageImage(url, signal),
    }),
    [openWeb, openPullRequest, openIssue, openThread, forgeReference],
  );
  return (
    <MarkitView
      markdown={props.text}
      finalized={!props.streaming}
      stream={stream}
      className={props.className}
      callbacks={callbacks}
      flavor={forgeReference ? "github" : proseFlavor}
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
  const root = useThreadField(threadId, threadCheckoutRoot);
  const workspaceId = useThreadField(threadId, threadWorkspaceId);
  const stream = useStreamName(props);
  const workspace = useOptionalWorkspace(threadId);
  const openWeb = useOpenWebAddress();
  const panelOpener = useContext(PullRequestOpener);
  const openIssue = useContext(IssueOpener);
  const downloadLinked = useContext(LinkedFileOpener);
  const openThread = useThreadNavigation();
  const fileLinks = useFileLinks({ client, threadId, itemId, root, workspace });
  // Only an answer that shows an image follows the thread for captures.
  const captures = useThreadStore(props.text.includes("![") ? threadId : undefined);
  // A finished answer of this item may stay drawn across remounts, in this client's own cache.
  const keep = useMemo(
    () =>
      itemId
        ? { answers: keptAnswersFor(client), scope: { threadId, itemId }, cwd, root }
        : undefined,
    [client, threadId, itemId, cwd, root],
  );

  const callbacks = useMemo(() => {
    const base = cwd ?? root;
    const actions = workspace?.actions;
    const openFile = (target: string) => {
      const path = localLinkPath(target) ?? target;
      const relative = checkoutLinkPath(path, root, cwd);
      if (relative && isCheckoutPath(relative)) return actions?.open(fileTab(relative));
      // Outside the checkout: the host serves the file because this message links it.
      if (itemId)
        downloadLinked?.({ threadId, itemId, reference: target, name: displayName(path) });
    };
    const openPullRequest =
      panelOpener ??
      (workspaceId && actions
        ? (pr: ForgePrRef) =>
            actions.open(
              pullRequestTab({ workspaceId, repository: pr.repository, number: pr.number }),
            )
        : undefined);
    return {
      ...linkCallbacks({
        openWeb,
        openPullRequest,
        openIssue,
        openThread,
        openFile,
        openMention: fileLinks.open,
      }),
      drawn: fileLinks.drawn,
      watchImages: captures
        ? (refresh: () => void) => watchImageCaptures(captures, refresh)
        : undefined,
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
    captures,
    cwd,
    downloadLinked,
    fileLinks,
    itemId,
    openIssue,
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
      stream={stream}
      className={props.className}
      callbacks={callbacks}
      flavor={proseFlavor}
      keep={keep}
    />
  );
}
