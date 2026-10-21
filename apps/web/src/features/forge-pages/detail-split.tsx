import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowsInSimpleIcon, ArrowsOutSimpleIcon, XIcon } from "@phosphor-icons/react";
import { readJson, writeJson } from "@ace/ui-core";
import { z } from "zod";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { useLayout } from "@/lib/layout.tsx";

const widthKey = "ace.forge.panelWidth";
const preferred = 640;
const min = 380;
/** Room the list keeps beside the panel. */
const listMin = 320;

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * The list, and the open item beside it in a panel that can be dragged wider, maximised (the
 * list steps aside) and closed with its button or Escape. Its width is kept on this device.
 */
export function DetailSplit(props: {
  list: ReactNode;
  /** The open item; none shows the list alone. */
  panel: ReactNode;
  panelLabel: string;
  onClose(): void;
}) {
  const { storage } = useLayout();
  const [width, setWidth] = useState(() => readJson(storage, widthKey, z.number(), preferred));
  const [maximised, setMaximised] = useState(false);
  const [room, setRoom] = useState(1200);
  const frame = useRef<HTMLDivElement>(null);
  const open = props.panel !== null && props.panel !== undefined && props.panel !== false;
  const onClose = props.onClose;
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRoom(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || editable(event.target)) return;
      // A dialog or menu over the page takes its own Escape.
      if (document.querySelector("[role=dialog],[role=menu],[role=listbox]")) return;
      event.preventDefault();
      if (maximised) setMaximised(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, maximised, onClose]);
  const max = Math.max(min, room - listMin);
  const shown = Math.min(Math.max(width, min), max);
  return (
    <div ref={frame} className="relative flex h-full min-h-0">
      <div className={cn("@container/list min-w-0 flex-1", open && maximised && "hidden")}>
        {props.list}
      </div>
      {open && (
        <section
          aria-label={props.panelLabel}
          style={maximised ? undefined : { width: shown }}
          className={cn(
            "relative flex min-h-0 flex-col border-l border-border bg-panel",
            maximised ? "flex-1 border-l-0" : "shrink-0",
          )}
        >
          {!maximised && (
            <ResizeHandle
              label="Resize panel"
              edge="left"
              size={shown}
              min={min}
              max={max}
              onResize={setWidth}
              onResizeEnd={(next) => writeJson(storage, widthKey, next)}
              onReset={() => {
                setWidth(preferred);
                writeJson(storage, widthKey, preferred);
              }}
            />
          )}
          <div
            className={cn("flex h-9 shrink-0 items-center justify-end gap-0.5 px-2", toolbarEdge)}
          >
            <IconButton
              size="sm"
              icon={maximised ? ArrowsInSimpleIcon : ArrowsOutSimpleIcon}
              label={maximised ? "Restore panel" : "Maximise panel"}
              onClick={() => setMaximised((value) => !value)}
            />
            <IconButton size="sm" icon={XIcon} label="Close panel" onClick={onClose} />
          </div>
          <div className="relative min-h-0 flex-1">{props.panel}</div>
        </section>
      )}
    </div>
  );
}
