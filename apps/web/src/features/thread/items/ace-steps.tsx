import type { Item } from "@ace/protocol";
import { aceToolLog, type AceLog, type AceLogRow, type AceToolView } from "@ace/ui-core/ace-tools";
import { useCallback, useMemo } from "react";
import { useLightbox } from "@/components/attachment-open.tsx";
import type { ShownImage } from "@/components/attachment-format.ts";
import { ImageTile } from "@/components/attachment-tiles.tsx";
import { useStepItemsSelect } from "./step-items.ts";

/*
 * ace's own steps in a work log: the log read as a whole (what each step acted on, the daemon's
 * audits folded into their calls) and the images a step answered with.
 */

const sameLog = (a: AceLog, b: AceLog) => a.signature === b.signature;

/** The open log's rows and each step's context; plain rows until the items are read. */
export function useAceLog(threadId: string, itemIds: readonly string[]): AceLog {
  const select = useCallback(
    (items: readonly (Item | undefined)[]) => aceToolLog(itemIds, items),
    [itemIds],
  );
  const log = useStepItemsSelect(threadId, itemIds, select, sameLog);
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
