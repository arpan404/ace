import type { Attachment, QueuedMessage } from "@ace/protocol";
import { MessageAttachments, type LocalAttachment } from "@/components/attachment-message.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useThreadSources } from "../sources/index.ts";
import { localAttachment } from "../composer/send-store.ts";

const unknownFile: LocalAttachment = {
  name: "Attached file",
  mimeType: "application/octet-stream",
  bytes: 0,
};

/**
 * The files of a message that wasn't sent, drawn as a sent message's are: the daemon's stored
 * metadata when it has it (the queue strip reads the same list), else what this window knows.
 */
export function HeldAttachments(props: {
  threadId: string;
  message: QueuedMessage;
  className?: string | undefined;
}) {
  const sources = useThreadSources();
  const hashes = (props.message.context?.attachments ?? []).map((file) => file.sha256);
  const stored = useDaemonQuery({
    queryKey: ["thread", "queued-attachments", props.threadId, hashes.toSorted().join()],
    enabled: hashes.length > 0,
    read: (_client, signal) =>
      sources.context.list({ id: props.threadId, workspaceId: "", title: "" }, signal),
  });
  if (!hashes.length) return null;
  const known: Attachment[] = [];
  const local: LocalAttachment[] = [];
  for (const sha256 of hashes) {
    const file = stored.data?.find((candidate) => candidate.sha256 === sha256);
    if (file) known.push(file);
    else local.push(localAttachment(sha256) ?? unknownFile);
  }
  return (
    <MessageAttachments
      threadId={props.threadId}
      attachments={known}
      local={local}
      className={props.className}
    />
  );
}
