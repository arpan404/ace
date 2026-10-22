import type { AceToolView } from "@ace/ui-core/ace-tools";
import { readAceLog, sameAceReading, type AceReading } from "@ace/ui-core/work-log-reading";
import { useMemo } from "react";
import { useLightbox } from "@/components/attachment-open.tsx";
import type { ShownImage } from "@/components/attachment-format.ts";
import { ImageTile } from "@/components/attachment-tiles.tsx";
import { useStepItemsSelect } from "./step-items.ts";

/*
 * ace's own steps in a work log: the log read as a whole (what each step acted on, the daemon's
 * audits folded into their calls) and the images a step answered with.
 */

const empty: AceReading = { contexts: {}, hidden: new Set(), signature: "" };

export function useAceLog(threadId: string, itemIds: readonly string[]): AceReading {
  return useStepItemsSelect(threadId, itemIds, readAceLog, sameAceReading) ?? empty;
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
