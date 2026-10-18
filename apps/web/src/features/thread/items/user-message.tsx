import { BubbleText } from "./bubble-text.tsx";
import { messageActions } from "./message-actions.ts";
import { userBubble } from "./user-bubble.ts";
import { useItem } from "@ace/client-react";
import { formatClock, messageOrigin, withoutPortableHandoff, sanitizeUserText } from "@ace/ui-core";
import { ArrowBendDownRightIcon, CheckIcon, ClockIcon, CopyIcon } from "@phosphor-icons/react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { Suspense, useRef } from "react";
import { imageGroupHeight, type LocalAttachment } from "@/components/attachment-format.ts";
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
 * Room for a message's attachments while their code arrives: the image group's height from the
 * images' known shapes, so the transcript keeps its place.
 */
function AttachmentsRoom(props: {
  images: readonly { width?: number | undefined; height?: number | undefined }[];
}) {
  const height = imageGroupHeight(props.images);
  if (!height) return null;
  return <span aria-hidden className="mb-1 block" style={{ height }} />;
}

/** How a message reached the agent, when that isn't simply typed and sent. */
const eyebrows: Partial<Record<string, { icon: IconGlyph; label: string }>> = {
  steer: { icon: ArrowBendDownRightIcon, label: "Steer" },
  queue: { icon: ClockIcon, label: "Queued" },
};

function Eyebrow(props: { kind: string | undefined }) {
  const eyebrow = props.kind ? eyebrows[props.kind] : undefined;
  if (!eyebrow) return null;
  return (
    <span
      data-origin={props.kind}
      className="mb-1 flex items-center gap-1 text-xs text-subtle-foreground"
    >
      <Icon icon={eyebrow.icon} size={12} />
      {eyebrow.label}
    </span>
  );
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
 * The person's message: its attachments above, unframed, then a right-aligned bubble of its words
 * (none for a message of attachments only), with a quiet eyebrow when it was steered or queued.
 * Its time, Copy and Edit sit beside the bubble's
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
  // Most messages carry no files: only those load the thumbnails' code.
  const parts = withoutPortableHandoff(
    message?.parts ?? local.send?.payload.input ?? local.staged?.input ?? [],
  );
  // The words as shown: a portable handoff's envelope stays out of the bubble.
  const text = sanitizeUserText(
    message || local.send ? inputText(parts) : (local.staged?.text ?? ""),
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
      <Eyebrow kind={messageOrigin(message)?.kind} />
      {files && (
        <Suspense fallback={<AttachmentsRoom images={files.images} />}>
          <DeferredAttachments.Component
            threadId={leasable(props.threadId)}
            attachments={message?.attachments}
            parts={message?.parts ?? local.send?.payload.input}
            local={message ? undefined : localFiles(local)}
            className={cn("max-w-[80%]", readable && "mb-1")}
          />
        </Suspense>
      )}
      {/* Touch: the actions under the bubble. A pointer: beside its foot, taking no height. */}
      <div className="flex w-full min-w-0 flex-col items-end gap-1 pointer-fine:flex-row pointer-fine:items-end pointer-fine:justify-end pointer-fine:gap-2">
        {readable && (
          <div className={cn(userBubble, "pointer-fine:order-last")}>
            <BubbleText text={text} parts={parts} ref={content} />
          </div>
        )}
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
