import { useSyncExternalStore } from "react";

/*
 * The size of the picture a Suit's video plays now (ADR 0169), for Settings: the file's own
 * pixels, read from its metadata, so "4K" shows only when the file is 4K.
 */

export interface VideoSize {
  width: number;
  height: number;
}

function createVideoShowing() {
  const sizes = new Map<string, VideoSize>();
  const watchers = new Set<() => void>();
  const tell = () => {
    for (const watcher of watchers) watcher();
  };
  return {
    set(suitId: string, size: VideoSize) {
      const known = sizes.get(suitId);
      if (known?.width === size.width && known.height === size.height) return;
      sizes.set(suitId, size);
      tell();
    },
    clear(suitId: string) {
      if (sizes.delete(suitId)) tell();
    },
    get: (suitId: string) => sizes.get(suitId),
    watch(changed: () => void) {
      watchers.add(changed);
      return () => void watchers.delete(changed);
    },
  };
}

/** The page's one record of what each Suit's video plays. */
export const videoShowing = createVideoShowing();

/** The size `suitId`'s video plays at now, or undefined when it isn't playing on this page. */
export function useVideoSize(suitId: string | undefined): VideoSize | undefined {
  return useSyncExternalStore(
    videoShowing.watch,
    () => (suitId ? videoShowing.get(suitId) : undefined),
    () => undefined,
  );
}
