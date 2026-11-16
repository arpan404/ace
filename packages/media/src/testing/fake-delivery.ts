import type { MediaDeliveryPort, ViewIntent } from "../media-viewers.ts";

/**
 * A daemon delivery for bridge tests: serves every kind and holds the views it granted, by the
 * id it gave (`views`). `live` is what ace-media delivers: as there, a view opened for a target
 * its connection already shows replaces that view, and a regrant opens a held view again.
 */
export function fakeDelivery() {
  const views = new Map<string, Omit<ViewIntent, "viewer">>();
  const live = new Set<string>();
  let ids = 0;
  const open = (viewer: string) => {
    const intent = views.get(viewer);
    if (!intent) return;
    for (const other of live) {
      const shown = views.get(other);
      if (
        shown?.connection === intent.connection &&
        JSON.stringify(shown.target) === JSON.stringify(intent.target)
      )
        live.delete(other);
    }
    live.add(viewer);
  };
  const port: MediaDeliveryPort = {
    serves: () => true,
    bind: (intent) => {
      const viewer = `view-${++ids}`;
      views.set(viewer, intent);
      open(viewer);
      return viewer;
    },
    granted: () => true,
    poster: () => Promise.resolve(undefined),
    configure: () => {},
    pause: () => {},
    regrant: open,
    unbind: (viewer) => {
      views.delete(viewer);
      live.delete(viewer);
    },
  };
  return { port, views, live };
}

/** A paired phone's main session, as an owner of media connections. */
export const phoneOwner = {
  session: "main-0d8c7a3e-4b1f-4e2a-9c5d-6f7a8b9c0d1e",
  device: "phone",
  admission: { kind: "pairing", generation: "3f9a1c0e7b2d4a6c8e1f0b2d4c6e8a1f" },
} as const;
