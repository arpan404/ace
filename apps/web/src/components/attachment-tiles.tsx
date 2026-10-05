import {
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FilePdfIcon,
  FileTextIcon,
  FileVideoIcon,
  FileZipIcon,
} from "@phosphor-icons/react";
import { useState, type CSSProperties } from "react";
import { Icon } from "@/components/icon.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { ImageUrl, type ImageState } from "./attachment-bytes.tsx";
import { UnavailableTile } from "./attachment-unavailable.tsx";
import {
  fileLabel,
  tileSize,
  visibleImages,
  type Shown,
  type ShownFile,
  type ShownImage,
} from "./attachment-format.ts";

/*
 * A message's attachments: image thumbnails (one up to 320×240, two to four in a 2-column grid of
 * 160×120, more as three and a "+N" tile) and file chips with the name and size.
 */

export function AttachmentTiles(props: Shown & { className?: string | undefined }) {
  const { images, files } = props;
  const { shown, more } = visibleImages(images.length);
  return (
    <div className={cn("flex flex-col items-end gap-1.5", props.className)}>
      {images.length > 0 && (
        <ul
          aria-label={images.length === 1 ? "Image" : `${images.length} images`}
          className={cn("grid w-fit gap-1.5", images.length > 1 && "grid-cols-2")}
        >
          {images.slice(0, shown).map((image) => (
            <li key={image.key}>
              <ImageTile
                image={image}
                size={tileSize(image, images.length)}
                fit={images.length === 1 && !image.width ? "contain" : "cover"}
              />
            </li>
          ))}
          {more > 0 && (
            <li>
              <span
                role="img"
                aria-label={`${more} more images`}
                style={{ width: 160, height: 120 }}
                className="grid place-items-center rounded-[10px] bg-secondary text-lg font-medium text-muted-foreground"
              >
                <span aria-hidden>+{more}</span>
              </span>
            </li>
          )}
        </ul>
      )}
      {files.length > 0 && (
        <ul aria-label="Attached files" className="flex max-w-full flex-wrap justify-end gap-1.5">
          {files.map((file) => (
            <li key={file.key} className="max-w-full min-w-0">
              <FileChip file={file} />
            </li>
          ))}
        </ul>
      )}
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
    <span style={style} className="relative block overflow-hidden rounded-[10px] bg-secondary">
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
    </span>
  );
}

function fileIcon(file: ShownFile) {
  const mime = file.mimeType ?? "",
    extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return FileImageIcon;
  if (mime.startsWith("audio/")) return FileAudioIcon;
  if (mime.startsWith("video/")) return FileVideoIcon;
  if (mime === "application/pdf" || extension === "pdf") return FilePdfIcon;
  if (/zip|tar|gzip|compressed/.test(mime) || ["zip", "tar", "gz", "tgz"].includes(extension))
    return FileZipIcon;
  if (/json|javascript|typescript|xml|x-sh/.test(mime)) return FileCodeIcon;
  if (mime.startsWith("text/")) return FileTextIcon;
  return FileIcon;
}

/** "report.pdf · 1.2 MB" with an icon by type; the full name in the tooltip. */
export function FileChip(props: { file: ShownFile }) {
  const label = fileLabel(props.file);
  return (
    <Tip label={props.file.name}>
      <span
        tabIndex={0}
        className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-secondary px-2 text-xs text-muted-foreground"
      >
        <Icon icon={fileIcon(props.file)} size={14} className="text-subtle-foreground" />
        <span className="min-w-0 truncate">{label}</span>
      </span>
    </Tip>
  );
}
