import type { Attachment } from "@ace/protocol";
import { useState, type CSSProperties } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { ImageUrl, type ImageState } from "./attachment-bytes.tsx";
import { FileChips } from "./attachment-file-chips.tsx";
import { ImageGroup } from "./attachment-image-group.tsx";
import { UnavailableTile } from "./attachment-unavailable.tsx";
import { imageLayout, tileSize, type Shown, type ShownImage } from "./attachment-format.ts";
import { deliveryDetails } from "./attachment-kind.ts";
import { useFilePreview, useLightbox } from "./attachment-open.tsx";

export { FileChip } from "./attachment-file-chips.tsx";

/*
 * A message's attachments, above its bubble and unframed: the images as one rounded group (see
 * `imageLayout`) and the files as compact chips. A thumbnail opens the lightbox, which pages
 * through every image of the message; a file chip opens its preview. Their code loads only then.
 */

export function AttachmentTiles(props: Shown & { className?: string | undefined }) {
  const { images, files } = props;
  const { show, lightbox } = useLightbox(images);
  const { show: showFile, preview } = useFilePreview();
  const layout = imageLayout(images);
  return (
    <div className={cn("flex flex-col items-end gap-1", props.className)}>
      {images.length > 0 && (
        <ImageGroup
          layout={layout}
          label={images.length === 1 ? "Image" : `${images.length} images`}
          renderCell={(cell) => (
            <ImageTile
              image={cell.image}
              size={cell}
              className="rounded-sm"
              fit={layout.kind === "single" && !cell.image.width ? "contain" : "cover"}
              more={cell.more}
              onOpen={(element) => show(cell.index, element)}
            />
          )}
        />
      )}
      {files.length > 0 && <FileChips files={files} onOpen={showFile} />}
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
  /** The tile stands for this many images: dimmed under "+N", it opens the rest. */
  more?: number | undefined;
  className?: string | undefined;
  onOpen(element: HTMLElement): void;
}

function Tile(props: TileProps & { url: ImageState }) {
  const image = props.url;
  const [painted, setPainted] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const corner = props.className ?? "rounded-md";
  // Clamp to the bubble's content box on narrow columns; `object-cover` crops the excess.
  const style: CSSProperties = {
    width: props.size.width,
    height: props.size.height,
    maxWidth: "100%",
  };
  if (image.state === "unavailable" || (image.state === "ready" && failed === image.url))
    return <UnavailableTile name={props.image.name} style={style} />;
  const ready = image.state === "ready" && painted === image.url;
  const button = (
    <button
      type="button"
      aria-label={props.more ? `Show ${props.more} more images` : undefined}
      onClick={(event) => props.onOpen(event.currentTarget)}
      style={style}
      className={cn("focus-ring relative block overflow-hidden bg-secondary", corner)}
    >
      {!ready && <Skeleton className={cn("absolute inset-0 h-auto", corner)} />}
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
            "size-full transition-opacity duration-(--motion-fast)",
            props.fit !== "contain" && "object-cover",
            !ready && "opacity-0",
          )}
        />
      )}
      {props.more !== undefined && (
        <span
          aria-hidden
          className="absolute inset-0 grid place-items-center bg-background/60 text-lg font-medium text-foreground tabular-nums"
        >
          +{props.more}
        </span>
      )}
    </button>
  );
  const delivery = props.image.delivery;
  return delivery ? <Tip label={deliveryDetails[delivery]}>{button}</Tip> : button;
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
        size={tileSize(image)}
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
        size={tileSize(image)}
        fit="contain"
        onOpen={(element) => show(0, element)}
      />
      {lightbox}
    </span>
  );
}
