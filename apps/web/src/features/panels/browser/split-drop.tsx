import { useState, type DragEvent } from "react";
import { tabDragType } from "@/lib/workspace/index.ts";

/** The daemon tab a dragged panel tab's key names, when it is a browser tab. */
const draggedTab = (key: string) => (key.startsWith("browser:") ? key.slice(8) : undefined);

/** A top tab dragged over this tab's right half: dropped there, it opens alongside it. */
const rightHalf = (event: DragEvent<HTMLElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX >= box.left + box.width / 2;
};

/**
 * A browser tab as a split view drop target: a top tab dragged onto its right half opens beside
 * it. Only tab drags count (files and text pass through). Spread `handlers` on the tab's root
 * and draw `indicator` inside it.
 */
export function useSplitDrop(own: string | undefined, onSplit: (tabId: string) => void) {
  const [over, setOver] = useState(false);
  const accepts = (event: DragEvent<HTMLElement>) =>
    own !== undefined && event.dataTransfer.types.includes(tabDragType);
  return {
    handlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!accepts(event)) return;
        const right = rightHalf(event);
        setOver(right);
        if (right) event.preventDefault();
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        setOver(false);
        if (!accepts(event)) return;
        const id = draggedTab(event.dataTransfer.getData(tabDragType));
        if (!id || id === own) return;
        event.preventDefault();
        onSplit(id);
      },
    },
    indicator: over ? (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-1/2 rounded-md bg-ring/8 outline-2 -outline-offset-4 outline-ring/45"
      />
    ) : null,
  };
}
