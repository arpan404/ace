import { MessageReferences } from "./message-references.tsx";
import { useItem } from "@ace/client-react";
import { formatClock, withoutPortableHandoff } from "@ace/ui-core";
import { Suspense } from "react";
import type { LocalAttachment } from "@/components/attachment-format.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { DeferredSendStatus } from "../composer/deferred-parts.tsx";
import {
  inputText,
  localAttachment,
  leasable,
  useLocalSendsView,
  type LocalSend,
} from "../composer/send-store.ts";

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
 * The person's message: a right-aligned bubble; its time shows on hover, keeping the column
 * quiet. The same bubble is drawn from the moment Enter is pressed (from the outbox, or held
 * while its files upload) until the daemon's item takes over under the same key, with a quiet
 * "Sending…" under it meanwhile and "Not sent" with Retry and Edit if it doesn't go. Attached
 * images show as thumbnails and files by name, never by a host path (AT-1).
 */
export function UserMessage(props: { threadId: string; itemId: string }) {
  const item = useItem(leasable(props.threadId), props.itemId);
  const local: LocalSend = useLocalSendsView(props.threadId)?.find(props.itemId) ?? nothing;
  const noticeId = local.noticeId;
  const message = item?.type === "message" ? item : undefined;
  if (!message && !local.send && !local.staged) return null;
  const text = message
    ? inputText(message.parts)
    : local.send
      ? inputText(local.send.payload.input)
      : (local.staged?.text ?? "");
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
  const saying =
    !!local.staged ||
    noticeId !== undefined ||
    local.send?.state === "saving" ||
    local.send?.state === "sent" ||
    local.send?.state === "failed";
  const time = (
    <span className="mt-[5px] pr-1 text-xs text-subtle-foreground opacity-0 transition-opacity duration-(--dur-1) group-focus-within/bubble:opacity-100 group-hover/bubble:opacity-100">
      {message ? formatClock(message.createdAt) : " "}
    </span>
  );
  return (
    <div className="group/bubble flex flex-col items-end">
      <div className="max-w-[82%] rounded-[16px_16px_4px_16px] bg-bubble px-[15px] py-2.5 text-[15px] leading-[1.55] tracking-[-0.005em] wrap-break-word whitespace-pre-wrap">
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
        {parts.length ? <MessageReferences parts={parts} /> : text}
      </div>
      {/* One line under the bubble: how its sending goes, else its time on hover. Both are
          the same height, so the row doesn't move when "Sending…" goes. */}
      {saying ? (
        <Suspense fallback={time}>
          <DeferredSendStatus.Component
            threadId={props.threadId}
            itemId={props.itemId}
            send={local.send}
            staged={local.staged}
            noticeId={noticeId}
            otherwise={time}
          />
        </Suspense>
      ) : (
        time
      )}
    </div>
  );
}
