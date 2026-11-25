import type { SpadeDocumentRef, SpadeImageRef } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { DocumentCard, DocumentList } from "./spade-attachment-document.tsx";
import { ImageLightbox, ImageTile } from "./spade-attachment-image.tsx";

/** At most four cells show; the last stands for the rest as "+N". */
const gridCells = 4;

/**
 * A message's pictures: one inline up to about 320px, several as a grid (2-up, or 3-up for
 * three), with "+N" on the last cell past four. Each opens in a lightbox that steps through
 * them all.
 */
function Pictures(props: {
  images: readonly SpadeImageRef[];
  side: "person" | "bot";
  inside: boolean;
}) {
  const [open, setOpen] = useState<number>();
  const { images } = props;
  const shown = images.slice(0, gridCells);
  const extra = images.length - shown.length;
  return (
    <div
      className={cn(
        "flex min-w-0",
        props.inside ? "w-full" : "w-full",
        props.side === "person" && !props.inside && "justify-end",
      )}
    >
      {images.length === 1 ? (
        images[0] && <ImageTile image={images[0]} index={0} onOpen={setOpen} />
      ) : (
        <div
          role="group"
          aria-label={`${images.length} images`}
          className={cn(
            "grid w-full max-w-80 gap-0.5 overflow-hidden rounded-2xl",
            shown.length === 3 ? "grid-cols-3" : "grid-cols-2",
          )}
        >
          {/* The same image twice in one message is one picture shown twice: keyed by place. */}
          {shown.map((image, place) => (
            <ImageTile
              key={`${place}:${image.sha256}`}
              image={image}
              index={place}
              fill
              {...(extra > 0 && place === shown.length - 1 ? { more: extra } : {})}
              onOpen={setOpen}
            />
          ))}
        </div>
      )}
      {open !== undefined && (
        <ImageLightbox
          images={images}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(undefined)}
        />
      )}
    </div>
  );
}

/** What a message carries besides words, iMessage style: pictures, then documents. */
export function Attachments(props: {
  images: readonly SpadeImageRef[];
  documents: readonly SpadeDocumentRef[];
  side: "person" | "bot";
  /** Inside the message's own bubble, above its caption, instead of bubbles of their own. */
  inside?: boolean;
}) {
  const { images, documents, side } = props;
  const inside = props.inside ?? false;
  const [first] = documents;
  return (
    <>
      {images.length > 0 && <Pictures images={images} side={side} inside={inside} />}
      {documents.length === 1 && first && (
        <DocumentCard document={first} side={side} inside={inside} />
      )}
      {documents.length > 1 && <DocumentList documents={documents} side={side} inside={inside} />}
    </>
  );
}
