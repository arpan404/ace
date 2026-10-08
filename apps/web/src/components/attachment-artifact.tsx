import { useThreadMeta } from "@ace/client-react";
import { lazy, Suspense } from "react";
import { isCheckoutPath } from "@ace/ui-core";
import { ArchiveIcon } from "@phosphor-icons/react";
import { projectRelative } from "./attachment-format.ts";
const ArtifactActions = lazy(() =>
  import("./artifact-actions.tsx").then((module) => ({ default: module.ArtifactActions })),
);

/**
 * A file the agent saved (a browser screenshot, a download), named relative to the project.
 * Workspace artifacts open in Files or download through the owning thread's file channel.
 */
export function ArtifactLine(props: { threadId: string; path: string; mimeType: string }) {
  const thread = useThreadMeta(props.threadId);
  const name = projectRelative(props.path, [
    thread?.details?.worktree,
    thread?.details?.workspace?.path,
  ]);
  const root = (thread?.details?.worktree ?? thread?.details?.workspace?.path)?.replace(/\/+$/, "");
  const relative = props.path.startsWith("/")
    ? root && props.path.startsWith(`${root}/`)
      ? props.path.slice(root.length + 1)
      : undefined
    : props.path;
  const available = relative !== undefined && isCheckoutPath(relative);
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="flex min-w-0 max-w-full items-center gap-2 text-ui text-muted-foreground">
        <ArchiveIcon aria-hidden size={16} className="shrink-0 text-subtle-foreground" />
        <span className="shrink-0">Saved</span>
        <code title={name} className="min-w-0 truncate font-mono text-sm text-foreground">
          {name}
        </code>
        {available && (
          <Suspense fallback={null}>
            <ArtifactActions threadId={props.threadId} path={relative} />
          </Suspense>
        )}
      </p>
    </div>
  );
}
