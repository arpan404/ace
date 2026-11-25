import { DownloadSimpleIcon, XIcon } from "@ace/icons";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { SpadeImageRef } from "@ace/ui-core/spade-chat";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { holdSpadePicture } from "./spade-images.ts";
import { useSpadeClient } from "./spade-machine.tsx";

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const imageName = (image: SpadeImageRef) =>
  `image-${image.sha256.slice(0, 8)}.${extensions[image.mediaType] ?? "png"}`;

/** A stored picture's object URL, read once and kept by hash while shown. */
function usePicture(hash: string) {
  const client = useSpadeClient();
  const [state, setState] = useState<{ hash: string; url?: string; failed?: true }>();
  useEffect(() => {
    let live = true;
    const picture = holdSpadePicture(client, hash);
    picture.url.then(
      (url) => live && setState({ hash, url }),
      () => live && setState({ hash, failed: true }),
    );
    return () => {
      live = false;
      picture.release();
    };
  }, [client, hash]);
  return state?.hash === hash ? state : undefined;
}

/** One picture, rounded, up to about 320px; it opens in the lightbox. `fill` crops it to its cell. */
export function ImageTile(props: {
  image: SpadeImageRef;
  index: number;
  fill?: boolean;
  more?: number;
  onOpen(index: number): void;
}) {
  const state = usePicture(props.image.sha256);
  const frame = props.fill ? "aspect-square w-full" : "";
  if (!state?.url) {
    return (
      <span
        role={state?.failed ? "img" : undefined}
        aria-label={state?.failed ? "An image that couldn't be loaded" : undefined}
        aria-busy={state ? undefined : true}
        className={cn(
          "grid place-items-center rounded-2xl bg-bubble text-xs text-muted-foreground",
          props.fill ? frame : "h-24 w-32",
        )}
      >
        {state?.failed ? "Image" : null}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={props.more ? `Open image, and ${props.more} more` : "Open image"}
      onClick={() => props.onOpen(props.index)}
      className={cn(
        "relative block overflow-hidden rounded-2xl focus-ring",
        props.fill ? frame : "max-w-full",
      )}
    >
      <img
        src={state.url}
        alt=""
        className={cn(
          "block rounded-2xl",
          props.fill ? "size-full object-cover" : "max-h-80 w-auto max-w-80 object-cover",
        )}
      />
      {props.more ? (
        <span className="absolute inset-0 grid place-items-center bg-black/45 text-lg font-semibold text-white">
          +{props.more}
        </span>
      ) : null}
    </button>
  );
}

/** The pictures of one message, one at a time over the page: ←/→ step, Esc closes, Download saves. */
export function ImageLightbox(props: {
  images: readonly SpadeImageRef[];
  index: number;
  onIndex(index: number): void;
  onClose(): void;
}) {
  const count = props.images.length;
  const image = props.images[props.index];
  const state = usePicture(image?.sha256 ?? "");
  if (!image) return null;
  const step = (by: number) => props.onIndex((props.index + by + count) % count);
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="ace-backdrop fixed inset-0 z-[100]"
          style={{ background: "color-mix(in oklab, var(--background) 94%, transparent)" }}
        />
        <DialogPrimitive.Popup
          onKeyDown={(event) => {
            if (count < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
            event.preventDefault();
            step(event.key === "ArrowLeft" ? -1 : 1);
          }}
          className="fixed inset-0 z-[101] flex flex-col text-foreground outline-none"
        >
          <header className="flex items-center gap-2 px-4 py-3">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-ui font-medium">
              {imageName(image)}
              {count > 1 ? ` · ${props.index + 1} of ${count}` : ""}
            </DialogPrimitive.Title>
            {state?.url && (
              <a
                href={state.url}
                download={imageName(image)}
                aria-label="Download image"
                className="grid size-[30px] place-items-center rounded-md text-muted-foreground focus-ring hover:bg-accent hover:text-foreground"
              >
                <Icon icon={DownloadSimpleIcon} size={16} />
              </a>
            )}
            <DialogPrimitive.Close
              render={<IconButton icon={XIcon} label="Close" tip="Close" size="default" />}
            />
          </header>
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            {state?.url && (
              <img
                src={state.url}
                alt=""
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
