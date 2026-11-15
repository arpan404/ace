import { lazy, Suspense, useMemo } from "react";
import { Button } from "@/components/ui/button.tsx";
import { shallowEqual, useThreadField, type ThreadRecord } from "@ace/client-react/thread-field";
import { isCheckoutPath } from "@ace/ui-core";
import { ArchiveIcon } from "@phosphor-icons/react";
import { ArtifactImage } from "./artifact-image.tsx";
import { UnavailableImage } from "./attachment-message.tsx";
import { projectRelative } from "./attachment-format.ts";
import { useFilePreview } from "./attachment-open.tsx";
const ArtifactActions = lazy(() =>
  import("./artifact-actions.tsx").then((module) => ({ default: module.ArtifactActions })),
);

/**
 * A file the agent saved (a browser screenshot, a download, a recording), named relative to the
 * project. Workspace artifacts open in Files or download through the owning thread's file
 * channel; Open file shows the saved bytes beside the thread, by kind.
 */
/** The thread's checkout folders, which name a file relative to its project. */
const checkoutFolders = (thread: ThreadRecord) => ({
  worktree: thread.details?.worktree,
  workspace: thread.details?.workspace?.path,
});

export function ArtifactLine(props: {
  threadId: string;
  path: string;
  mimeType: string;
  artifactId?: string | undefined;
  bytes?: number | undefined;
  filename?: string | undefined;
}) {
  const { show, preview } = useFilePreview();
  const file = useMemo(
    () => ({
      name: props.filename ?? props.path.split("/").at(-1) ?? "Saved file",
      mimeType: props.mimeType,
      bytes: props.bytes,
      source: props.artifactId
        ? {
            kind: "artifact" as const,
            threadId: props.threadId,
            artifactId: props.artifactId,
            bytes: props.bytes ?? 0,
          }
        : undefined,
    }),
    [props.filename, props.path, props.mimeType, props.bytes, props.artifactId, props.threadId],
  );
  const folders = useThreadField(props.threadId, checkoutFolders, shallowEqual);
  const name = projectRelative(props.path, [folders?.worktree, folders?.workspace]);
  const root = (folders?.worktree ?? folders?.workspace)?.replace(/\/+$/, "");
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
        <code
          title={props.filename ?? name}
          className="min-w-0 truncate font-mono text-[12.5px] text-foreground"
        >
          {props.filename ?? name}
        </code>
        {available && (
          <Suspense fallback={null}>
            <ArtifactActions threadId={props.threadId} path={relative} />
          </Suspense>
        )}
      </p>
      {props.artifactId && (
        <Button variant="ghost" size="sm" onClick={(event) => show(file, event.currentTarget)}>
          {props.mimeType.startsWith("video/") ? "Play recording" : "Open file"}
        </Button>
      )}
      {preview}
      {props.mimeType.startsWith("image/") &&
        (file.source ? (
          <ArtifactImage name={file.name} source={{ ...file.source, mimeType: props.mimeType }} />
        ) : (
          <UnavailableImage name={name} />
        ))}
    </div>
  );
}
