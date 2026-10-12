import { useState, type KeyboardEvent } from "react";
import { XIcon } from "@phosphor-icons/react";
import { VisibleImageUrl } from "./visible-image-url.tsx";
import type { ImageSource } from "./attachment-format.ts";
import type { ChipAttachment } from "./attachment-chips.tsx";
import { FileGlyph, FileName } from "./attachment-face.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { fileMeta } from "./attachment-kind.ts";

/** A draft image keeps a useful preview size through uploading, failure and reload. */
export function AttachmentChipImage(props: {
  item: ChipAttachment;
  source: ImageSource | undefined;
  onOpen(item: ChipAttachment, element: HTMLElement): void;
  onRemove(key: number, from: HTMLElement): void;
  onRetry?: ((key: number) => void) | undefined;
}) {
  const { item } = props;
  const [failedUrl, setFailedUrl] = useState<string>();
  const failed = item.state === "failed";
  const uploading = item.state === "uploading";
  const percent = Math.round(item.progress * 100);
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    props.onRemove(item.key, event.currentTarget);
  };
  return (
    <li className="relative w-28 shrink-0 rounded-lg border border-sidebar-border bg-background/50 p-1">
      <button
        type="button"
        data-chip-open
        aria-label={`Preview ${item.name}`}
        aria-keyshortcuts="Delete Backspace"
        onClick={(event) => props.onOpen(item, event.currentTarget)}
        onKeyDown={keys}
        className="focus-ring block w-full min-w-0 rounded-md text-left"
      >
        <VisibleImageUrl
          source={props.source}
          className="relative grid h-20 w-full place-items-center overflow-hidden rounded-md bg-secondary"
        >
          {(image) => (
            <>
              {image.state === "loading" ? (
                <Skeleton className="absolute inset-0 size-full" />
              ) : image.state === "ready" && image.url !== failedUrl ? (
                <img
                  src={image.url}
                  alt={item.name}
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  onError={() => setFailedUrl(image.url)}
                  className="size-full object-cover"
                />
              ) : (
                <span className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
                  <FileGlyph kind="image" />
                  Preview unavailable
                </span>
              )}
              {uploading && (
                <span
                  role="progressbar"
                  aria-label={`Uploading ${item.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  className="absolute inset-x-0 bottom-0 h-1 bg-foreground/20"
                >
                  <span
                    style={{ width: `${percent}%` }}
                    className="block h-full bg-tint transition-[width] duration-(--dur-1)"
                  />
                </span>
              )}
            </>
          )}
        </VisibleImageUrl>
        <span className="mt-1 block px-0.5 text-xs text-foreground">
          <FileName name={item.name} />
        </span>
        {!failed && (
          <span className="block px-0.5 text-xs text-muted-foreground">
            {uploading ? `Uploading ${percent}%` : fileMeta(item)}
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label={`Remove ${item.name}`}
        onClick={(event) => props.onRemove(item.key, event.currentTarget)}
        className="focus-ring absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full border border-sidebar-border bg-background text-foreground hover:bg-accent"
      >
        <XIcon aria-hidden size={12} />
      </button>
      {failed && (
        <p role="status" className="px-0.5 text-xs text-status-failed">
          Couldn't upload: {item.error ?? "The upload failed"}
        </p>
      )}
      {failed && item.retryable && props.onRetry && (
        <button
          type="button"
          aria-label={`Retry ${item.name}`}
          onClick={() => props.onRetry?.(item.key)}
          className="focus-ring rounded-sm px-0.5 text-xs font-medium underline"
        >
          Retry
        </button>
      )}
    </li>
  );
}
