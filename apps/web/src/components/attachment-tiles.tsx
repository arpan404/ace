import type { Attachment } from "@ace/protocol";
import { useState, type CSSProperties } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { ImageUrl, type ImageState } from "./attachment-bytes.tsx";
import { FileGlyph, FileName } from "./attachment-face.tsx";
import { UnavailableTile } from "./attachment-unavailable.tsx";
import {
  tileSize,
  visibleImages,
  type Shown,
  type ShownFile,
  type ShownImage,
} from "./attachment-format.ts";
import { deliveryDetails, deliveryLabels, describeFile, fileMeta } from "./attachment-kind.ts";
import { useFilePreview, useLightbox } from "./attachment-open.tsx";

/*
 * A message's attachments: image thumbnails (one up to 320×240, two to four in a 2-column grid of
 * 160×120, more as three and a "+N" tile) and file chips by kind with the name, size and how the
 * agent received the file. A thumbnail opens the lightbox, a file chip its preview; their code
 * loads only then.
 */

export function AttachmentTiles(props: Shown & { className?: string | undefined }) {
  const { images, files } = props;
  const { shown, more } = visibleImages(images.length);
  const { show, lightbox } = useLightbox(images);
  const { show: showFile, preview } = useFilePreview();
  // Images sent as paths say so: the agent read files, not pictures.
  const imageDelivery = images.some((image) => image.delivery === "file_path")
    ? "file_path"
    : images.find((image) => image.delivery)?.delivery;
  return (
    <div className={cn("flex flex-col items-end gap-1.5", props.className)}>
      {imageDelivery && (
        <Tip label={deliveryDetails[imageDelivery]}>
          <span tabIndex={0} className="focus-ring rounded-xs text-xs text-muted-foreground">
            {imageDelivery === "file_path" ? "Images sent as files" : "Native images"}
          </span>
        </Tip>
      )}
      {images.length > 0 && (
        <ul
          aria-label={images.length === 1 ? "Image" : `${images.length} images`}
          className={cn("grid w-fit gap-1.5", images.length > 1 && "grid-cols-2")}
        >
          {images.slice(0, shown).map((image, index) => (
            <li key={image.key}>
              <ImageTile
                image={image}
                size={tileSize(image, images.length)}
                fit={images.length === 1 && !image.width ? "contain" : "cover"}
                onOpen={(element) => show(index, element)}
              />
            </li>
          ))}
          {more > 0 && (
            <li>
              <button
                type="button"
                aria-label={`Show ${more} more images`}
                onClick={(event) => show(shown, event.currentTarget)}
                style={{ width: 160, height: 120 }}
                className="grid place-items-center rounded-[10px] bg-secondary text-lg font-medium text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground"
              >
                <span aria-hidden>+{more}</span>
              </button>
            </li>
          )}
        </ul>
      )}
      {files.length > 0 && (
        <ul aria-label="Attached files" className="flex max-w-full flex-wrap justify-end gap-1.5">
          {files.map((file) => (
            <li key={file.key} className="max-w-full min-w-0">
              <FileChip file={file} onOpen={showFile} />
            </li>
          ))}
        </ul>
      )}
      {lightbox}
      {preview}
    </div>
  );
}

/** One thumbnail: a skeleton at its final size until the bytes arrive, never a broken image. */
export function ImageTile(props: TileProps) {
  return (
    <ImageUrl source={props.image.source}>{(image) => <Tile {...props} url={image} />}</ImageUrl>
  );
}

interface TileProps {
  image: ShownImage;
  size: { width: number; height: number };
  /** `contain` letterboxes an image whose shape isn't known instead of cropping it. */
  fit?: "cover" | "contain" | undefined;
  onOpen(element: HTMLElement): void;
}

