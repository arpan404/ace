import type { Attachment } from "@ace/protocol";
import { XIcon } from "@phosphor-icons/react";
import { useRef, type KeyboardEvent } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { FileGlyph, FileName } from "./attachment-face.tsx";
import type { FileSource, ShownImage } from "./attachment-format.ts";
import { describeFile, fileMeta } from "./attachment-kind.ts";
import { useFilePreview, useLightbox } from "./attachment-open.tsx";

/** A file being added to the next message, as the composer's chip shows it. */
export interface ChipAttachment {
  key: number;
  name: string;
  /** Object URL for image previews; a draft restored after a reload has none. */
  preview?: string | undefined;
  /** The file itself, for its preview; a draft restored after a reload has none. */
  file?: File | undefined;
  mimeType?: string | undefined;
  /** The daemon's reading of the bytes, once it holds them. */
  kind?: Attachment["kind"] | undefined;
  bytes?: number | undefined;
  /** Set once the daemon holds the file. */
  sha256?: string | undefined;
  state: "uploading" | "ready" | "failed";
  /** 0..1 */
  progress: number;
  /** Why it failed, in words. */
  error?: string | undefined;
  /** Whether trying again can help (a file over the limit can't). */
  retryable?: boolean | undefined;
}

/**
 * The attachments of the message being written, as chips that wrap onto a few rows (then the
 * rows scroll). Each chip names its kind by glyph and words ("12 KB · TypeScript"); uploads draw
 * a progress ring, failures say why and offer Retry. A chip opens its preview on click or Enter,
 * and Delete or Backspace removes it, moving focus to the next chip or back to the message.
 * `threadId` lets a chip restored from a saved draft preview the copy the daemon holds.
 */
export function AttachmentChipRow(props: {
  items: readonly ChipAttachment[];
  onRemove(key: number): void;
  onRetry?: ((key: number) => void) | undefined;
  threadId?: string | undefined;
}) {
  const list = useRef<HTMLUListElement>(null);
  const images = props.items.flatMap((item): ShownImage[] => {
    const source = imageSource(item, props.threadId);
    return source && describeFile(item).kind === "image"
      ? [{ key: String(item.key), name: item.name, bytes: item.bytes, source }]
      : [];
  });
  const { show: showImage, lightbox } = useLightbox(images);
  const { show: showFile, preview } = useFilePreview();
  const open = (item: ChipAttachment, element: HTMLElement) => {
    const image = images.findIndex((shown) => shown.key === String(item.key));
    if (image >= 0) return showImage(image, element);
    showFile(
      {
        name: item.name,
        bytes: item.bytes,
        mimeType: item.mimeType,
        kind: item.kind,
        source: fileSource(item, props.threadId),
      },
      element,
    );
  };
  // Focus moves on before the chip goes, so the keyboard never lands on the page's body.
  const remove = (key: number, from: HTMLElement) => {
    const chips = [...(list.current?.querySelectorAll<HTMLElement>("[data-chip-open]") ?? [])];
    const at = chips.indexOf(from);
    const next =
      chips[at + 1] ??
      chips[at - 1] ??
      list.current?.closest('[data-slot="composer"]')?.querySelector("textarea");
    next?.focus();
    props.onRemove(key);
  };
  return (
    <>
      <ul
        ref={list}
        aria-label="Attachments"
        className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto px-3 pt-3 [scrollbar-width:none]"
      >
        {props.items.map((item) => (
          <Chip
            key={item.key}
            item={item}
            onOpen={open}
            onRemove={remove}
            onRetry={props.onRetry}
          />
        ))}
      </ul>
      {lightbox}
      {preview}
    </>
  );
}

function imageSource(item: ChipAttachment, threadId: string | undefined) {
  if (item.preview) return { kind: "url", url: item.preview } as const;
  if (item.sha256 && threadId)
    return {
      kind: "attachment",
      threadId,
      sha256: item.sha256,
      bytes: item.bytes ?? 0,
      thumbnail: true,
    } as const;
  return undefined;
}

