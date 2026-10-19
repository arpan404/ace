import { useState, type DragEvent } from "react";
import { modifierMask } from "./pointer-input.ts";
import type { DropPoint } from "./use-browser-features.ts";

/** Whether a drag carries files from this device (not text, links or ace's own tab drags). */
const carriesFiles = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files");

/**
 * The live page as a drop target for files from this device: dropped, they go to the page at
 * that point (`locate` maps it to the page's pixels), where its own drop zone takes them.
 * Spread `handlers` on the page view and draw `indicator` inside it.
 */
export function useFileDrop(
  locate: (event: DragEvent<HTMLElement>) => { x: number; y: number },
  onDrop: ((files: File[], at: DropPoint) => void) | undefined,
) {
  const [over, setOver] = useState(false);
  if (!onDrop) return { handlers: {}, indicator: null };
  return {
    handlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        setOver(false);
        if (!carriesFiles(event)) return;
        // The page takes them; nothing behind the view (the composer's drop) gets them too.
        event.preventDefault();
        event.stopPropagation();
        const files = [...event.dataTransfer.files];
        if (files.length) onDrop(files, { ...locate(event), modifiers: modifierMask(event) });
      },
    },
    indicator: over ? (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 rounded-md outline-2 -outline-offset-4 outline-ring/45"
      />
    ) : null,
  };
}
