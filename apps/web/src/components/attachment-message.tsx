import type { Attachment, ContentPart } from "@ace/protocol";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { cn } from "@/lib/cn.ts";
import {
  collectAttachments,
  tileSize,
  visibleImages,
  type LocalAttachment,
  type Shown,
} from "./attachment-format.ts";

/*
 * The attachments of one message, as thumbnails and file chips. Only this shell is in the
 * thread's first chunk; the tiles load on demand (warm them with `preloadAttachments`), and
 * until then placeholders hold their exact size so the transcript doesn't move.
 */

const Tiles = deferredComponent(() =>
  import("./attachment-tiles.tsx").then((module) => module.AttachmentTiles),
);

const Unavailable = deferredComponent(() =>
  import("./attachment-unavailable.tsx").then((module) => module.UnavailableTile),
);

/** Warm the thumbnails' code while the browser is idle. */
export function preloadAttachments(): Promise<unknown> {
  return Promise.all([Tiles.preload(), Unavailable.preload()]);
}

/** The neutral tile for an image this device can't show, with its name. */
export function UnavailableImage(props: { name: string }) {
  return (
    <Suspense
      fallback={<Skeleton className="rounded-[10px]" style={{ width: 240, height: 120 }} />}
    >
      <Unavailable.Component name={props.name} />
    </Suspense>
  );
}

export type { LocalAttachment };

/**
 * Thumbnails and file chips for a message: the daemon's `attachments` (resolved through the
 * thread's connection), legacy `image`/`file` content parts, and `local` files of a send the
 * daemon doesn't have yet. Host paths are never shown.
 */
export function MessageAttachments(props: {
  threadId?: string | undefined;
  attachments?: readonly Attachment[] | undefined;
  parts?: readonly ContentPart[] | undefined;
  local?: readonly LocalAttachment[] | undefined;
  className?: string | undefined;
}) {
  const shown = collectAttachments(props);
  if (!shown.images.length && !shown.files.length) return null;
  return (
    <Suspense fallback={<Placeholder {...shown} className={props.className} />}>
      <Tiles.Component {...shown} className={props.className} />
    </Suspense>
  );
}

function Placeholder(props: Shown & { className?: string | undefined }) {
  const { shown, more } = visibleImages(props.images.length);
  return (
    <div aria-hidden className={cn("flex flex-col items-end gap-1.5", props.className)}>
      {props.images.length > 0 && (
        <span className={cn("grid w-fit gap-1.5", props.images.length > 1 && "grid-cols-2")}>
          {props.images.slice(0, shown + (more ? 1 : 0)).map((image) => (
            <Skeleton
              key={image.key}
              className="rounded-[10px]"
              style={tileSize(image, props.images.length)}
            />
          ))}
        </span>
      )}
      {props.files.length > 0 && <Skeleton className="h-10 w-40 rounded-lg" />}
    </div>
  );
}
