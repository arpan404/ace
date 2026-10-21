import { z } from "zod";
import { useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { copyImageToClipboard } from "@/lib/clipboard-image.ts";
import type { PreviewSource } from "../sources.ts";
import type { PageTarget } from "./page-context-menu.tsx";
import { reason } from "./use-browser-features.ts";

const Target = z.object({
  link: z.string().max(8192).optional(),
  image: z.string().max(8192).optional(),
});
const ImageData = z.object({ data: z.string() });

/** The image's bytes from the page, typed by their first bytes (the clipboard needs a type). */
function imageBlob(data: string): Blob {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const type =
    bytes[0] === 0x89 && bytes[1] === 0x50
      ? "image/png"
      : bytes[0] === 0xff && bytes[1] === 0xd8
        ? "image/jpeg"
        : bytes[0] === 0x47 && bytes[1] === 0x49
          ? "image/gif"
          : bytes[0] === 0x52 && bytes[8] === 0x57
            ? "image/webp"
            : "";
  return new Blob([bytes], type ? { type } : {});
}

/** "photo.jpg" from an image's address, or "image". */
export function imageName(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    return (
      decodeURIComponent(last)
        .replace(/[\\/:*?"<>|]/g, "_")
        .slice(0, 128) || "image"
    );
  } catch {
    return "image";
  }
}

/**
 * The link or image under a right click on a page ace draws, and the menu's link and image
 * commands. The page is asked at the click; a later click replaces an earlier answer.
 */
export function usePageTarget(input: {
  source: PreviewSource;
  threadId: string;
  tabId: string | undefined;
  openTab(url: string): void;
}) {
  const { source, threadId, tabId } = input;
  const toast = useToast();
  const [target, setTarget] = useState<PageTarget>();
  const asked = useRef(0);
  const tool = source.pageTool;
  const image = async (url: string) => {
    if (!tool) throw new Error("Not available here");
    const { data } = ImageData.parse(await tool(threadId, { action: "image_data", url }, tabId));
    return imageBlob(data);
  };
  const copyText = (text: string) =>
    void navigator.clipboard?.writeText(text).catch(() => toast.error({ title: "Couldn't copy" }));
  return {
    target,
    locate(point: { x: number; y: number }) {
      const ask = ++asked.current;
      setTarget(undefined);
      if (!tool) return;
      void tool(threadId, { action: "context_target", ...point }, tabId)
        .then((raw) => {
          const parsed = Target.safeParse(raw);
          if (ask === asked.current) setTarget(parsed.success ? parsed.data : {});
        })
        .catch(() => {
          if (ask === asked.current) setTarget({});
        });
    },
    openLink: input.openTab,
    copyLink: (url: string) => copyText(url),
    copyImage(url: string) {
      void copyImageToClipboard(image(url)).catch((error: unknown) =>
        toast.error({ title: "Couldn't copy the image", description: reason(error) }),
      );
    },
    /** Saves through this app's own download (a save dialog in the desktop app). */
    saveImage(url: string) {
      void image(url).then(
        (blob) => {
          const href = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = href;
          anchor.download = imageName(url);
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(href), 60_000);
        },
        (error: unknown) =>
          toast.error({ title: "Couldn't save the image", description: reason(error) }),
      );
    },
  };
}
