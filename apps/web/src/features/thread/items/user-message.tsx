import { useItem } from "@ace/client-react";
import { FileIcon } from "@phosphor-icons/react";
import { formatClock } from "@ace/ui-core";
import { leasable } from "../lib/pending-thread-id.ts";
import { inputText, SendStatus, useLocalSend } from "./send-status.tsx";

/**
 * The person's message: a right-aligned bubble; its time shows on hover, keeping the column
 * quiet. The same bubble is drawn from the moment Enter is pressed (from the outbox, or held
 * while its files upload) until the daemon's item takes over under the same key, with a quiet
 * "Sending…" under it meanwhile and "Not sent" with Retry and Edit if it doesn't go.
 */
export function UserMessage(props: { threadId: string; itemId: string }) {
  const item = useItem(leasable(props.threadId), props.itemId);
  const local = useLocalSend(props.threadId, props.itemId);
  const message = item?.type === "message" ? item : undefined;
  const parts = message?.parts ?? local.send?.payload.input;
  const text = message
    ? inputText(message.parts)
    : local.send
      ? inputText(local.send.payload.input)
      : (local.staged?.text ?? "");
  if (!message && !local.send && !local.staged) return null;
  const files = (parts ?? []).flatMap((part) => (part.type === "file" ? [part.path] : []));
  // Images come from the daemon; only inline data, blobs and web URLs are loaded.
  const images = (parts ?? []).flatMap((part) =>
    part.type === "image" && /^(data:image\/|blob:|https?:)/.test(part.url) ? [part] : [],
  );
  return (
    <div className="group/bubble flex flex-col items-end">
      <div className="max-w-[82%] rounded-[16px_16px_4px_16px] bg-bubble px-[15px] py-2.5 text-[15px] leading-[1.55] tracking-[-0.005em] wrap-break-word whitespace-pre-wrap">
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((image) => (
              <img
                key={image.url}
                src={image.url}
                alt="Attached image"
                className="max-h-40 rounded-md object-cover"
              />
            ))}
          </div>
        )}
        {text}
        {files.length > 0 && (
          <span className="mt-2 flex flex-wrap gap-1.5">
            {files.map((path) => (
              <span
                key={path}
                className="inline-flex items-center gap-1 rounded-sm bg-secondary px-1.5 font-mono text-xs text-muted-foreground"
              >
                <FileIcon aria-hidden size={12} />
                {path}
              </span>
            ))}
          </span>
        )}
      </div>
      {/* One line under the bubble: how its sending goes, else its time on hover. Both are
          the same height, so the row doesn't move when "Sending…" goes. */}
      <SendStatus
        threadId={props.threadId}
        itemId={props.itemId}
        send={local.send}
        staged={local.staged}
        otherwise={
          <span className="mt-[5px] pr-1 text-xs text-subtle-foreground opacity-0 transition-opacity duration-(--dur-1) group-focus-within/bubble:opacity-100 group-hover/bubble:opacity-100">
            {message ? formatClock(message.createdAt) : "\u00a0"}
          </span>
        }
      />
    </div>
  );
}