function fileSource(item: ChipAttachment, threadId: string | undefined): FileSource | undefined {
  if (item.file) return { kind: "file", file: item.file };
  if (item.sha256 && threadId)
    return { kind: "attachment", threadId, sha256: item.sha256, bytes: item.bytes ?? 0 };
  return undefined;
}

function Chip(props: {
  item: ChipAttachment;
  onOpen(item: ChipAttachment, element: HTMLElement): void;
  onRemove(key: number, from: HTMLElement): void;
  onRetry?: ((key: number) => void) | undefined;
}) {
  const { item } = props;
  const failed = item.state === "failed";
  const uploading = item.state === "uploading";
  const reason = item.error ?? "The upload failed";
  const percent = Math.round(item.progress * 100);
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    props.onRemove(item.key, event.currentTarget);
  };
  return (
    <li
      className={cn(
        "inline-flex h-8 min-w-0 shrink-0 items-center gap-1 rounded-lg bg-secondary pr-1 pl-1 text-ui leading-4",
        failed ? "max-w-80" : "max-w-60",
      )}
      style={failed ? { boxShadow: "inset 0 0 0 1px var(--color-status-failed)" } : undefined}
    >
      <button
        type="button"
        data-chip-open
        aria-label={`Preview ${item.name}`}
        aria-keyshortcuts="Delete"
        onClick={(event) => props.onOpen(item, event.currentTarget)}
        onKeyDown={keys}
        className="focus-ring flex h-full min-w-0 items-center gap-1.5 rounded-md"
      >
        <Thumb item={item} />
        <FileName name={item.name} />
        {!failed && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {uploading ? `${percent}%` : fileMeta(item)}
          </span>
        )}
      </button>
      {uploading && (
        <span
          role="progressbar"
          aria-label={`Uploading ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="sr-only"
        />
      )}
      {failed && (
        <>
          <Tip label={reason}>
            <span
              tabIndex={0}
              className="focus-ring shrink-0 rounded-xs text-xs text-status-failed"
            >
              Couldn't upload<span className="sr-only">: {reason}</span>
            </span>
          </Tip>
          {item.retryable && props.onRetry && (
            <button
              type="button"
              aria-label={`Retry ${item.name}`}
              onClick={() => props.onRetry?.(item.key)}
              className="shrink-0 rounded-sm px-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
            >
              Retry
            </button>
          )}
        </>
      )}
      <IconButton
        icon={XIcon}
        label={`Remove ${item.name}`}
        size="sm"
        tooltip={false}
        onClick={(event) => props.onRemove(item.key, event.currentTarget)}
      />
    </li>
  );
}

/** The preview or the kind's glyph; while uploading, a ring around it fills with the progress. */
function Thumb(props: { item: ChipAttachment }) {
  const { item } = props;
  const uploading = item.state === "uploading";
  // Inside the ring the glyph shrinks so the chip keeps its height.
  const size = uploading ? "size-5" : "size-6";
  const glyph = item.preview ? (
    <img src={item.preview} alt="" className={cn(size, "shrink-0 rounded-sm object-cover")} />
  ) : (
    <FileGlyph kind={describeFile(item).kind} className={size} />
  );
  if (!uploading) return glyph;
  // r = 13 on a 28 box: circumference ≈ 81.7.
  const circumference = 2 * Math.PI * 13;
  return (
    <span
      aria-hidden
      style={{ margin: -2 }}
      className="relative grid size-7 shrink-0 place-items-center"
    >
      {glyph}
      <svg viewBox="0 0 28 28" className="absolute inset-0 -rotate-90">
        <circle
          cx="14"
          cy="14"
          r="13"
          fill="none"
          strokeWidth="2"
          className="stroke-foreground/20"
        />
        <circle
          cx="14"
          cy="14"
          r="13"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - item.progress)}
          className="stroke-foreground transition-[stroke-dashoffset] duration-(--dur-1)"
        />
      </svg>
    </span>
  );
}
