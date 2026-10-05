import { useThreadMeta } from "@ace/client-react";
import { ArchiveIcon } from "@phosphor-icons/react";
import { projectRelative } from "./attachment-format.ts";
import { UnavailableImage } from "./attachment-message.tsx";

/**
 * A file the agent saved (a browser screenshot, a download), named relative to the project.
 * An artifact item carries only the daemon's path, not a content id this device can fetch, so
 * an image shows the neutral unavailable tile under its name instead of a thumbnail.
 */
export function ArtifactLine(props: { threadId: string; path: string; mimeType: string }) {
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
        <code title={name} className="min-w-0 truncate font-mono text-[12.5px] text-foreground">
          {name}
        </code>
      </p>
      {props.mimeType.startsWith("image/") && <UnavailableImage name={name} />}
    </div>
  );
}
