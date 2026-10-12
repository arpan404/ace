import type { Item } from "@ace/protocol";
import {
  aceCallOf,
  aceToolLog,
  screenStep,
  type AceLog,
  type AceToolView,
} from "@ace/ui-core/ace-tools";
import { useMemo } from "react";
import { useLightbox } from "@/components/attachment-open.tsx";
import type { ShownImage } from "@/components/attachment-format.ts";
import { ImageTile } from "@/components/attachment-tiles.tsx";
import { useStepItemsSelect } from "./step-items.ts";

/*
 * ace's own steps in a work log: the log read as a whole (what each step acted on, the daemon's
 * audits folded into their calls) and the images a step answered with.
 */

/** Whether an item is one of ace's own steps or the daemon's audit of one; memoised per item. */
const aceItems = new WeakMap<Item, boolean>();
function isAce(item: Item): boolean {
  let known = aceItems.get(item);
  if (known === undefined) {
    known = !!screenStep(item) || !!aceCallOf(item);
    aceItems.set(item, known);
  }
  return known;
}

/** ace's steps in a log: what each acted on, and the audits folded into the call they record. */
export interface AceReading {
  contexts: AceLog["contexts"];
  hidden: ReadonlySet<string>;
  signature: string;
}
const empty: AceReading = { contexts: {}, hidden: new Set(), signature: "" };
const sameReading = (a: AceReading, b: AceReading) => a.signature === b.signature;

function readAceLog(items: readonly (Item | undefined)[]): AceReading {
  const ace = items.filter((item): item is Item => !!item && isAce(item));
  if (!ace.length) return empty;
  // Only ace's own steps feed its reading, so a log of other tools costs nothing here.
  const log = aceToolLog(
    ace.map((item) => item.id),
    ace,
  );
  const shown = new Set(log.rows.flatMap((row) => (row.kind === "group" ? row.ids : [row.id])));
  const hidden = new Set(ace.flatMap((item) => (shown.has(item.id) ? [] : [item.id])));
  return { contexts: log.contexts, hidden, signature: log.signature };
}

export function useAceLog(threadId: string, itemIds: readonly string[]): AceReading {
  return useStepItemsSelect(threadId, itemIds, readAceLog, sameReading) ?? empty;
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
