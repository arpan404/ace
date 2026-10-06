import { Suspense, useRef, useState } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import type { PreviewFile, ShownImage } from "./attachment-format.ts";

/*
 * Opening an attachment over the page: images in the lightbox, every other file in the preview
 * dialog. Both load their code only when first opened, so neither the thread's first chunk nor
 * the chips' carries them.
 */

const Lightbox = deferredComponent(() =>
  import("./attachment-lightbox.tsx").then((module) => module.Lightbox),
);
const Preview = deferredComponent(() =>
  import("./attachment-preview.tsx").then((module) => module.AttachmentPreview),
);

/** The lightbox over `images`: `show` opens it at an image, `lightbox` is the element to render. */
export function useLightbox(images: readonly ShownImage[]) {
  const [open, setOpen] = useState<number>();
  const opener = useRef<HTMLElement | null>(null);
  const show = (index: number, element: HTMLElement) => {
    opener.current = element;
    setOpen(index);
  };
  const lightbox = open !== undefined && (
    <Suspense fallback={null}>
      <Lightbox.Component
        images={images}
        index={open}
        onIndex={setOpen}
        onClose={() => setOpen(undefined)}
        finalFocus={opener}
      />
    </Suspense>
  );
  return { show, lightbox };
}

/** The preview dialog for one file: `show` opens it, `preview` is the element to render. */
export function useFilePreview() {
  const [open, setOpen] = useState<PreviewFile>();
  const opener = useRef<HTMLElement | null>(null);
  const show = (file: PreviewFile, element: HTMLElement) => {
    opener.current = element;
    setOpen(file);
  };
  const preview = open && (
    <Suspense fallback={null}>
      <Preview.Component file={open} onClose={() => setOpen(undefined)} finalFocus={opener} />
    </Suspense>
  );
  return { show, preview };
}
