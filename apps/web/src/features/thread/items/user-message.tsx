import { useItem } from "@ace/client-react";
import { FileIcon } from "@phosphor-icons/react";
import { formatClock } from "@ace/ui-core";

/** The person's message: a right-aligned bubble; its time shows on hover, keeping the column quiet. */
export function UserMessage(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  if (item?.type !== "message") return null;
  const text = item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const files = item.parts.flatMap((part) => (part.type === "file" ? [part.path] : []));
  // Images come from the daemon; only inline data, blobs and web URLs are loaded.
  const images = item.parts.flatMap((part) =>
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
      <span className="mt-[5px] pr-1 text-xs text-subtle-foreground opacity-0 transition-opacity duration-(--dur-1) group-focus-within/bubble:opacity-100 group-hover/bubble:opacity-100">
        {formatClock(item.createdAt)}
      </span>
    </div>
  );
}
