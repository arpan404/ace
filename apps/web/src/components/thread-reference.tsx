import { useClient, useThreadMeta, useThread, useThreadStore } from "@ace/client-react";
import { ThreadId, ItemId } from "@ace/protocol";
import { useQuery } from "@tanstack/react-query";
import { Suspense, createContext, useContext, useCallback, useEffect, type ReactNode } from "react";
import { isCheckoutPath } from "@ace/ui-core";
import { fileTab, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
const InlineImage = deferredComponent(() =>
  import("./attachment-tiles.tsx").then((module) => module.CapturedInlineImage),
);
import type { ClientApi, ThreadReader, ThreadSource } from "@ace/client";
import type { Attachment } from "@ace/protocol";
import { displayName } from "./attachment-format.ts";

export const ThreadReferenceScope = createContext<
  { threadId: string; cwd?: string; itemId?: string } | undefined
>(undefined);

/** Local prose links resolve on the thread host, never in this browser's filesystem. */
export function ThreadReference(props: {
  reference: string;
  children?: ReactNode;
  image?: boolean;
  alt?: string;
}) {
  const scope = useContext(ThreadReferenceScope);
  return scope ? <ScopedReference {...props} {...scope} /> : props.children;
}

function localPath(reference: string): string | undefined {
  try {
    if (reference.startsWith("file:")) {
      const url = new URL(reference);
      if (url.host && url.host !== "localhost") return;
      return decodeURIComponent(url.pathname);
    }
    return /^[a-z][a-z\d+.-]*:/i.test(reference)
      ? undefined
      : reference.replace(/:\d+(?::\d+)?$/, "");
  } catch {
    return;
  }
}

function ScopedReference(props: {
  threadId: string;
  cwd?: string;
  itemId?: string;
  reference: string;
  image?: boolean;
  alt?: string;
  children?: ReactNode;
}) {
  const client = useClient();
  const thread = useThreadMeta(props.threadId);
  const workspace = useWorkspaceActions(props.threadId);
  const path = localPath(props.reference);
  const root = (thread?.details?.worktree ?? thread?.details?.workspace?.path)?.replace(/\/+$/, "");
  const base = props.cwd ?? root;
  const resolvePath = (value: string, cwd = base) =>
    normalizedPath(value.startsWith("/") || !cwd ? value : `${cwd}/${value}`);
  const selector = useCallback(
    (reader: ThreadReader): Attachment | undefined => {
      if (!path || !(props.image || /\.(?:png|jpe?g|webp)$/i.test(path))) return;
      const expected = normalizedPath(path.startsWith("/") || !base ? path : `${base}/${path}`);
      const boundary = props.itemId ? reader.order.indexOf(props.itemId) : reader.order.length;
      if (boundary < 0) return;
      for (const id of reader.order.slice(0, boundary).toReversed()) {
        const item = reader.item(id);
        if (
          item?.type !== "tool_call" ||
          item.call.detail.kind !== "image" ||
          !item.call.detail.path ||
          !item.call.detail.attachment
        )
          continue;
        const capturedPath = localPath(item.call.detail.path);
        const source = item.call.detail.sourcePath && localPath(item.call.detail.sourcePath);
        const cwd = reader.agent(item.agentId)?.cwd;
        if (
          props.itemId &&
          !path.startsWith("/") &&
          item.agentId !== reader.item(props.itemId)?.agentId
        )
          continue;
        if (
          (props.itemId &&
            !path.startsWith("/") &&
            source &&
            normalizedPath(source) === normalizedPath(path)) ||
          (capturedPath &&
            normalizedPath(
              capturedPath.startsWith("/") || !cwd ? capturedPath : `${cwd}/${capturedPath}`,
            ) === expected)
        )
          return item.call.detail.attachment;
      }
    },
    [path, base, props.image, props.itemId],
  );
  const toolIds = useThread(props.threadId, ["order"], readTools, sameIds) ?? [];
  const localCapture = useThread(
    props.threadId,
    ["agents", ...toolIds.map((id) => `item:${id}` as const)],
    selector,
  );
  const store = useThreadStore(props.threadId);
  const candidate = !!path && (props.image || /\.(?:png|jpe?g|webp)(?::\d+)?$/i.test(path));
  const captured = useQuery({
    queryKey: [
      "thread",
      props.threadId,
      "image-reference",
      props.itemId,
      props.itemId ? props.reference : path ? resolvePath(path) : props.reference,
    ],
    queryFn: async ({ signal }) => {
      const response = await resolveImage(client, signal, () =>
        client.request(
          {
            type: "context.request",
            operation: {
              op: "image.resolve",
              threadId: ThreadId.parse(props.threadId),
              reference: props.itemId
                ? normalizedPath(path ?? props.reference)
                : path
                  ? resolvePath(path)
                  : props.reference,
              ...(props.itemId ? { itemId: ItemId.parse(props.itemId) } : {}),
            },
          },
          { signal },
        ),
      );
      return response.result.kind === "attachment" ? response.result.attachment : null;
    },
    enabled: candidate && !localCapture,
    staleTime: 30_000,
  });
  const { data: resolvedImage, refetch: refreshImage } = captured;
  useEffect(() => {
    if (!candidate || localCapture || resolvedImage !== null) return;
    if (!store) return;
    return watchImageCaptures(store, refreshImage);
  }, [candidate, localCapture, resolvedImage, refreshImage, store]);
  const absolute = path ? resolvePath(path) : undefined;
  const relative = absolute?.startsWith("/")
    ? root && absolute.startsWith(`${root}/`)
      ? absolute.slice(root.length + 1)
      : undefined
    : absolute;
  const attachment = localCapture ?? captured.data;
  if (attachment)
    return (
      <Suspense fallback={<span>{props.children ?? props.alt ?? attachment.name}</span>}>
        <InlineImage.Component threadId={props.threadId} attachment={attachment} alt={props.alt} />
      </Suspense>
    );
  if (relative && isCheckoutPath(relative))
    return (
      <button
        type="button"
        onClick={() => workspace.open(fileTab(relative))}
        className="text-link underline decoration-ring/40 underline-offset-[3px] hover:decoration-current"
      >
        {props.children ?? props.alt ?? displayName(relative)}
      </button>
    );
  return (
    <span title="This file is not available from the thread's environment">
      {props.children ?? props.alt ?? displayName(props.reference)}
    </span>
  );
}

const readCursor = (reader: ThreadReader) => reader.cursor;
const readTools = (reader: ThreadReader) =>
  reader.order.filter((id) => reader.item(id)?.type === "tool_call");
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

function normalizedPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !path.startsWith("/")) parts.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + parts.join("/");
}

// One small metadata lookup at a time per connection; image bytes use their own bounded cache.
const lookupTails = new WeakMap<ClientApi, Promise<unknown>>();
async function resolveImage<T>(
  client: ClientApi,
  signal: AbortSignal,
  lookup: () => Promise<T>,
): Promise<T> {
  const previous = lookupTails.get(client) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => {
      signal.throwIfAborted();
      return lookup();
    });
  lookupTails.set(client, current);
  try {
    return await current;
  } finally {
    if (lookupTails.get(client) === current) lookupTails.delete(client);
  }
}

/** Refresh a negative lookup only after a new committed fact; release cancels pending work. */
function watchImageCaptures(store: ThreadSource, refresh: () => Promise<unknown>): () => void {
  const cursor = store.select(["cursor"], readCursor);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = cursor.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 750);
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