function Tile(props: TileProps & { url: ImageState }) {
  const image = props.url;
  const [painted, setPainted] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const style: CSSProperties = { width: props.size.width, height: props.size.height };
  if (image.state === "unavailable" || (image.state === "ready" && failed === image.url))
    return <UnavailableTile name={props.image.name} style={style} />;
  const ready = image.state === "ready" && painted === image.url;
  return (
    <button
      type="button"
      onClick={(event) => props.onOpen(event.currentTarget)}
      style={style}
      className="relative block overflow-hidden rounded-[10px] bg-secondary"
    >
      {!ready && <Skeleton className="absolute inset-0 h-auto rounded-[10px]" />}
      {image.state === "ready" && (
        <img
          src={image.url}
          alt={props.image.name}
          // Letterboxed, and never scaled past its own size.
          style={props.fit === "contain" ? { objectFit: "scale-down" } : undefined}
          draggable={false}
          onLoad={() => setPainted(image.url)}
          onError={() => setFailed(image.url)}
          className={cn(
            "size-full transition-opacity duration-(--dur-1)",
            props.fit !== "contain" && "object-cover",
            !ready && "opacity-0",
          )}
        />
      )}
    </button>
  );
}

/**
 * A sent file: its kind's glyph, the name, and under it the size, type and how the agent got
 * it ("native PDF", "inline text, truncated"), which the tooltip explains. A file this device
 * can read opens its preview; one an agent only named by path is a quiet label.
 */
export function FileChip(props: {
  file: ShownFile;
  onOpen?: ((file: ShownFile, element: HTMLElement) => void) | undefined;
}) {
  const { file } = props;
  const kind = describeFile(file).kind;
  const meta = fileMeta(file) + (file.delivery ? ` · ${deliveryLabels[file.delivery]}` : "");
  const tip = file.delivery ? deliveryDetails[file.delivery] : file.name;
  const face = (
    <>
      <FileGlyph kind={kind} />
      <span className="flex min-w-0 flex-col items-start">
        <span className="flex max-w-full min-w-0 text-ui text-foreground">
          <FileName name={file.name} />
        </span>
        <span className="max-w-full truncate text-xs text-muted-foreground">{meta}</span>
      </span>
    </>
  );
  const chip =
    "flex max-w-full min-w-0 items-center gap-1.5 rounded-lg bg-secondary py-1 pr-2.5 pl-1.5 text-left leading-4";
  const onOpen = props.onOpen;
  return (
    <Tip label={tip}>
      {file.source && onOpen ? (
        <button
          type="button"
          aria-label={`${file.name}, ${meta}`}
          onClick={(event) => onOpen(file, event.currentTarget)}
          className={cn(chip, "focus-ring transition-colors duration-(--dur-1) hover:bg-accent")}
        >
          {face}
        </button>
      ) : (
        <span tabIndex={0} aria-label={`${file.name}, ${meta}`} className={cn(chip, "focus-ring")}>
          {face}
        </span>
      )}
    </Tip>
  );
}

/** An inline image of agent prose: a thumbnail that opens the lightbox. */
export function InlineImage(props: { src: string; alt: string }) {
  const images: ShownImage[] = [
    {
      key: props.src,
      name: props.alt || "Image",
      source: { kind: "url", url: props.src },
    },
  ];
  const { show, lightbox } = useLightbox(images);
  const [image] = images;
  if (!image) return null;
  return (
    <span className="my-1 inline-block align-middle">
      <ImageTile
        image={image}
        size={tileSize(image, 1)}
        fit="contain"
        onOpen={(element) => show(0, element)}
      />
      {lightbox}
    </span>
  );
}

/** A captured local image remains phrasing content inside markdown paragraphs. */
export function CapturedInlineImage(props: {
  threadId: string;
  attachment: Attachment;
  alt?: string | undefined;
}) {
  const image: ShownImage = {
    key: props.attachment.sha256,
    name: props.alt || props.attachment.name,
    width: props.attachment.width,
    height: props.attachment.height,
    source: {
      kind: "attachment",
      threadId: props.threadId,
      sha256: props.attachment.sha256,
      bytes: props.attachment.bytes,
      thumbnail: props.attachment.thumbnailAvailable === true,
    },
  };
  const { show, lightbox } = useLightbox([image]);
  return (
    <span className="my-1 inline-block align-middle">
      <ImageTile
        image={image}
        size={tileSize(image, 1)}
        fit="contain"
        onOpen={(element) => show(0, element)}
      />
      {lightbox}
    </span>
  );
}
