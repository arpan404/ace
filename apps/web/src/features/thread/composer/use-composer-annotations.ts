import type { DraftAnnotations } from "@ace/ui-core";
import { useDraftAnnotations } from "@/features/annotations/index.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";

/** The draft's browser annotations, uploaded into the thread's context like its other files. */
export function useComposerAnnotations(thread: ThreadRef, restored: DraftAnnotations | undefined) {
  const sources = useThreadSources();
  return useDraftAnnotations({
    restored,
    upload: (file) => sources.context.upload(thread, file, () => {}),
    release: (sha256) => sources.context.release(thread, sha256),
  });
}
