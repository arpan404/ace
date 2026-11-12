import { z } from "zod";
import { spadeJson } from "./json.ts";

/**
 * Settings › Spade › Web search (spade/docs/design.md, Web search): the person's own SearXNG
 * address and whether a Brave Search key is stored. Spade never sends the key back.
 */
export interface SpadeSearchSettings {
  searxngUrl: string | null;
  braveKeySet: boolean;
  /** This machine has a keychain, so a key typed here can be kept. */
  keychain: boolean;
}

const settingsShape = z.object({
  searxng_url: z.string().nullish().catch(null),
  brave_key_set: z.boolean().catch(false),
  keychain: z.boolean().catch(true),
});

export function parseSpadeSearchSettings(body: string): SpadeSearchSettings | undefined {
  const parsed = settingsShape.safeParse(spadeJson(body));
  if (!parsed.success) return undefined;
  return {
    searxngUrl: parsed.data.searxng_url ?? null,
    braveKeySet: parsed.data.brave_key_set,
    keychain: parsed.data.keychain,
  };
}

/** The first words of `web_search`'s result when nothing is set up for it to search with. */
export const spadeSearchNotSetUp = "No web search is set up.";

/** Whether a finished call was `web_search` finding nothing set up to search with. */
export function spadeNeedsSearchSetup(name: string, content: unknown, isError: boolean): boolean {
  return (
    isError &&
    name === "web_search" &&
    typeof content === "string" &&
    content.startsWith(spadeSearchNotSetUp)
  );
}
