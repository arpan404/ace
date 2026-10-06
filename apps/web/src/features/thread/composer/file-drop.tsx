import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import type { ComposerHandle } from "./composer.tsx";
import { carriesFiles } from "./file-intake.ts";

/** A field of its own takes its own paste; only one outside every field goes to the composer. */
function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || !!target.closest("input, textarea, [contenteditable]"))
  );
}

/**
 * Files dropped anywhere on a screen go to its composer: `handlers` go on the screen's box and
 * `overlay` inside it, shown while files are dragged over. Files pasted while the focus is
 * outside every field (after clicking the transcript, say) go there too.
 */
export function useFileDrop(composer: RefObject<ComposerHandle | null>) {
  const [over, setOver] = useState(false);
  // Enter and leave fire for every child crossed; the drag has left only when they balance.
  const depth = useRef(0);
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (!event.clipboardData?.files.length || editable(event.target)) return;
      event.preventDefault();
      composer.current?.takeFiles(event.clipboardData);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [composer]);
  const end = () => {
    depth.current = 0;
    setOver(false);
  };
  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current++;
      setOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent) => {
      if (carriesFiles(event.dataTransfer) && --depth.current <= 0) end();
    },
    onDrop: (event: DragEvent) => {
      end();
      // The composer took a drop on itself already.
      if (event.defaultPrevented || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      composer.current?.takeFiles(event.dataTransfer);
    },
  };
  const overlay = over && (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-background text-center"
    >
      <p className="text-md font-medium text-foreground">Drop files to attach</p>
      <p className="text-xs text-muted-foreground">A folder adds up to 50 of its files</p>
    </div>
  );
  return { handlers, overlay };
}
