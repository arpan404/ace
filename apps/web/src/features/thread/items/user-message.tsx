import { BubbleText } from "./bubble-text.tsx";
import { messageActions } from "./message-actions.ts";
import { userBubble } from "./user-bubble.ts";
import type { PendingSend } from "@ace/client";
import { useItem, usePendingSends } from "@ace/client-react";
import type { ContentPart } from "@ace/protocol";
import { bubbleContent, formatClock, messageOrigin } from "@ace/ui-core";
import { AnnotationsCard } from "@/features/annotations/index.ts";
import { ArrowBendDownRightIcon, CheckIcon, ClockIcon, CopyIcon } from "@phosphor-icons/react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { Suspense, useRef } from "react";
import { imageGroupHeight, type LocalAttachment } from "@/components/attachment-format.ts";
import { cn } from "@/lib/cn.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { DeferredSendStatus } from "../composer/deferred-parts.tsx";
import { localAttachment, leasable } from "../composer/send-store.ts";

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
function localFiles(send: PendingSend): readonly LocalAttachment[] | undefined {
  const sent = send.payload.context?.attachments;
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

/** What a bubble shows of a message's parts: its words, its files, its annotations. */
function bubbleOf(input: readonly ContentPart[], attached: readonly { mimeType: string }[]) {
  const { parts, text, readable, annotations } = bubbleContent(input);
  const images: { width?: number | undefined; height?: number | undefined }[] = [
    ...attached.filter((file) => file.mimeType.startsWith("image/")),
    ...parts.flatMap((part) => (part.type === "image" ? [{}] : [])),
  ];
  // Most messages carry no files: only those load the thumbnails' code.
  const files =
    attached.length || parts.some((part) => part.type === "file" || part.type === "image")
      ? { images }
      : undefined;
  return { parts, text, files, readable, annotations };
}

/**
 * The person's message, as the daemon holds it: its attachments above, unframed, then a
 * right-aligned bubble of its words (none for a message of attachments only), with a quiet
 * eyebrow when it was steered or queued. Its time and Copy sit under the bubble, revealed on
 * hover or focus (always on touch). Only the daemon's item is drawn: a message still on its way
 * (or one that didn't go) is in the composer's strip, never here. Attached images show as
 * thumbnails and files by name, never by a host path (AT-1).
 */
export function UserMessage(props: { threadId: string; itemId: string }) {
  const content = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();
  const item = useItem(leasable(props.threadId), props.itemId);
  const message = item?.type === "message" ? item : undefined;
  if (!message) return null;
  const { parts, text, files, readable, annotations } = bubbleOf(
    message.parts,
    message.attachments ?? [],
  );
  if (!readable && !files) return null;
  return (
    <div className="group/bubble flex flex-col items-end">
      <Eyebrow kind={messageOrigin(message)?.kind} />
      {files && (
        <Suspense fallback={<AttachmentsRoom images={files.images} />}>
          <DeferredAttachments.Component
            threadId={leasable(props.threadId)}
            attachments={message.attachments}
            parts={message.parts}
            className={cn("max-w-[80%]", readable && "mb-1")}
          />
        </Suspense>
      )}
      {/* The actions sit under the bubble, right-aligned with it. */}
      <div className="flex w-full min-w-0 flex-col items-end gap-1">
        {readable && (
          <div className={userBubble}>
            <BubbleText text={text} parts={parts} ref={content} />
          </div>
        )}
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
          {copied && (
            <span role="status" className="text-xs text-muted-foreground">
              Copied
            </span>
          )}
        </div>
      </div>
      {annotations && (
        <div className="mt-1 max-w-[80%]">
          <AnnotationsCard annotations={annotations} />
        </div>
      )}
    </div>
  );
}

/**
 * A new thread's first message while the daemon is still making the thread (there is no
 * transcript yet): the bubble from this window's outbox, with how its sending goes under it,
 * and "Not sent" with Retry and Edit if the start was refused. The thread's own transcript
 * takes over with the daemon's item once the thread exists.
 */
export function StartingMessage(props: { threadId: string; commandId: string }) {
  const send = usePendingSends(props.threadId).find((entry) => entry.commandId === props.commandId);
  if (!send) return null;
  const local = localFiles(send);
  const { parts, text, files, readable, annotations } = bubbleOf(send.payload.input, local ?? []);
  if (!readable && !files) return null;
  return (
    <div className="flex flex-col items-end">
      {files && (
        <Suspense fallback={<AttachmentsRoom images={files.images} />}>
          <DeferredAttachments.Component
            threadId={undefined}
            attachments={undefined}
            parts={send.payload.input}
            local={local}
            className={cn("max-w-[80%]", readable && "mb-1")}
          />
        </Suspense>
      )}
      {readable && (
        <div className={userBubble}>
          <BubbleText text={text} parts={parts} />
        </div>
      )}
      {annotations && (
        <div className="mt-1 max-w-[80%]">
          <AnnotationsCard annotations={annotations} />
        </div>
      )}
      {send.state !== "delivered" && (
        <div className="mt-1 flex min-h-6 items-center gap-2">
          <Suspense fallback={null}>
            <DeferredSendStatus.Component
              threadId={props.threadId}
              send={send}
              staged={undefined}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
