import type { ClientApi } from "@ace/client";
import { useClient, useThreadMeta } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { isCheckoutPath } from "@ace/ui-core";
import {
  resolveFileReference,
  workspaceRelative,
  type FileReference,
  type FileResolution,
} from "@ace/ui-core/file-references";
import { useQuery } from "@tanstack/react-query";
import { useContext, type ReactNode } from "react";
import { codeSpanClass } from "@/components/inline-markdown.tsx";
import { cn } from "@/lib/cn.ts";
import {
  fileTabId,
  findTab,
  tabKey,
  useScopeWorkspace,
  useWorkspaceActions,
} from "@/lib/workspace/index.ts";
import { ThreadReferenceScope } from "./thread-reference.tsx";

/*
 * A file an answer mentions (`loader.ts`, `src/app/x.tsx:42`), shown as a link once the thread's
 * checkout confirms it. Resolution asks the daemon's path index once per path per thread (the
 * query cache keeps the answer), and only for settled text: a block still streaming renders
 * plain. A unique match opens in the side panel's Files view at its line; several matches open
 * the Files tree filtered to the name; no match stays plain text or code.
 */

const searchLimit = 50;

// One path lookup at a time per connection, so a long answer doesn't flood the daemon.
const tails = new WeakMap<ClientApi, Promise<unknown>>();
async function queued<T>(client: ClientApi, signal: AbortSignal, run: () => Promise<T>) {
  const current = (tails.get(client) ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      signal.throwIfAborted();
      return run();
    });
  tails.set(client, current);
  try {
    return await current;
  } finally {
    if (tails.get(client) === current) tails.delete(client);
  }
}

async function lookup(
  client: ClientApi,
  threadId: string,
  path: string,
  signal: AbortSignal,
): Promise<FileResolution> {
  const reply = await queued(client, signal, () =>
    client.request(
      {
        type: "context.request",
        operation: {
          op: "mention.complete",
          threadId: ThreadId.parse(threadId),
          query: path.slice(0, 128),
          limit: searchLimit,
        },
      },
      { signal },
    ),
  );
  const result = reply.result;
  if (result.kind !== "completion") return { kind: "none" };
  return resolveFileReference(path, result.paths.filter(isCheckoutPath));
}

function objectData(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? { ...data } : {};
}

function Plain(props: { text: string; code: boolean }): ReactNode {
  return props.code ? <code className={codeSpanClass}>{props.text}</code> : props.text;
}

/** `text` as written; a link into the thread's checkout when `reference` resolves there. */
export function FileReferenceLink(props: {
  text: string;
  reference: FileReference;
  code: boolean;
}): ReactNode {
  const scope = useContext(ThreadReferenceScope);
  if (!scope) return <Plain text={props.text} code={props.code} />;
  return <ScopedLink {...props} threadId={scope.threadId} />;
}

function ScopedLink(props: {
  threadId: string;
  text: string;
  reference: FileReference;
  code: boolean;
}): ReactNode {
  const client = useClient();
  const thread = useThreadMeta(props.threadId);
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const root = thread?.details?.worktree ?? thread?.details?.workspace?.path;
  const relative = workspaceRelative(props.reference.path, root);
  const resolved = useQuery({
    queryKey: ["thread", props.threadId, "file-reference", relative],
    queryFn: ({ signal }) => lookup(client, props.threadId, relative ?? "", signal),
    enabled: !!relative,
    // Memoized for the thread's session: the same mention never asks twice.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
  });
  const resolution = resolved.data;
  if (!resolution || resolution.kind === "none")
    return <Plain text={props.text} code={props.code} />;

  const open = () => {
    if (resolution.kind === "file") {
      const id = fileTabId(resolution.path);
      const existing = findTab(workspace, tabKey("files", id));
      actions.open({
        kind: "files",
        id,
        data: {
          ...objectData(existing?.tab.data),
          path: resolution.path,
          preview: false,
          ...(props.reference.line === undefined ? {} : { line: props.reference.line }),
        },
      });
      return;
    }
    // Several files share the name: the Files tree, filtered to it, lets the person pick.
    const tree = findTab(workspace, tabKey("files"));
    const name = relative?.split("/").at(-1) ?? props.reference.path;
    actions.open({ kind: "files", data: { ...objectData(tree?.tab.data), query: name } });
  };
  const label =
    resolution.kind === "file"
      ? `Open ${resolution.path}${props.reference.line ? ` at line ${props.reference.line}` : ""}`
      : `Find ${props.text} in Files (${resolution.paths.length} matches)`;
  return (
    <button
      type="button"
      onClick={open}
      title={label}
      data-file-link={resolution.kind}
      className={cn(
        "cursor-pointer rounded-xs text-link underline-offset-[3px] outline-none hover:underline focus-visible:underline focus-ring",
        !props.code && "wrap-break-word",
      )}
    >
      {props.code ? (
        <code className={cn(codeSpanClass, "text-link")}>{props.text}</code>
      ) : (
        props.text
      )}
    </button>
  );
}
