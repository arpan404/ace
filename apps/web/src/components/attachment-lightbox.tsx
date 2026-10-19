import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CopyIcon,
  DownloadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { buttonVariants, Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { copyImageToClipboard } from "@/lib/clipboard-image.ts";
import { ImageUrl, type ImageState } from "./attachment-bytes.tsx";
import { formatBytes, type ShownImage } from "./attachment-format.ts";

/** The page, nearly hidden: the image is what matters here, in either theme. Blur comes
 * from the shared `.ace-backdrop` (glass.css): under Translucent it blurs the page by the
 * `--backdrop-blur` token, under Solid and reduced transparency it darkens only. */
const backdrop = { background: "color-mix(in oklab, var(--background) 94%, transparent)" };

/*
 * A message's images, one at a time over the page: fitted to the viewport, with the name, size,
 * Download and Copy image. ←/→ step through the images, Esc closes and focus returns to the
 * thumbnail that opened it. Wheel, pinch or double-click zooms up to the image's own size.
 */
export function Lightbox(props: {
  images: readonly ShownImage[];
  index: number;
  onIndex(index: number): void;
  onClose(): void;
  finalFocus: RefObject<HTMLElement | null>;
}) {
  const count = props.images.length;
  const index = Math.min(Math.max(props.index, 0), count - 1);
  const image = props.images[index];
  const step = (by: number) => props.onIndex((index + by + count) % count);
  // Focus starts on the popup itself, so no button's tooltip opens over the image.
  const popup = useRef<HTMLDivElement>(null);
  if (!image) return null;
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="ace-backdrop fixed inset-0 z-[100]" style={backdrop} />
        <DialogPrimitive.Popup
          ref={popup}
          tabIndex={-1}
          initialFocus={popup}
          finalFocus={props.finalFocus}
          onKeyDown={(event) => {
            if (count < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
            event.preventDefault();
            step(event.key === "ArrowLeft" ? -1 : 1);
          }}
          className="fixed inset-0 z-[101] flex flex-col text-foreground outline-none"
        >
          <PopupFocus />
          <header className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-ui font-medium">
                {image.name}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-xs text-muted-foreground">
                {[
                  image.bytes === undefined ? undefined : formatBytes(image.bytes),
                  count > 1 ? `${index + 1} of ${count}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </DialogPrimitive.Description>
            </div>
            <ImageUrl key={image.key} source={image.source} full>
              {(full) => <Actions image={image} full={full} />}
            </ImageUrl>
            <DialogPrimitive.Close render={<IconButton icon={XIcon} label="Close" />} />
          </header>
          <div className="relative flex min-h-0 flex-1 items-center gap-2 px-2 pb-4">
            {count > 1 && (
              <IconButton icon={ArrowLeftIcon} label="Previous image" onClick={() => step(-1)} />
            )}
            <ImageUrl key={image.key} source={image.source} full>
              {(full) => (
                <ImageUrl source={image.source}>
                  {(preview) => (
                    <Stage image={image} shown={full.state === "ready" ? full : preview} />
                  )}
                </ImageUrl>
              )}
            </ImageUrl>
            {count > 1 && (
              <IconButton icon={ArrowRightIcon} label="Next image" onClick={() => step(1)} />
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/*
 * Focuses the popup in a layout effect, so focus is inside the dialog before Base UI hides
 * the page behind it. Base UI's FloatingFocusManager applies aria-hidden to everything
 * outside in a passive effect but moves `initialFocus` on a later frame; without this the
 * thumbnail still holds focus while its ancestor takes aria-hidden and Chromium blocks it
 * ("Blocked aria-hidden on an element because its descendant retained focus"). This sits
 * inside the popup because Base UI mounts its portal a commit after the lightbox does, so a
 * layout effect on the lightbox itself runs while the popup ref is still null. Once focus is
 * inside the popup this never touches it again, so stepping and the header buttons keep it.
 */
function PopupFocus() {
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    // The popup is the closest dialog ancestor of this marker; the forwarded popup ref
    // can't be used here because Base UI attaches it after this effect runs.
    const node = marker.current?.closest<HTMLElement>('[role="dialog"]');
    if (!node || node.hidden || !node.isConnected) return;
    const active = node.ownerDocument.activeElement;
    if (active && node.contains(active)) return;
    node.focus({ preventScroll: true });
  });
  return <span ref={marker} hidden />;
}

/** Download and Copy image, once the full image is here. */
function Actions(props: { image: ShownImage; full: ImageState }) {
  const full = props.full;
  const toast = useToast();
  const url = full.state === "ready" ? full.url : undefined;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={!url}
        onClick={() => {
          if (!url) return;
          copyImageToClipboard(fetch(url).then((response) => response.blob())).then(
            () => toast.add({ title: "Image copied" }),
            () => toast.error({ title: "Couldn't copy the image" }),
          );
        }}
      >
        <CopyIcon aria-hidden size={14} />
        Copy image
      </Button>
      {url ? (
        <a
          href={url}
          download={props.image.name}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <DownloadSimpleIcon aria-hidden size={14} />
          Download
        </a>
      ) : (
        <Button variant="ghost" size="sm" disabled>
          <DownloadSimpleIcon aria-hidden size={14} />
          Download
        </Button>
      )}
    </>
  );
}

/** The image fitted to the stage; zoom grows it toward its natural size, then it scrolls. */
function Stage(props: { image: ShownImage; shown: ImageState }) {
  const shown = props.shown;
  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ width: number; height: number; max: number }>();
  const [zoom, setZoom] = useState(1);
  const max = fit?.max ?? 1;
  // Native listeners: pinch arrives as ctrl+wheel or two touches, and both must not zoom the page.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const zoomBy = (factor: number) =>
      setZoom((current) => Math.min(max, Math.max(1, current * factor)));
    let distance = 0;
    const spread = (touches: TouchList) => {
      const [a, b] = [touches[0], touches[1]];
      return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
    };
    const wheel = (event: WheelEvent) => {
      const scrollable =
        element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth;
      if (!event.ctrlKey && !event.metaKey && scrollable) return;
      event.preventDefault();
      zoomBy(Math.exp(-event.deltaY / 300));
    };
    const touch = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      const next = spread(event.touches);
      if (distance && next) zoomBy(next / distance);
      distance = next;
    };
    const reset = () => (distance = 0);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("touchmove", touch, { passive: false });
    element.addEventListener("touchend", reset);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("touchmove", touch);
      element.removeEventListener("touchend", reset);
    };
  }, [max]);
  const zoomed = fit && zoom > 1;
  return (
    <div
      ref={stage}
      className={cn(
        "flex h-full min-w-0 flex-1 overflow-auto",
        // Centred while it fits; once zoomed, from the top-left corner so every edge scrolls.
        !zoomed && "items-center justify-center",
      )}
    >
      {shown.state === "ready" ? (
        <img
          src={shown.url}
          alt={props.image.name}
          draggable={false}
          onLoad={(event) => {
            if (zoom > 1) return;
            const img = event.currentTarget;
            const width = img.clientWidth || img.naturalWidth;
            setFit({
              width,
              height: img.clientHeight || img.naturalHeight,
              max: Math.max(1, img.naturalWidth / Math.max(1, width)),
            });
          }}
          onDoubleClick={() => setZoom((current) => (current > 1 ? 1 : max))}
          style={{
            margin: "auto",
            ...(zoomed
              ? { width: fit.width * zoom, height: fit.height * zoom, maxWidth: "none" }
              : {}),
            ...(max > 1 ? { cursor: zoomed ? "zoom-out" : "zoom-in" } : {}),
          }}
          className={cn("shrink-0 select-none", !zoomed && "max-h-full max-w-full object-contain")}
        />
      ) : shown.state === "loading" ? (
        <Skeleton
          className="h-auto rounded-md"
          style={{ margin: "auto", aspectRatio: "4 / 3", width: "min(640px, 80%)" }}
        />
      ) : (
        <p className="text-ui text-muted-foreground" style={{ margin: "auto" }}>
          Image unavailable on this device
        </p>
      )}
    </div>
  );
}
