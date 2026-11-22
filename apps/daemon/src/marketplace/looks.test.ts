import { describe, expect, it } from "vitest";
import { checkFiles } from "@ace/marketplace/checks";
import { sampleRecipe, sampleSkill, sampleSuit } from "@ace/marketplace/testing";
import type { ArchiveFile } from "@ace/marketplace";
import type { MarketEntryType } from "@ace/protocol/marketplace";
import { EntryLooks, type LookRequest } from "./looks.ts";
import type { PreparedEntry } from "./review.ts";

/** A version as the source serves it once checked. */
function entry(type: MarketEntryType, name: string, files: ArchiveFile[]): PreparedEntry {
  const checked = checkFiles(type, name, files);
  return {
    source: "market",
    type,
    name,
    title: name,
    version: "1.0.0",
    hash: checked.hash,
    signed: true,
    reviewed: true,
    byAce: true,
    checked,
  };
}

const served: Record<string, () => PreparedEntry> = {
  "spade-bot/inbox": () => entry("spade-bot", "inbox", sampleRecipe()),
  "spade-bot/plain": () => entry("spade-bot", "plain", sampleRecipe({ face: undefined })),
  "suit/harbour-dusk": () => entry("suit", "harbour-dusk", sampleSuit()),
  "spade-skill/triage-mail": () => entry("spade-skill", "triage-mail", sampleSkill()),
};

/** A source whose fetches finish only when the test lets them, counting what it was asked. */
function source() {
  const asked: string[] = [];
  const pending: (() => void)[] = [];
  let running = 0;
  let mostAtOnce = 0;
  let clock = 0;
  const looks = new EntryLooks({
    now: () => clock,
    fetch: async (request: LookRequest) => {
      const key = `${request.type}/${request.name}`;
      asked.push(`${key}@${request.version ?? "latest"}`);
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise<void>((resolve) => pending.push(resolve));
      running--;
      const make = served[key];
      if (!make) throw new Error(`${key} isn't listed`);
      return make();
    },
  });
  const settle = async () => {
    for (let round = 0; round < 50; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      pending.splice(0).forEach((resolve) => resolve());
    }
  };
  return {
    looks,
    asked,
    settle,
    mostAtOnce: () => mostAtOnce,
    advance: (ms: number) => (clock += ms),
  };
}

const bot = (name: string, version?: string): LookRequest => ({
  source: "market",
  type: "spade-bot",
  name,
  ...(version ? { version } : {}),
});

/** A refused fetch's message, caught as soon as it is asked for. */
const refusal = (thrown: unknown) => (thrown instanceof Error ? thrown.message : "");

describe("card looks", () => {
  it("answers a bot's face and a Suit's suit.json from the version's bytes", async () => {
    const { looks, settle } = source();
    const face = looks.read(bot("inbox", "1.0.0"));
    const suit = looks.read({ source: "market", type: "suit", name: "harbour-dusk" });
    const faceless = looks.read(bot("plain", "1.0.0"));
    await settle();
    expect((await face).face).toMatchObject({ kind: "character", body: "fox", pair: "ember" });
    expect(JSON.parse((await suit).suit ?? "{}")).toMatchObject({ id: "harbour-dusk" });
    expect(await faceless).toEqual({ op: "look" });
  });

  it("fetches nothing for a type that has no look", async () => {
    const { looks, asked } = source();
    expect(
      await looks.read({ source: "market", type: "spade-skill", name: "triage-mail" }),
    ).toEqual({ op: "look" });
    expect(asked).toEqual([]);
  });

  it("fetches a version once however many cards ask, and keeps it", async () => {
    const { looks, asked, settle } = source();
    const cards = [1, 2, 3].map(() => looks.read(bot("inbox", "1.0.0")));
    await settle();
    await Promise.all(cards);
    await looks.read(bot("inbox", "1.0.0"));
    expect(asked).toEqual(["spade-bot/inbox@1.0.0"]);
  });

  it("runs a shelf's fetches a few at a time and answers every card", async () => {
    const { looks, settle, mostAtOnce } = source();
    const shelf = Array.from({ length: 10 }, (_, index) =>
      looks.read(bot("inbox", `1.0.${index}`)),
    );
    await settle();
    const answered = await Promise.all(shelf);
    expect(answered.every((look) => look.face !== undefined)).toBe(true);
    expect(mostAtOnce()).toBeGreaterThan(1);
    expect(mostAtOnce()).toBeLessThanOrEqual(4);
  });

  it("reads the newest version's look again once half an hour has passed", async () => {
    const { looks, asked, settle, advance } = source();
    const first = looks.read(bot("inbox"));
    await settle();
    await first;
    advance(29 * 60_000);
    await looks.read(bot("inbox"));
    advance(2 * 60_000);
    const again = looks.read(bot("inbox"));
    await settle();
    await again;
    expect(asked).toEqual(["spade-bot/inbox@latest", "spade-bot/inbox@latest"]);
  });

  it("tries a refused fetch again on the next ask", async () => {
    const { looks, asked, settle } = source();
    const missing = looks.read(bot("gone", "1.0.0")).catch(refusal);
    await settle();
    expect(await missing).toContain("isn't listed");
    const retry = looks.read(bot("gone", "1.0.0")).catch(refusal);
    await settle();
    expect(await retry).toContain("isn't listed");
    expect(asked).toHaveLength(2);
  });
});
