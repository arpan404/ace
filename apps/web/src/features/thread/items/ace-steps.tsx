import type { Item } from "@ace/protocol";
import {
  aceToolLog,
  groupLine,
  type AceLog,
  type AceLogRow,
  type AceToolView,
} from "@ace/ui-core/ace-tools";
import { CaretRightIcon } from "@phosphor-icons/react";
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { useLightbox } from "@/components/attachment-open.tsx";
import type { ShownImage } from "@/components/attachment-format.ts";
import { ImageTile } from "@/components/attachment-tiles.tsx";
import { LiveWorkMark } from "@/components/live-work-mark.tsx";
import { cn } from "@/lib/cn.ts";
import { useItemsSelect } from "../lib/use-items.ts";
import { ToolMarkIcon } from "./tool-mark.tsx";

/*
 * ace's own steps in an open work log: the log read as a whole (what each step acted on, the
 * daemon's audits folded into their calls), groups of steps on one app, site or device, and the
 * images a step answered with.
 */

const sameLog = (a: AceLog, b: AceLog) => a.signature === b.signature;

/** The open log's rows and each step's context; plain rows until the items are read. */
export function useAceLog(threadId: string, itemIds: readonly string[]): AceLog {
  const select = useCallback(
    (items: readonly (Item | undefined)[]) => aceToolLog(itemIds, items),
    [itemIds],
  );
  const log = useItemsSelect(threadId, itemIds, select, sameLog);
  return useMemo(
    () =>
      log ?? {
        rows: itemIds.map((id): AceLogRow => ({ kind: "step", id })),
        contexts: {},
        signature: "",
      },
    [log, itemIds],
  );
}

/** "Used Safari · 8 actions · 3 failed", opening to its steps. */
export function StepGroup(props: {
  group: Extract<AceLogRow, { kind: "group" }>;
  children: ReactNode;
}) {
  const { group } = props;
  const [toggled, setOpen] = useState<boolean>();
  const open = toggled ?? group.awaiting;
  const panel = useId();
  const [label, ...counts] = groupLine(group).split(" · ");
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        aria-label={groupLine(group)}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1.5 text-left text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:bg-accent"
      >
        {group.running ? <LiveWorkMark className="mx-px" /> : <ToolMarkIcon mark={group.mark} />}
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 text-xs text-subtle-foreground">
          {counts.map((count, index) => (
            <span key={count} className={cn(count.endsWith("failed") && "text-status-failed")}>
              {index ? " · " : ""}
              {count}
            </span>
          ))}
        </span>
        <CaretRightIcon
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <ul id={panel} aria-label={label} className="fx-rise-in flex flex-col border-l-2 pl-2.5">
          {props.children}
        </ul>
      )}
    </li>
  );
}

/** A step's screenshots and images as small thumbnails; each opens the image lightbox. */
export function StepImages(props: { view: AceToolView }) {
  const { images: urls, words } = props.view;
  const images = useMemo<ShownImage[]>(
    () =>
      urls.map((url, index) => ({
        key: `${index}:${url.length}:${url.slice(-24)}`,
        name: urls.length > 1 ? `${words.past} (${index + 1})` : words.past,
        source: { kind: "url", url },
      })),
    [urls, words.past],
  );
  const { show, lightbox } = useLightbox(images);
  return (
    <div className="mt-1 mb-2 flex flex-wrap gap-1.5 pl-6">
      {images.map((image, index) => (
        <ImageTile
          key={image.key}
          image={image}
          size={{ width: 96, height: 60 }}
          fit="contain"
          onOpen={(element) => show(index, element)}
        />
      ))}
      {lightbox}
    </div>
  );
}
