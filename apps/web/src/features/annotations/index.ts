/*
 * Browser annotation (ADR 0082): the Browser's Annotate mode, the composer's annotations and
 * their chip, and the card a sent message shows them in.
 */
export type { AnnotationDriver } from "./driver.ts";
export {
  useAnnotate,
  annotateUnavailable,
  annotateHint,
  type AnnotatablePage,
} from "./use-annotate.ts";
export {
  useDraftAnnotations,
  useAnnotationPort,
  type AnnotationHandOff,
  type DraftAnnotationsState,
} from "./draft-annotations.ts";
export { withAnnotations } from "./hand-off.ts";
export { AnnotationChip, preloadAnnotationChip } from "./annotation-chip.tsx";
export { annotationCount } from "./annotation-words.ts";
export { AnnotationsCard } from "./annotation-card.tsx";
