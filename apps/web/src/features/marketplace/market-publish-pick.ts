import type {
  MarketMe,
  MarketPickType,
  MarketPublishable,
  Recipe,
} from "@ace/protocol/marketplace";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { market, marketKey } from "./market-api.ts";
import { standing, type MarketPublishItem } from "./market-publish-port.ts";

/*
 * The Item step's picker (ADR 0174 §2): the person's own bots, skills and plugins from the
 * daemon, each with the source the daemon reads its files from, and a bot's recipe as it will be
 * published. Pure helpers turn one into what the flow publishes.
 */

const pickKey = [...marketKey, "publish", "pick"] as const;

/** The person's own things of `type` that can be published, and places that couldn't be read. */
export function usePublishables(type: MarketPickType) {
  return useDaemonQuery({
    queryKey: [...pickKey, type],
    retry: false,
    read: async (client, signal) =>
      await market(client, { op: "publishables", type }, "publishables", signal),
  });
}

/** A bot's recipe as publishing it sends it, with what a recipe can't carry. */
export function useBotRecipe(id: string | undefined) {
  return useDaemonQuery({
    queryKey: [...pickKey, "recipe", id ?? ""],
    enabled: id !== undefined,
    retry: false,
    read: async (client, signal) =>
      await market(client, { op: "botRecipe", id: id ?? "" }, "botRecipe", signal),
  });
}

/** What publishing one picked thing means: its name, words, source and where it stands. */
export function pickedItem(me: MarketMe | undefined, picked: MarketPublishable): MarketPublishItem {
  const mine = me?.entries.find(
    (entry) => entry.type === picked.type && entry.name === picked.name,
  );
  return {
    type: picked.type,
    name: picked.name,
    title: mine?.title ?? picked.title,
    line: mine?.line ?? picked.line,
    source: picked.source,
    ...standing(me, picked.type, picked.name),
  };
}

/** Whether `item` is the picked thing `picked`, by where its files come from. */
export function samePick(item: MarketPublishItem | undefined, picked: MarketPublishable): boolean {
  return JSON.stringify(item?.source) === JSON.stringify(picked.source);
}

/** Where a picked thing lives, as a few words. */
export function fromWords(picked: MarketPublishable): string {
  switch (picked.from) {
    case "spade":
      return "In Spade";
    case "ace":
      return "In ace's skills";
    case "plugin":
      return "Installed plugin";
  }
}

/** A recipe's connector need as a label: its catalogue id or its address. */
export const needLabel = (need: Recipe["needs"]["connectors"][number]) =>
  "id" in need ? need.id : need.url;

/** `spade-skill/triage-mail` → `triage-mail`; a folder in the recipe keeps its path. */
export const refName = (ref: string) => ref.replace(/^spade-(?:skill|plugin)\//, "");
