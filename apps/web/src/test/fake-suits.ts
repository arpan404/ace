import { SuitManifest, type SuitDetail, type SuitSummary } from "@ace/protocol/suits";
import type { SuitActive, SuitTransport } from "@/theme/suits/suit-transport.ts";

/** A Suit as the daemon would describe it; `manifest` is parsed so defaults fill in. */
export function fakeSuit(
  manifest: Record<string, unknown> & { id: string },
  summary: Partial<SuitSummary> = {},
): SuitDetail {
  const parsed = SuitManifest.parse({ format: 1, name: manifest.id, ...manifest });
  return {
    summary: {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      schemes: (["light", "dark"] as const).filter((scheme) => parsed[scheme] !== undefined),
      scene: false,
      contentHash: "hash-1",
      problems: [],
      ...summary,
    },
    manifest: parsed,
    sceneUrl: null,
    sceneUrls: {},
    assets: {},
    css: null,
    ornaments: {},
  };
}

/** The daemon's Suit library at the transport: tests push lists and `suit.active` by hand. */
export function fakeSuitLibrary(initial: readonly SuitDetail[]) {
  let suits = [...initial];
  let socket: number | undefined;
  const lists = new Set<(suits: readonly SuitSummary[], socket?: number) => void>();
  const actives = new Set<(active: SuitActive) => void>();
  const transport: SuitTransport = {
    watch(receive) {
      lists.add(receive);
      queueMicrotask(() =>
        receive(
          suits.map((suit) => suit.summary),
          socket,
        ),
      );
      return () => lists.delete(receive);
    },
    async read(id) {
      const found = suits.find((suit) => suit.summary.id === id);
      if (!found) throw new Error(`no Suit ${id}`);
      return found;
    },
    watchActive(receive) {
      actives.add(receive);
      return () => actives.delete(receive);
    },
  };
  return {
    transport,
    /** A new list; `over` names a new daemon socket, whose served URLs the Suits now carry. */
    replace(next: readonly SuitDetail[], over = socket) {
      suits = [...next];
      socket = over;
      for (const receive of lists)
        receive(
          suits.map((suit) => suit.summary),
          socket,
        );
    },
    active(active: SuitActive) {
      for (const receive of actives) receive(active);
    },
  };
}
