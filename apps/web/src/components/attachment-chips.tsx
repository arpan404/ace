import { FileIcon, InfoIcon, XIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/** A file being added to the next message, as the composer's chip shows it. */
export interface ChipAttachment {
  key: number;
  name: string;
  /** Object URL for image previews; a draft restored after a reload has none. */
  preview?: string | undefined;
  mimeType?: string | undefined;
  state: "uploading" | "ready" | "failed";
  /** 0..1 */
  progress: number;
  /** Why it failed, in words. */
  error?: string | undefined;
  /** Whether trying again can help (a file over the limit can't). */
  retryable?: boolean | undefined;
}

/**
 * The attachments of the message being written: one row of fixed height above the text, which
 * scrolls sideways rather than wrapping, so adding a file never moves the text's inset. Image
 * chips show their preview at once; uploads draw a progress ring, failures say why and offer
 * Retry, and `unsupported` is the provider's note for image chips it can't read.
 */
export function AttachmentChipRow(props: {
  items: readonly ChipAttachment[];
  onRemove(key: number): void;
  onRetry?: ((key: number) => void) | undefined;
  unsupported?: string | undefined;
}) {
  return (
    <ul
      aria-label="Attachments"
      className="flex scroll-fade-x gap-2 overflow-x-auto px-3 pt-3 [scrollbar-width:none]"
    >
      {props.items.map((item) => (
        <Chip
          key={item.key}
          item={item}
          onRemove={props.onRemove}
          onRetry={props.onRetry}
          unsupported={
            item.mimeType?.startsWith("image/") || item.preview ? props.unsupported : undefined
          }
        />
      ))}
    </ul>
  );
}

function Chip(props: {
  item: ChipAttachment;
  onRemove(key: number): void;
  onRetry?: ((key: number) => void) | undefined;
  unsupported?: string | undefined;
}) {
  const { item } = props;
  const failed = item.state === "failed";
  const reason = item.error ?? "The upload failed";
  return (
    <li
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-secondary pr-1 pl-1 text-ui leading-4",
        failed ? "max-w-80" : "max-w-60",
      )}
      style={failed ? { boxShadow: "inset 0 0 0 1px var(--color-status-failed)" } : undefined}
    >
      <Thumb item={item} />
      <span className="min-w-0 truncate">{item.name}</span>
      {failed && (
        <>
          <Tip label={reason}>
            <span tabIndex={0} className="shrink-0 text-xs text-status-failed">
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
      {props.unsupported && !failed && (
        <Tip label={props.unsupported}>
          <span tabIndex={0} className="grid size-5 shrink-0 place-items-center">
            <InfoIcon aria-hidden size={14} className="text-muted-foreground" />
            <span className="sr-only">{props.unsupported}</span>
          </span>
        </Tip>
      )}
      <IconButton
        icon={XIcon}
        label={`Remove ${item.name}`}
        size="sm"
        tooltip={false}
        onClick={() => props.onRemove(item.key)}
      />
    </li>
  );
}

/** The preview or file glyph; while uploading, a ring around it fills with the progress. */
function Thumb(props: { item: ChipAttachment }) {
  const { item } = props;
  const uploading = item.state === "uploading";
  // Inside the ring the glyph shrinks so the chip keeps its height.
  const size = uploading ? "size-5" : "size-6";
  const glyph = item.preview ? (
    <img src={item.preview} alt="" className={cn(size, "rounded-sm object-cover")} />
  ) : (
    <span className={cn(size, "grid place-items-center")}>
      <FileIcon aria-hidden size={14} className="text-muted-foreground" />
    </span>
  );
  if (!uploading) return glyph;
  const percent = Math.round(item.progress * 100);
  // r = 13 on a 28 box: circumference ≈ 81.7.
  const circumference = 2 * Math.PI * 13;
  return (
    <Tip label={`Uploading · ${percent}%`}>
      <span
        role="progressbar"
        aria-label={`Uploading ${item.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        tabIndex={0}
        style={{ margin: -2 }}
        className="relative grid size-7 shrink-0 place-items-center"
      >
        {glyph}
        <svg aria-hidden viewBox="0 0 28 28" className="absolute inset-0 -rotate-90">
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
    </Tip>
  );
}
