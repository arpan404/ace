import { MessageReferences } from "./message-references.tsx";
import { messageActions } from "./message-actions.ts";
import { userBubble } from "./user-bubble.ts";
import { useItem } from "@ace/client-react";
import { formatClock, withoutPortableHandoff, sanitizeUserText } from "@ace/ui-core";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { Suspense, useRef } from "react";
import type { LocalAttachment } from "@/components/attachment-format.ts";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { DeferredSendStatus } from "../composer/deferred-parts.tsx";
import {
  inputText,
  localAttachment,
  leasable,
  useLocalSendsView,
  type LocalSend,
} from "../composer/send-store.ts";
import { EditMessageButton, useEditPoint } from "../transitions/message-edits.tsx";

const nothing: LocalSend = {};

/** Thumbnails and file chips; their code loads with the thread's deferred parts. */
const DeferredAttachments = deferredComponent(() =>
  import("@/components/attachment-message.tsx").then((module) => module.MessageAttachments),
);

/**
 * Room for a message's attachments while their code arrives: a lone image's box at its known
 * aspect (within 320×240), else a grid's rows of 120, so the bubble keeps its size.
 */
function AttachmentsRoom(props: {
  images: readonly { width?: number | undefined; height?: number | undefined }[];
}) {
  const [first] = props.images;
  if (!first) return null;
  const height =
    props.images.length === 1
      ? Math.min(240, (320 * (first.height ?? 3)) / (first.width ?? 4))
      : Math.ceil(Math.min(props.images.length, 4) / 2) * 126;
  return <span aria-hidden className="mb-2 block" style={{ height }} />;
}

/** Files of a message the daemon hasn't echoed yet, as this window knows them. */
function localFiles(local: LocalSend): readonly LocalAttachment[] | undefined {
  if (local.staged) return local.staged.attachments;
  const sent = local.send?.payload.context?.attachments;
  if (!sent?.length) return undefined;
  return sent.map(
    (file) =>
      localAttachment(file.sha256) ?? {
        name: "Attachment",
        mimeType: "application/octet-stream",
        bytes: 0,
      },
  );
}

/**
 * The person's message: a right-aligned bubble. Its time, Copy and Edit sit beside the bubble's
 * foot on hover or focus (always on touch), so an idle message costs no height of its own. The
 * same bubble is drawn from the moment Enter is pressed (from the outbox, or held while its files
 * upload) until the daemon's item takes over under the same key, with a quiet "Sending…" under it
 * meanwhile and "Not sent" with Retry and Edit if it doesn't go. Attached images show as
 * thumbnails and files by name, never by a host path (AT-1).
 */
export function UserMessage(props: { threadId: string; itemId: string }) {
  const content = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();
  const item = useItem(leasable(props.threadId), props.itemId);
  const local: LocalSend = useLocalSendsView(props.threadId)?.find(props.itemId) ?? nothing;
  const editPoint = useEditPoint(props.threadId, props.itemId);
  const noticeId = local.noticeId;
  const message = item?.type === "message" ? item : undefined;
  if (!message && !local.send && !local.staged) return null;
  const text = sanitizeUserText(
    message
      ? inputText(message.parts)
      : local.send
        ? inputText(local.send.payload.input)
        : (local.staged?.text ?? ""),
  );
  // Most messages carry no files: only those load the thumbnails' code.
  const parts = withoutPortableHandoff(
    message?.parts ?? local.send?.payload.input ?? local.staged?.input ?? [],
  );
  const images: { width?: number | undefined; height?: number | undefined }[] = [
    ...(message?.attachments ?? []).filter((file) => file.mimeType.startsWith("image/")),
    ...parts.flatMap((part) => (part.type === "image" ? [{}] : [])),
  ];
  const files =
    message?.attachments?.length ||
    parts.some((part) => part.type === "file" || part.type === "image") ||
    (!message && localFiles(local)?.length)
      ? { images }
      : undefined;
  const readable = !!text || parts.some((part) => part.type === "mention");
  if (!readable && !files) return null;
  const saying =
    !!local.staged ||
    noticeId !== undefined ||
    local.send?.state === "saving" ||
    local.send?.state === "sent" ||
    local.send?.state === "failed";
  return (
    <div className="group/bubble flex flex-col items-end">
      {/* Touch: the actions under the bubble. A pointer: beside its foot, taking no height. */}
      <div className="flex w-full min-w-0 flex-col items-end gap-1 pointer-fine:flex-row pointer-fine:items-end pointer-fine:justify-end pointer-fine:gap-2">
        <div className={cn(userBubble, "pointer-fine:order-last")}>
          {files && (
            <Suspense fallback={<AttachmentsRoom images={files.images} />}>
              <DeferredAttachments.Component
                threadId={leasable(props.threadId)}
                attachments={message?.attachments}
                parts={message?.parts ?? local.send?.payload.input}
                local={message ? undefined : localFiles(local)}
                className={text ? "mb-2" : undefined}
              />
            </Suspense>
          )}
          <div ref={content}>{parts.length ? <MessageReferences parts={parts} /> : text}</div>
        </div>
        {message && !saying && (
          <div className={cn(messageActions("bubble"), "shrink-0")}>
            <time
              dateTime={new Date(message.createdAt).toISOString()}
              className="pr-1 text-xs text-subtle-foreground"
            >
              {formatClock(message.createdAt)}
            </time>
            {readable && (
              <IconButton
                icon={copied ? CheckIcon : CopyIcon}
                label={copied ? "Copied message" : "Copy message"}
                size="sm"
                onClick={() => copy(content.current?.textContent ?? text)}
              />
            )}
            {readable && editPoint && (
              <EditMessageButton
                threadId={props.threadId}
                itemId={props.itemId}
                point={editPoint}
              />
            )}
            {copied && (
              <span role="status" className="text-xs text-muted-foreground">
                Copied
              </span>
            )}
          </div>
        )}
      </div>
      {/* Only while it is on its way (or didn't go): how its sending goes, under the bubble. */}
      {saying && (
        <div className="mt-1 flex min-h-6 items-center gap-2">
          <Suspense fallback={null}>
            <DeferredSendStatus.Component
              threadId={props.threadId}
              itemId={props.itemId}
              send={local.send}
              staged={local.staged}
              noticeId={noticeId}
              otherwise={null}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
