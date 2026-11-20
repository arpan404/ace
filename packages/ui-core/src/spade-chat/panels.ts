import { z } from "zod";

/*
 * A packaged bot's panels (ADR 0200 §5.2, spade/docs/surfaces.md): sandboxed pages its package
 * ships, opened beside its conversation on the web and desktop. Spade lists them with the page
 * each shows, by hash, and the actions it may send; the bot sets their state with `panel_update`
 * and the latest state is folded from the conversation, so a panel follows it live. Phones show
 * the bot's cards instead. Read leniently, as every event is.
 */

/** One of a bot's panels, as `GET /v1/conversations/{id}/panels` lists it. */
export interface SpadePanel {
  id: string;
  title: string;
  /** The sha256 of the page it shows; undefined until one arrived. */
  page: string | undefined;
  /** The actions its page may send, by name. */
  actions: readonly string[];
  /** The state its bot last set, as Spade had it when listed. */
  state: unknown;
}

const Listed = z.object({
  panels: z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((item) => {
        const read = z
          .object({
            id: z.string().min(1).max(40),
            title: z.string().catch(""),
            page: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .nullish()
              .catch(undefined),
            actions: z.array(z.string()).catch([]),
            state: z.unknown().optional(),
          })
          .safeParse(item);
        if (!read.success) return [];
        const { id, title, page, actions, state } = read.data;
        return [{ id, title: title || id, page: page ?? undefined, actions, state }];
      }),
    ),
});

/** A bot's panels from Spade's answer; none when it can't be read. */
export function readSpadePanels(raw: unknown): SpadePanel[] {
  const read = Listed.safeParse(raw);
  return read.success ? read.data.panels : [];
}

/** The stored events `wire.ts` reads for panels, `spade_core::panel` as it writes them. */
export const spadePanelEvents = [
  z.object({ type: z.literal("panel_updated"), surface: z.string().min(1), data: z.unknown() }),
  z.object({
    type: z.literal("panel_action"),
    surface: z.string().min(1),
    action: z.string(),
    label: z.string().catch(""),
  }),
] as const;

/** A panel's state: the latest the conversation set, else what Spade listed. */
export function spadePanelState(panel: SpadePanel, folded: ReadonlyMap<string, unknown>): unknown {
  return folded.has(panel.id) ? folded.get(panel.id) : panel.state;
}
