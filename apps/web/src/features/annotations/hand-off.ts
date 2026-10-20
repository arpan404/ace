import type { ContentPart } from "@ace/protocol";
import type { AnnotationHandOff, AnnotationOutcome } from "./draft-annotations.ts";

/** The composer's hand-off of its attached files, as the send pipeline takes them. */
export interface FilesHandOff<Local> {
  local: Local[];
  settled: Promise<{ sha256: string; name: string }[]>;
  outcomes: Promise<AnnotationOutcome[]>;
  files: (File | undefined)[];
  /** Files still being made (an annotation image being captured), in `local`'s order. */
  later?: (Promise<File | undefined> | undefined)[];
  release(): void;
  restore?(): void;
}

/**
 * A message with its browser annotations: the person's parts first, then the block; the
 * person's files first, then the annotation images in the block's order.
 */
export function withAnnotations<Local>(
  message: { input: ContentPart[]; files: FilesHandOff<Local> },
  annotations: AnnotationHandOff | undefined,
  local: (image: AnnotationHandOff["local"][number]) => Local,
): { input: ContentPart[]; files: FilesHandOff<Local> } {
  if (!annotations) return message;
  const { files } = message;
  const images = Promise.all(annotations.outcomes);
  return {
    input: [...message.input, annotations.part],
    files: {
      ...files,
      local: [...files.local, ...annotations.local.map(local)],
      settled: Promise.all([files.settled, images]).then(([own, extra]) => [
        ...own,
        ...extra.flatMap((outcome) => ("sha256" in outcome ? [outcome] : [])),
      ]),
      outcomes: Promise.all([files.outcomes, images]).then(([own, extra]) => [...own, ...extra]),
      files: [...files.files, ...annotations.files],
      later: [...(files.later ?? files.local.map(() => undefined)), ...annotations.later],
      restore: () => {
        files.restore?.();
        annotations.restore();
      },
    },
  };
}
