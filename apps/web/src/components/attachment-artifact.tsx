import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useThreadMeta } from "@ace/client-react";
import { ArchiveIcon } from "@phosphor-icons/react";
import { projectRelative } from "./attachment-format.ts";
import { UnavailableImage } from "./attachment-message.tsx";

/**
 * A file the agent saved (a browser screenshot, a download), named relative to the project.
 * An artifact item carries only the daemon's path, not a content id this device can fetch, so
 * an image shows the neutral unavailable tile under its name instead of a thumbnail.
 */
const Preview = lazy(() =>
  import("./attachment-preview.tsx").then((module) => ({ default: module.AttachmentPreview })),
);
export function ArtifactLine(props: {
  threadId: string;
  path: string;
  mimeType: string;
  artifactId?: string | undefined;
  bytes?: number | undefined;
  filename?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const file = useMemo(
    () => ({
      name: props.filename ?? "Device recording.mp4",
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
    [props.filename, props.mimeType, props.bytes, props.artifactId, props.threadId],
  );
  const thread = useThreadMeta(props.threadId);
  const name = projectRelative(props.path, [
    thread?.details?.worktree,
    thread?.details?.workspace?.path,
  ]);
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
      </p>
      {props.artifactId && (
        <Button ref={trigger} variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Play recording
        </Button>
      )}
      {open && (
        <Suspense>
          <Preview file={file} finalFocus={trigger} onClose={() => setOpen(false)} />
        </Suspense>
      )}
      {props.mimeType.startsWith("image/") && <UnavailableImage name={name} />}
    </div>
  );
}
