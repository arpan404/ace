import type { Item, ThreadView } from "@ace/protocol";

/** Read one detached transcript tail while retaining the status lease for the whole read. */
export function loadThreadSnapshot(source: {
  acquire(): ThreadView;
  release(): void;
  items(status: ThreadView): {
    items: Item[];
    itemsBefore: ThreadView["itemsBefore"];
    itemSeqs?: ThreadView["itemSeqs"];
  };
  retainAgents(view: ThreadView): void;
}): ThreadView {
  const status = source.acquire();
  try {
    const view: ThreadView = structuredClone({ ...status, items: {}, itemOrder: [] });
    const page = source.items(status);
    view.items = Object.fromEntries(page.items.map((item) => [item.id, item]));
    view.itemOrder = page.items.map((item) => item.id);
    view.itemsBefore = page.itemsBefore;
    if (page.itemSeqs) view.itemSeqs = page.itemSeqs;
    source.retainAgents(view);
    return view;
  } finally {
    source.release();
  }
}
