import type { SlashMenu, SlashMenuRow } from "@/features/thread/index.ts";
import { useQuery } from "@tanstack/react-query";
import { slashEntry, parseInvocables, type SlashRow } from "./spade-slash.ts";
import { segment, spadeHttp } from "./spade-requests.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

/** What `/` does besides starting a skill or command: the screen's own, by name. */
export interface SlashAction {
  id: string;
  name: string;
  description: string;
  run(): void;
}

/** The skills and commands this bot may be told to use, by conversation. */
export function useSpadeInvocables(conversation: string | undefined) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  return useQuery({
    queryKey: ["spade", "invocables", machine, conversation ?? ""],
    enabled: conversation !== undefined,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const text = await spadeHttp(
        client,
        "GET",
        `/v1/conversations/${segment(conversation ?? "")}/invocables`,
        { signal },
      );
      const rows = parseInvocables(JSON.parse(text));
      if (!rows) throw new Error("Spade's skills didn't make sense.");
      return rows;
    },
  });
}

const groups = { skill: "Skills", command: "Commands" } as const;

/** The menu behind `/`: the actions, then the bot's skills and commands. */
export function slashMenu(actions: readonly SlashAction[], invocables: readonly SlashRow[]) {
  const rows: SlashMenuRow[] = [
    ...actions.map((action): SlashMenuRow => ({
      group: "Actions",
      id: action.id,
      name: action.name,
      description: action.description,
      source: "Spade",
    })),
    ...invocables.map((row): SlashMenuRow => ({
      group: groups[row.kind],
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      entry: slashEntry(row),
    })),
  ];
  return { rows, run: (id: string) => actions.find((action) => action.id === id)?.run() };
}

/** [`slashMenu`] as the composer takes it. */
export function useSlashMenu(
  actions: readonly SlashAction[],
  invocables: readonly SlashRow[] | undefined,
): SlashMenu {
  const menu = slashMenu(actions, invocables ?? []);
  return { rows: menu.rows, onAction: menu.run };
}
